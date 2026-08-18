import { Router } from "express";
import { z } from "zod";
import { requireDatabase } from "./db.js";
import { HttpError } from "./errors.js";

const router = Router();
const idSchema = z.string().uuid();
const courseBody = z.object({
  code: z.string().trim().min(1).max(80),
  section: z.string().trim().min(1).max(80),
  title: z.string().trim().max(200).nullable().optional(),
  term: z.string().trim().min(1).max(80),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  canvasCourseId: z.string().trim().max(100).nullable().optional(),
  canvasUrl: z.url().nullable().optional()
}).refine((value) => value.endDate >= value.startDate, {
  message: "End date must be on or after start date", path: ["endDate"]
});
const updateBody = z.object({
  code: z.string().trim().min(1).max(80).optional(),
  section: z.string().trim().min(1).max(80).optional(),
  title: z.string().trim().max(200).nullable().optional(),
  term: z.string().trim().min(1).max(80).optional(),
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
  canvasCourseId: z.string().trim().max(100).nullable().optional(),
  canvasUrl: z.url().nullable().optional()
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

const selectColumns = `id, code, section, title, term,
  start_date::text AS "startDate", end_date::text AS "endDate",
  purge_after::text AS "purgeAfter", canvas_course_id AS "canvasCourseId",
  canvas_url AS "canvasUrl", created_at::text AS "createdAt"`;

router.get("/", async (_request, response) => {
  const database = requireDatabase();
  const result = await database.query(`SELECT ${selectColumns} FROM courses ORDER BY end_date DESC, code, section`);
  response.json({ courses: result.rows });
});

router.get("/:id", async (request, response) => {
  const id = idSchema.parse(request.params.id);
  const database = requireDatabase();
  const result = await database.query(`SELECT ${selectColumns} FROM courses WHERE id = $1`, [id]);
  if (!result.rows[0]) throw new HttpError(404, "Course not found");
  response.json(result.rows[0]);
});

router.post("/", async (request, response) => {
  const body = courseBody.parse(request.body);
  const database = requireDatabase();
  const result = await database.query(`INSERT INTO courses
    (code, section, title, term, start_date, end_date, canvas_course_id, canvas_url)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id, code, section, title, term, start_date::text AS "startDate",
      end_date::text AS "endDate", purge_after::text AS "purgeAfter",
      canvas_course_id AS "canvasCourseId", canvas_url AS "canvasUrl", created_at::text AS "createdAt"`,
  [body.code, body.section, body.title ?? null, body.term, body.startDate, body.endDate,
    body.canvasCourseId ?? null, body.canvasUrl ?? null]);
  response.status(201).json(result.rows[0]);
});

router.patch("/:id", async (request, response) => {
  const id = idSchema.parse(request.params.id);
  const patch = updateBody.parse(request.body);
  const database = requireDatabase();
  const current = await database.query(`SELECT code, section, title, term, start_date::text AS "startDate",
      end_date::text AS "endDate", canvas_course_id AS "canvasCourseId", canvas_url AS "canvasUrl"
    FROM courses WHERE id = $1`, [id]);
  if (!current.rows[0]) throw new HttpError(404, "Course not found");
  const body = courseBody.parse({ ...current.rows[0], ...patch });
  const result = await database.query(`UPDATE courses SET code = $1, section = $2,
      title = $3, term = $4, start_date = $5, end_date = $6, canvas_course_id = $7,
      canvas_url = $8 WHERE id = $9
    RETURNING id, code, section, title, term, start_date::text AS "startDate",
      end_date::text AS "endDate", purge_after::text AS "purgeAfter",
      canvas_course_id AS "canvasCourseId", canvas_url AS "canvasUrl", created_at::text AS "createdAt"`,
  [body.code, body.section, body.title ?? null, body.term, body.startDate, body.endDate,
    body.canvasCourseId ?? null, body.canvasUrl ?? null, id]);
  response.json(result.rows[0]);
});

router.put("/:id", async (request, response) => {
  const id = idSchema.parse(request.params.id);
  const body = courseBody.parse(request.body);
  const database = requireDatabase();
  const result = await database.query(`UPDATE courses SET code = $1, section = $2,
      title = $3, term = $4, start_date = $5, end_date = $6, canvas_course_id = $7,
      canvas_url = $8 WHERE id = $9
    RETURNING id, code, section, title, term, start_date::text AS "startDate",
      end_date::text AS "endDate", purge_after::text AS "purgeAfter",
      canvas_course_id AS "canvasCourseId", canvas_url AS "canvasUrl", created_at::text AS "createdAt"`,
  [body.code, body.section, body.title ?? null, body.term, body.startDate, body.endDate,
    body.canvasCourseId ?? null, body.canvasUrl ?? null, id]);
  if (!result.rows[0]) throw new HttpError(404, "Course not found");
  response.json(result.rows[0]);
});

router.delete("/:id", async (request, response) => {
  const id = idSchema.parse(request.params.id);
  const database = requireDatabase();
  const result = await database.query("DELETE FROM courses WHERE id = $1 RETURNING id", [id]);
  if (!result.rows[0]) throw new HttpError(404, "Course not found");
  response.status(204).end();
});

export const coursesRouter = router;
