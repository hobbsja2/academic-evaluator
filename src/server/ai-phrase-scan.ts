// Deterministic scan for phrasing common in chatbot output. Unlike the local
// model's judgement it is repeatable and every hit is shown to the professor.
// Multi-word phrases are preferred; single words are limited to ones that are
// rare in ordinary student business writing.
const STOCK_PHRASES: readonly string[] = [
  'delve', 'delves', 'delving', 'tapestry', 'multifaceted', 'ever-evolving', 'ever-changing landscape',
  'fast-paced world', 'fast-paced business', "in today's", 'in the realm of', 'business landscape',
  'plays a crucial role', 'plays a pivotal role', 'plays a vital role', 'it is important to note',
  'it is worth noting', 'it is essential to', 'a testament to', 'navigate the complexities',
  'navigate the challenges', 'weather the storm', 'unlock new opportunities', 'unlock the potential',
  'holistic approach', 'data-driven insights', 'seamless collaboration', 'paramount', 'fostering',
  'foster a culture', 'robust and agile', 'game-changer',
  'as an ai', 'as a language model', 'certainly!', 'i hope this helps', "here's a revised"
];

const WORDS_PER_DENSITY_UNIT = 1000;
const MIN_DISTINCT_PHRASES = 3;
// Score floors keyed by distinct stock phrases per 1,000 words.
const DENSITY_FLOORS: ReadonlyArray<{ minDensity: number; floor: number }> = [
  { minDensity: 8, floor: 7 },
  { minDensity: 4, floor: 5 }
];

export interface PhraseScanResult {
  phrases: string[];
  densityPerThousandWords: number;
  scoreFloor: number;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\u2018\u2019]/g, '\'').replace(/\s+/g, ' ');
}

function containsPhrase(text: string, phrase: string): boolean {
  const escaped: string = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z])${escaped}`, 'i').test(text);
}

/** True when a passage contains any stock phrase. */
export function containsStockPhrase(passage: string): boolean {
  const text: string = normalize(passage);
  return STOCK_PHRASES.some((phrase: string): boolean => containsPhrase(text, phrase));
}

/** Lists the distinct stock phrases in a submission and the score floor they imply. */
export function scanStockPhrases(submissionText: string): PhraseScanResult {
  const text: string = normalize(submissionText);
  const phrases: string[] = STOCK_PHRASES.filter((phrase: string): boolean => containsPhrase(text, phrase));
  const wordCount: number = Math.max(1, text.split(' ').filter(Boolean).length);
  const densityPerThousandWords: number = Math.round((phrases.length / wordCount) * WORDS_PER_DENSITY_UNIT * 10) / 10;
  const band = DENSITY_FLOORS.find((item): boolean => densityPerThousandWords >= item.minDensity);
  const scoreFloor: number = phrases.length >= MIN_DISTINCT_PHRASES && band ? band.floor : 0;
  return { phrases, densityPerThousandWords, scoreFloor };
}
