import { createHmac } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { RosterStudent } from "../shared/types.js";
import { config } from "./config.js";
import { requireDatabase, withTransaction } from "./db.js";
import { HttpError } from "./errors.js";
import { writeStructuredLog } from "./logger.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const stablePriority = ["id", "canvas user id", "sis id", "sis user id", "login id", "sis login id"];
const identityLabelPriority = ["name", "sortable name", "login id", "sis id"];
const MAX_STUDENT_NAME_CHARS = 200;
const MAX_ROSTER_ROWS = 500;
const MAX_REPORTED_HEADERS = 12;
const MAX_REPORTED_HEADER_CHARS = 40;
const courseIdSchema = z.object({ courseId: z.string().uuid() });

type ParsedRoster = {
  headers: string[];
  normalized: string[];
  rows: string[][];
  stableIndex: number;
  stableHeader: string;
};

function normalizedHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

/**
 * Renders the header row for a 400 message so a rejected CSV tells the user what
 * their file actually contains. Column headers are not student data, but the list
 * is bounded in both length and count so a malformed file cannot pad the response.
 */
function describeHeaders(headers: string[]): string {
  const shown = headers.slice(0, MAX_REPORTED_HEADERS).map((header) => header.slice(0, MAX_REPORTED_HEADER_CHARS));
  const suffix = headers.length > MAX_REPORTED_HEADERS ? `, … (${headers.length} columns total)` : "";
  return `${shown.join(", ")}${suffix}`;
}

function readCsv(buffer: Buffer): ParsedRoster {
  const records = parse(buffer, { bom: true, relax_column_count: true, skip_empty_lines: true }) as string[][];
  if (records.length < 2) throw new HttpError(400, "CSV must contain a header and at least one data row");
  const headers = records[0].map((value) => String(value ?? "").trim());
  const normalized = headers.map(normalizedHeader);
  let stableIndex = -1;
  for (const candidate of stablePriority) {
    stableIndex = normalized.indexOf(candidate);
    if (stableIndex >= 0) break;
  }
  if (stableIndex < 0) {
    throw new HttpError(400, `CSV needs one stable ID column: ${stablePriority.join(", ")}. `
      + `Found: ${describeHeaders(headers)}`);
  }
  const roleIndex = normalized.indexOf("role");
  const allRows = records.slice(1).map((row) => row.map((value) => String(value ?? "")));
  const rows = roleIndex < 0
    ? allRows
    : allRows.filter((row) => normalizedHeader(row[roleIndex] ?? "").includes("student"));
  if (!rows.length) throw new HttpError(400, "CSV contains no student rows");
  return { headers, normalized, rows, stableIndex, stableHeader: headers[stableIndex] };
}

function base32ish(buffer: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < 8) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (output.length === 8) break;
  }
  return output;
}

/**
 * Derives a stable, course-scoped pseudonym. Keyed on the course UUID rather than
 * its code and section, so renaming a course never changes an existing pseudonym.
 */
function pseudonym(key: string, courseId: string, stableId: string): string {
  const coursePart = base32ish(createHmac("sha256", key).update(courseId).digest());
  const studentPart = base32ish(createHmac("sha256", key).update(`${courseId}\0${stableId}`).digest());
  return `C${coursePart}-S${studentPart}`;
}

function resolveNameIndex(parsed: ParsedRoster): number {
  for (const candidate of identityLabelPriority) {
    const index = parsed.normalized.indexOf(candidate);
    if (index >= 0) return index;
  }
  throw new HttpError(400, `CSV needs one student name column: ${identityLabelPriority.join(", ")}. `
    + `Found: ${describeHeaders(parsed.headers)}`);
}

/**
 * Maps parsed rows to pseudonym/name pairs. Row values are never logged, because
 * a log line could otherwise carry a name fragment. Repeated stable IDs collapse
 * to one entry (last row wins) so a duplicated roster row cannot make the upsert
 * touch the same conflict key twice.
 */
