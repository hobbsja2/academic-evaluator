import { Router } from "express";
import { z } from "zod";
import type { DiscussionTimeliness, StagedDiscussionSubmission } from "../shared/types.js";
import { config } from "./config.js";
import { requireActiveCourseSelection } from "./courses.js";
import { HttpError } from "./errors.js";

const requestSchema = z.object({
  postText: z.string().trim().min(1).max(20_000)
});

const MAX_ENTRY_LENGTH = 6_000;
const MAX_EXCERPT_LENGTH = 400;
const MAX_FORMATTED_LENGTH = 120_000;
const SUBMISSION_TTL_MS = 30 * 60 * 1000;
const SUBMISSION_TTL_MINUTES = 30;

const replySchema = z.object({
  text: z.string().trim().min(1).max(MAX_ENTRY_LENGTH),
  createdAt: z.string().trim().max(60).nullable().optional(),
  replyingTo: z.string().trim().max(80).nullable().optional(),
  parentExcerpt: z.string().trim().max(MAX_EXCERPT_LENGTH).nullable().optional()
});
const submissionImportSchema = z.object({
  courseId: z.union([z.string(), z.number()]).transform(String),
  assignmentId: z.union([z.string(), z.number()]).transform(String),
  assignmentName: z.string().trim().max(300).nullable().optional(),
  assignmentDirections: z.string().max(50_000).nullable().optional(),
  dueAt: z.string().trim().max(60).nullable().optional(),
  selectedCourseToken: z.string().uuid(),
  sourceUrl: z.url().nullable().optional(),
  capturedAt: z.iso.datetime().optional(),
  submission: z.object({
    initialPosts: z.array(z.object({
      text: z.string().trim().min(1).max(MAX_ENTRY_LENGTH),
      createdAt: z.string().trim().max(60).nullable().optional()
    })).max(10),
    replies: z.array(replySchema).max(60)
  }).refine((value) => value.initialPosts.length > 0 || value.replies.length > 0,
    "The capture contained no discussion entries")
});

// Timeliness is decided by calendar arithmetic, not model judgement. The rule is
// stated in "EST", but Eastern observes daylight saving for much of the academic
// year, so America/New_York local time is used rather than a fixed -05:00 offset.
const GRADING_TIME_ZONE = "America/New_York";
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type EasternMoment = { dateKey: string; time: string; weekday: string; weekdayIndex: number };

function easternMoment(iso: string | null | undefined): EasternMoment | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: GRADING_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short"
  }).formatToParts(parsed);
  const lookup = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const shortWeekday = lookup("weekday");
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(shortWeekday);
  if (weekdayIndex < 0) return null;
  // Intl renders midnight as hour 24 in some ICU builds.
  const hour = lookup("hour") === "24" ? "00" : lookup("hour");
  return {
    dateKey: `${lookup("year")}-${lookup("month")}-${lookup("day")}`,
    time: `${hour}:${lookup("minute")}`,
    weekday: WEEKDAY_NAMES[weekdayIndex],
    weekdayIndex
  };
}

