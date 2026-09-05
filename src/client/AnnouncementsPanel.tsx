import { useCallback, useEffect, useState } from "react";
import type { AnnouncementDraft, InstructorProfile } from "../shared/types";
import { api, jsonInit } from "./api-client";

const MAX_RESUME_LENGTH = 20_000;
const MAX_INTRODUCTION_LENGTH = 20_000;
const MAX_OVERVIEW_LENGTH = 50_000;
const MAX_NOTES_LENGTH = 2_000;

type NoticeInput = { kind: "success" | "error" | "info"; text: string };

type AnnouncementsPanelProps = {
  courseId: string;
  courseLabel: string | null;
  busy: string;
  setBusy: (value: string) => void;
  onNotice: (notice: NoticeInput) => void;
  onError: (error: unknown) => void;
};

type DocumentFieldProps = {
  id: string;
  label: string;
  hint: string;
  value: string;
  rows: number;
  maxLength: number;
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onUpload: (file: File) => void;
};

function DocumentField({
  id, label, hint, value, rows, maxLength, placeholder, disabled, onChange, onUpload
}: DocumentFieldProps) {
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <input
        id={`${id}-file`}
        type="file"
        accept=".doc,.docx,.pdf"
        disabled={disabled}
        aria-label={`Upload a document for ${label}`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onUpload(file);
        }}
      />
      <textarea
        id={id}
        rows={rows}
        maxLength={maxLength}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <small>{value.length.toLocaleString()} / {maxLength.toLocaleString()} characters. {hint}</small>
    </div>
  );
}

