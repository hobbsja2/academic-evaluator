import { z } from 'zod';
import type { AiUseAssessment, AiUseIndicator } from '../shared/types.js';
import { containsStockPhrase, scanStockPhrases, type PhraseScanResult } from './ai-phrase-scan.js';

const AI_USE_SCORE_MIN = 0;
const AI_USE_SCORE_MAX = 10;
// Top of the "mostly human" band; the score is capped here when no AI indicator
// survives quote verification.
const UNVERIFIED_SCORE_CAP = 3;
const MAX_INDICATORS = 4;
const MIN_QUOTE_LENGTH = 8;

function clampScore(value: number): number {
  return Math.min(AI_USE_SCORE_MAX, Math.max(AI_USE_SCORE_MIN, Math.round(value)));
}

const indicatorSchema = z.object({
  quote: z.string().trim().transform((value: string): string => value.slice(0, 300)),
  observation: z.string().trim().min(1).transform((value: string): string => value.slice(0, 300))
});

const indicatorListSchema = z.array(indicatorSchema)
  .catch([])
  .transform((value: AiUseIndicator[]): AiUseIndicator[] => value.slice(0, MAX_INDICATORS));

/**
 * Tolerant parser for the model's raw assessment. A missing or malformed block
 * becomes null so it can never fail an otherwise valid grading run.
 */
export const rawAiUseAssessmentSchema = z.object({
  aiIndicators: indicatorListSchema,
  humanIndicators: indicatorListSchema,
  summary: z.string().trim().catch('').transform((value: string): string => value.slice(0, 600)),
  score: z.number().finite().transform(clampScore)
}).nullable().catch(null);

type RawAiUseAssessment = NonNullable<z.infer<typeof rawAiUseAssessmentSchema>>;

const savedIndicatorSchema = z.object({ quote: z.string().max(300), observation: z.string().max(300) });

/** Strict shape accepted when a reviewed run is saved later from the client. */
export const savedAiUseAssessmentSchema = z.object({
  score: z.number().int().min(AI_USE_SCORE_MIN).max(AI_USE_SCORE_MAX),
  aiIndicators: z.array(savedIndicatorSchema).max(MAX_INDICATORS),
  humanIndicators: z.array(savedIndicatorSchema).max(MAX_INDICATORS),
  summary: z.string().max(600),
  unverifiedCount: z.number().int().min(0).max(MAX_INDICATORS * 2),
  scoreCapped: z.boolean(),
  stockPhrases: z.array(z.string().max(60)).max(60),
  phraseDensity: z.number().min(0),
  phraseFloorApplied: z.boolean()
}).nullable().optional();

const INDICATOR_FORMAT: Record<string, unknown> = {
  type: 'array',
  maxItems: MAX_INDICATORS,
  items: {
    type: 'object',
    properties: {
      quote: { type: 'string', maxLength: 150 },
      observation: { type: 'string', maxLength: 160 }
    },
    required: ['quote', 'observation'],
    additionalProperties: false
  }
};

/**
 * Ollama structured-output fragment. Indicators come before the score so the
 * model states its evidence first and scores from it. The small local model
 * skips checks that are only described in prose, so this is a required field.
 */
export const AI_USE_FORMAT: Record<string, unknown> = {
  type: 'object',
  properties: {
    aiIndicators: INDICATOR_FORMAT,
    humanIndicators: INDICATOR_FORMAT,
    summary: { type: 'string', maxLength: 400 },
    score: { type: 'integer', minimum: AI_USE_SCORE_MIN, maximum: AI_USE_SCORE_MAX }
  },
  required: ['aiIndicators', 'humanIndicators', 'summary', 'score'],
  additionalProperties: false
};

