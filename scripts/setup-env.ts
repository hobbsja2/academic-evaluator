import { randomBytes } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { constants } from "node:fs";

const path = new URL("../.env", import.meta.url);

try {
  await access(path, constants.F_OK);
  console.log(".env already exists; no changes were made.");
} catch {
  const identityKey = randomBytes(32).toString("hex");
  const contents = [
    "# Add the Neon pooled connection string locally; never commit or share it.",
    "# DATABASE_URL=postgresql://USER:PASSWORD@HOST/course-grading-assist?sslmode=require",
    `STUDENT_IDENTITY_KEY=${identityKey}`,
    "OLLAMA_BASE_URL=http://127.0.0.1:11434",
    "OLLAMA_MODEL=qwen3:4b-instruct",
    "LIBREOFFICE_PATH=C:\\Program Files\\LibreOffice\\program\\soffice.com",
    "PORT=8787",
    ""
  ].join("\n");
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log("Created Git-ignored .env with a new student identity key.");
  console.log("Add DATABASE_URL locally before running npm run db:migrate.");
}
