import { Router } from "express";
import { z } from "zod";
import { config } from "./config.js";
import { HttpError } from "./errors.js";

const requestSchema = z.object({
  postText: z.string().trim().min(1).max(20_000)
});

const router = Router();

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
