type LogLevel = "info" | "error";

type LogDetails = Record<string, boolean | number | string | null>;

export function writeStructuredLog(level: LogLevel, event: string, details: LogDetails = {}): void {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details });
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${entry}\n`);
}
