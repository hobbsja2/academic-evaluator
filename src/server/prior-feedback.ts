import type { GradingBackend } from "../shared/types.js";
import { config } from "./config.js";
import { getDatabase } from "./db.js";
import { writeStructuredLog } from "./logger.js";

export interface PriorFeedbackBlock {
  text: string;
  runCount: number;
  truncated: boolean;
}

export interface PriorFeedbackInput {
  courseId: string;
  pseudonym: string;
  backend: GradingBackend;
  /** The assignment being graded now, excluded so a run never sees its own feedback. */
  excludeAssignmentId: string | null;
}

type PriorRun = {
  id: string;
  createdAt: string;
  assignmentTitle: string | null;
};

type PriorCriterion = {
  runId: string;
  criterionName: string | null;
  approvedRating: string;
  approvedPoints: number;
  approvedExplanation: string;
};

// Explanation cap for every run after the newest one. The newest run's cap is
// derived from the remaining budget instead, so it always fits.
const OLDER_RUN_EXPLANATION_CHARS = 400;
const MINIMUM_EXPLANATION_CHARS = 80;

function budgetFor(backend: GradingBackend): number {
  return backend === "claude"
    ? config.priorFeedbackMaxChars * config.priorFeedbackClaudeFactor
    : config.priorFeedbackMaxChars;
}

function formatRun(run: PriorRun, criteria: PriorCriterion[], perCriterionChars: number): string {
  const header = `Assignment "${run.assignmentTitle ?? "Untitled assignment"}" (graded ${run.createdAt.slice(0, 10)}):`;
  const lines = criteria.map((criterion) => {
    const name = criterion.criterionName ?? "Unnamed criterion";
    const explanation = criterion.approvedExplanation.trim().slice(0, perCriterionChars);
    return `- ${name}: ${criterion.approvedRating} (${criterion.approvedPoints} pts) — ${explanation}`;
  });
  return [header, ...lines].join("\n");
}

async function fetchRuns(
  courseId: string,
  pseudonym: string,
  excludeAssignmentId: string | null
): Promise<PriorRun[]> {
  const database = getDatabase();
  if (!database) return [];
  const runs = await database.query(`SELECT gr.id, gr.created_at::text AS "createdAt",
      a.title AS "assignmentTitle"
    FROM grading_runs gr JOIN students s ON s.id = gr.student_id
    JOIN assignments a ON a.id = gr.assignment_id
    WHERE gr.course_id = $1 AND s.pseudonym = $2 AND ($4::uuid IS NULL OR gr.assignment_id <> $4)
    ORDER BY gr.created_at DESC LIMIT $3`,
  [courseId, pseudonym, config.priorFeedbackRunLimit, excludeAssignmentId]);
  return runs.rows as PriorRun[];
}

async function fetchCriteria(runIds: string[]): Promise<Map<string, PriorCriterion[]>> {
  const database = getDatabase();
  const grouped = new Map<string, PriorCriterion[]>();
  if (!database) return grouped;
  const rows = await database.query(`SELECT cr.grading_run_id AS "runId", rc.name AS "criterionName",
      cr.approved_rating AS "approvedRating", cr.approved_points::float8 AS "approvedPoints",
      cr.approved_explanation AS "approvedExplanation"
    FROM criterion_results cr JOIN rubric_criteria rc ON rc.id = cr.criterion_id
    WHERE cr.grading_run_id = ANY($1::uuid[]) ORDER BY rc.position`, [runIds]);
  for (const row of rows.rows as PriorCriterion[]) {
    const existing = grouped.get(row.runId);
    if (existing) existing.push(row);
    else grouped.set(row.runId, [row]);
  }
  return grouped;
}

/**
 * Assembles the prompt block newest run first. The newest run is always included,
 * with its explanations capped so it fits the budget by construction; older runs
 * are all-or-nothing and the first overflow stops assembly.
 */
function assemble(runs: PriorRun[], criteriaByRun: Map<string, PriorCriterion[]>, budget: number): PriorFeedbackBlock {
  const sections: string[] = [];
  let used = 0;
  let truncated = false;
  let runCount = 0;
  for (const run of runs) {
    const criteria = criteriaByRun.get(run.id) ?? [];
    if (!criteria.length) continue;
    const isNewest = sections.length === 0;
    const perCriterionChars = isNewest
      ? Math.max(MINIMUM_EXPLANATION_CHARS, Math.floor(budget / Math.max(1, criteria.length)))
      : OLDER_RUN_EXPLANATION_CHARS;
    const section = formatRun(run, criteria, perCriterionChars);
    if (!isNewest && used + section.length > budget) {
      truncated = true;
      break;
    }
    sections.push(section);
    used += section.length;
    runCount += 1;
  }
  return { text: sections.join("\n\n").trim(), runCount, truncated };
}

/**
 * Loads the grader's own previously saved feedback for this student on the
 * course's *other* assignments. Returns null whenever there is nothing to inject,
 * including when the budget is zero, the database is absent, or a query fails —
 * grading must never fail because prior feedback is unavailable.
 */
export async function loadPriorFeedback(input: PriorFeedbackInput): Promise<PriorFeedbackBlock | null> {
  const budget = budgetFor(input.backend);
  if (budget <= 0) return null;
  if (!getDatabase()) return null;
  try {
    const runs = await fetchRuns(input.courseId, input.pseudonym, input.excludeAssignmentId);
    if (!runs.length) return null;
    const criteriaByRun = await fetchCriteria(runs.map((run) => run.id));
    const block = assemble(runs, criteriaByRun, budget);
    if (!block.text || !block.runCount) return null;
    return block;
  } catch (error) {
    writeStructuredLog("info", "prior_feedback_unavailable", {
      pseudonym: input.pseudonym,
      errorType: error instanceof Error ? error.name : "UnknownError"
    });
    return null;
  }
}
