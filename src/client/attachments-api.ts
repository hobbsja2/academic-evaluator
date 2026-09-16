import type { AssignmentAttachment, AttachmentRole } from "../shared/types";
import { api, jsonInit } from "./api-client";

export type AttachmentCreateInput = {
  assignmentId: string;
  fileName: string;
  role: AttachmentRole;
  extractedText: string;
  requirements: string | null;
};

export type AttachmentPatch = {
  role?: AttachmentRole;
  includeInGrading?: boolean;
  requirements?: string | null;
};

/** Preserves the server's message when there is one, so the UI can show it verbatim. */
function describe(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

export async function fetchAttachments(assignmentId: string): Promise<AssignmentAttachment[]> {
  const params = new URLSearchParams({ assignmentId });
  try {
    const response = await api<{ attachments: AssignmentAttachment[] }>(`/api/attachments?${params}`);
    return response.attachments;
  } catch (error) {
    throw describe(error, "The attachment list could not be loaded.");
  }
}

export async function createAttachment(input: AttachmentCreateInput): Promise<void> {
  try {
    await api<{ attachment: AssignmentAttachment }>("/api/attachments", jsonInit("POST", input));
  } catch (error) {
    throw describe(error, "The attachment could not be saved.");
  }
}

export async function patchAttachment(id: string, patch: AttachmentPatch): Promise<void> {
  try {
    await api<{ attachment: AssignmentAttachment }>(`/api/attachments/${id}`, jsonInit("PATCH", patch));
  } catch (error) {
    throw describe(error, "The attachment could not be updated.");
  }
}

export async function removeAttachment(id: string): Promise<void> {
  try {
    await api<void>(`/api/attachments/${id}`, { method: "DELETE" });
  } catch (error) {
    throw describe(error, "The attachment could not be removed.");
  }
}

export async function extractDocumentText(file: File): Promise<string> {
  const body = new FormData();
  body.append("file", file);
  try {
    const response = await api<{ text: string }>("/api/documents/extract", { method: "POST", body });
    return response.text.trim();
  } catch (error) {
    throw describe(error, "The document text could not be extracted.");
  }
}