function collectStudents(parsed: ParsedRoster, key: string, courseId: string): Array<{ pseudonym: string; name: string }> {
  const nameIndex = resolveNameIndex(parsed);
  const byPseudonym = new Map<string, { pseudonym: string; name: string }>();
  parsed.rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const stableId = (row[parsed.stableIndex] ?? "").trim();
    if (!stableId) {
      throw new HttpError(400, `Row ${rowNumber} has no value in ${parsed.stableHeader}. `
        + `Columns found: ${describeHeaders(parsed.headers)}`);
    }
    const name = (row[nameIndex] ?? "").trim();
    if (!name) throw new HttpError(400, `Row ${rowNumber} has no student name`);
    if (name.length > MAX_STUDENT_NAME_CHARS) {
      throw new HttpError(400, `Row ${rowNumber} has a student name longer than ${MAX_STUDENT_NAME_CHARS} characters`);
    }
    const generated = pseudonym(key, courseId, stableId);
    byPseudonym.set(generated, { pseudonym: generated, name });
  });
  return [...byPseudonym.values()];
}

// RETURNING order is undefined, so the import response is sorted the same way the
// list route is, keeping the dropdown order stable across both.
function sortByLabel(students: RosterStudent[]): RosterStudent[] {
  return [...students].sort((a, b) => (a.name ?? a.pseudonym).localeCompare(b.name ?? b.pseudonym));
}

router.post("/validate", upload.single("file"), (request, response) => {
  if (!request.file) throw new HttpError(400, "A multipart CSV file field named file is required");
  const parsed = readCsv(request.file.buffer);
  response.json({
    valid: true,
    rowCount: parsed.rows.length,
    columnCount: parsed.headers.length,
    headers: parsed.headers,
    stableIdHeader: parsed.stableHeader
  });
});

async function persistRoster(courseId: string, csv: Buffer): Promise<RosterStudent[]> {
  const database = requireDatabase();
  const key = config.studentIdentityKey;
  if (!key) throw new HttpError(503, "STUDENT_IDENTITY_KEY is required to import a roster");
  const parsed = readCsv(csv);
  if (parsed.rows.length > MAX_ROSTER_ROWS) {
    throw new HttpError(400, `Roster has more than ${MAX_ROSTER_ROWS} student rows`);
  }
  const collected = collectStudents(parsed, key, courseId);
  const course = await database.query("SELECT id FROM courses WHERE id = $1", [courseId]);
  if (!course.rows[0]) throw new HttpError(404, "Course not found");
  const paramGroups: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (const student of collected) {
    paramGroups.push(`($${p}, $${p + 1}, $${p + 2})`);
    params.push(courseId, student.pseudonym, student.name);
    p += 3;
  }
  return withTransaction(database, async (client) => {
    const inserted = await client.query(
      `INSERT INTO students (course_id, pseudonym, display_name) VALUES ${paramGroups.join(", ")}
        ON CONFLICT (course_id, pseudonym)
        DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
        RETURNING id, pseudonym, display_name AS "name"`,
      params
    );
    return inserted.rows as RosterStudent[];
  });
}

// Audit trail for a write of identifiable data. Both outcomes are logged because
// a rejection is otherwise invisible: safeErrorHandler only records 5xx, so a 400
// used to leave no server-side trace at all. Counts and status only, never a name.
router.post("/import", upload.single("file"), async (request, response) => {
  response.set("Cache-Control", "no-store");
  if (!request.file) throw new HttpError(400, "A multipart CSV file field named file is required");
  const { courseId } = courseIdSchema.parse(request.body);
  try {
    const students = await persistRoster(courseId, request.file.buffer);
    writeStructuredLog("info", "roster_import_completed", { courseId, imported: students.length });
    response.status(201).json({ imported: students.length, students: sortByLabel(students) });
  } catch (error) {
    writeStructuredLog("error", "roster_import_rejected", {
      courseId,
      status: error instanceof HttpError ? error.status : 500
    });
    throw error;
  }
});

router.get("/", async (request, response) => {
  response.set("Cache-Control", "no-store");
  const { courseId } = courseIdSchema.parse(request.query);
  const database = requireDatabase();
  const students = await database.query(`SELECT id, pseudonym, display_name AS "name"
    FROM students WHERE course_id = $1 ORDER BY display_name, pseudonym`, [courseId]);
  response.json({ students: students.rows as RosterStudent[] });
});

export const rostersRouter = router;
