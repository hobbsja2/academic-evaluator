import React, { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  AiUseAssessment, AttachmentFinding, AttachmentSnapshot, Course, GradeCriterionResult, NormalizedRubric,
  RosterStudent, StagedDiscussionSubmission
} from "../shared/types";
import { AiUsePanel, aiUseBand } from "./AiUsePanel";
import { AnnouncementsPanel } from "./AnnouncementsPanel";
import { AttachmentsPanel } from "./AttachmentsPanel";
import { ApiError, api, jsonInit } from "./api-client";

type Health = {
  status: string;
  database: { configured: boolean; connected: boolean };
  ollama: { available: boolean; model: string; modelAvailable: boolean };
  libreOffice: { available: boolean; version: string | null };
  retention: { lastAttemptAt: string | null; lastSuccessAt: string | null; consecutiveFailures: number; lastErrorName: string | null };
};
type StoredRubric = NormalizedRubric & { id?: string; version?: number };
type RubricList = { memory: NormalizedRubric[]; persisted: StoredRubric[] };
type ActiveCourseSelection = Pick<Course, "id" | "code" | "section" | "title" | "term"> & { token: string };
type Notice = { kind: "success" | "error" | "info"; text: string } | null;
type HistoryRun = {
  id: string; createdAt: string; apaEnabled: boolean; model: string;
  assignmentName: string; rubricTitle: string | null; version: number;
  aiUseScore: number | null;
  results: Array<{ criterionName: string | null; approvedRating: string; approvedPoints: number; approvedExplanation: string }>;
};

type CourseForm = {
  code: string; section: string; title: string; term: string; startDate: string; endDate: string;
  canvasCourseId: string; canvasUrl: string;
};
const emptyCourse: CourseForm = {
  code: "", section: "", title: "", term: "", startDate: "", endDate: "", canvasCourseId: "", canvasUrl: "",
};

