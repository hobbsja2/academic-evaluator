import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { AssignmentAttachment, AttachmentRole } from "../shared/types";
import {
  createAttachment, extractDocumentText, fetchAttachments, patchAttachment, removeAttachment
} from "./attachments-api";

const MAX_REQUIREMENTS_LENGTH = 4_000;
const PROMPT_BUDGET_LABEL = "2,000";
const ACCEPTED_FILE_TYPES = ".pdf,.doc,.docx,.odt,.rtf,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv";
const ROLE_OPTIONS: Array<{ value: AttachmentRole; label: string }> = [
  { value: "template", label: "Required template" },
  { value: "instructions", label: "Supplemental instructions" },
  { value: "reference", label: "Reference only" }
];
const ROLE_BADGES: Record<AttachmentRole, string> = {
  template: "Template", instructions: "Instructions", reference: "Reference"
};

type NoticeInput = { kind: "success" | "error" | "info"; text: string };

type AttachmentsPanelProps = {
  assignmentId: string | null;
  assignmentName: string | null;
  busy: string;
  setBusy: (value: string) => void;
  onNotice: (notice: NoticeInput) => void;
  onError: (error: unknown) => void;
};

type PendingUpload = {
  key: string;
  fileName: string;
  extractedText: string;
  role: AttachmentRole;
  requirements: string;
};

function roleSelect(
  id: string, value: AttachmentRole, disabled: boolean, onChange: (role: AttachmentRole) => void
) {
  return (
    <select id={id} value={value} disabled={disabled}
      onChange={(event) => onChange(event.target.value as AttachmentRole)}>
      {ROLE_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

/** Extracts one file, returning either a staged upload or a per-file error string. */
async function extractOne(file: File): Promise<PendingUpload | string> {
  try {
    const text = await extractDocumentText(file);
    if (!text) return `${file.name}: no readable text was found. A scanned or image-only file cannot be read.`;
    return {
      key: `${file.name}-${file.size}-${file.lastModified}`,
      fileName: file.name,
      extractedText: text,
      role: "template",
      requirements: text.slice(0, MAX_REQUIREMENTS_LENGTH)
    };
  } catch (error) {
    return `${file.name}: ${error instanceof Error ? error.message : "extraction failed"}`;
  }
}

/** Reads every file, keeping per-file outcomes so one bad file cannot hide the rest. */
async function stageFiles(files: File[]): Promise<{ added: PendingUpload[]; failures: string[] }> {
  const added: PendingUpload[] = [];
  const failures: string[] = [];
  for (const file of files) {
    try {
      const outcome = await extractOne(file);
      if (typeof outcome === "string") failures.push(outcome);
      else added.push(outcome);
    } catch (error) {
      failures.push(`${file.name}: ${error instanceof Error ? error.message : "extraction failed"}`);
    }
  }
  return { added, failures };
}

async function persistPending(
  assignmentId: string, pending: PendingUpload[]
): Promise<{ saved: string[]; failed: string[] }> {
  const saved: string[] = [];
  const failed: string[] = [];
  for (const item of pending) {
    try {
      await createAttachment({
        assignmentId,
        fileName: item.fileName,
        role: item.role,
        extractedText: item.extractedText,
        requirements: item.requirements.trim() || null
      });
      saved.push(item.fileName);
    } catch (error) {
      failed.push(`${item.fileName}: ${error instanceof Error ? error.message : "save failed"}`);
    }
  }
  return { saved, failed };
}

function PanelHeading() {
  return (
    <div className="section-heading">
      <div><span className="step">4</span><h2 id="attachments-heading">Assignment files</h2></div>
      <p>Templates and extra instruction files that came with the assignment.</p>
    </div>
  );
}

type UploadFieldProps = { reading: boolean; onFiles: (files: File[]) => void };

function UploadField({ reading, onFiles }: UploadFieldProps) {
  return (
    <>
      <label htmlFor="attachment-file">Add files</label>
      <input id="attachment-file" type="file" multiple accept={ACCEPTED_FILE_TYPES} disabled={reading}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length) onFiles(files);
        }} />
      <small>
        Select one or more files. Accepts {ACCEPTED_FILE_TYPES.replace(/\./g, "").toUpperCase()}.
        Workbooks and decks convert through LibreOffice, so every sheet and slide is read.
        {reading ? " Reading files…" : ""}
      </small>
    </>
  );
}

type PendingCardProps = {
  item: PendingUpload;
  disabled: boolean;
  onChange: (key: string, patch: Partial<PendingUpload>) => void;
  onRemove: (key: string) => void;
};