export function AnnouncementsPanel({
  courseId, courseLabel, busy, setBusy, onNotice, onError
}: AnnouncementsPanelProps) {
  const [resumeText, setResumeText] = useState("");
  const [courseIntroduction, setCourseIntroduction] = useState("");
  const [profileUpdatedAt, setProfileUpdatedAt] = useState<string | null>(null);
  const [moduleTitle, setModuleTitle] = useState("");
  const [weekLabel, setWeekLabel] = useState("");
  const [moduleOverview, setModuleOverview] = useState("");
  const [additionalNotes, setAdditionalNotes] = useState("");
  const [includeResume, setIncludeResume] = useState(true);
  const [announcement, setAnnouncement] = useState("");
  const [model, setModel] = useState("");

  const loadProfile = useCallback(async (targetCourseId: string) => {
    if (!targetCourseId) return;
    try {
      const params = new URLSearchParams({ courseId: targetCourseId });
      const { profile } = await api<{ profile: InstructorProfile }>(`/api/announcements/profile?${params}`);
      setResumeText(profile.resumeText ?? "");
      setCourseIntroduction(profile.courseIntroduction ?? "");
      setProfileUpdatedAt(profile.updatedAt);
    } catch (error) {
      onError(error);
    }
  }, [onError]);

  useEffect(() => {
    setAnnouncement("");
    setModuleTitle("");
    setWeekLabel("");
    setModuleOverview("");
    setAdditionalNotes("");
    setResumeText("");
    setCourseIntroduction("");
    setProfileUpdatedAt(null);
    void loadProfile(courseId);
  }, [courseId, loadProfile]);

  async function uploadInto(file: File, target: (text: string) => void, busyKey: string) {
    setBusy(busyKey);
    const body = new FormData();
    body.append("file", file);
    try {
      const response = await api<{ text: string }>("/api/documents/extract", { method: "POST", body });
      target(response.text.trim());
      onNotice({ kind: "success", text: `Extracted text from ${file.name}. Review it before generating.` });
    } catch (error) {
      onError(error);
    } finally {
      setBusy("");
    }
  }

  async function saveProfile() {
    setBusy("announcement-profile");
    try {
      const { profile } = await api<{ profile: InstructorProfile }>(
        "/api/announcements/profile", jsonInit("PUT", {
          courseId,
          resumeText: resumeText.trim() || null,
          courseIntroduction: courseIntroduction.trim() || null
        }));
      setProfileUpdatedAt(profile.updatedAt);
      onNotice({ kind: "success", text: "Reference material saved for this course. It will be reused for every module." });
    } catch (error) { onError(error); } finally { setBusy(""); }
  }

  async function generateAnnouncement() {
    if (!moduleTitle.trim() || !moduleOverview.trim()) return;
    setBusy("announcement"); setAnnouncement("");
    try {
      const draft = await api<AnnouncementDraft>("/api/announcements/generate", jsonInit("POST", {
        courseId,
        moduleTitle: moduleTitle.trim(),
        weekLabel: weekLabel.trim() || null,
        moduleOverview: moduleOverview.trim(),
        additionalNotes: additionalNotes.trim() || null,
        includeResume
      }));
      setAnnouncement(draft.announcement); setModel(draft.model);
      onNotice({ kind: "success", text: "Draft announcement generated. Review and edit before posting to Canvas." });
    } catch (error) { onError(error); } finally { setBusy(""); }
  }

  async function copyAnnouncement() {
    const text = announcement.trim();
    if (!text || busy === "copy-announcement") return;
    setBusy("copy-announcement");
    try {
      await navigator.clipboard.writeText(text);
      onNotice({ kind: "success", text: "Announcement copied." });
    } catch {
      onNotice({ kind: "error", text: "Clipboard access was blocked. Select and copy the announcement manually." });
    } finally { setBusy(""); }
  }

  if (!courseId) {
    return (
      <section className="panel" aria-labelledby="announcement-heading">
        <div className="section-heading">
          <div><span className="step">A</span><h2 id="announcement-heading">Module announcement</h2></div>
        </div>
        <p className="warning-text">Select a course in the Grading tab first. Announcements use the course code, term, and its saved reference material.</p>
      </section>
    );
  }

  const canGenerate = Boolean(moduleTitle.trim() && moduleOverview.trim()) && busy !== "announcement";
  return (
    <>
      <section className="panel" aria-labelledby="reference-heading">
        <div className="section-heading">
          <div><span className="step">A</span><h2 id="reference-heading">Reference material</h2></div>
          <p>Saved once per course and reused for every weekly announcement.</p>
        </div>
        <p className="scoring-note">
          {courseLabel ? `Stored for ${courseLabel}. ` : ""}
          This is your own material, not student data. It is saved in the configured database and is removed with the course when its retention window ends.
        </p>
        <div className="two-column">
          <DocumentField
            id="course-introduction"
            label="Course introduction"
            hint="How you normally frame this course for students."
            value={courseIntroduction}
            rows={9}
            maxLength={MAX_INTRODUCTION_LENGTH}
            placeholder="Upload or paste your course introduction."
            disabled={busy === "announcement-introduction"}
            onChange={setCourseIntroduction}
            onUpload={(file) => void uploadInto(file, setCourseIntroduction, "announcement-introduction")}
          />
          <DocumentField
            id="resume-text"
            label="Resume or professional background"
            hint="Only used for a brief credibility line. Never embellished."
            value={resumeText}
            rows={9}
            maxLength={MAX_RESUME_LENGTH}
            placeholder="Upload or paste your resume."
            disabled={busy === "announcement-resume"}
            onChange={setResumeText}
            onUpload={(file) => void uploadInto(file, setResumeText, "announcement-resume")}
          />
        </div>
        <div className="button-row">
          <button type="button" disabled={busy === "announcement-profile"} onClick={() => void saveProfile()}>
            {busy === "announcement-profile" ? "Saving…" : "Save reference material"}
          </button>
          {profileUpdatedAt && <span className="model-chip">Last saved {profileUpdatedAt.slice(0, 16).replace("T", " ")}</span>}
        </div>
      </section>

      <section className="panel" aria-labelledby="module-heading">
        <div className="section-heading">
          <div><span className="step">B</span><h2 id="module-heading">This week's module</h2></div>
          <p>Upload the Module Overview and Objectives, then generate the opening announcement.</p>
        </div>
        <div className="form-grid">
          <div>
            <label htmlFor="module-title">Module title</label>
            <input id="module-title" maxLength={200} value={moduleTitle} placeholder="Ethical Decision Making"
              onChange={(event) => setModuleTitle(event.target.value)} />
          </div>
          <div>
            <label htmlFor="week-label">Week or module label (optional)</label>
            <input id="week-label" maxLength={80} value={weekLabel} placeholder="Week 3"
              onChange={(event) => setWeekLabel(event.target.value)} />
          </div>
        </div>
        <DocumentField
          id="module-overview"
          label="Module overview and objectives"
          hint="The only source for module content. Nothing outside this text will be invented."
          value={moduleOverview}
          rows={12}
          maxLength={MAX_OVERVIEW_LENGTH}
          placeholder="Upload or paste the Module Overview and Objectives."
          disabled={busy === "announcement-overview"}
          onChange={setModuleOverview}
          onUpload={(file) => void uploadInto(file, setModuleOverview, "announcement-overview")}
        />
        <div className="directions-editor">
          <label htmlFor="additional-notes">Additional notes to include (optional)</label>
          <textarea id="additional-notes" rows={3} maxLength={MAX_NOTES_LENGTH} value={additionalNotes}
            placeholder="Reminders the model cannot infer, such as a due date or a live session time."
            onChange={(event) => setAdditionalNotes(event.target.value)} />
          <small>Dates and deadlines are only included when you state them here or in the overview.</small>
          <label className="check-row" htmlFor="include-resume">
            <input id="include-resume" type="checkbox" checked={includeResume}
              onChange={(event) => setIncludeResume(event.target.checked)} />
            <span>Reference my professional background in one short sentence</span>
          </label>
        </div>
        <div className="button-row">
          <button className="primary large" type="button" disabled={!canGenerate} onClick={() => void generateAnnouncement()}>
            {busy === "announcement" ? "Generating locally…" : "Generate announcement"}
          </button>
          <button className="secondary large" type="button" disabled={busy === "announcement"}
            onClick={() => { setModuleOverview(""); setAdditionalNotes(""); setAnnouncement(""); setModuleTitle(""); setWeekLabel(""); }}>
            Clear module
          </button>
        </div>
        {announcement && <div className="discussion-reply">
          <div className="results-title">
            <div><p className="eyebrow">Draft — review before posting</p><h3>Opening announcement</h3></div>
            <span className="model-chip">Model: {model}</span>
          </div>
          <label htmlFor="announcement-text">Announcement text</label>
          <textarea id="announcement-text" rows={14} maxLength={6000} value={announcement}
            onChange={(event) => setAnnouncement(event.target.value)} />
          <div className="button-row">
            <button type="button" disabled={busy === "copy-announcement"} onClick={() => void copyAnnouncement()}>Copy announcement</button>
          </div>
          <small>Verify every date, name, and credential before posting. The model drafts only.</small>
        </div>}
      </section>
    </>
  );
}
