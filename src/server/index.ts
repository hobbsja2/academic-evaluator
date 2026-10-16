import { app } from "./app.js";
import { config } from "./config.js";
import { closeDatabase } from "./db.js";
import { writeStructuredLog } from "./logger.js";
import { runRetention, startRetentionSchedule, stopRetentionSchedule } from "./retention.js";

// The backend has been dying silently while idle, leaving Vite serving a UI with no
// API behind it. Nothing here prevents that, but it makes the cause visible instead
// of leaving an empty log.
process.on("uncaughtException", (error: Error) => {
  writeStructuredLog("error", "backend_uncaught_exception", {
    errorName: error.name,
    detail: error.message.slice(0, 300),
    stack: (error.stack ?? "").split("\n").slice(0, 4).join(" | ")
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  writeStructuredLog("error", "backend_unhandled_rejection", {
    errorName: reason instanceof Error ? reason.name : typeof reason,
    detail: reason instanceof Error ? reason.message.slice(0, 300) : String(reason).slice(0, 300)
  });
  process.exit(1);
});

process.on("exit", (code: number) => {
  writeStructuredLog("info", "backend_exiting", { code });
});

for (const signal of ["SIGHUP", "SIGBREAK"] as const) {
  process.on(signal, () => {
    writeStructuredLog("info", "backend_signal_received", { signal });
  });
}

// Not awaited: the startup purge now retries with backoff, and blocking on it would
// delay listening by the whole retry budget in exactly the case where the database
// is unreachable. Its outcome is reported on /api/health instead.
startRetentionSchedule();
void runRetention();

const server = app.listen(config.port, "127.0.0.1", () => {
  writeStructuredLog("info", "backend_listening", { host: "127.0.0.1", port: config.port });
});

async function shutdown(): Promise<void> {
  stopRetentionSchedule();
  server.close();
  try {
    await closeDatabase();
  } catch (error) {
    throw error;
  }
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