function shiftDateKey(dateKey: string, days: number): string {
  const shifted = new Date(`${dateKey}T12:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** The Friday at or before the module's end date, in Eastern local time. */
function onTimeFridayKey(due: EasternMoment): string {
  const daysBackToFriday = (due.weekdayIndex - 5 + 7) % 7;
  return shiftDateKey(due.dateKey, -daysBackToFriday);
}

type StagedEntry = StagedDiscussionSubmission & { localCourseId: string; expiresAtMs: number };

// Student discussion text is deliberately never written to the database; it is held
// only in server memory for a short window, matching the staged-directions flow.
const stagedSubmissions = new Map<string, StagedEntry>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [key, value] of stagedSubmissions) {
    if (value.expiresAtMs <= now) stagedSubmissions.delete(key);
  }
}

type TimelinessInput = {
  dueAt: string | null;
  initialPostAt: string | null;
  replyDates: Array<string | null>;
};

function computeTimeliness(input: TimelinessInput): DiscussionTimeliness {
  const due = easternMoment(input.dueAt);
  const initial = easternMoment(input.initialPostAt);
  const fridayKey = due ? onTimeFridayKey(due) : null;
  const replyMoments = input.replyDates.map((value) => easternMoment(value));
  const replyDateKeys = replyMoments.map((moment) => moment?.dateKey ?? null);
  const knownReplyKeys = replyDateKeys.filter((key): key is string => Boolean(key));
  const distributed = Boolean(initial) && knownReplyKeys.some((key) => key !== initial?.dateKey);
  return {
    timeZone: GRADING_TIME_ZONE,
    dueAt: due ? `${due.weekday} ${due.dateKey} ${due.time}` : null,
    onTimeDeadline: fridayKey ? `Friday ${fridayKey} 23:59` : null,
    initialPostAt: initial ? `${initial.weekday} ${initial.dateKey} ${initial.time}` : null,
    // The deadline is end of day, so comparing calendar dates is sufficient.
    initialOnTime: initial && fridayKey ? initial.dateKey <= fridayKey : null,
    replyDates: replyDateKeys,
    repliesDistributed: knownReplyKeys.length ? distributed : null
  };
}

function timelinessSection(timeliness: DiscussionTimeliness): string {
  const lines = [`All times converted to ${timeliness.timeZone} local time.`];
  lines.push(`Module due date: ${timeliness.dueAt ?? "not published by Canvas"}`);
  lines.push(`On-time deadline for the initial response: ${timeliness.onTimeDeadline ?? "could not be derived without a due date"}`);
  lines.push(`Initial response posted: ${timeliness.initialPostAt ?? "no initial response found"}`);
  if (timeliness.initialOnTime === null) {
    lines.push("Initial response on time: CANNOT BE DETERMINED");
  } else {
    lines.push(`Initial response on time: ${timeliness.initialOnTime ? "YES" : "NO, it was submitted after the deadline"}`);
  }
  const dates = timeliness.replyDates.filter((value): value is string => Boolean(value));
  lines.push(`Reply dates: ${dates.length ? dates.join(", ") : "no replies found"}`);
  if (timeliness.repliesDistributed === null) {
    lines.push("Replies distributed across more than one day: CANNOT BE DETERMINED");
  } else {
    lines.push(`Replies distributed across more than one day: ${timeliness.repliesDistributed
      ? "YES, at least one reply falls on a different date than the initial response"
      : "NO, every reply falls on the same date as the initial response"}`);
  }
  return `=== TIMELINESS (computed from Canvas timestamps; authoritative, do not recalculate) ===\n${lines.join("\n")}`;
}

/**
 * Renders the capture as clearly delimited sections so a rubric criterion about
 * peer engagement has something specific to evaluate.
 */
function formatSubmission(input: z.infer<typeof submissionImportSchema>["submission"]): string {
  const blocks: string[] = [];
  input.initialPosts.forEach((post, index) => {
    const label = input.initialPosts.length > 1 ? ` ${index + 1} OF ${input.initialPosts.length}` : "";
    const posted = post.createdAt ? ` (posted ${post.createdAt})` : "";
    blocks.push(`=== INITIAL DISCUSSION RESPONSE${label}${posted} ===\n${post.text}`);
  });
  if (!input.initialPosts.length) {
    blocks.push("=== INITIAL DISCUSSION RESPONSE ===\nNo initial response by this student was found in the thread.");
  }
  input.replies.forEach((reply, index) => {
    const target = reply.replyingTo?.trim() || "a peer";
    const posted = reply.createdAt ? ` (posted ${reply.createdAt})` : "";
    const excerpt = reply.parentExcerpt?.trim()
      ? `\n${target} wrote (excerpt): ${reply.parentExcerpt.trim()}`
      : "";
    blocks.push(
      `=== REPLY ${index + 1} OF ${input.replies.length} — to ${target}${posted} ===${excerpt}\nStudent's reply: ${reply.text}`
    );
  });
  if (!input.replies.length) {
    blocks.push("=== PEER REPLIES ===\nNo replies to other students by this student were found in the thread.");
  }
  return blocks.join("\n\n").slice(0, MAX_FORMATTED_LENGTH);
}

function buildFormattedSubmission(
  body: z.infer<typeof submissionImportSchema>
): { text: string; timeliness: DiscussionTimeliness } {
  const timeliness = computeTimeliness({
    dueAt: body.dueAt ?? null,
    initialPostAt: body.submission.initialPosts[0]?.createdAt ?? null,
    replyDates: body.submission.replies.map((reply) => reply.createdAt ?? null)
  });
  const text = `${timelinessSection(timeliness)}\n\n${formatSubmission(body.submission)}`
    .slice(0, MAX_FORMATTED_LENGTH);
  return { text, timeliness };
}

