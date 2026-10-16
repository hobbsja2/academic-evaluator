export interface Course {
  id: string;
  code: string;
  section: string;
  title: string | null;
  term: string;
  startDate: string;
  endDate: string;
  purgeAfter: string;
  canvasCourseId: string | null;
  canvasUrl: string | null;
  gradingPolicy: string | null;
  createdAt: string;
}

export interface NormalizedRating {
  sourceId: string;
  label: string | null;
  description: string | null;
  points: number | null;
}

export interface NormalizedCriterion {
  sourceId: string;
  name: string | null;
  description: string | null;
  maximumPoints: number | null;
  ratings: NormalizedRating[];
}

export interface NormalizedRubric {
  courseId: string | null;
  courseName: string | null;
  assignmentId: string | null;
  assignmentName: string | null;
  assignmentDirections: string | null;
  rubricTitle: string | null;
  totalPoints: number | null;
  capturedAt: string;
  sourceUrl: string | null;
  criteria: NormalizedCriterion[];
  source: "extension" | "fixture";
}

export type AttachmentRole = "template" | "instructions" | "reference";

export interface AssignmentAttachment {
  id: string;
  assignmentId: string;
  fileName: string;
  role: AttachmentRole;
  includeInGrading: boolean;
  requirements: string | null;
  extractedCharacters: number;
  updatedAt: string;
}

export interface DiscussionTimeliness {
  timeZone: string;
  dueAt: string | null;
  onTimeDeadline: string | null;
  initialPostAt: string | null;
  initialOnTime: boolean | null;
  replyDates: Array<string | null>;
  repliesDistributed: boolean | null;
}

export interface StagedDiscussionSubmission {
  assignmentName: string | null;
  assignmentDirections: string | null;
  capturedAt: string;
  expiresAt: string;
  initialPostCount: number;
  replyCount: number;
  characters: number;
  timeliness: DiscussionTimeliness;
  text: string;
}

export interface AttachmentFinding {
  requirement: string;
  satisfied: boolean;
  note: string;
}

/**
 * Advisory estimate of how much AI generation shaped a submission. 0 means more
 * likely than not written solely by a human; 10 means heavy AI use throughout.
 * It never changes criterion points.
 */
export interface AiUseAssessment {
  score: number;
  aiIndicators: AiUseIndicator[];
  humanIndicators: AiUseIndicator[];
  summary: string;
  /** Indicators dropped because their quote was not found in the submission. */
  unverifiedCount: number;
  /** True when the score was lowered because no AI indicator could be verified. */
  scoreCapped: boolean;
  /** Stock chatbot phrases found by the server's deterministic scan. */
  stockPhrases: string[];
  /** Distinct stock phrases per 1,000 words. */
  phraseDensity: number;
  /** True when the phrase density raised the model's score to a minimum. */
  phraseFloorApplied: boolean;
}

/** One observation, anchored to a verbatim quote from the submission. */
export interface AiUseIndicator {
  quote: string;
  observation: string;
}

export interface AttachmentSnapshot {
  fileName: string;
  role: AttachmentRole;
  requirements: string;
}

export interface InstructorProfile {
  courseId: string;
  resumeText: string | null;
  courseIntroduction: string | null;
  updatedAt: string | null;
}

export interface AnnouncementDraft {
  model: string;
  announcement: string;
}

/**
 * One imported roster row. `name` is the student's real name and is used for
 * display and selection only; every request body and saved run carries the
 * course-scoped `pseudonym` instead.
 */
export interface RosterStudent {
  id: string;
  pseudonym: string;
  name: string | null;
}

export type GradingBackend = "ollama" | "claude";

export interface GradeCriterionResult {
  resultId?: string;
  criterionId: string;
  suggestedRating: string;
  suggestedPoints: number;
  explanation: string;
  evidence: string[];
  confidence: number;
  reviewRequired: boolean;
  approvedRating: string;
  approvedPoints: number;
  approvedExplanation: string;
}
