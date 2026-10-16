import { config } from "./config.js";
import { databaseConfigured, purgeExpiredCourses } from "./db.js";
import { describeErrorForLog } from "./errors.js";
import { writeStructuredLog, type LogDetails } from "./logger.js";

export interface RetentionStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastErrorName: string | null;
}

const status: RetentionStatus = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  consecutiveFailures: 0,
  lastErrorName: null
};

let scheduleTimer: NodeJS.Timeout | null = null;
let recoveryTimer: NodeJS.Timeout | null = null;

export function retentionStatus(): RetentionStatus {
  return { ...status };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

function recordSuccess(deletedCourses: number): void {
  status.lastSuccessAt = new Date().toISOString();
  status.consecutiveFailures = 0;
  status.lastErrorName = null;
  if (deletedCourses > 0) writeStructuredLog("info", "retention_purge_completed", { deletedCourses });
}

/**
 * The machine suspends, which drops the pool's WebSockets and fires the suspended
 * interval the instant it resumes, before the network is back. Retrying absorbs
 * that race. Resolves to null on success, or to the last failure's log fields.
 */
async function attemptPurge(): Promise<LogDetails | null> {
  const attempts = config.retentionRetryAttempts;
  let lastCause: LogDetails = { errorName: null, detail: "purge never attempted" };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const deletedCourses = await purgeExpiredCourses();
      recordSuccess(deletedCourses);
      return null;
    } catch (error) {
      lastCause = describeErrorForLog(error);
      writeStructuredLog("error", "retention_purge_attempt_failed", { ...lastCause, attempt, attempts });
      if (attempt < attempts) await delay(config.retentionRetryBackoffMs * attempt);
    }
  }
  return lastCause;
}

export async function runRetention(): Promise<boolean> {
  if (!databaseConfigured()) return false;
  status.lastAttemptAt = new Date().toISOString();
  const cause = await attemptPurge();
  if (!cause) return true;
  status.consecutiveFailures += 1;
  const name = cause.errorName;
  status.lastErrorName = typeof name === "string" ? name : null;
  writeStructuredLog("error", "retention_purge_failed", {
    ...cause,
    attempts: config.retentionRetryAttempts,
    consecutiveFailures: status.consecutiveFailures
  });
  scheduleRecovery();
  return false;
}

// One short re-attempt after a failed sweep, so a transient transport failure does
// not leave expired data in place for the rest of the interval. Unreferenced, so it
// never holds the process open on its own.
function scheduleRecovery(): void {
  if (recoveryTimer) return;
  writeStructuredLog("info", "retention_recovery_scheduled", {
    delayMs: config.retentionRecoveryDelayMs,
    consecutiveFailures: status.consecutiveFailures
  });
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    void runRetention();
  }, config.retentionRecoveryDelayMs);
  recoveryTimer.unref();
}

export function startRetentionSchedule(): void {
  if (scheduleTimer) return;
  scheduleTimer = setInterval(() => void runRetention(), config.retentionIntervalMs);
  scheduleTimer.unref();
}

export function stopRetentionSchedule(): void {
  if (scheduleTimer) clearInterval(scheduleTimer);
  if (recoveryTimer) clearTimeout(recoveryTimer);
  scheduleTimer = null;
  recoveryTimer = null;
}
