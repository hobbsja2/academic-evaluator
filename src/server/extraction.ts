import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { Router } from "express";
import mammoth from "mammoth";
import multer from "multer";
import { PDFParse } from "pdf-parse";
import { config } from "./config.js";
import { HttpError } from "./errors.js";

const run = promisify(execFile);
const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

const ZIP_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx", ".odt"]);
const OLE_EXTENSIONS = new Set([".doc", ".xls", ".ppt"]);
// Spreadsheets and decks convert to PDF rather than CSV or text so that every
// sheet and slide is captured instead of only the first one.
const PDF_CONVERSION_EXTENSIONS = new Set([".xlsx", ".pptx", ".xls", ".ppt"]);
// Word-like formats keep more structure by round-tripping through DOCX.
const DOCX_CONVERSION_EXTENSIONS = new Set([".doc", ".rtf", ".odt"]);
// Already plain text, so no conversion is needed.
const PLAIN_TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv"]);
const SUPPORTED_EXTENSIONS = [
  ".pdf", ".doc", ".docx", ".odt", ".rtf",
  ".xls", ".xlsx", ".ppt", ".pptx",
  ".txt", ".md", ".csv"
];
const CONVERSION_TIMEOUT_MS = 90_000;

function validateSignature(extension: string, data: Buffer): void {
  if (PLAIN_TEXT_EXTENSIONS.has(extension)) return;
  const isPdf = data.subarray(0, 5).toString() === "%PDF-";
  const isZip = data[0] === 0x50 && data[1] === 0x4b;
  const isOle = data.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  const isRtf = data.subarray(0, 5).toString() === "{\\rtf";
  const mismatch = (extension === ".pdf" && !isPdf) ||
    (extension === ".rtf" && !isRtf) ||
    (ZIP_EXTENSIONS.has(extension) && !isZip) ||
    (OLE_EXTENSIONS.has(extension) && !isOle);
  if (mismatch) {
    throw new HttpError(400, `The file contents do not match a ${extension.replace(".", "").toUpperCase()} document. It may be renamed or corrupted.`);
  }
}

async function extractPdf(data: Buffer): Promise<string> {
  const parser = new PDFParse({ data });
  try {
    return (await parser.getText()).text;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, "The PDF text layer could not be read. A scanned PDF has no extractable text.");
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function convertWithLibreOffice(
  data: Buffer,
  inputExtension: string,
  target: "pdf" | "docx"
): Promise<Buffer> {
  let directory: string;
  try {
    directory = await mkdtemp(join(tmpdir(), "grading-doc-"));
  } catch {
    throw new HttpError(500, "A temporary working directory could not be created");
  }
  try {
    const input = join(directory, `input${inputExtension}`);
    await writeFile(input, data, { mode: 0o600 });
    await run(config.libreOfficePath, ["--headless", "--convert-to", target, "--outdir", directory, input], {
      timeout: CONVERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024
    });
    const converted = await readFile(join(directory, `input.${target}`)).catch(() => null);
    if (!converted) throw new HttpError(422, "LibreOffice did not produce a converted file");
    return converted;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, "LibreOffice could not convert the document");
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function extractViaDocxConversion(data: Buffer, extension: string): Promise<string> {
  try {
    const converted = await convertWithLibreOffice(data, extension, "docx");
    return (await mammoth.extractRawText({ buffer: converted })).value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const label = extension.replace(".", "").toUpperCase();
    throw new HttpError(422, `The ${label} document could not be converted. Confirm LibreOffice is installed and not already running.`);
  }
}

async function extractViaPdfConversion(data: Buffer, extension: string): Promise<string> {
  try {
    const converted = await convertWithLibreOffice(data, extension, "pdf");
    return await extractPdf(converted);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const label = extension.replace(".", "").toUpperCase();
    throw new HttpError(422, `The ${label} document could not be converted. Confirm LibreOffice is installed and not already running.`);
  }
}

async function extractDocx(data: Buffer): Promise<string> {
  try {
    return (await mammoth.extractRawText({ buffer: data })).value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, "The DOCX document could not be read. It may be corrupted.");
  }
}

async function extractText(extension: string, data: Buffer): Promise<string> {
  if (PLAIN_TEXT_EXTENSIONS.has(extension)) return data.toString("utf8");
  if (extension === ".pdf") return extractPdf(data);
  if (extension === ".docx") return extractDocx(data);
  if (DOCX_CONVERSION_EXTENSIONS.has(extension)) return extractViaDocxConversion(data, extension);
  if (PDF_CONVERSION_EXTENSIONS.has(extension)) return extractViaPdfConversion(data, extension);
  throw new HttpError(415, `Only ${SUPPORTED_EXTENSIONS.join(", ")} documents are accepted`);
}

router.post("/extract", upload.single("file"), async (request, response) => {
  if (!request.file) throw new HttpError(400, "A multipart document field named file is required");
  const extension = extname(request.file.originalname).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    const attempted = extension ? `"${extension}" files are` : "Files without an extension are";
    throw new HttpError(415, `${attempted} not supported. Accepted types: ${SUPPORTED_EXTENSIONS.join(", ")}`);
  }
  validateSignature(extension, request.file.buffer);
  let text: string;
  try {
    text = await extractText(extension, request.file.buffer);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, "The document could not be read");
  }
  response.set("Cache-Control", "no-store").json({ text });
});

export const extractionRouter = router;
