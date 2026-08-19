import { Router } from "express";
import { z } from "zod";
import type { GradeCriterionResult } from "../shared/types.js";
import { config } from "./config.js";
import { getDatabase, withTransaction } from "./db.js";
import { HttpError } from "./errors.js";

const criterionSchema = z.object({
  sourceId: z.string().min(1),
  name: z.string().nullable(),
  description: z.string().nullable(),
  maximumPoints: z.number().nonnegative().nullable(),
  ratings: z.array(z.object({
    sourceId: z.string(), label: z.string().nullable(), description: z.string().nullable(), points: z.number().nullable()
  }))
});
const gradingContextSchema = z.object({
  courseId: z.string().uuid(),
  rubricId: z.string().uuid(),
  pseudonym: z.string().trim().min(1).max(120)
});
const requestSchema = z.object({
  rubric: z.object({ criteria: z.array(criterionSchema).min(1), rubricTitle: z.string().nullable().optional() }).passthrough(),
  submissionText: z.string().trim().min(1).max(250_000),
  apaEnabled: z.boolean(),
  context: gradingContextSchema.optional()
});
const suggestionSchema = z.object({
  criterionId: z.string().min(1),
  suggestedRating: z.string().min(1).max(200),
  suggestedPoints: z.number().nonnegative(),
  explanation: z.string().min(1).max(1500),
  evidence: z.array(z.string().max(500)).max(8),
  confidence: z.number().min(0).max(1),
  reviewRequired: z.boolean()
});
const outputSchema = z.object({ results: z.array(suggestionSchema) });
const router = Router();

export async function ollamaStatus(): Promise<{ available: boolean; model: string; modelAvailable: boolean }> {
  try {
    const response = await fetch(`${config.ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return { available: false, model: config.ollamaModel, modelAvailable: false };
    const body = await response.json() as { models?: Array<{ name?: string; model?: string }> };
    const modelAvailable = body.models?.some((item) => item.name === config.ollamaModel || item.model === config.ollamaModel) ?? false;
    return { available: true, model: config.ollamaModel, modelAvailable };
  } catch {
    return { available: false, model: config.ollamaModel, modelAvailable: false };
  }
}

function promptFor(body: z.infer<typeof requestSchema>): string {
  const apaRule = body.apaEnabled
    ? "APA style is enabled; apply APA-related rubric requirements only where the rubric explicitly supports them."
    : "APA style is disabled. You MUST NOT deduct points, lower ratings, criticize, or mention APA formatting/citations for any reason.";
  return `You are a grading assistant. Evaluate only against the supplied rubric. ${apaRule}
Return one result per criterion. Treat displayed rubric rating points as anchor examples, not the only allowed scores. Choose the best-fitting displayed qualitative rating label when labels are available, but award any defensible numeric value from zero through the criterion maximum, including values between rating anchors. Do not force points to equal a displayed anchor. Explain criterion-specific deductions clearly. Use concise Canvas-ready explanations, direct submission evidence, and conservative confidence. Set reviewRequired true for ambiguity or confidence below 0.75.
RUBRIC JSON:\n${JSON.stringify(body.rubric)}\nSUBMISSION TEXT:\n${body.submissionText}`;
}
const ollamaFormat = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          criterionId: { type: "string" }, suggestedRating: { type: "string" },
          suggestedPoints: { type: "number", minimum: 0 }, explanation: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
          confidence: { type: "number", minimum: 0, maximum: 1 }, reviewRequired: { type: "boolean" }
        },
        required: ["criterionId", "suggestedRating", "suggestedPoints", "explanation", "evidence", "confidence", "reviewRequired"],
        additionalProperties: false
      }
    }
  },
  required: ["results"], additionalProperties: false
};

async function persistResults(
  body: z.infer<typeof requestSchema>,
  results: GradeCriterionResult[]
): Promise<{ gradingRunId: string | null; results: Array<GradeCriterionResult & { resultId?: string }> }> {
  if (!body.context) return { gradingRunId: null, results };
  const database = getDatabase();
  if (!database) throw new HttpError(503, "Database is required to save grading results");
  const rubricRows = await database.query(`SELECT r.id, r.assignment_id AS "assignmentId", a.course_id AS "courseId"
    FROM rubrics r JOIN assignments a ON a.id = r.assignment_id WHERE r.id = $1`, [body.context.rubricId]);
  if (!rubricRows.rows[0] || String(rubricRows.rows[0].courseId) !== body.context.courseId) {
    throw new HttpError(400, "Rubric does not belong to the selected course");
  }
  const students = await database.query(`SELECT id FROM students
    WHERE course_id = $1 AND pseudonym = $2`, [body.context.courseId, body.context.pseudonym]);
  if (!students.rows[0]) throw new HttpError(404, "Pseudonym was not found in the selected course");
  return withTransaction(database, async (client) => {
    const runs = await client.query(`INSERT INTO grading_runs
      (course_id, assignment_id, rubric_id, student_id, apa_enabled, model)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [body.context!.courseId, rubricRows.rows[0].assignmentId, body.context!.rubricId,
      students.rows[0].id, body.apaEnabled, config.ollamaModel]);
    const criteria = await client.query(`SELECT id, source_id AS "sourceId" FROM rubric_criteria
      WHERE rubric_id = $1`, [body.context!.rubricId]);
    const criterionIds = new Map(criteria.rows.map((item) => [String(item.sourceId), String(item.id)]));
    const saved: Array<GradeCriterionResult & { resultId?: string }> = [];
    for (const item of results) {
      const criterionId = criterionIds.get(item.criterionId);
      if (!criterionId) throw new HttpError(409, "Stored rubric no longer matches the grading result");
      const inserted = await client.query(`INSERT INTO criterion_results
        (grading_run_id, criterion_id, suggested_rating, suggested_points, explanation, evidence,
          confidence, review_required, approved_rating, approved_points, approved_explanation)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11) RETURNING id`,
      [runs.rows[0].id, criterionId, item.suggestedRating, item.suggestedPoints,
        item.explanation, JSON.stringify(item.evidence), item.confidence, item.reviewRequired,
        item.approvedRating, item.approvedPoints, item.approvedExplanation]);
      saved.push({ ...item, resultId: String(inserted.rows[0].id) });
    }
    return { gradingRunId: String(runs.rows[0].id), results: saved };
  });
}

