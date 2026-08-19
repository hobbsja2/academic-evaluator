import { Router } from "express";
import { z } from "zod";
import { assignment13FixtureMetadata, assignment13Rubric } from "../fixtures/assignment-1-3-rubric.js";
import type { NormalizedRubric } from "../shared/types.js";
import { getDatabase, withTransaction } from "./db.js";
import { HttpError } from "./errors.js";

const MAX_ASSIGNMENT_DIRECTIONS_LENGTH = 50_000;
const PENDING_DIRECTIONS_TTL_MS = 30 * 60 * 1000;
const ratingSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  name: z.string().nullable(),
  description: z.string().nullable(),
  points: z.number().finite().nullable()
});
const criterionSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  name: z.string().nullable(),
  description: z.string().nullable(),
  maximumPoints: z.number().finite().nonnegative().nullable(),
  ratings: z.array(ratingSchema)
});
const directionsSchema = z.string().max(MAX_ASSIGNMENT_DIRECTIONS_LENGTH).nullable();
const importSchema = z.object({
  courseId: z.union([z.string(), z.number()]).transform(String).nullable(),
  courseName: z.string().nullable(),
  assignmentId: z.union([z.string(), z.number()]).transform(String).nullable(),
  assignmentName: z.string().nullable(),
  assignmentDirections: directionsSchema.optional(),
  rubricTitle: z.string().nullable(),
  criteria: z.array(criterionSchema).min(1),
  totalPoints: z.number().finite().nonnegative().nullable(),
  sourceUrl: z.url().nullable().optional(),
  capturedAt: z.iso.datetime().optional()
});
const updateDirectionsSchema = z.object({ assignmentDirections: directionsSchema });
const directionsImportSchema = z.object({
  courseId: z.union([z.string(), z.number()]).transform(String),
  courseName: z.string().nullable().optional(),
  assignmentId: z.union([z.string(), z.number()]).transform(String),
  assignmentName: z.string().nullable().optional(),
  assignmentDirections: z.string().trim().min(1).max(MAX_ASSIGNMENT_DIRECTIONS_LENGTH),
  sourceUrl: z.url().nullable().optional(),
  capturedAt: z.iso.datetime().optional()
});

const router = Router();
const latest = new Map<string, NormalizedRubric>();
const pendingDirections = new Map<string, { directions: string; expiresAt: number }>();

function normalizedDirections(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function normalize(input: z.infer<typeof importSchema>): NormalizedRubric {
  const criteria = input.criteria.map((criterion) => ({
    sourceId: criterion.id,
    name: criterion.name?.trim() || null,
    description: criterion.description?.trim() || null,
    maximumPoints: criterion.maximumPoints,
    ratings: criterion.ratings.map((rating) => ({
      sourceId: rating.id,
      label: rating.name?.trim() || null,
      description: rating.description?.trim() || null,
      points: rating.points
    }))
  }));
  return {
    courseId: input.courseId,
    courseName: input.courseName?.trim() || null,
    assignmentId: input.assignmentId,
    assignmentName: input.assignmentName?.trim() || null,
    assignmentDirections: normalizedDirections(input.assignmentDirections),
    rubricTitle: input.rubricTitle?.trim() || null,
    totalPoints: input.totalPoints ?? (criteria.every((item) => item.maximumPoints !== null)
      ? criteria.reduce((sum, item) => sum + (item.maximumPoints ?? 0), 0) : null),
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    sourceUrl: input.sourceUrl ?? null,
    criteria,
    source: "extension"
  };
}

function memoryKey(rubric: NormalizedRubric): string {
  return `${rubric.courseId ?? rubric.courseName ?? "unknown"}\0${rubric.assignmentId ?? rubric.assignmentName ?? "unknown"}`;
}

function pendingDirectionsKey(value: { courseId: string | null; assignmentId: string | null }): string | null {
  return value.courseId && value.assignmentId ? `${value.courseId}\0${value.assignmentId}` : null;
}

async function persistRubric(rubric: NormalizedRubric): Promise<{ persisted: boolean; rubricId?: string; version?: number }> {
  try {
  const database = getDatabase();
  if (!database || !rubric.assignmentName) return { persisted: false };
  const uuid = z.string().uuid().safeParse(rubric.courseId);
  const courses = uuid.success
    ? (await database.query("SELECT id FROM courses WHERE id = $1", [uuid.data])).rows
    : rubric.courseId
      ? (await database.query("SELECT id FROM courses WHERE canvas_course_id = $1 LIMIT 2", [rubric.courseId])).rows
      : rubric.courseName
        ? (await database.query("SELECT id FROM courses WHERE code = $1 OR title = $1 LIMIT 2", [rubric.courseName])).rows
        : [];
  if (courses.length !== 1) return { persisted: false };
  return withTransaction(database, async (client) => {
    const assignments = await client.query(`INSERT INTO assignments (course_id, canvas_assignment_id, title)
      VALUES ($1, $2, $3)
      ON CONFLICT (course_id, title) DO UPDATE SET
        canvas_assignment_id = COALESCE(EXCLUDED.canvas_assignment_id, assignments.canvas_assignment_id),
        title = EXCLUDED.title RETURNING id`, [courses[0].id, rubric.assignmentId, rubric.assignmentName]);
    const versions = await client.query(`SELECT COALESCE(MAX(version), 0)::int + 1 AS version
      FROM rubrics WHERE assignment_id = $1`, [assignments.rows[0].id]);
    const version = Number(versions.rows[0].version);
    const inserted = await client.query(`INSERT INTO rubrics
      (assignment_id, title, version, total_points, assignment_directions, source, source_url, captured_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [assignments.rows[0].id, rubric.rubricTitle, version, rubric.totalPoints,
      rubric.assignmentDirections, rubric.source, rubric.sourceUrl, rubric.capturedAt]);
    for (const [criterionPosition, criterion] of rubric.criteria.entries()) {
      const criterionRows = await client.query(`INSERT INTO rubric_criteria
        (rubric_id, source_id, name, description, maximum_points, position)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [inserted.rows[0].id, criterion.sourceId, criterion.name, criterion.description,
        criterion.maximumPoints, criterionPosition]);
      for (const [ratingPosition, rating] of criterion.ratings.entries()) {
        await client.query(`INSERT INTO rubric_ratings
          (criterion_id, source_id, label, description, points, position)
          VALUES ($1, $2, $3, $4, $5, $6)`,
        [criterionRows.rows[0].id, rating.sourceId, rating.label, rating.description,
          rating.points, ratingPosition]);
      }
    }
    return { persisted: true, rubricId: String(inserted.rows[0].id), version };
  });
  } catch (error) {
    throw error;
  }
}