function PendingCard({ item, disabled, onChange, onRemove }: PendingCardProps) {
  return (
    <div className="directions-editor">
      <h4>{item.fileName}</h4>
      <label htmlFor={`pending-role-${item.key}`}>Role</label>
      {roleSelect(`pending-role-${item.key}`, item.role, disabled, (role) => onChange(item.key, { role }))}
      <label htmlFor={`pending-requirements-${item.key}`}>Requirements to apply when grading</label>
      <textarea id={`pending-requirements-${item.key}`} rows={8} maxLength={MAX_REQUIREMENTS_LENGTH}
        value={item.requirements} disabled={disabled}
        onChange={(event) => onChange(item.key, { requirements: event.target.value })} />
      <small>Prefilled with the extracted text. Trim it to the requirements you actually want checked — only the first {PROMPT_BUDGET_LABEL} characters reach the grader.</small>
      <div className="button-row">
        <button className="secondary" type="button" disabled={disabled} onClick={() => onRemove(item.key)}>
          Remove {item.fileName}
        </button>
      </div>
    </div>
  );
}

type PendingSectionProps = {
  pending: PendingUpload[];
  saving: boolean;
  onAttachAll: () => void;
  onDiscardAll: () => void;
  onChange: (key: string, patch: Partial<PendingUpload>) => void;
  onRemove: (key: string) => void;
};

function PendingSection({
  pending, saving, onAttachAll, onDiscardAll, onChange, onRemove
}: PendingSectionProps) {
  if (!pending.length) return null;
  return (
    <>
      <div className="button-row">
        <button className="primary large" type="button" disabled={saving} onClick={onAttachAll}>
          {saving ? "Attaching…" : `Attach ${pending.length} file(s) to assignment`}
        </button>
        <button className="secondary large" type="button" disabled={saving} onClick={onDiscardAll}>
          Discard all
        </button>
      </div>
      {pending.map((item) => (
        <PendingCard key={item.key} item={item} disabled={saving} onChange={onChange} onRemove={onRemove} />
      ))}
    </>
  );
}

type AttachmentRowProps = {
  attachment: AssignmentAttachment;
  busy: string;
  onSave: (id: string, patch: Partial<AssignmentAttachment>) => void;
  onDelete: (id: string, fileName: string) => void;
};

function AttachmentRow({ attachment, busy, onSave, onDelete }: AttachmentRowProps) {
  const [requirements, setRequirements] = useState(attachment.requirements ?? "");
  const saving = busy === `attachment-${attachment.id}`;
  return (
    <div className="result-card">
      <div className="result-header">
        <div>
          <span>{ROLE_BADGES[attachment.role]}</span>
          <h3>{attachment.fileName}</h3>
        </div>
        <span className="badge ready">{attachment.extractedCharacters.toLocaleString()} chars extracted</span>
      </div>
      <div className="approval-editor">
        <label htmlFor={`role-${attachment.id}`}>Role</label>
        {roleSelect(`role-${attachment.id}`, attachment.role, saving, (role) => onSave(attachment.id, { role }))}
        <label className="check-row" htmlFor={`include-${attachment.id}`}>
          <input id={`include-${attachment.id}`} type="checkbox" checked={attachment.includeInGrading}
            disabled={saving}
            onChange={(event) => onSave(attachment.id, { includeInGrading: event.target.checked })} />
          <span>Apply this file when grading</span>
        </label>
        <label htmlFor={`requirements-${attachment.id}`}>Requirements used at grading time</label>
        <textarea id={`requirements-${attachment.id}`} rows={6} maxLength={MAX_REQUIREMENTS_LENGTH}
          value={requirements} disabled={saving}
          placeholder="List the checkable requirements from this file, one per line."
          onChange={(event) => setRequirements(event.target.value)} />
        <small>{requirements.length.toLocaleString()} / {MAX_REQUIREMENTS_LENGTH.toLocaleString()} characters. Only the first {PROMPT_BUDGET_LABEL} characters reach the grader.</small>
        <div className="button-row">
          <button type="button" disabled={saving}
            onClick={() => onSave(attachment.id, { requirements: requirements.trim() || null })}>
            {saving ? "Saving…" : "Save requirements"}
          </button>
          <button className="secondary" type="button" disabled={saving}
            onClick={() => onDelete(attachment.id, attachment.fileName)}>Remove</button>
        </div>
      </div>
    </div>
  );
}

