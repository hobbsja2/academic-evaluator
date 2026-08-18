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
  rubricTitle: string | null;
  totalPoints: number | null;
  capturedAt: string;
  sourceUrl: string | null;
  criteria: NormalizedCriterion[];
  source: "extension" | "fixture";
}

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
