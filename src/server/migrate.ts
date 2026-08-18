import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "@neondatabase/serverless";
import { writeStructuredLog } from "./logger.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  writeStructuredLog("error", "migration_database_url_missing");
  process.exitCode = 1;
} else {
  const migrationUrl = new URL("../../db/001_initial.sql", import.meta.url);
  const migration = await readFile(migrationUrl, "utf8");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(migration);
      await client.query("COMMIT");
      writeStructuredLog("info", "migration_applied", { migration: "db/001_initial.sql" });
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