const router = Router();

router.post("/submission", (request, response) => {
  try {
    const body = submissionImportSchema.parse(request.body);
    const course = requireActiveCourseSelection(body.selectedCourseToken);
    pruneExpired();
    const { text, timeliness } = buildFormattedSubmission(body);
    const capturedAt = body.capturedAt ?? new Date().toISOString();
    const expiresAtMs = Date.now() + SUBMISSION_TTL_MS;
    stagedSubmissions.set(`${course.id}\0${body.assignmentId}`, {
      localCourseId: course.id,
      assignmentName: body.assignmentName?.trim() || null,
      assignmentDirections: body.assignmentDirections?.trim() || null,
      capturedAt,
      expiresAt: new Date(expiresAtMs).toISOString(),
      initialPostCount: body.submission.initialPosts.length,
      replyCount: body.submission.replies.length,
      characters: text.length,
      timeliness,
      text,
      expiresAtMs
    });
    response.set("Cache-Control", "no-store").status(201).json({
      staged: true,
      expiresInMinutes: SUBMISSION_TTL_MINUTES,
      course: { code: course.code, section: course.section, term: course.term },
      initialPostCount: body.submission.initialPosts.length,
      replyCount: body.submission.replies.length
    });
  } catch (error) {
    throw error;
  }
});

router.get("/submission", (request, response) => {
  try {
    const { courseId } = z.object({ courseId: z.string().uuid() }).parse(request.query);
    pruneExpired();
    let newest: StagedEntry | null = null;
    for (const value of stagedSubmissions.values()) {
      if (value.localCourseId !== courseId) continue;
      if (!newest || value.capturedAt > newest.capturedAt) newest = value;
    }
    if (!newest) {
      response.set("Cache-Control", "no-store").json({ submission: null });
      return;
    }
    const { localCourseId, expiresAtMs, ...submission } = newest;
    void localCourseId; void expiresAtMs;
    response.set("Cache-Control", "no-store").json({ submission });
  } catch (error) {
    throw error;
  }
});

router.delete("/submission", (request, response) => {
  try {
    const { courseId } = z.object({ courseId: z.string().uuid() }).parse(request.query);
    for (const [key, value] of stagedSubmissions) {
      if (value.localCourseId === courseId) stagedSubmissions.delete(key);
    }
    response.status(204).end();
  } catch (error) {
    throw error;
  }
});

function promptFor(postText: string): string {
  return `You are an experienced university professor replying to a student's weekly discussion-board post.
Write a warm, substantive reply of 2 to 3 sentences, in first person, addressed to the student.
Acknowledge a specific point they made, add one insight or gentle probing question that deepens the discussion, and keep an encouraging, collegial academic tone.
Do not assign a grade or score. Do not use a salutation or signature. Return only the reply text with no preamble, quotation marks, or labels.
STUDENT POST:\n${postText}`;
}

router.post("/analyze", async (request, response) => {
  const { postText } = requestSchema.parse(request.body);
  let ollamaResponse: Response;
  try {
    ollamaResponse = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.ollamaModel,
        stream: false,
        messages: [
          { role: "system", content: "You are a supportive university professor. Reply in 2 to 3 sentences of plain text only." },
          { role: "user", content: promptFor(postText) }
        ],
        options: { temperature: 0.4 }
      }),
      signal: AbortSignal.timeout(config.ollamaTimeoutMs)
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new HttpError(504, `Local analysis timed out after ${Math.ceil(config.ollamaTimeoutMs / 1000)} seconds. Warm the Ollama model and try again.`);
    }
    throw new HttpError(503, "Local Ollama service is unavailable");
  }
  if (!ollamaResponse.ok) throw new HttpError(502, "Local Ollama analysis request failed");
  let envelope: { message?: { content?: string }; response?: string };
  try {
    envelope = await ollamaResponse.json() as { message?: { content?: string }; response?: string };
  } catch {
    throw new HttpError(502, "Local Ollama returned an unreadable response");
  }
  const raw = (envelope.message?.content ?? envelope.response ?? "").trim();
  if (!raw) throw new HttpError(502, "Local Ollama returned no response text");
  const reply = raw.replace(/^["'\s]+|["'\s]+$/g, "").slice(0, 2000);
  response.set("Cache-Control", "no-store").json({ model: config.ollamaModel, response: reply });
});

export const discussionsRouter = router;