function labelForRubric(rubric: NormalizedRubric): string {
  return rubric.rubricTitle || rubric.assignmentName || "Untitled rubric";
}
// A purge that keeps failing used to be visible only on the server's stderr.
function retentionLabel(health: Health | null): string {
  if (!health) return "Automatic purge status unknown";
  const { consecutiveFailures, lastErrorName, lastAttemptAt } = health.retention;
  if (consecutiveFailures > 0) {
    return `Automatic purge failing (${consecutiveFailures}× ${lastErrorName ?? "unknown cause"})`;
  }
  // Without a database the purge never runs, so it has not earned "healthy".
  return lastAttemptAt ? "Automatic purge healthy" : "Automatic purge idle";
}
function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(`${value}T00:00:00`));
}
// Two students can share a name, so the pseudonym tail is appended to tell them
// apart — and only then, to keep the common case readable.
function studentOptionLabel(student: RosterStudent, students: RosterStudent[]): string {
  if (!student.name) return student.pseudonym;
  const repeated = students.filter((item) => item.name === student.name).length > 1;
  return repeated ? `${student.name} (…${student.pseudonym.slice(-4)})` : student.name;
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState("");
  const [extensionCourseId, setExtensionCourseId] = useState("");
  const [courseForm, setCourseForm] = useState<CourseForm>(emptyCourse);
  const [extendedEndDate, setExtendedEndDate] = useState("");
  const [rubrics, setRubrics] = useState<StoredRubric[]>([]);
  const [rubricIndex, setRubricIndex] = useState("");
  const [assignmentDirections, setAssignmentDirections] = useState("");
  const [rosterFile, setRosterFile] = useState<File | null>(null);
  const [roster, setRoster] = useState<RosterStudent[]>([]);
  // The global notice renders at the top of a 2700px page, far above the roster
  // control, so every import outcome is also reported inside the roster panel.
  const [rosterMessage, setRosterMessage] = useState<Notice>(null);
  const [documentName, setDocumentName] = useState("");
  const [submissionText, setSubmissionText] = useState("");
  const [pseudonym, setPseudonym] = useState("");
  const [apaEnabled, setApaEnabled] = useState(false);
  const [gradingBackend, setGradingBackend] = useState<"ollama" | "claude">("ollama");
  const [results, setResults] = useState<GradeCriterionResult[]>([]);
  const [attachmentFindings, setAttachmentFindings] = useState<AttachmentFinding[]>([]);
  const [aiUseAssessment, setAiUseAssessment] = useState<AiUseAssessment | null>(null);
  const [gradingRunId, setGradingRunId] = useState<string | null>(null);
  const [appliedAttachments, setAppliedAttachments] = useState<AttachmentSnapshot[]>([]);
  const [stagedDiscussion, setStagedDiscussion] = useState<StagedDiscussionSubmission | null>(null);
  const [gradingPolicy, setGradingPolicy] = useState("");
  const [history, setHistory] = useState<HistoryRun[]>([]);
  const [model, setModel] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState("");
  const [activeTab, setActiveTab] = useState<"grading" | "discussions" | "announcements">("grading");
  const [discussionPost, setDiscussionPost] = useState("");
  const [discussionReply, setDiscussionReply] = useState("");

  const selectedCourse = courses.find((course) => course.id === courseId);
  // Display only. Every request body carries the pseudonym, never the name.
  const studentLabel = roster.find((student) => student.pseudonym === pseudonym)?.name ?? pseudonym;
  const selectedRubric = rubricIndex === "" ? undefined : rubrics[Number(rubricIndex)];
  // Persisted rubrics carry the local assignment UUID; memory and fixture rubrics
  // carry a Canvas identifier instead, which attachments cannot key on.
  const attachmentAssignmentId = selectedRubric?.id ? selectedRubric.assignmentId : null;
  const extractionStats = useMemo(() => submissionText ? {
    characters: submissionText.length,
    words: submissionText.trim().split(/\s+/).filter(Boolean).length,
    pages: Math.max(1, Math.ceil(submissionText.length / 3000)),
  } : null, [submissionText]);

  useEffect(() => {
    void api<Health>("/api/health").then(setHealth).catch((error) => showError(error));
    void (async () => {
      try {
        const { courses: values } = await api<{ courses: Course[] }>("/api/courses");
        setCourses(values);
        await activateCourse(values[0]?.id || "", false);
      } catch (error) {
        showError(error);
      }
    })();
  }, []);

  useEffect(() => {
    setExtendedEndDate(selectedCourse?.endDate ?? "");
  }, [selectedCourse?.id, selectedCourse?.endDate]);

  useEffect(() => {
    setGradingPolicy(selectedCourse?.gradingPolicy ?? "");
  }, [selectedCourse?.id, selectedCourse?.gradingPolicy]);

  useEffect(() => {
    setAssignmentDirections(selectedRubric?.assignmentDirections ?? "");
  }, [rubricIndex, selectedRubric?.assignmentDirections]);

  // The single place the roster is fetched. Fires on mount and on every course change.
  useEffect(() => {
    void loadRoster(selectedCourse?.id ?? "");
  }, [selectedCourse?.id]);

  // Stable identity is required: child panels list onError in hook dependencies, and
  // a new function on every render re-ran AnnouncementsPanel's reset effect, which
  // wiped a freshly generated draft the moment the app re-rendered.
  const showError = useCallback((error: unknown): void => {
    setNotice({ kind: "error", text: error instanceof Error ? error.message : "Unexpected error" });
  }, []);

  async function loadCourseRubrics(targetCourseId: string) {
    try {
      const params = new URLSearchParams({ courseId: targetCourseId });
      const { memory, persisted } = await api<RubricList>(`/api/rubrics?${params}`);
      setRubrics([...persisted, ...memory]);
    } catch (error) {
      throw error;
    }
  }

  async function activateCourse(targetCourseId: string, announce = true) {
    setCourseId(targetCourseId);
    setExtensionCourseId("");
    setRubrics([]);
    setRubricIndex("");
    setAssignmentDirections("");
    setResults([]);
    setHistory([]);
    setPseudonym("");
    setStagedDiscussion(null);
    if (announce) setBusy("course-selection");
    try {
      if (!targetCourseId) {
        await api<void>("/api/courses/active", { method: "DELETE" });
        if (announce) setNotice({ kind: "info", text: "No active course. Canvas imports are disabled until a course is selected." });
        return;
      }
      const selection = await api<{ activeCourse: ActiveCourseSelection }>(
        "/api/courses/active", jsonInit("PUT", { courseId: targetCourseId }));
      setExtensionCourseId(selection.activeCourse.id);
      await loadCourseRubrics(targetCourseId);
      if (announce) {
        setNotice({
          kind: "success",
          text: `${selection.activeCourse.code} section ${selection.activeCourse.section} is now the Canvas extension import target.`
        });
      }
    } catch (error) {
      setRubrics([]);
      showError(error);
    } finally {
      if (announce) setBusy("");
    }
  }

  async function refreshCourseRubrics() {
    if (!courseId) return;
    setBusy("rubrics");
    try {
      const selection = await api<{ activeCourse: ActiveCourseSelection }>(
        "/api/courses/active", jsonInit("PUT", { courseId }));
      setExtensionCourseId(selection.activeCourse.id);
      await loadCourseRubrics(courseId);
      setRubricIndex("");
      setNotice({ kind: "success", text: "Rubrics refreshed and this course reactivated for Canvas imports." });
    } catch (error) { showError(error); } finally { setBusy(""); }
  }

  async function createCourse(event: FormEvent) {
    event.preventDefault(); setBusy("course"); setNotice(null);
    try {
      const created = await api<Course>("/api/courses", jsonInit("POST", {
        ...courseForm,
        title: courseForm.title || null,
        canvasCourseId: courseForm.canvasCourseId || null,
        canvasUrl: courseForm.canvasUrl || null,
      }));
      setCourses((current) => [created, ...current]);
      setCourseForm(emptyCourse);
      await activateCourse(created.id, false);
      setNotice({ kind: "success", text: `${created.code} section ${created.section} created and selected for Canvas imports.` });
    } catch (error) { showError(error); } finally { setBusy(""); }
  }
  async function deleteCourse(course: Course) {
    const warning = `Delete ${course.code} section ${course.section}? This can also remove related rosters, rubrics, and grading records. This cannot be undone.`;
    if (!window.confirm(warning)) return;
    setBusy("delete");
    try {
      await api<void>(`/api/courses/${course.id}`, { method: "DELETE" });
      const remaining = courses.filter((item) => item.id !== course.id);
      setCourses(remaining);
      await activateCourse(remaining[0]?.id || "", false);
      setNotice({ kind: "success", text: "Course deleted." });
    } catch (error) { showError(error); } finally { setBusy(""); }
  }

  async function updateCourseEndDate(course: Course) {
    if (!extendedEndDate || extendedEndDate === course.endDate) return;
    setBusy("extend");
    try {
      const updated = await api<Course>(`/api/courses/${course.id}`, jsonInit("PATCH", { endDate: extendedEndDate }));
      setCourses((current) => current.map((item) => item.id === updated.id ? updated : item));
      setNotice({ kind: "success", text: `Course end date updated. Data is now scheduled for purge on ${formatDate(updated.purgeAfter)}.` });
    } catch (error) { showError(error); } finally { setBusy(""); }
  }

  async function loadRoster(targetCourseId: string): Promise<void> {
    setRoster([]);
    if (!targetCourseId) return;
    try {
      const params = new URLSearchParams({ courseId: targetCourseId });
      const { students } = await api<{ students: RosterStudent[] }>(`/api/rosters?${params}`);
      setRoster(students);
    } catch (error) {
      // Without a database there is no roster to load, and the rest of the app
      // still works, so a 503 is not surfaced as an error.
      if (error instanceof ApiError && error.status === 503) return;
      showError(error);
    }
  }

  // Every exit path sets rosterMessage. The two guards used to return silently,
  // which is what made a click on Import roster look like nothing happened.
  async function importRoster(): Promise<void> {
    setNotice(null);
    setRosterMessage(null);
    if (!selectedCourse) {
      setRosterMessage({ kind: "error", text: "Select a course first, then import its roster." });
      return;
    }
    if (!rosterFile) {
      setRosterMessage({ kind: "error", text: "Choose a roster CSV file first." });
      return;
    }
    setBusy("roster");
    const body = new FormData();
    body.append("file", rosterFile);
    body.append("courseId", selectedCourse.id);
    try {
      const response = await api<{ imported: number; students: RosterStudent[] }>(
        "/api/rosters/import", { method: "POST", body });
      setRoster(response.students);
      const text = `${response.imported} students imported. Select a student in the grading section below.`;
      setRosterMessage({ kind: "success", text });
      setNotice({ kind: "success", text: `${response.imported} students imported.` });
    } catch (error) {
      setRosterMessage({
        kind: "error",
        text: `Roster import failed. ${error instanceof Error ? error.message : "Unexpected error"}`,
      });
      showError(error);
    } finally { setBusy(""); }
  }

  async function loadFixture() {
    setBusy("fixture");
    try {
      const response = await api<{ rubric: NormalizedRubric; metadata: unknown }>("/api/rubrics/fixture/assignment-1-3");
      setRubrics((current) => {
        const next = [...current, response.rubric]; setRubricIndex(String(next.length - 1)); return next;
      });
      setNotice({ kind: "info", text: "Fixture loaded. Its rating descriptors are incomplete; recapture the official Canvas rubric before real grading." });
    } catch (error) { showError(error); } finally { setBusy(""); }
  }

  async function saveAssignmentDirections() {
    if (!selectedRubric?.id) return;
    setBusy("directions");
    try {
      const updated = await api<{ id: string; assignmentDirections: string | null }>(
        `/api/rubrics/${selectedRubric.id}/directions`,
        jsonInit("PATCH", { assignmentDirections: assignmentDirections.trim() || null }),
      );
      setRubrics((current) => current.map((rubric, index) =>
        index === Number(rubricIndex) ? { ...rubric, assignmentDirections: updated.assignmentDirections } : rubric));
      setAssignmentDirections(updated.assignmentDirections ?? "");
      setNotice({ kind: "success", text: "Assignment directions saved with this rubric version." });
    } catch (error) { showError(error); } finally { setBusy(""); }
  }

  // Pulls the discussion response and peer replies staged by the Canvas extension
  // from a SpeedGrader page. Held in server memory only, so it expires.
  async function loadStagedDiscussion(announce = true) {
    if (!selectedCourse) return;
    if (announce) setBusy("discussion-capture");
    try {
      const params = new URLSearchParams({ courseId: selectedCourse.id });
      const { submission } = await api<{ submission: StagedDiscussionSubmission | null }>(
        `/api/discussions/submission?${params}`);
      setStagedDiscussion(submission);
      if (!announce) return;
      if (!submission) {
        setNotice({
          kind: "info",
          text: `No staged capture found for ${selectedCourse.code} section ${selectedCourse.section}. Open a student's SpeedGrader page for a graded discussion and click the extension. The extension stages against the course marked as the Canvas extension target, so confirm this is that course.`
        });
        return;
      }
      setNotice({
        kind: "success",
        text: `Found a capture with ${submission.initialPostCount} initial post(s) and ${submission.replyCount} repl${submission.replyCount === 1 ? "y" : "ies"}. Load it to grade.`
      });
    } catch (error) { showError(error); } finally { if (announce) setBusy(""); }
  }

  function applyStagedDiscussion() {
    if (!stagedDiscussion) return;
    setSubmissionText(stagedDiscussion.text);
    setDocumentName(`${stagedDiscussion.assignmentName || "Discussion"} (SpeedGrader capture)`);
    setResults([]); setAttachmentFindings([]); setAiUseAssessment(null); setGradingRunId(null); setAppliedAttachments([]);
    if (stagedDiscussion.assignmentDirections && !assignmentDirections.trim()) {
      setAssignmentDirections(stagedDiscussion.assignmentDirections);
    }
    setNotice({ kind: "success", text: "Discussion capture loaded as the submission. Generate suggestions when ready; a student is only needed to save." });
  }

  async function saveGradingPolicy() {
    if (!selectedCourse) return;
    setBusy("grading-policy");
    try {
      const updated = await api<Course>(`/api/courses/${selectedCourse.id}/grading-policy`,
        jsonInit("PUT", { gradingPolicy: gradingPolicy.trim() || null }));
      setCourses((current) => current.map((course) => course.id === updated.id ? updated : course));
      setNotice({ kind: "success", text: "Course grading policy saved. It applies to every run for this course." });
    } catch (error) { showError(error); } finally { setBusy(""); }
  }

  async function extractDocument(file: File | null) {
    if (!file) return;
    setBusy("document"); setSubmissionText(""); setDocumentName(file.name); setResults([]);
    const body = new FormData(); body.append("file", file);
    try {
      const response = await api<{ text: string }>("/api/documents/extract", { method: "POST", body });
      setSubmissionText(response.text);
      setNotice({ kind: "success", text: "Document extracted in memory. Student content is intentionally hidden and is not stored in this browser." });
    } catch (error) { setDocumentName(""); showError(error); } finally { setBusy(""); }
  }

  async function loadHistory() {
    if (!selectedCourse || !pseudonym.trim()) return;
    setBusy("history"); setHistory([]);
    try {
      const params = new URLSearchParams({ courseId: selectedCourse.id, pseudonym: pseudonym.trim() });
      const response = await api<{ history: HistoryRun[] }>(`/api/grading/history?${params}`);
      setHistory(response.history);
      setNotice({ kind: "info", text: response.history.length ? `Found ${response.history.length} saved grading run(s).` : "No saved grading runs found for this student." });
    } catch (error) { showError(error); } finally { setBusy(""); }
  }

  async function gradeSubmission() {
    if (!selectedRubric || !submissionText) return;
    setBusy("grading"); setResults([]); setAttachmentFindings([]); setAiUseAssessment(null);
    setGradingRunId(null); setAppliedAttachments([]);
    const context = selectedRubric.id && selectedCourse && pseudonym.trim()
      ? { courseId: selectedCourse.id, rubricId: selectedRubric.id, pseudonym: pseudonym.trim() }
      : undefined;
    try {
      const rubricForGrading = {
        ...selectedRubric,
        assignmentDirections: assignmentDirections.trim() || null,
      };
      const response = await api<{
        model: string; gradingRunId: string | null; results: GradeCriterionResult[];
        appliedAttachments: AttachmentSnapshot[];
        attachmentFindings: AttachmentFinding[];
        aiUseAssessment: AiUseAssessment | null;
      }>(
        "/api/grading", jsonInit("POST", {
          rubric: rubricForGrading, submissionText, apaEnabled, context,
          assignmentId: attachmentAssignmentId,
          courseId: selectedCourse?.id ?? null,
          pseudonym: pseudonym || null,
          backend: gradingBackend,
        }),
      );
      setResults(response.results); setModel(response.model);
      setAttachmentFindings(response.attachmentFindings ?? []);
      setAiUseAssessment(response.aiUseAssessment ?? null);
      setGradingRunId(response.gradingRunId);
      setAppliedAttachments(response.appliedAttachments ?? []);
      const applied = response.appliedAttachments?.length
        ? ` ${response.appliedAttachments.length} assignment file(s) included in grading: ${response.appliedAttachments.map((item) => item.fileName).join(", ")}.`
        : attachmentAssignmentId
          ? " No assignment files were sent to the grader — check that files are attached and have requirements text saved."
          : "";
      setNotice({ kind: "success", text: (context ? "Suggestions generated and saved as a reviewable run." : "Suggestions generated for review. This run was not persisted.") + applied });
    } catch (error) { showError(error); } finally { setBusy(""); }
  }

  // Persists a run that was generated without a pseudonym, so reviewing first and
  // deciding to keep it later does not require re-running local inference.
  async function saveRun() {
    if (!selectedRubric?.id || !selectedCourse || !pseudonym.trim() || !results.length) return;
    setBusy("save-run");
    try {
      const response = await api<{ gradingRunId: string; results: GradeCriterionResult[] }>(
        "/api/grading/runs", jsonInit("POST", {
          courseId: selectedCourse.id,
          rubricId: selectedRubric.id,
          pseudonym: pseudonym.trim(),
          apaEnabled,
          assignmentDirections: assignmentDirections.trim() || null,
          attachments: appliedAttachments,
          results,
          aiUseAssessment,
        }),
      );
      setResults(response.results);
      setGradingRunId(response.gradingRunId);
      setNotice({ kind: "success", text: `Run saved for ${studentLabel}. Individual criteria can now be approved and saved.` });
    } catch (error) { showError(error); } finally { setBusy(""); }
  }

  const updateResult = useCallback((index: number, patch: Partial<GradeCriterionResult>) => {
    setResults((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }, []);

  const saveResult = useCallback(async (index: number, resultToSave: GradeCriterionResult) => {
    if (!resultToSave.resultId) return;
    setBusy(`save-${index}`);
    try {
      await api(`/api/grading/results/${resultToSave.resultId}`, jsonInit("PATCH", {
        approvedRating: resultToSave.approvedRating,
        approvedPoints: resultToSave.approvedPoints,
        approvedExplanation: resultToSave.approvedExplanation,
      }));
      setNotice({ kind: "success", text: "Approved criterion saved." });
    } catch (error) { showError(error); } finally { setBusy(""); }
  }, []);

  const copyComment = useCallback(async (result: GradeCriterionResult) => {
    const text = result.approvedExplanation;
    try { await navigator.clipboard.writeText(text); setNotice({ kind: "success", text: "Canvas-ready comment copied." }); }
    catch { setNotice({ kind: "error", text: "Clipboard access was blocked. Select and copy the approved comment manually." }); }
  }, []);

  async function analyzeDiscussion() {
    if (!discussionPost.trim()) return;
    setBusy("discussion"); setDiscussionReply("");
    try {
      const response = await api<{ model: string; response: string }>(
        "/api/discussions/analyze", jsonInit("POST", { postText: discussionPost.trim() }),
      );
      setDiscussionReply(response.response); setModel(response.model);
      setNotice({ kind: "success", text: "Draft professor response generated. Review and edit before posting." });
    } catch (error) { showError(error); } finally { setBusy(""); }
  }

  async function copyDiscussionReply() {
    const text = discussionReply.trim();
    if (!text || busy === "copy-reply") return;
    setBusy("copy-reply");
    try { await navigator.clipboard.writeText(text); setNotice({ kind: "success", text: "Response copied." }); }
    catch { setNotice({ kind: "error", text: "Clipboard access was blocked. Select and copy the response manually." }); }
    finally { setBusy(""); }
  }
  return (
    <div className="app-shell">
      <header className="topbar">
        <div><p className="eyebrow">Local-first faculty tool</p><h1>Course Grading Assist</h1></div>
        <div className="health-summary" aria-label="System health">
          <StatusDot ok={health?.database.connected} label={health?.database.connected ? "Database connected" : "Database unavailable"} />
          <StatusDot ok={health?.ollama.available && health.ollama.modelAvailable} label={health?.ollama.modelAvailable ? "Grader ready" : "Grader unavailable"} />
          <StatusDot ok={health?.libreOffice.available} label={health?.libreOffice.available ? "DOC extraction ready" : "DOC extraction unavailable"} />
          <StatusDot ok={health ? health.retention.consecutiveFailures === 0 : undefined} label={retentionLabel(health)} />
        </div>
      </header>

      <main>
        <nav className="tab-bar" role="tablist" aria-label="Workspaces">
          <button type="button" role="tab" aria-selected={activeTab === "grading"} className={`tab ${activeTab === "grading" ? "active" : ""}`} onClick={() => setActiveTab("grading")}>Grading</button>
          <button type="button" role="tab" aria-selected={activeTab === "discussions"} className={`tab ${activeTab === "discussions" ? "active" : ""}`} onClick={() => setActiveTab("discussions")}>Discussions</button>
          <button type="button" role="tab" aria-selected={activeTab === "announcements"} className={`tab ${activeTab === "announcements" ? "active" : ""}`} onClick={() => setActiveTab("announcements")}>Announcements</button>
        </nav>
        {notice && <div className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div>}
        {health && !health.database.configured && (
          <div className="notice info" role="status"><strong>Database is not configured.</strong> Fixture grading and document extraction remain available, but courses and saved edits require a database.</div>
        )}

        {activeTab === "announcements" && <AnnouncementsPanel
          courseId={courseId}
          courseLabel={selectedCourse ? `${selectedCourse.code} section ${selectedCourse.section}` : null}
          busy={busy}
          setBusy={setBusy}
          onNotice={setNotice}
          onError={showError}
        />}

        {activeTab === "discussions" && <section className="panel" aria-labelledby="discussion-heading">
          <div className="section-heading"><div><span className="step">D</span><h2 id="discussion-heading">Discussion response</h2></div><p>Paste a student's weekly discussion post and generate a brief professor-style reply.</p></div>
          <label htmlFor="discussion-post">Student discussion post</label>
          <textarea id="discussion-post" rows={10} maxLength={20000} value={discussionPost} placeholder="Paste the student's discussion post here." onChange={(event) => { setDiscussionPost(event.target.value); setDiscussionReply(""); }} />
          <small>{discussionPost.length.toLocaleString()} / 20,000 characters. Content stays in memory and is not stored.</small>
          <div className="button-row">
            <button className="primary large" type="button" disabled={!discussionPost.trim() || busy === "discussion"} onClick={() => void analyzeDiscussion()}>{busy === "discussion" ? "Analyzing locally…" : "Analyze"}</button>
            <button className="secondary large" type="button" disabled={(!discussionPost && !discussionReply) || busy === "discussion"} onClick={() => { setDiscussionPost(""); setDiscussionReply(""); }}>Clear</button>
          </div>
          {discussionReply && <div className="discussion-reply">
            <div className="results-title"><div><p className="eyebrow">Draft — review before posting</p><h3>Suggested professor response</h3></div><span className="model-chip">Model: {model}</span></div>
            <textarea id="discussion-reply" rows={4} maxLength={2000} value={discussionReply} onChange={(event) => setDiscussionReply(event.target.value)} />
            <div className="button-row"><button type="button" disabled={busy === "copy-reply"} onClick={() => void copyDiscussionReply()}>Copy response</button></div>
            <small>The tool suggests only. Review and edit before posting to Canvas.</small>
          </div>}
        </section>}

        {activeTab === "grading" && <><section className="panel" aria-labelledby="course-heading">
          <div className="section-heading"><div><span className="step">1</span><h2 id="course-heading">Course workspace</h2></div><p>Select the course context used for rosters and saved grading.</p></div>
          <div className="two-column">
            <div>
              <label htmlFor="course-select">Active course</label>
              <select id="course-select" value={courseId} disabled={busy === "course-selection"} onChange={(event) => void activateCourse(event.target.value)}>
                <option value="">No course selected</option>
                {courses.map((course) => <option key={course.id} value={course.id}>{course.code} · {course.section} · {course.term}</option>)}
              </select>
              {selectedCourse && <div className="course-card">
                <div><strong>{selectedCourse.title || selectedCourse.code}</strong><span>{selectedCourse.code} · Section {selectedCourse.section}</span></div>
                <p className="scoring-note"><strong>Canvas extension target:</strong> {extensionCourseId === selectedCourse.id ? "Active. New captures will be saved only to this course." : "Activating this course…"}</p>
                <dl><div><dt>Term</dt><dd>{selectedCourse.term}</dd></div><div><dt>Dates</dt><dd>{formatDate(selectedCourse.startDate)}–{formatDate(selectedCourse.endDate)}</dd></div><div><dt>Automatic purge</dt><dd>{formatDate(selectedCourse.purgeAfter)}</dd></div></dl>
                <p className="warning-text">Course-related student and grading data is scheduled for purge after this date.</p>
                <div className="directions-editor">
                  <label htmlFor="grading-policy">Course grading policy</label>
                  <textarea id="grading-policy" rows={4} maxLength={4000} value={gradingPolicy}
                    placeholder="For example: properly cited corporate websites and materials count as proper external sources."
                    onChange={(event) => setGradingPolicy(event.target.value)} />
                  <small>Applied to every grading run for this course. It settles how existing rubric criteria are interpreted; it cannot add criteria or change point maximums.</small>
                  <div className="directions-actions">
                    <button type="button" className="secondary"
                      disabled={busy === "grading-policy" || gradingPolicy === (selectedCourse.gradingPolicy ?? "")}
                      onClick={() => void saveGradingPolicy()}>
                      {busy === "grading-policy" ? "Saving…" : "Save grading policy"}
                    </button>
                    <span>{selectedCourse.gradingPolicy ? "A policy is active for this course." : "No policy set."}</span>
                  </div>
                </div>
                <div className="retention-editor">
                  <label htmlFor="extended-end-date">Extend or correct course end date</label>
                  <div className="button-row">
                    <input id="extended-end-date" type="date" min={selectedCourse.startDate} value={extendedEndDate} onChange={(event) => setExtendedEndDate(event.target.value)} />
                    <button className="secondary" type="button" disabled={!extendedEndDate || extendedEndDate === selectedCourse.endDate || busy === "extend"} onClick={() => void updateCourseEndDate(selectedCourse)}>{busy === "extend" ? "Updating…" : "Update retention date"}</button>
                  </div>
                </div>
                {selectedCourse.canvasUrl && <a href={selectedCourse.canvasUrl} target="_blank" rel="noreferrer">Open Canvas course</a>}
                <button className="danger ghost" type="button" disabled={busy === "delete"} onClick={() => void deleteCourse(selectedCourse)}>Delete course…</button>
              </div>}
            </div>
            <form onSubmit={(event) => void createCourse(event)}>
              <h3>Create course</h3>
              <div className="form-grid">
                <Field label="Course code" required value={courseForm.code} onChange={(value) => setCourseForm({ ...courseForm, code: value })} />
                <Field label="Section" required value={courseForm.section} onChange={(value) => setCourseForm({ ...courseForm, section: value })} />
                <Field label="Course title" value={courseForm.title} onChange={(value) => setCourseForm({ ...courseForm, title: value })} />
                <Field label="Term" required value={courseForm.term} onChange={(value) => setCourseForm({ ...courseForm, term: value })} placeholder="Fall 2026" />
                <Field label="Start date" type="date" required value={courseForm.startDate} onChange={(value) => setCourseForm({ ...courseForm, startDate: value })} />
                <Field label="End date" type="date" required value={courseForm.endDate} onChange={(value) => setCourseForm({ ...courseForm, endDate: value })} />
                <Field label="Canvas course ID" value={courseForm.canvasCourseId} onChange={(value) => setCourseForm({ ...courseForm, canvasCourseId: value })} />
                <Field label="Canvas URL" type="url" value={courseForm.canvasUrl} onChange={(value) => setCourseForm({ ...courseForm, canvasUrl: value })} />
              </div>
              <button disabled={busy === "course"}>{busy === "course" ? "Creating…" : "Create course"}</button>
            </form>
          </div>
        </section>

        <section className="panel" aria-labelledby="roster-heading">
          <div className="section-heading"><div><span className="step">2</span><h2 id="roster-heading">Course roster</h2></div><p>Import the Canvas roster CSV once so students can be selected by name when grading.</p></div>
          <label htmlFor="roster-file">Canvas roster CSV</label>
          <input id="roster-file" type="file" accept=".csv,text/csv" onChange={(event) => { setRosterFile(event.target.files?.[0] || null); setRosterMessage(null); }} />
          {/* Deliberately enabled even when a prerequisite is missing: a disabled button
              cannot tell the user why the click did nothing. importRoster() reports the
              specific reason instead. */}
          <button type="button" className="secondary" disabled={busy === "roster"} onClick={() => void importRoster()}>{busy === "roster" ? "Importing…" : "Import roster"}</button>
          {rosterMessage && <small className={rosterMessage.kind === "error" ? "field-error" : undefined} role={rosterMessage.kind === "error" ? "alert" : "status"}>{rosterMessage.text}</small>}
          {!selectedCourse && <small>Select a course before importing a roster.</small>}
          {roster.length > 0 && <small role="status">{roster.length} student(s) in this course's roster.</small>}
        </section>
        <section className="panel" aria-labelledby="rubric-heading">
          <div className="section-heading"><div><span className="step">3</span><h2 id="rubric-heading">Rubric and submission</h2></div><p>Choose the evaluation standard and extract a supported document locally.</p></div>
          <div className="two-column">
            <div>
              <label htmlFor="rubric-select">Rubric</label>
              <select id="rubric-select" value={rubricIndex} onChange={(event) => { setRubricIndex(event.target.value); setResults([]); }}>
                <option value="">Choose a rubric</option>
                {rubrics.map((rubric, index) => <option key={`${rubric.id || rubric.assignmentId || "rubric"}-${index}`} value={index}>{labelForRubric(rubric)}{rubric.id ? ` · v${rubric.version ?? "?"}` : " · in memory"}</option>)}
              </select>
              <div className="button-row">
                <button type="button" className="secondary" disabled={!courseId || busy === "rubrics" || busy === "course-selection"} onClick={() => void refreshCourseRubrics()}>{busy === "rubrics" ? "Refreshing…" : "Refresh course rubrics"}</button>
                <button type="button" className="secondary" disabled={!courseId || busy === "fixture"} onClick={() => void loadFixture()}>Load Assignment 1.3 fixture</button>
              </div>
              {selectedRubric && <>
                <div className="rubric-summary"><strong>{labelForRubric(selectedRubric)}</strong><span>{selectedRubric.criteria.length} criteria · {selectedRubric.totalPoints ?? "—"} points</span>{selectedRubric.source === "fixture" && <p className="warning-text"><strong>Fixture warning:</strong> Rating descriptors are incomplete. Use for demonstrations only; recapture from Canvas before official grading.</p>}</div>
                <div className="directions-editor">
                  <label htmlFor="assignment-directions">Assignment directions (supporting context)</label>
                  <textarea id="assignment-directions" rows={8} maxLength={50000} value={assignmentDirections} placeholder="No assignment directions were captured. Add or paste faculty-approved directions here if needed." onChange={(event) => { setAssignmentDirections(event.target.value); setResults([]); }} />
                  <small>{assignmentDirections.length.toLocaleString()} / 50,000 characters. Review before grading. Directions help interpret deliverables but cannot create scoring criteria or override the rubric.</small>
                  <div className="directions-actions">
                    {selectedRubric.id ? <button type="button" className="secondary" disabled={busy === "directions"} onClick={() => void saveAssignmentDirections()}>{busy === "directions" ? "Saving…" : "Save directions"}</button> : <span>Edits apply to this browser session and grading request only.</span>}
                  </div>
                </div>
              </>}
            </div>
            <div>
              <label htmlFor="document-file">Student document</label>
              <input id="document-file" type="file" accept=".doc,.docx,.pdf,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => void extractDocument(event.target.files?.[0] || null)} />
              <small>.doc, .docx, or .pdf · Maximum 15 MB. Content stays in memory and is never written to localStorage.</small>
              <div className="directions-editor">
                <h4>Graded discussion</h4>
                <p>For a discussion, capture the student's SpeedGrader page with the extension instead of uploading a file. The response and peer replies are held in server memory for 30 minutes and never stored.</p>
                <div className="button-row">
                  <button type="button" className="secondary" disabled={!selectedCourse || busy === "discussion-capture"}
                    onClick={() => void loadStagedDiscussion()}>
                    {busy === "discussion-capture" ? "Checking…" : "Check for SpeedGrader capture"}
                  </button>
                  {stagedDiscussion && <button type="button" className="primary" onClick={() => applyStagedDiscussion()}>
                    Load as submission
                  </button>}
                </div>
                {stagedDiscussion && <>
                  <small role="status">
                    {stagedDiscussion.assignmentName || "Discussion"} · {stagedDiscussion.initialPostCount} initial post(s) · {stagedDiscussion.replyCount} repl{stagedDiscussion.replyCount === 1 ? "y" : "ies"} · {stagedDiscussion.characters.toLocaleString()} characters · expires {new Date(stagedDiscussion.expiresAt).toLocaleTimeString()}
                    {stagedDiscussion.replyCount === 0 && " · No peer replies were captured; verify in SpeedGrader before grading a peer-response criterion."}
                  </small>
                  <div className="stats" aria-label="Computed timeliness">
                    <div><strong>{stagedDiscussion.timeliness.initialOnTime === null ? "?" : stagedDiscussion.timeliness.initialOnTime ? "On time" : "Late"}</strong><span>initial response</span></div>
                    <div><strong>{stagedDiscussion.timeliness.repliesDistributed === null ? "?" : stagedDiscussion.timeliness.repliesDistributed ? "Spread" : "Same day"}</strong><span>reply dates</span></div>
                    <div><strong>{stagedDiscussion.timeliness.replyDates.filter(Boolean).length}</strong><span>dated replies</span></div>
                    <p>
                      Deadline used: {stagedDiscussion.timeliness.onTimeDeadline || "unavailable"} ({stagedDiscussion.timeliness.timeZone}).
                      Initial response posted {stagedDiscussion.timeliness.initialPostAt || "unknown"}.
                      {!stagedDiscussion.timeliness.dueAt && " Canvas published no due date, so timeliness could not be derived."}
                    </p>
                  </div>
                </>}
              </div>
              {busy === "document" && <p className="loading" role="status">Extracting document…</p>}
              {extractionStats && <div className="stats" aria-label="Extraction statistics"><div><strong>{extractionStats.words.toLocaleString()}</strong><span>words</span></div><div><strong>{extractionStats.characters.toLocaleString()}</strong><span>characters</span></div><div><strong>~{extractionStats.pages}</strong><span>pages</span></div><p>{documentName} extracted. Full student content is intentionally not displayed.</p></div>}
            </div>
          </div>
        </section>

        <AttachmentsPanel
          assignmentId={attachmentAssignmentId}
          assignmentName={selectedRubric?.assignmentName ?? null}
          busy={busy}
          setBusy={setBusy}
          onNotice={setNotice}
          onError={showError}
        />

        <section className="panel" aria-labelledby="grade-heading">
          <div className="section-heading"><div><span className="step">5</span><h2 id="grade-heading">Generate suggestions</h2></div><p>Set the APA policy and review every result before use. A student is only needed to save a run.</p></div>
          <p className="scoring-note"><strong>Flexible scoring:</strong> Rubric rating points are anchors, not exclusive values. Suggested and professor-approved points may fall between anchors, from zero through each criterion maximum.</p>
          <div className="grade-controls">
            <div>
              <label htmlFor="student-select">Student</label>
              <select id="student-select" value={pseudonym} disabled={roster.length === 0}
                onChange={(event) => { setPseudonym(event.target.value); setHistory([]); }}>
                <option value="">No student selected</option>
                {roster.map((student) => <option key={student.pseudonym} value={student.pseudonym}>{studentOptionLabel(student, roster)}</option>)}
              </select>
              <small>{roster.length === 0
                ? "Import this course's roster in step 2 to select a student."
                : "Only needed to save a run. Suggestions can be generated without selecting anyone."}</small>
              <button type="button" className="secondary history-button" disabled={!selectedCourse || !pseudonym.trim() || busy === "history"} onClick={() => void loadHistory()}>{busy === "history" ? "Searching…" : "Find saved records"}</button>
            </div>
            <fieldset><legend>APA evaluation</legend><label className="switch-row"><input type="checkbox" checked={apaEnabled} onChange={(event) => setApaEnabled(event.target.checked)} /><span>Evaluate APA requirements</span></label><p className={apaEnabled ? "enabled-note" : "disabled-note"}>{apaEnabled ? "Enabled: APA applies only where the rubric explicitly supports it." : "Disabled: the grader must not deduct points, lower ratings, criticize, or mention APA."}</p></fieldset>
            <fieldset><legend>Grading backend</legend><label className="switch-row"><input type="radio" name="gradingBackend" value="ollama" checked={gradingBackend === "ollama"} onChange={() => setGradingBackend("ollama")} /><span>Local Ollama</span></label><label className="switch-row"><input type="radio" name="gradingBackend" value="claude" checked={gradingBackend === "claude"} onChange={() => setGradingBackend("claude")} /><span>Claude Haiku (cloud)</span></label><p className={gradingBackend === "claude" ? "enabled-note" : "disabled-note"}>{gradingBackend === "claude" ? "Cloud: grading sent to Anthropic. Requires ANTHROPIC_API_KEY in server .env." : "Local: all grading runs on your machine via Ollama. No data leaves."}</p></fieldset>
          </div>
          <button className="primary large" type="button" disabled={!selectedRubric || !submissionText || busy === "grading"} onClick={() => void gradeSubmission()}>{busy === "grading" ? (gradingBackend === "claude" ? "Grading with Claude…" : "Grading locally…") : "Generate grading suggestions"}</button>
          {(!selectedRubric || !submissionText) && <small>Choose a rubric and extract a document to continue.</small>}
          {history.length > 0 && <div className="history-list" aria-label="Saved grading records">
            <h3>Saved records for {studentLabel}</h3>
            {history.map((run) => <details key={run.id}>
              <summary><strong>{run.assignmentName}</strong><span>{new Date(run.createdAt).toLocaleString()} · {run.results.reduce((sum, item) => sum + item.approvedPoints, 0)} approved points{run.aiUseScore !== null && ` · AI use ${run.aiUseScore}/10 (${aiUseBand(run.aiUseScore).label.toLowerCase()})`}</span></summary>
              <div>{run.results.map((item, index) => <div className="history-result" key={`${run.id}-${index}`}><strong>{item.criterionName || `Criterion ${index + 1}`}: {item.approvedRating} · {item.approvedPoints}</strong><p>{item.approvedExplanation}</p></div>)}</div>
            </details>)}
          </div>}
        </section>

        {attachmentFindings.length > 0 && <section className="panel" aria-labelledby="findings-heading">
          <div className="section-heading">
            <div><span className="step">!</span><h2 id="findings-heading">Assignment file compliance</h2></div>
            <p>Checks against the attached template and instruction files.</p>
          </div>
          <div className="privacy-warning">
            <p><strong>Advisory only.</strong> The local model both misses violations and reports requirements as met when they are not. Confirm every item against the submission yourself before acting on it, and treat a "Met" result as unverified.</p>
          </div>
          {attachmentFindings.map((finding, index) => (
            <div className="history-result" key={`${index}-${finding.requirement.slice(0, 24)}`}>
              <span className={`badge ${finding.satisfied ? "ready" : "review"}`}>{finding.satisfied ? "Reported met" : "Reported not met"}</span>
              <strong> {finding.requirement}</strong>
              <p>{finding.note}</p>
            </div>
          ))}
        </section>}

        {results.length > 0 && aiUseAssessment && <AiUsePanel assessment={aiUseAssessment} />}

        {results.length > 0 && !gradingRunId && <section className="panel" aria-labelledby="save-run-heading">
          <div className="section-heading">
            <div><span className="step">6</span><h2 id="save-run-heading">Keep this run</h2></div>
            <p>Optional. Suggestions below are in memory only until saved.</p>
          </div>
          {selectedRubric?.id ? <>
            <p>Student: {pseudonym ? studentLabel : "none selected"}</p>
            {!pseudonym && <small>Select a student from the course roster before saving this run.</small>}
            <div className="button-row">
              <button className="primary" type="button"
                disabled={!selectedCourse || !pseudonym || busy === "save-run"}
                onClick={() => void saveRun()}>
                {busy === "save-run" ? "Saving…" : "Save run for this student"}
              </button>
            </div>
          </> : <p className="warning-text">This run used a fixture or unsaved rubric, so it cannot be persisted. Capture the rubric from Canvas to enable saving.</p>}
        </section>}

        {results.length > 0 && <section className="results" aria-labelledby="results-heading">
          <div className="results-title"><div><p className="eyebrow">Human review required</p><h2 id="results-heading">Criterion results</h2></div><span className="model-chip">Model: {model}</span></div>
          {results.map((result, index) => (
            <ResultCard
              key={result.criterionId}
              result={result}
              index={index}
              criterion={selectedRubric?.criteria.find((item) => item.sourceId === result.criterionId)}
              isSaving={busy === `save-${index}`}
              onUpdate={updateResult}
              onSave={saveResult}
              onCopy={copyComment}
            />
          ))}
        </section>}
        </>}
      </main>
      <footer>Course Grading Assist · Local processing · Faculty approval required before posting</footer>
    </div>
  );
}

function StatusDot({ ok, label }: { ok: boolean | undefined; label: string }) {
  return <span className="status-item"><span className={`dot ${ok ? "ok" : "off"}`} aria-hidden="true" />{label}</span>;
}
function Field({ label, onChange, ...props }: { label: string; onChange: (value: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange">) {
  const id = `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return <div><label htmlFor={id}>{label}</label><input id={id} {...props} onChange={(event) => onChange(event.target.value)} /></div>;
}

function AutoResizeTextarea({ value, onChange, id, maxLength, className }: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  maxLength?: number;
  className?: string;
}) {
  const ref = React.useRef<HTMLTextAreaElement>(null);

  // Resize on mount and whenever value changes externally (e.g. after generation).
  // Using a layout effect keeps it synchronous with the DOM paint so there's no flash.
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      id={id}
      value={value}
      maxLength={maxLength}
      className={className}
      style={{ overflow: "hidden", resize: "none" }}
      onChange={(event) => {
        // Resize immediately in the event handler before React re-renders,
        // so the height update is synchronous and doesn't swallow keystrokes.
        const el = event.currentTarget;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
        onChange(event.target.value);
      }}
    />
  );
}

type ResultCardProps = {
  result: GradeCriterionResult;
  index: number;
  criterion: import("../shared/types").NormalizedCriterion | undefined;
  isSaving: boolean;
  onUpdate: (index: number, patch: Partial<GradeCriterionResult>) => void;
  onSave: (index: number, result: GradeCriterionResult) => void;
  onCopy: (result: GradeCriterionResult) => void;
};

const ResultCard = React.memo(function ResultCard({
  result, index, criterion, isSaving, onUpdate, onSave, onCopy
}: ResultCardProps) {
  return (
    <article className="result-card">
      <div className="result-header">
        <div><span>Criterion {index + 1}</span><h3>{criterion?.name || result.criterionId}</h3></div>
        <span className={result.reviewRequired ? "badge review" : "badge ready"}>
          {result.reviewRequired ? "Review required" : "Ready to review"}
        </span>
      </div>
      <div className="suggestion-grid">
        <div><span>Suggested rating</span><strong>{result.suggestedRating}</strong></div>
        <div><span>Suggested points</span><strong>{result.suggestedPoints} / {criterion?.maximumPoints ?? "—"}</strong></div>
        <div><span>Confidence</span><strong>{Math.round(result.confidence * 100)}%</strong></div>
      </div>
      <div className="analysis-copy">
        <h4>Model rationale</h4><p>{result.explanation}</p>
        <h4>Evidence</h4>
        {result.evidence.length
          ? <ul>{result.evidence.map((evidence, evidenceIndex) => <li key={evidenceIndex}>{evidence}</li>)}</ul>
          : <p>No direct evidence returned.</p>}
      </div>
      <div className="approval-editor">
        <h4>Approved Canvas feedback</h4>
        <div className="form-grid">
          <Field label="Approved rating" required value={result.approvedRating}
            onChange={(value) => onUpdate(index, { approvedRating: value })} />
          <Field label="Approved points" type="number" min={0} step="any" required
            value={String(result.approvedPoints)} max={criterion?.maximumPoints ?? undefined}
            onChange={(value) => onUpdate(index, { approvedPoints: Number(value) })} />
        </div>
        <label htmlFor={`explanation-${index}`}>Approved comment</label>
        <AutoResizeTextarea id={`explanation-${index}`} maxLength={1500}
          value={result.approvedExplanation}
          onChange={(value) => onUpdate(index, { approvedExplanation: value })} />
        <div className="button-row">
          <button type="button" onClick={() => onCopy(result)}>Copy Canvas-ready comment</button>
          <button type="button" className="secondary" disabled={!result.resultId || isSaving}
            onClick={() => onSave(index, result)}>
            {isSaving ? "Saving…" : "Save approved edits"}
          </button>
        </div>
        {!result.resultId && <small>Not saved yet. Use <strong>Keep this run</strong> above to store it against a student; approved edits can then be saved without regrading.</small>}
      </div>
    </article>
  );
});
