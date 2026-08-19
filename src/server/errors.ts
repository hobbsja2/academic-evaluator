import type { ErrorRequestHandler, RequestHandler } from "express";
import multer from "multer";
import { ZodError } from "zod";
import { writeStructuredLog } from "./logger.js";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
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
