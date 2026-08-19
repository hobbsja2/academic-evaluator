import "dotenv/config";
import { z } from "zod";

const defaultLibreOffice = process.platform === "win32"
  ? "C:\\Program Files\\LibreOffice\\program\\soffice.com"
  : "soffice";
const envSchema = z.object({
  DATABASE_URL: z.string().trim().min(1).optional(),
  STUDENT_IDENTITY_KEY: z.string().min(32).optional(),
  OLLAMA_BASE_URL: z.string().url().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().trim().min(1).default("qwen3:4b-instruct"),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(900_000).default(300_000),
  LIBREOFFICE_PATH: z.string().trim().min(1).default(defaultLibreOffice),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  JSON_LIMIT: z.string().trim().min(1).default("1mb")
});

const parsed = envSchema.parse(process.env);
const ollamaUrl = new URL(parsed.OLLAMA_BASE_URL);
const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
if (!localHosts.has(ollamaUrl.hostname)) {
  throw new Error("OLLAMA_BASE_URL must use a loopback host; cloud model calls are disabled");
}

export const config = {
  databaseUrl: parsed.DATABASE_URL,
  studentIdentityKey: parsed.STUDENT_IDENTITY_KEY,
  ollamaBaseUrl: ollamaUrl.toString().replace(/\/$/, ""),
  ollamaModel: parsed.OLLAMA_MODEL,
  ollamaTimeoutMs: parsed.OLLAMA_TIMEOUT_MS,
  libreOfficePath: parsed.LIBREOFFICE_PATH,
  port: parsed.PORT,
  jsonLimit: parsed.JSON_LIMIT
} as const;

export function requireIdentityKey(): string {
  if (!config.studentIdentityKey) {
    throw Object.assign(new Error("STUDENT_IDENTITY_KEY is required for pseudonym actions"), { status: 503 });
  }
  return config.studentIdentityKey;
}
