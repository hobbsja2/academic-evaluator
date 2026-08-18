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

function validateSignature(extension: string, data: Buffer): void {
  const pdf = data.subarray(0, 5).toString() === "%PDF-";
  const zip = data[0] === 0x50 && data[1] === 0x4b;
  const ole = data.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if ((extension === ".pdf" && !pdf) || (extension === ".docx" && !zip) || (extension === ".doc" && !ole)) {
    throw new HttpError(400, "File content does not match its supported document type");
  }
}

async function extractPdf(data: Buffer): Promise<string> {
  try {
    const parser = new PDFParse({ data });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  } catch (error) {
    throw error;
  }
}

async function extractLegacyDoc(data: Buffer): Promise<string> {
  try {
    const directory = await mkdtemp(join(tmpdir(), "grading-doc-"));
    try {
      const input = join(directory, "input.doc");
      await writeFile(input, data, { mode: 0o600 });
      await run(config.libreOfficePath, ["--headless", "--convert-to", "docx", "--outdir", directory, input], {
        timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024
      });
      const converted = await readFile(join(directory, "input.docx"));
      return (await mammoth.extractRawText({ buffer: converted })).value;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(422, "The DOC document could not be converted");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } catch (error) {
    throw error;
  }
}
router.post("/extract", upload.single("file"), async (request, response) => {
  try {
    if (!request.file) throw new HttpError(400, "A multipart document field named file is required");
    const extension = extname(request.file.originalname).toLowerCase();
    if (![".doc", ".docx", ".pdf"].includes(extension)) {
      throw new HttpError(415, "Only .doc, .docx, and .pdf documents are accepted");
    }
    validateSignature(extension, request.file.buffer);
    let text: string;
    if (extension === ".pdf") text = await extractPdf(request.file.buffer);
    else if (extension === ".docx") text = (await mammoth.extractRawText({ buffer: request.file.buffer })).value;
    else text = await extractLegacyDoc(request.file.buffer);
    response.set("Cache-Control", "no-store").json({ text });
  } catch (error) {
    throw error;
  }
});

export const extractionRouter = router;
