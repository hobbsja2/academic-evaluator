import { app } from "./app.js";
import { config } from "./config.js";
import { closeDatabase, databaseConfigured, purgeExpiredCourses } from "./db.js";
import { writeStructuredLog } from "./logger.js";

async function runRetention(): Promise<void> {
  if (!databaseConfigured()) return;
  try {
    const count = await purgeExpiredCourses();
    if (count > 0) writeStructuredLog("info", "retention_purge_completed", { deletedCourses: count });
  } catch {
    writeStructuredLog("error", "retention_purge_failed");
  }
}

try {
  await runRetention();
} catch (error) {
  throw error;
}
const retentionTimer = setInterval(() => void runRetention(), 6 * 60 * 60 * 1000);
retentionTimer.unref();

const server = app.listen(config.port, "127.0.0.1", () => {
  writeStructuredLog("info", "backend_listening", { host: "127.0.0.1", port: config.port });
});

async function shutdown(): Promise<void> {
  clearInterval(retentionTimer);
  server.close();
  try {
    await closeDatabase();
  } catch (error) {
    throw error;
  }
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
