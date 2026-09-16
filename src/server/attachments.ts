import { Router } from "express";
import { z } from "zod";
import type { AssignmentAttachment, AttachmentSnapshot } from "../shared/types.js";
import { requireDatabase } from "./db.js";
import { HttpError } from "./errors.js";

const MAX_FILE_NAME_LENGTH = 260;
const MAX_EXTRACTED_TEXT_LENGTH = 200_000;
const MAX_REQUIREMENTS_LENGTH = 4_000;

// Per-attachment ceiling on what reaches the grading prompt. Grading runs with
// num_ctx 8192 (~32k characters for rubric, directions, submission and output
// combined), so attachment text has to stay small or it crowds out the submission.
const MAX_SNAPSHOT_LENGTH = 2_000;

const router = Router();
const idSchema = z.string().uuid();
const roleSchema = z.enum(["template", "instructions", "reference"]);

const listQuerySchema = z.object({ assignmentId: idSchema });
const createSchema = z.object({
  assignmentId: idSchema,
  fileName: z.string().trim().min(1).max(MAX_FILE_NAME_LENGTH),
  role: roleSchema,
  extractedText: z.string().trim().min(1).max(MAX_EXTRACTED_TEXT_LENGTH),
  requirements: z.string().trim().max(MAX_REQUIREMENTS_LENGTH).nullable().optional(),
  includeInGrading: z.boolean().optional()
});
const updateSchema = z.object({
  role: roleSchema.optional(),
  includeInGrading: z.boolean().optional(),
  requirements: z.string().trim().max(MAX_REQUIREMENTS_LENGTH).nullable().optional()
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

const selectColumns = `id, assignment_id AS "assignmentId", file_name AS "fileName", role,
  include_in_grading AS "includeInGrading", requirements,
  char_length(extracted_text) AS "extractedCharacters", updated_at::text AS "updatedAt"`;

/**
 * Loads the attachment text that should influence a grading run, bounded per
 * attachment. Falls back to an excerpt of the extracted document when the
 * professor has not distilled a requirements list yet.
 */
export async function loadAttachmentSnapshots(assignmentId: string): Promise<AttachmentSnapshot[]> {
  const database = requireDatabase();
  let result;
  try {
    result = await database.query(`SELECT file_name AS "fileName", role, requirements,
        extracted_text AS "extractedText"
      FROM assignment_attachments
      WHERE assignment_id = $1 AND include_in_grading = true
      ORDER BY role, file_name`, [assignmentId]);
  } catch (error) {
    throw error;
  }
  const snapshots: AttachmentSnapshot[] = [];
  for (const row of result.rows) {
    const source = String(row.requirements ?? "").trim() || String(row.extractedText ?? "").trim();
    if (!source) continue;
    snapshots.push({
      fileName: String(row.fileName),
      role: row.role as AttachmentSnapshot["role"],
      requirements: source.slice(0, MAX_SNAPSHOT_LENGTH)
    });
  }
  return snapshots;
}

router.get("/", async (request, response) => {
  try {
    const { assignmentId } = listQuerySchema.parse(request.query);
    const database = requireDatabase();
    const result = await database.query(`SELECT ${selectColumns} FROM assignment_attachments
      WHERE assignment_id = $1 ORDER BY role, file_name`, [assignmentId]);
    response.set("Cache-Control", "no-store").json({ attachments: result.rows as AssignmentAttachment[] });
  } catch (error) {
    throw error;
  }
});

router.post("/", async (request, response) => {
  try {
  const body = createSchema.parse(request.body);
  const database = requireDatabase();
  const assignment = await database.query("SELECT id FROM assignments WHERE id = $1", [body.assignmentId]);
  if (!assignment.rows[0]) throw new HttpError(404, "Assignment was not found");
  // Reference material is background reading, so it stays out of grading unless
  // the professor opts in explicitly.
  const includeInGrading = body.includeInGrading ?? body.role !== "reference";
  const result = await database.query(`INSERT INTO assignment_attachments
      (assignment_id, file_name, role, include_in_grading, extracted_text, requirements)
      VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (assignment_id, file_name) DO UPDATE SET role = EXCLUDED.role,
      include_in_grading = EXCLUDED.include_in_grading,
      extracted_text = EXCLUDED.extracted_text,
      requirements = EXCLUDED.requirements, updated_at = now()
    RETURNING ${selectColumns}`,
  [body.assignmentId, body.fileName, body.role, includeInGrading,
    body.extractedText, body.requirements?.trim() || null]);
  response.status(201).json({ attachment: result.rows[0] as AssignmentAttachment });
  } catch (error) {
    throw error;
  }
});

router.patch("/:id", async (request, response) => {
  try {
  const id = idSchema.parse(request.params.id);
  const patch = updateSchema.parse(request.body);
  const database = requireDatabase();
  const result = await database.query(`UPDATE assignment_attachments SET
      role = COALESCE($1::text, role),
      include_in_grading = COALESCE($2::boolean, include_in_grading),
      requirements = CASE WHEN $3::boolean THEN $4::text ELSE requirements END,
      updated_at = now()
    WHERE id = $5 RETURNING ${selectColumns}`,
  [patch.role ?? null, patch.includeInGrading ?? null,
    Object.prototype.hasOwnProperty.call(patch, "requirements"),
    patch.requirements?.trim() || null, id]);
  if (!result.rows[0]) throw new HttpError(404, "Attachment was not found");
  response.json({ attachment: result.rows[0] as AssignmentAttachment });
  } catch (error) {
    throw error;
  }
});

router.delete("/:id", async (request, response) => {
  try {
    const id = idSchema.parse(request.params.id);
    const database = requireDatabase();
    const result = await database.query("DELETE FROM assignment_attachments WHERE id = $1 RETURNING id", [id]);
    if (!result.rows[0]) throw new HttpError(404, "Attachment was not found");
    response.status(204).end();
  } catch (error) {
    throw error;
  }
});

export const attachmentsRouter = router;
