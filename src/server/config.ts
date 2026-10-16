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
  // Generation slows to ~3 tokens/s once a long paper fills the context on this
  // hardware, and a full rubric response can approach num_predict (3000 tokens).
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(1_800_000).default(1_200_000),
  // Grading context window in tokens. Prompt instructions and rubric use ~5k tokens and
  // the bounded output up to 3k, so 8192 rejected papers longer than about four pages.
  OLLAMA_GRADING_NUM_CTX: z.coerce.number().int().min(8192).max(131_072).default(16_384),
  // Character budget for the student's prior saved feedback injected into the
  // grading prompt. 0 disables injection entirely.
  PRIOR_FEEDBACK_MAX_CHARS: z.coerce.number().int().min(0).max(20_000).default(3_000),
  // Cloud grading backend. Set to "claude" and supply ANTHROPIC_API_KEY to use Claude Haiku.
  GRADING_BACKEND: z.enum(["ollama", "claude"]).default("ollama"),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().trim().min(1).default("claude-haiku-4-5"),
  LIBREOFFICE_PATH: z.string().trim().min(1).default(defaultLibreOffice),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  JSON_LIMIT: z.string().trim().min(1).default("1mb"),
  // How often expired courses are purged. The machine sleeps, which suspends the
  // timer and kills the pool's idle connections, so the purge needs both a retry
  // and a shorter re-attempt after a failed sweep rather than waiting a full cycle.
  RETENTION_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(6 * 60 * 60 * 1000),
  RETENTION_RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  RETENTION_RETRY_BACKOFF_MS: z.coerce.number().int().min(1_000).max(600_000).default(5_000),
  RETENTION_RECOVERY_DELAY_MS: z.coerce.number().int().min(60_000).max(21_600_000).default(15 * 60 * 1000)
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
  ollamaGradingNumCtx: parsed.OLLAMA_GRADING_NUM_CTX,
  gradingBackend: parsed.GRADING_BACKEND,
  anthropicApiKey: parsed.ANTHROPIC_API_KEY,
  anthropicModel: parsed.ANTHROPIC_MODEL,
  libreOfficePath: parsed.LIBREOFFICE_PATH,
  port: parsed.PORT,
  jsonLimit: parsed.JSON_LIMIT,
  retentionIntervalMs: parsed.RETENTION_INTERVAL_MS,
  retentionRetryAttempts: parsed.RETENTION_RETRY_ATTEMPTS,
  retentionRetryBackoffMs: parsed.RETENTION_RETRY_BACKOFF_MS,
  retentionRecoveryDelayMs: parsed.RETENTION_RECOVERY_DELAY_MS,
  priorFeedbackMaxChars: parsed.PRIOR_FEEDBACK_MAX_CHARS,
  // How many of the student's most recent saved runs are considered.
  priorFeedbackRunLimit: 5,
  // Claude's context is far larger than the local model's, so it gets more budget.
  priorFeedbackClaudeFactor: 2
} as const;
