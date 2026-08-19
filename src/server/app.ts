import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { coursesRouter } from "./courses.js";
import { extractionRouter } from "./extraction.js";
import { gradingRouter } from "./grading.js";
import { healthRouter } from "./health.js";
import { notFound, safeErrorHandler } from "./errors.js";
import { rostersRouter } from "./rosters.js";
import { rubricsRouter } from "./rubrics.js";

const viteHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/;

function isViteOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const port = Number(url.port);
    return url.protocol === "http:" && viteHosts.has(url.hostname) &&
      Number.isInteger(port) && port >= 5173 && port <= 5199 &&
      !url.username && !url.password;
  } catch {
    return false;
  }
}

export const app = express();
app.disable("x-powered-by");
app.use(cors({
  origin(origin, callback) {
    if (!origin || isViteOrigin(origin) || extensionOrigin.test(origin)) callback(null, true);
    else callback(Object.assign(new Error("Origin is not allowed"), { status: 403 }));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  maxAge: 600
}));
app.use(express.json({ limit: config.jsonLimit, type: "application/json" }));

app.use("/api/health", healthRouter);
app.use("/api/courses", coursesRouter);
app.use("/api/rosters", rostersRouter);
app.use("/api/rubrics", rubricsRouter);
app.use("/api/documents", extractionRouter);
app.use("/api/grading", gradingRouter);
app.use(notFound);
app.use(safeErrorHandler);
