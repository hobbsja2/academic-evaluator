import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Router } from "express";
import { config } from "./config.js";
import { databaseConfigured, databaseConnected } from "./db.js";
import { ollamaStatus } from "./grading.js";
import { retentionStatus } from "./retention.js";

const run = promisify(execFile);
const router = Router();

export async function libreOfficeStatus(): Promise<{ available: boolean; version: string | null }> {
  try {
    const { stdout, stderr } = await run(config.libreOfficePath, ["--version"], {
      timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024
    });
    const version = `${stdout}${stderr}`.trim().split(/\r?\n/, 1)[0] || null;
    return { available: true, version };
  } catch {
    return { available: false, version: null };
  }
}

router.get("/", async (_request, response) => {
  try {
    const [connected, ollama, libreOffice] = await Promise.all([
      databaseConnected(), ollamaStatus(), libreOfficeStatus()
    ]);
    response.json({
      status: "ok",
      database: { configured: databaseConfigured(), connected },
      ollama,
      libreOffice,
      // Timestamps, a failure count and an error name only — no course or student data.
      retention: retentionStatus()
    });
  } catch (error) {
    throw error;
  }
});

export const healthRouter = router;