const approvalSchema = z.object({
  approvedRating: z.string().trim().min(1).max(200),
  approvedPoints: z.number().nonnegative(),
  approvedExplanation: z.string().trim().min(1).max(1500)
});

router.patch("/results/:id", async (request, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const body = approvalSchema.parse(request.body);
  const database = getDatabase();
  if (!database) throw new HttpError(503, "Database is not configured");
  const result = await database.query(`UPDATE criterion_results AS cr SET approved_rating = $1,
      approved_points = $2, approved_explanation = $3
    FROM rubric_criteria AS rc WHERE cr.id = $4 AND rc.id = cr.criterion_id
      AND (rc.maximum_points IS NULL OR $2 <= rc.maximum_points)
    RETURNING cr.id, cr.approved_rating AS "approvedRating",
      cr.approved_points::float8 AS "approvedPoints", cr.approved_explanation AS "approvedExplanation"`,
  [body.approvedRating, body.approvedPoints, body.approvedExplanation, id]);
  if (!result.rows[0]) throw new HttpError(400, "Result was not found or points exceed the criterion maximum");
  response.json(result.rows[0]);
});

router.get("/history", async (request, response) => {
  const query = z.object({ courseId: z.string().uuid(), pseudonym: z.string().trim().min(1).max(120) }).parse(request.query);
  const database = getDatabase();
  if (!database) throw new HttpError(503, "Database is not configured");
  const runs = await database.query(`SELECT gr.id, gr.created_at::text AS "createdAt", gr.apa_enabled AS "apaEnabled",
      gr.model, a.title AS "assignmentName", r.title AS "rubricTitle", r.version
    FROM grading_runs gr JOIN students s ON s.id = gr.student_id
    JOIN assignments a ON a.id = gr.assignment_id JOIN rubrics r ON r.id = gr.rubric_id
    WHERE gr.course_id = $1 AND s.pseudonym = $2
    ORDER BY gr.created_at DESC LIMIT 100`, [query.courseId, query.pseudonym]);
  const history = [];
  for (const run of runs.rows) {
    const results = await database.query(`SELECT rc.name AS "criterionName", cr.approved_rating AS "approvedRating",
        cr.approved_points::float8 AS "approvedPoints", cr.approved_explanation AS "approvedExplanation",
        cr.confidence::float8 AS confidence, cr.review_required AS "reviewRequired"
      FROM criterion_results cr JOIN rubric_criteria rc ON rc.id = cr.criterion_id
      WHERE cr.grading_run_id = $1 ORDER BY rc.position`, [run.id]);
    history.push({ ...run, results: results.rows });
  }
  response.json({ history });
});

router.post("/", async (request, response) => {
  const body = requestSchema.parse(request.body);
  let ollamaResponse: Response;
  try {
    ollamaResponse = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.ollamaModel,
        stream: false,
        format: ollamaFormat,
        messages: [
          { role: "system", content: "Return valid JSON only. Never infer criteria not present in the rubric." },
          { role: "user", content: promptFor(body) }
        ],
        options: { temperature: 0.1 }
      }),
      signal: AbortSignal.timeout(config.ollamaTimeoutMs)
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new HttpError(504, `Local grading timed out after ${Math.ceil(config.ollamaTimeoutMs / 1000)} seconds. Warm the Ollama model and try again.`);
    }
    throw new HttpError(503, "Local Ollama service is unavailable");
  }
  if (!ollamaResponse.ok) throw new HttpError(502, "Local Ollama grading request failed");
  let envelope: { message?: { content?: string }; response?: string };
  try {
    envelope = await ollamaResponse.json() as { message?: { content?: string }; response?: string };
  } catch (error) {
    throw error;
  }
  const content = envelope.message?.content ?? envelope.response;
  if (!content) throw new HttpError(502, "Local Ollama returned no grading data");
  let decoded: unknown;
  try { decoded = JSON.parse(content); } catch { throw new HttpError(502, "Local Ollama returned invalid JSON"); }
  const suggestions = outputSchema.parse(decoded).results;
  const expected = new Map(body.rubric.criteria.map((item) => [item.sourceId, item]));
  const received = new Set<string>();
  for (const item of suggestions) {
    const criterion = expected.get(item.criterionId);
    if (!criterion || received.has(item.criterionId)) throw new HttpError(502, "Local Ollama returned invalid criterion coverage");
    if (criterion.maximumPoints !== null && item.suggestedPoints > criterion.maximumPoints) {
      throw new HttpError(502, "Local Ollama awarded points above a criterion maximum");
    }
    received.add(item.criterionId);
  }
  if (received.size !== expected.size) throw new HttpError(502, "Local Ollama omitted rubric criteria");
  const results: GradeCriterionResult[] = suggestions.map((item) => ({
    ...item,
    approvedRating: item.suggestedRating,
    approvedPoints: item.suggestedPoints,
    approvedExplanation: item.explanation
  }));
  const persisted = await persistResults(body, results);
  response.set("Cache-Control", "no-store").json({
    model: config.ollamaModel,
    apaEnabled: body.apaEnabled,
    gradingRunId: persisted.gradingRunId,
    results: persisted.results
  });
});

export const gradingRouter = router;
