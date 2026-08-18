import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import { requireIdentityKey } from "./config.js";
import { getDatabase, withTransaction } from "./db.js";
import { HttpError } from "./errors.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const unlockUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
const baseFieldsSchema = z.object({
  courseId: z.string().uuid(),
  courseCode: z.string().trim().min(1).max(80),
  section: z.string().trim().min(1).max(80),
  format: z.enum(["encrypted", "csv"]).default("encrypted")
});
const unlockFieldsSchema = z.object({ passphrase: z.string().min(12).max(256) }).strict();
const stablePriority = ["id", "canvas user id", "sis id", "sis user id", "login id", "sis login id"];
const identityLabelPriority = ["name", "sortable name", "login id", "sis id"];
const formatMarker = "cga-roster-crosswalk";
const aad = Buffer.from("course-grading-assist/roster-crosswalk/v1", "utf8");
const scryptParameters = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const envelopeSchema = z.object({
  format: z.literal(formatMarker),
  version: z.literal(1),
  cipher: z.literal("AES-256-GCM"),
  kdf: z.object({
    name: z.literal("scrypt"),
    N: z.literal(scryptParameters.N),
    r: z.literal(scryptParameters.r),
    p: z.literal(scryptParameters.p),
    maxmem: z.literal(scryptParameters.maxmem),
    salt: z.string()
  }).strict(),
  iv: z.string(),
  authTag: z.string(),
  ciphertext: z.string()
}).strict();

type CrosswalkEnvelope = z.infer<typeof envelopeSchema>;
type UnlockedMapping = { identityLabel: string; pseudonym: string };

function normalizedHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function readCsv(buffer: Buffer): { headers: string[]; rows: string[][]; stableIndex: number; stableHeader: string } {
  const records = parse(buffer, { bom: true, relax_column_count: true, skip_empty_lines: true }) as string[][];
  if (records.length < 2) throw new HttpError(400, "CSV must contain a header and at least one data row");
  const headers = records[0].map((value) => String(value ?? "").trim());
  const normalized = headers.map(normalizedHeader);
  let stableIndex = -1;
  for (const candidate of stablePriority) {
    stableIndex = normalized.indexOf(candidate);
    if (stableIndex >= 0) break;
  }
  if (stableIndex < 0) throw new HttpError(400, `CSV needs one stable ID column: ${stablePriority.join(", ")}`);
  const roleIndex = normalized.indexOf("role");
  const allRows = records.slice(1).map((row) => row.map((value) => String(value ?? "")));
  const rows = roleIndex < 0
    ? allRows
    : allRows.filter((row) => normalizedHeader(row[roleIndex] ?? "").includes("student"));
  if (!rows.length) throw new HttpError(400, "CSV contains no student rows");
  return { headers, rows, stableIndex, stableHeader: headers[stableIndex] };
}

function sanitize(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 20) || "COURSE";
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

function pseudonym(key: string, courseId: string, courseCode: string, section: string, stableId: string): string {
  const digest = createHmac("sha256", key).update(`${courseId}\0${stableId}`).digest();
  return `${sanitize(courseCode)}-${sanitize(section)}-S${base32ish(digest)}`;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  const secret = Buffer.from(passphrase, "utf8");
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, 32, scryptParameters, (error, key) => {
      secret.fill(0);
      if (error) reject(error);
      else resolve(key);
    });
  });
}

async function encryptCrosswalk(plaintext: Buffer, passphrase: string): Promise<CrosswalkEnvelope> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  let key: Buffer | undefined;
  try {
    key = await deriveKey(passphrase, salt);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      format: formatMarker,
      version: 1,
      cipher: "AES-256-GCM",
      kdf: { name: "scrypt", ...scryptParameters, salt: salt.toString("base64") },
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
  } finally {
    key?.fill(0);
  }
}

function decodeBase64(value: string, field: string, expectedLength?: number): Buffer {
  if (!value || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new HttpError(400, `Encrypted crosswalk has invalid ${field}`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (expectedLength !== undefined && decoded.length !== expectedLength)) {
    decoded.fill(0);
    throw new HttpError(400, `Encrypted crosswalk has invalid ${field}`);
  }
  return decoded;
}

function parseEnvelope(buffer: Buffer): CrosswalkEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch {
    throw new HttpError(400, "Encrypted crosswalk file is not valid JSON");
  }
  const result = envelopeSchema.safeParse(value);
  if (!result.success) throw new HttpError(400, "Encrypted crosswalk envelope is invalid or unsupported");
  return result.data;
}

async function decryptCrosswalk(envelope: CrosswalkEnvelope, passphrase: string): Promise<Buffer> {
  const salt = decodeBase64(envelope.kdf.salt, "salt", 16);
  const iv = decodeBase64(envelope.iv, "IV", 12);
  const authTag = decodeBase64(envelope.authTag, "authentication tag", 16);
  const ciphertext = decodeBase64(envelope.ciphertext, "ciphertext");
  let key: Buffer | undefined;
  try {
    key = await deriveKey(passphrase, salt);
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new HttpError(400, "Encrypted crosswalk could not be unlocked");
    }
  } finally {
    key?.fill(0);
    salt.fill(0);
    iv.fill(0);
    authTag.fill(0);
    ciphertext.fill(0);
  }
}

