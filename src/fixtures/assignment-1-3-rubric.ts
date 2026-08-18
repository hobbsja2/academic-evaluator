import type { NormalizedRubric } from "../shared/types.js";

const labels = ["Excellent A", "Above Average B", "Average C", "Near Failing D", "Failing F"];
const definitions = [
  { name: "Identification and Analysis of the Main Issues/Problem", maximumPoints: 45, points: [45, 40, 35, 31, 26] },
  { name: "Organization and Coherence", maximumPoints: 20, points: [20, 18, 16, 14, 12] },
  { name: "Links to Course Readings and Additional Research", maximumPoints: 20, points: [20, 18, 16, 14, 12] },
  { name: "Style, Mechanics, and Format", maximumPoints: 15, points: [15, 12, 10, 8, 6] }
] as const;

export const assignment13Rubric: NormalizedRubric = {
  courseId: null,
  courseName: "MGMT 436",
  assignmentId: "assignment-1-3",
  assignmentName: "1.3 Assignment",
  rubricTitle: "1.3 Assignment Rubric",
  totalPoints: 100,
  capturedAt: "2026-01-01T00:00:00.000Z",
  sourceUrl: null,
  source: "fixture",
  criteria: definitions.map((criterion, criterionIndex) => ({
    sourceId: `criterion-${criterionIndex + 1}`,
    name: criterion.name,
    description: null,
    maximumPoints: criterion.maximumPoints,
    ratings: labels.map((label, ratingIndex) => ({
      sourceId: `criterion-${criterionIndex + 1}-rating-${ratingIndex + 1}`,
      label,
      description: null,
      points: criterion.points[ratingIndex]
    }))
  }))
};

export const assignment13FixtureMetadata = {
  descriptionSource: "Descriptor text was not available in the transferred screenshot context; recapture from Canvas before official use.",
  ratingSource: "Rating labels and points transcribed from the provided rubric screenshot."
} as const;
