import type { ErrorRequestHandler, RequestHandler } from "express";
import multer from "multer";
import { ZodError } from "zod";
import { writeStructuredLog, type LogDetails } from "./logger.js";

const MAX_LOG_DETAIL_CHARS = 300;
const MAX_LOG_LABEL_CHARS = 80;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function readProperty(value: object, key: string): unknown {
  return key in value ? Reflect.get(value, key) : undefined;
}

function readLabel(value: object, key: string): string | null {
  const found = readProperty(value, key);
  return typeof found === "string" && found ? found.slice(0, MAX_LOG_LABEL_CHARS) : null;
}

// pg's DatabaseError names itself "error", so the SQLSTATE in `code` is the only
// field that identifies which database failure occurred.
function readCode(error: Error): string | null {
  const code = readProperty(error, "code");
  if (typeof code === "string" || typeof code === "number") return String(code).slice(0, MAX_LOG_LABEL_CHARS);
  return null;
}

function firstStackFrame(error: Error): string | null {
  const frame = (error.stack ?? "").split("\n").map((line) => line.trim()).find((line) => line.startsWith("at "));
  return frame ? frame.slice(0, MAX_LOG_LABEL_CHARS) : null;
}

function constructorName(value: object): string {
  const name: unknown = value.constructor?.name;
  return typeof name === "string" && name ? name.slice(0, MAX_LOG_LABEL_CHARS) : "Object";
}

/**
 * Describes a thrown object that is not an Error. The Neon driver re-emits the raw
 * WebSocket error Event as the stream error, so a transport failure arrives as an
 * ErrorEvent: no `name`, an empty `message`, and the real cause nested in `.error`.
 * Read structurally rather than with instanceof so it holds across realms, and
 * compose a detail that is never empty.
 */
function describeNonError(value: object): LogDetails {
  const kind = constructorName(value);
  const eventType = readLabel(value, "type");
  const nested = readProperty(value, "error");
  const nestedError = nested instanceof Error ? nested : null;
  const message = readLabel(value, "message") ?? (nestedError?.message || null);
  const parts = [
    message,
    nestedError && !message ? `nested ${nestedError.name}` : null,
    eventType ? `type=${eventType}` : null,
    nestedError ? firstStackFrame(nestedError) : null,
  ].filter((part): part is string => Boolean(part));
  return {
    errorKind: kind,
    errorName: nestedError ? nestedError.name.slice(0, MAX_LOG_LABEL_CHARS) : kind,
    detail: (parts.join(" | ") || `no detail on ${kind}`).slice(0, MAX_LOG_DETAIL_CHARS),
    errorCode: nestedError ? readCode(nestedError) : null,
  };
}

/**
 * Normalizes any thrown value into log fields. Internal diagnostics only — this is
 * deliberately not routed through safeErrorHandler, which masks messages at 5xx to
 * keep them out of a client response. Carries no request payload, so no PII.
 */
export function describeErrorForLog(error: unknown): LogDetails {
  if (error instanceof Error) {
    return {
      errorKind: constructorName(error),
      errorName: error.name.slice(0, MAX_LOG_LABEL_CHARS),
      detail: (error.message || `no message on ${error.name}`).slice(0, MAX_LOG_DETAIL_CHARS),
      errorCode: readCode(error),
      stackFrame: firstStackFrame(error),
    };
  }
  if (typeof error === "object" && error !== null) return describeNonError(error);
  return {
    errorKind: typeof error,
    errorName: typeof error,
    detail: String(error).slice(0, MAX_LOG_DETAIL_CHARS),
    errorCode: null,
  };
}

export const notFound: RequestHandler = (_request, _response, next) => {
  next(new HttpError(404, "Endpoint not found"));
};

export const safeErrorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  let status = Number(error?.status) || 500;
  let message = error instanceof HttpError
    ? error.message
    : status < 500 ? String(error?.message || "Request failed") : "Internal server error";
  if (error instanceof ZodError) {
    status = 400;
    message = error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
  } else if (error instanceof multer.MulterError) {
    status = 400;
    message = error.code === "LIMIT_FILE_SIZE" ? "Uploaded file is too large" : "Invalid upload";
  } else if (error instanceof SyntaxError && "body" in error) {
    status = 400;
    message = "Invalid JSON body";
  }
  if (status >= 500) writeStructuredLog("error", "request_failed", { errorType: error?.name ?? "Error" });
  response.status(status).json({ error: message });
};
