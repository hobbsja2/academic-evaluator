import { Pool, type PoolClient } from "@neondatabase/serverless";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { writeStructuredLog } from "./logger.js";

export type Database = Pool;
let pool: Database | null = null;

export function databaseConfigured(): boolean {
  return Boolean(config.databaseUrl);
}

export function getDatabase(): Database | null {
  if (!config.databaseUrl) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: 5,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 10_000
    });
    pool.on("error", (error: Error) => {
      writeStructuredLog("error", "database_pool_idle_error", { errorType: error.name });
    });
  }
  return pool;
}

export function requireDatabase(): Database {
  const database = getDatabase();
  if (!database) throw new HttpError(503, "Database is not configured");
  return database;
}

export async function withTransaction<T>(
  database: Database,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await database.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        writeStructuredLog("error", "database_transaction_rollback_failed", {
          errorType: rollbackError instanceof Error ? rollbackError.name : "UnknownError"
        });
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function databaseConnected(): Promise<boolean> {
  const database = getDatabase();
  if (!database) return false;
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function purgeExpiredCourses(): Promise<number> {
  const database = getDatabase();
  if (!database) return 0;
  const deleted = await database.query("DELETE FROM courses WHERE purge_after <= CURRENT_DATE RETURNING id");
  return deleted.rows.length;
}

export async function closeDatabase(): Promise<void> {
  const activePool = pool;
  pool = null;
  if (activePool) await activePool.end();
}