/** Prompt section describing the advisory AI-use assessment. */
export const AI_USE_PROMPT_RULE = `AI-USE ASSESSMENT (advisory; separate from grading): populate aiUseAssessment. It must not influence any criterion's points, rating, or explanation.
Every indicator needs "quote": a short passage copied word for word from the SUBMISSION TEXT, and "observation": one sentence on what that passage shows. Only report what actually appears in this submission. Do not copy the example categories below as indicators, and leave a list empty when nothing in the text fits it. Indicators without a verbatim quote are discarded.
Signs of AI generation include: polished but generic prose with no personal, workplace, or course-specific detail; formulaic structure such as tidy lists of three and a conclusion that restates the introduction; stock phrases common in chatbot output; specific statistics or citations with no traceable source; abrupt shifts in voice between sections; leftover chatbot text. Signs of human writing include: specific personal or workplace experiences, references to class sessions, an individual and uneven voice, informal phrasing, and minor errors.
Correct grammar alone is not evidence of AI use, and writing by non-native speakers or text cleaned up with a grammar checker must not be scored high for that reason. Score 0 to 3 when human indicators dominate (0 means more likely than not written solely by the student), 4 to 6 when evidence is mixed or inconclusive, and 7 to 10 when AI indicators dominate (10 means heavy AI generation throughout). Keep the summary to two sentences. You cannot run a detector; this is a judgement from the text alone.`;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, '\'')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function quoteFound(indicator: AiUseIndicator, normalizedSubmission: string): boolean {
  const quote: string = normalize(indicator.quote).replace(/^["']+|["'.…]+$/g, '').trim();
  return quote.length >= MIN_QUOTE_LENGTH && normalizedSubmission.includes(quote);
}

/**
 * Keeps only indicators whose quote really appears in the submission, and caps
 * the score in the "mostly human" band when no AI indicator survives. The local
 * model otherwise reports prompt examples (such as "delve") that the text lacks.
 */
export function verifyAiUseAssessment(raw: RawAiUseAssessment | null, submissionText: string): AiUseAssessment | null {
  if (!raw) return null;
  const normalizedSubmission: string = normalize(submissionText);
  const aiIndicators: AiUseIndicator[] = raw.aiIndicators.filter((item: AiUseIndicator): boolean => quoteFound(item, normalizedSubmission));
  // A "human" quote containing chatbot stock phrasing is mislabelled evidence.
  const humanIndicators: AiUseIndicator[] = raw.humanIndicators.filter((item: AiUseIndicator): boolean =>
    quoteFound(item, normalizedSubmission) && !containsStockPhrase(item.quote));
  const unverifiedCount: number = raw.aiIndicators.length + raw.humanIndicators.length - aiIndicators.length - humanIndicators.length;
  const scan: PhraseScanResult = scanStockPhrases(submissionText);
  // Stock phrases are verified AI evidence too, so they also prevent the cap.
  const scoreCapped: boolean = aiIndicators.length === 0 && scan.phrases.length === 0 && raw.score > UNVERIFIED_SCORE_CAP;
  const cappedScore: number = scoreCapped ? UNVERIFIED_SCORE_CAP : raw.score;
  // The small model reads dense chatbot phrasing as "structured" human writing, so
  // a high phrase density sets a minimum score.
  const phraseFloorApplied: boolean = scan.scoreFloor > cappedScore;
  const score: number = Math.max(cappedScore, scan.scoreFloor);
  // When the floor overrides the model, its summary argues for the rejected score.
  const summary: string = phraseFloorApplied ? '' : raw.summary;
  return {
    score, aiIndicators, humanIndicators, summary, unverifiedCount, scoreCapped,
    stockPhrases: scan.phrases, phraseDensity: scan.densityPerThousandWords, phraseFloorApplied
  };
}

/** Database row values for a run's assessment. */
export function aiUseColumns(assessment: AiUseAssessment | null): { score: number | null; details: string | null } {
  if (!assessment) return { score: null, details: null };
  const { score, ...details } = assessment;
  return { score, details: JSON.stringify(details) };
}