router.post("/directions/import", (request, response) => {
  const body = directionsImportSchema.parse(request.body);
  const key = pendingDirectionsKey({ courseId: body.courseId, assignmentId: body.assignmentId });
  if (!key) throw new HttpError(400, "Canvas course and assignment IDs are required");
  pendingDirections.set(key, {
    directions: body.assignmentDirections,
    expiresAt: Date.now() + PENDING_DIRECTIONS_TTL_MS
  });
  response.status(201).json({ staged: true, expiresInMinutes: 30 });
});

router.post("/import", async (request, response) => {
  try {
    const parsed = importSchema.parse(request.body);
    const key = pendingDirectionsKey(parsed);
    const pending = key ? pendingDirections.get(key) : undefined;
    if (key && pending && pending.expiresAt <= Date.now()) pendingDirections.delete(key);
    const stagedDirections = pending && pending.expiresAt > Date.now() ? pending.directions : undefined;
    const assignmentDirections = normalizedDirections(parsed.assignmentDirections) ?? stagedDirections ?? null;
    const rubric = normalize({ ...parsed, assignmentDirections });
    latest.set(memoryKey(rubric), rubric);
    const persistence = await persistRubric(rubric);
    if (key) pendingDirections.delete(key);
    response.status(201).json({ rubric, directionsMerged: Boolean(stagedDirections), ...persistence });
  } catch (error) {
    throw error;
  }
});

router.get("/fixture/assignment-1-3", (_request, response) => {
  response.json({ rubric: assignment13Rubric, metadata: assignment13FixtureMetadata });
});

router.patch("/:id/directions", async (request, response) => {
  try {
    const rubricId = z.string().uuid().parse(request.params.id);
    const body = updateDirectionsSchema.parse(request.body);
    const database = getDatabase();
    if (!database) throw new HttpError(503, "Database is not configured");
    const assignmentDirections = normalizedDirections(body.assignmentDirections);
    const updated = await database.query(`UPDATE rubrics SET assignment_directions = $1
      WHERE id = $2 RETURNING id, assignment_directions AS "assignmentDirections"`,
    [assignmentDirections, rubricId]);
    if (!updated.rows[0]) throw new HttpError(404, "Rubric was not found");
    response.json(updated.rows[0]);
  } catch (error) {
    throw error;
  }
});

router.get("/", async (_request, response) => {
  try {
  const database = getDatabase();
  const memory = [...latest.values()];
  if (!database) return response.json({ memory, persisted: [] });
  const rubrics = await database.query(`SELECT r.id, r.title AS "rubricTitle", r.version,
      r.total_points::float8 AS "totalPoints", r.assignment_directions AS "assignmentDirections",
      r.source, r.source_url AS "sourceUrl", r.captured_at::text AS "capturedAt",
      a.id AS "assignmentId", a.title AS "assignmentName", c.id AS "courseId",
      c.code AS "courseName"
    FROM rubrics r JOIN assignments a ON a.id = r.assignment_id
    JOIN courses c ON c.id = a.course_id ORDER BY r.created_at DESC`);
  const persisted = [];
  for (const row of rubrics.rows) {
    const criteria = await database.query(`SELECT id, source_id AS "sourceId", name, description,
        maximum_points::float8 AS "maximumPoints" FROM rubric_criteria
      WHERE rubric_id = $1 ORDER BY position`, [row.id]);
    const normalizedCriteria = [];
    for (const criterion of criteria.rows) {
      const ratings = await database.query(`SELECT source_id AS "sourceId", label, description, points::float8 AS points
        FROM rubric_ratings WHERE criterion_id = $1 ORDER BY position`, [criterion.id]);
      normalizedCriteria.push({ ...criterion, id: undefined, ratings: ratings.rows });
    }
    persisted.push({ ...row, criteria: normalizedCriteria });
  }
  response.json({ memory, persisted });
  } catch (error) {
    throw error;
  }
});

export const rubricsRouter = router;