function readUnlockedMappings(plaintext: Buffer): UnlockedMapping[] {
  let records: string[][];
  try {
    records = parse(plaintext, { bom: true, skip_empty_lines: true }) as string[][];
  } catch {
    throw new HttpError(400, "Unlocked file is not a valid pseudonym crosswalk");
  }
  if (records.length < 2) throw new HttpError(400, "Unlocked file is not a valid pseudonym crosswalk");
  const headers = records[0].map((value) => normalizedHeader(String(value ?? "")));
  const pseudonymMatches = headers.map((value, index) => value === "pseudonym" ? index : -1).filter((index) => index >= 0);
  const identityIndices = identityLabelPriority.map((candidate) => headers.indexOf(candidate)).filter((index) => index >= 0);
  if (pseudonymMatches.length !== 1 || !identityIndices.length) {
    throw new HttpError(400, "Unlocked file is not a valid pseudonym crosswalk");
  }
  const pseudonymIndex = pseudonymMatches[0];
  const seen = new Set<string>();
  const mappings = records.slice(1).map((row) => {
    const identityLabel = identityIndices.map((index) => String(row[index] ?? "").trim()).find(Boolean) ?? "";
    const value = String(row[pseudonymIndex] ?? "").trim();
    if (!identityLabel || !/^[A-Z0-9]{1,20}-[A-Z0-9]{1,20}-S[A-Z2-7]{8}$/.test(value) || seen.has(value)) {
      throw new HttpError(400, "Unlocked file is not a valid pseudonym crosswalk");
    }
    seen.add(value);
    return { identityLabel, pseudonym: value };
  });
  if (!mappings.length) throw new HttpError(400, "Unlocked file is not a valid pseudonym crosswalk");
  return mappings;
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

router.post("/crosswalk", upload.single("file"), async (request, response) => {
  response.set("Cache-Control", "no-store");
  if (!request.file) throw new HttpError(400, "A multipart CSV file field named file is required");
  const fields = baseFieldsSchema.parse(request.body);
  const passphrase = typeof request.body.passphrase === "string" ? request.body.passphrase : undefined;
  if (fields.format === "encrypted" && (!passphrase || passphrase.length < 12 || passphrase.length > 256)) {
    throw new HttpError(400, "Encrypted export requires a passphrase between 12 and 256 characters");
  }
  if (fields.format === "csv" && passphrase !== undefined) {
    throw new HttpError(400, "Plain CSV export must not include a passphrase");
  }
  const key = requireIdentityKey();
  const parsed = readCsv(request.file.buffer);
  const seen = new Map<string, string>();
  const outputRows: string[][] = [];
  const pseudonyms: string[] = [];
  for (const row of parsed.rows) {
    const stableId = (row[parsed.stableIndex] ?? "").trim();
    if (!stableId) throw new HttpError(400, `Every row must have a value in ${parsed.stableHeader}`);
    const generated = pseudonym(key, fields.courseId, fields.courseCode, fields.section, stableId);
    const prior = seen.get(generated);
    if (prior && prior !== stableId) throw new HttpError(409, "Pseudonym collision detected; crosswalk was not created");
    seen.set(generated, stableId);
    pseudonyms.push(generated);
    outputRows.push([...parsed.headers.map((_, index) => row[index] ?? ""), generated]);
  }
  const database = getDatabase();
  if (database) {
    try {
      const course = await database.query("SELECT id FROM courses WHERE id = $1", [fields.courseId]);
      if (!course.rows[0]) throw new HttpError(404, "Course not found");
      await withTransaction(database, async (client) => {
        for (const value of pseudonyms) {
          try {
            await client.query(`INSERT INTO students (course_id, pseudonym) VALUES ($1, $2)
              ON CONFLICT (course_id, pseudonym) DO NOTHING`, [fields.courseId, value]);
          } catch (error) {
            throw error;
          }
        }
      });
    } catch (error) {
      throw error;
    }
  }
  const lines = [[...parsed.headers, "Pseudonym"], ...outputRows]
    .map((row) => row.map(csvCell).join(",")).join("\r\n");
  const csv = Buffer.from(`\uFEFF${lines}\r\n`, "utf8");
  if (fields.format === "csv") {
    response.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=roster-crosswalk.csv" });
    response.send(csv);
    return;
  }
  try {
    const envelope = await encryptCrosswalk(csv, passphrase!);
    response.set({ "Content-Type": "application/json; charset=utf-8", "Content-Disposition": "attachment; filename=roster-crosswalk.cga.json" });
    response.json(envelope);
  } finally {
    csv.fill(0);
  }
});

router.post("/crosswalk/unlock", unlockUpload.single("file"), async (request, response) => {
  response.set("Cache-Control", "no-store");
  if (!request.file) throw new HttpError(400, "A multipart encrypted crosswalk file field named file is required");
  const fields = unlockFieldsSchema.parse(request.body);
  const envelope = parseEnvelope(request.file.buffer);
  let plaintext: Buffer | undefined;
  try {
    plaintext = await decryptCrosswalk(envelope, fields.passphrase);
    const mappings = readUnlockedMappings(plaintext);
    response.json({ count: mappings.length, mappings });
  } finally {
    plaintext?.fill(0);
  }
});

export const rostersRouter = router;
