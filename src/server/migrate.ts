import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "@neondatabase/serverless";
import { writeStructuredLog } from "./logger.js";

// Applied in order inside one transaction. Each file is idempotent, so a repeat
// run is a no-op; a failure in any file rolls back the whole batch.
const MIGRATION_FILES = ["db/001_initial.sql", "db/002_student_names.sql"] as const;

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  writeStructuredLog("error", "migration_database_url_missing");
  process.exitCode = 1;
} else {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      for (const file of MIGRATION_FILES) {
        const sql = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
        await client.query(sql);
        writeStructuredLog("info", "migration_applied", { migration: file });
      }
      await client.query("COMMIT");
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          writeStructuredLog("error", "migration_rollback_failed", {
            errorType: rollbackError instanceof Error ? rollbackError.name : "UnknownError"
          });
        }
      }
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