function NoAssignmentNotice() {
  return (
    <section className="panel" aria-labelledby="attachments-heading">
      <PanelHeading />
      <p className="warning-text">Select a saved rubric first. Files attach to the assignment, so they stay in place when you re-capture the rubric from Canvas.</p>
    </section>
  );
}

function useAttachmentList(assignmentId: string | null, onError: (error: unknown) => void) {
  const [attachments, setAttachments] = useState<AssignmentAttachment[]>([]);
  const reload = useCallback(async () => {
    if (!assignmentId) { setAttachments([]); return; }
    try {
      setAttachments(await fetchAttachments(assignmentId));
    } catch (error) {
      onError(error);
    }
  }, [assignmentId, onError]);
  useEffect(() => { void reload(); }, [reload]);
  return { attachments, reload };
}

type ActionDeps = {
  assignmentId: string | null;
  pending: PendingUpload[];
  setPending: Dispatch<SetStateAction<PendingUpload[]>>;
  reload: () => Promise<void>;
  setBusy: (value: string) => void;
  onNotice: (notice: NoticeInput) => void;
  onError: (error: unknown) => void;
};

function useAttachmentActions(deps: ActionDeps) {
  const { assignmentId, pending, setPending, reload, setBusy, onNotice, onError } = deps;

  async function handleFiles(files: File[]): Promise<void> {
    setBusy("attachment-extract");
    try {
      const { added, failures } = await stageFiles(files);
      if (added.length) {
        setPending((current) => [
          ...current.filter((item) => !added.some((entry) => entry.key === item.key)), ...added
        ]);
      }
      if (failures.length) onNotice({ kind: "error", text: `${failures.length} of ${files.length} file(s) could not be read. ${failures.join(" ")}` });
      else onNotice({ kind: "info", text: `Read ${added.length} file(s). Trim each one to the checkable requirements, then attach.` });
    } finally { setBusy(""); }
  }

  async function attachAll(): Promise<void> {
    if (!assignmentId) return;
    setBusy("attachment-save");
    try {
      const { saved, failed } = await persistPending(assignmentId, pending);
      setPending((current) => current.filter((item) => !saved.includes(item.fileName)));
      await reload();
      if (failed.length) onNotice({ kind: "error", text: `Attached ${saved.length}. Failed: ${failed.join(" ")}` });
      else onNotice({ kind: "success", text: `Attached ${saved.length} file(s) to this assignment.` });
    } finally { setBusy(""); }
  }

  async function runUpdate(id: string, action: () => Promise<void>, message: string): Promise<void> {
    setBusy(`attachment-${id}`);
    try {
      await action();
      await reload();
      onNotice({ kind: "success", text: message });
    } catch (error) { onError(error); } finally { setBusy(""); }
  }

  return { handleFiles, attachAll, runUpdate };
}

export function AttachmentsPanel({
  assignmentId, assignmentName, busy, setBusy, onNotice, onError
}: AttachmentsPanelProps) {
  const { attachments, reload } = useAttachmentList(assignmentId, onError);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  useEffect(() => { setPending([]); }, [assignmentId]);
  const { handleFiles, attachAll, runUpdate } = useAttachmentActions({
    assignmentId, pending, setPending, reload, setBusy, onNotice, onError
  });

  if (!assignmentId) return <NoAssignmentNotice />;

  const appliedCount = attachments.filter((item) => item.includeInGrading).length;
  return (
    <section className="panel" aria-labelledby="attachments-heading">
      <PanelHeading />
      <p className="scoring-note">
        {assignmentName ? `Attached to ${assignmentName}. ` : ""}
        {appliedCount} of {attachments.length} file(s) will be applied when grading. These inform existing rubric criteria; they never add new criteria or point values.
      </p>
      <UploadField reading={busy === "attachment-extract"} onFiles={(files) => void handleFiles(files)} />
      <PendingSection
        pending={pending}
        saving={busy === "attachment-save"}
        onAttachAll={() => void attachAll()}
        onDiscardAll={() => setPending([])}
        onChange={(key, patch) => setPending((current) => current.map((item) => item.key === key ? { ...item, ...patch } : item))}
        onRemove={(key) => setPending((current) => current.filter((item) => item.key !== key))}
      />
      {attachments.length > 0 && <div className="results">
        {attachments.map((attachment) => (
          <AttachmentRow key={attachment.id} attachment={attachment} busy={busy}
            onSave={(id, patch) => void runUpdate(id, () => patchAttachment(id, patch), "Attachment updated.")}
            onDelete={(id, fileName) => void runUpdate(id, () => removeAttachment(id), `${fileName} removed.`)} />
        ))}
      </div>}
    </section>
  );
}
