import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Course, GradeCriterionResult, NormalizedRubric } from "../shared/types";

type Health = {
  status: string;
  database: { configured: boolean; connected: boolean };
  ollama: { available: boolean; model: string; modelAvailable: boolean };
  libreOffice: { available: boolean; version: string | null };
};
type StoredRubric = NormalizedRubric & { id?: string; version?: number };
type RubricList = { memory: NormalizedRubric[]; persisted: StoredRubric[] };
type ActiveCourseSelection = Pick<Course, "id" | "code" | "section" | "title" | "term"> & { token: string };
type Validation = { valid: boolean; rowCount: number; columnCount: number; headers: string[]; stableIdHeader: string };
type CrosswalkMapping = { identityLabel: string; pseudonym: string };
type Notice = { kind: "success" | "error" | "info"; text: string } | null;
type HistoryRun = {
  id: string; createdAt: string; apaEnabled: boolean; model: string;
  assignmentName: string; rubricTitle: string | null; version: number;
  results: Array<{ criterionName: string | null; approvedRating: string; approvedPoints: number; approvedExplanation: string }>;
};

type CourseForm = {
  code: string; section: string; title: string; term: string; startDate: string; endDate: string;
  canvasCourseId: string; canvasUrl: string;
};
const emptyCourse: CourseForm = {
  code: "", section: "", title: "", term: "", startDate: "", endDate: "", canvasCourseId: "", canvasUrl: "",
};

class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ApiError(0, "The local application service could not be reached.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    const fallback = response.status === 503
      ? "This feature needs a configured database or local service. You can continue with non-persisted workflows."
      : `Request failed (${response.status})`;
    throw new ApiError(response.status, body.error || fallback);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
function labelForRubric(rubric: NormalizedRubric): string {
  return rubric.rubricTitle || rubric.assignmentName || "Untitled rubric";
}
function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(`${value}T00:00:00`));
}
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
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
  const [validation, setValidation] = useState<Validation | null>(null);
  const [crosswalkConfirmed, setCrosswalkConfirmed] = useState(false);
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [exportPassphraseConfirmation, setExportPassphraseConfirmation] = useState("");
  const [unlockFile, setUnlockFile] = useState<File | null>(null);
  const [unlockPassphrase, setUnlockPassphrase] = useState("");
  const [unlockedMappings, setUnlockedMappings] = useState<CrosswalkMapping[]>([]);
  const [documentName, setDocumentName] = useState("");
  const [submissionText, setSubmissionText] = useState("");
  const [pseudonym, setPseudonym] = useState("");
  const [apaEnabled, setApaEnabled] = useState(false);
  const [results, setResults] = useState<GradeCriterionResult[]>([]);
  const [history, setHistory] = useState<HistoryRun[]>([]);
  const [model, setModel] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState("");
  const [activeTab, setActiveTab] = useState<"grading" | "discussions">("grading");
  const [discussionPost, setDiscussionPost] = useState("");
  const [discussionReply, setDiscussionReply] = useState("");

  const selectedCourse = courses.find((course) => course.id === courseId);
  const selectedRubric = rubricIndex === "" ? undefined : rubrics[Number(rubricIndex)];
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
    setAssignmentDirections(selectedRubric?.assignmentDirections ?? "");
  }, [rubricIndex, selectedRubric?.assignmentDirections]);

  useEffect(() => {
    setUnlockedMappings([]);
    setUnlockPassphrase("");
  }, [selectedCourse?.id]);

  function showError(error: unknown) {
    setNotice({ kind: "error", text: error instanceof Error ? error.message : "Unexpected error" });
  }

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

  async function validateRoster() {
    if (!rosterFile) return;
    setBusy("roster"); setValidation(null); setCrosswalkConfirmed(false);
    const body = new FormData(); body.append("file", rosterFile);
    try {
      setValidation(await api<Validation>("/api/rosters/validate", { method: "POST", body }));
      setNotice({ kind: "success", text: "Roster structure is valid. Review the privacy warning before creating a crosswalk." });
    } catch (error) { showError(error); } finally { setBusy(""); }
  }

  async function downloadCrosswalk(format: "encrypted" | "csv") {
    if (!rosterFile || !selectedCourse) return;
    if (format === "csv" && !crosswalkConfirmed) return;
    if (format === "encrypted" && (exportPassphrase.length < 12 || exportPassphrase !== exportPassphraseConfirmation)) return;
    setBusy(`crosswalk-${format}`);
    const body = new FormData();
    body.append("file", rosterFile); body.append("courseId", selectedCourse.id);
    body.append("courseCode", selectedCourse.code); body.append("section", selectedCourse.section);
    body.append("format", format);
    if (format === "encrypted") body.append("passphrase", exportPassphrase);
    try {
      const response = await fetch("/api/rosters/crosswalk", { method: "POST", body });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new ApiError(response.status, payload.error || "Crosswalk could not be created.");
      }
      const encrypted = format === "encrypted";
      downloadBlob(await response.blob(), encrypted ? "roster-crosswalk.cga.json" : "roster-crosswalk.csv");
      setExportPassphrase("");
      setExportPassphraseConfirmation("");
      setNotice({
        kind: "success",
        text: encrypted
          ? "Encrypted crosswalk downloaded. Keep its passphrase separately; it cannot be recovered."
          : "Plaintext crosswalk downloaded. Store this identifiable CSV only in an approved secure location."
      });
    } catch (error) { showError(error); } finally { setBusy(""); }
  }

  async function unlockCrosswalk() {
    if (!unlockFile || unlockPassphrase.length < 12) return;
    setBusy("unlock"); setUnlockedMappings([]);
    const body = new FormData();
    body.append("file", unlockFile); body.append("passphrase", unlockPassphrase);
    try {
      const unlocked = await api<{ count: number; mappings: CrosswalkMapping[] }>("/api/rosters/crosswalk/unlock", { method: "POST", body });
      setUnlockedMappings(unlocked.mappings);
      setUnlockPassphrase("");
      setNotice({ kind: "success", text: `${unlocked.count} crosswalk mappings unlocked in memory for this course selection.` });
    } catch (error) { showError(error); } finally { setBusy(""); }
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
      setNotice({ kind: "info", text: response.history.length ? `Found ${response.history.length} saved grading run(s).` : "No saved grading runs found for this pseudonym." });
    } catch (error) { showError(error); } finally { setBusy(""); }
  }

  async function gradeSubmission() {
    if (!selectedRubric || !submissionText) return;
    setBusy("grading"); setResults([]);
    const context = selectedRubric.id && selectedCourse && pseudonym.trim()
      ? { courseId: selectedCourse.id, rubricId: selectedRubric.id, pseudonym: pseudonym.trim() }
      : undefined;
    try {
      const rubricForGrading = {
        ...selectedRubric,
        assignmentDirections: assignmentDirections.trim() || null,
      };
      const response = await api<{ model: string; gradingRunId: string | null; results: GradeCriterionResult[] }>(
        "/api/grading", jsonInit("POST", { rubric: rubricForGrading, submissionText, apaEnabled, context }),
      );
      setResults(response.results); setModel(response.model);
      setNotice({ kind: "success", text: context ? "Suggestions generated and saved as a reviewable run." : "Suggestions generated for review. This run was not persisted." });
    } catch (error) { showError(error); } finally { setBusy(""); }
  }

  function updateResult(index: number, patch: Partial<GradeCriterionResult>) {
    setResults((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }

  async function saveResult(index: number) {
    const result = results[index]; if (!result.resultId) return;
    setBusy(`save-${index}`);
    try {
      await api(`/api/grading/results/${result.resultId}`, jsonInit("PATCH", {
        approvedRating: result.approvedRating, approvedPoints: result.approvedPoints,
        approvedExplanation: result.approvedExplanation,
      }));
      setNotice({ kind: "success", text: "Approved criterion saved." });
    } catch (error) { showError(error); } finally { setBusy(""); }
  }

  async function copyComment(result: GradeCriterionResult) {
    const text = `${result.approvedRating} — ${result.approvedPoints} points\n${result.approvedExplanation}`;
    try { await navigator.clipboard.writeText(text); setNotice({ kind: "success", text: "Canvas-ready comment copied." }); }
    catch { setNotice({ kind: "error", text: "Clipboard access was blocked. Select and copy the approved comment manually." }); }
  }

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
    if (!discussionReply) return;
    try { await navigator.clipboard.writeText(discussionReply); setNotice({ kind: "success", text: "Response copied." }); }
    catch { setNotice({ kind: "error", text: "Clipboard access was blocked. Select and copy the response manually." }); }
  }
  return (
    <div className="app-shell">
      <header className="topbar">
        <div><p className="eyebrow">Local-first faculty tool</p><h1>Course Grading Assist</h1></div>
        <div className="health-summary" aria-label="System health">
          <StatusDot ok={health?.database.connected} label={health?.database.connected ? "Database connected" : "Database unavailable"} />
          <StatusDot ok={health?.ollama.available && health.ollama.modelAvailable} label={health?.ollama.modelAvailable ? "Grader ready" : "Grader unavailable"} />
          <StatusDot ok={health?.libreOffice.available} label={health?.libreOffice.available ? "DOC extraction ready" : "DOC extraction unavailable"} />
        </div>
      </header>

      <main>
        <nav className="tab-bar" role="tablist" aria-label="Workspaces">
          <button type="button" role="tab" aria-selected={activeTab === "grading"} className={`tab ${activeTab === "grading" ? "active" : ""}`} onClick={() => setActiveTab("grading")}>Grading</button>
          <button type="button" role="tab" aria-selected={activeTab === "discussions"} className={`tab ${activeTab === "discussions" ? "active" : ""}`} onClick={() => setActiveTab("discussions")}>Discussions</button>
        </nav>
        {notice && <div className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div>}
        {health && !health.database.configured && (
          <div className="notice info" role="status"><strong>Database is not configured.</strong> Fixture grading and document extraction remain available, but courses and saved edits require a database.</div>
        )}

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
            <div className="button-row"><button type="button" onClick={() => void copyDiscussionReply()}>Copy response</button></div>
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
          <div className="section-heading"><div><span className="step">2</span><h2 id="roster-heading">Pseudonym roster</h2></div><p>Validate a roster, export an encrypted crosswalk, or unlock one temporarily in memory.</p></div>
          <label htmlFor="roster-file">Canvas roster CSV</label>
          <input id="roster-file" type="file" accept=".csv,text/csv" onChange={(event) => { setRosterFile(event.target.files?.[0] || null); setValidation(null); setCrosswalkConfirmed(false); }} />
          <button type="button" className="secondary" disabled={!rosterFile || busy === "roster"} onClick={() => void validateRoster()}>{busy === "roster" ? "Validating…" : "Validate roster"}</button>
          {validation && <div className="validation-card"><strong>{validation.rowCount} student rows ready</strong><span>{validation.columnCount} columns · Stable ID: {validation.stableIdHeader}</span>
            <div className="encrypted-export">
              <div><strong>Recommended: encrypted crosswalk</strong><p>The complete identifiable CSV is encrypted before download. The passphrase is used only for this export, is never stored, and cannot be recovered.</p></div>
              <div className="form-grid">
                <div><label htmlFor="export-passphrase">Encryption passphrase</label><input id="export-passphrase" type="password" autoComplete="off" minLength={12} maxLength={256} value={exportPassphrase} onChange={(event) => setExportPassphrase(event.target.value)} aria-describedby="export-passphrase-help" /></div>
                <div><label htmlFor="export-passphrase-confirmation">Confirm passphrase</label><input id="export-passphrase-confirmation" type="password" autoComplete="off" minLength={12} maxLength={256} value={exportPassphraseConfirmation} onChange={(event) => setExportPassphraseConfirmation(event.target.value)} /></div>
              </div>
              <small id="export-passphrase-help">Use 12–256 characters and keep it separately from the encrypted file.</small>
              {exportPassphraseConfirmation && exportPassphrase !== exportPassphraseConfirmation && <small className="field-error" role="alert">Passphrases do not match.</small>}
              <button type="button" disabled={!selectedCourse || exportPassphrase.length < 12 || exportPassphrase !== exportPassphraseConfirmation || busy === "crosswalk-encrypted"} onClick={() => void downloadCrosswalk("encrypted")}>{busy === "crosswalk-encrypted" ? "Encrypting…" : "Create and download encrypted crosswalk"}</button>
              {!selectedCourse && <small>Select a course before creating the crosswalk.</small>}
            </div>
            <details className="plaintext-fallback">
              <summary>Plaintext CSV fallback (higher risk)</summary>
              <div className="privacy-warning"><strong>Identifiable data warning</strong><p>This fallback downloads student identities and pseudonyms without encryption. Store it only in an approved secure location and never upload it with submissions.</p>
                <label className="check-row"><input type="checkbox" checked={crosswalkConfirmed} onChange={(event) => setCrosswalkConfirmed(event.target.checked)} />I understand this CSV contains identifiable student data.</label>
              </div>
              <button type="button" className="secondary" disabled={!selectedCourse || !crosswalkConfirmed || busy === "crosswalk-csv"} onClick={() => void downloadCrosswalk("csv")}>{busy === "crosswalk-csv" ? "Creating…" : "Create and download plaintext CSV"}</button>
            </details>
          </div>}
          <div className="unlock-card">
            <h3>Unlock encrypted crosswalk</h3>
            <p>Choose an encrypted crosswalk and enter its passphrase. Identity labels and pseudonyms are returned only to this page's React memory; they are not stored in browser storage or Neon.</p>
            <div className="form-grid">
              <div><label htmlFor="unlock-file">Encrypted crosswalk file</label><input id="unlock-file" type="file" accept=".json,application/json" onChange={(event) => { setUnlockFile(event.target.files?.[0] || null); setUnlockedMappings([]); }} /></div>
              <div><label htmlFor="unlock-passphrase">Passphrase</label><input id="unlock-passphrase" type="password" autoComplete="off" minLength={12} maxLength={256} value={unlockPassphrase} onChange={(event) => setUnlockPassphrase(event.target.value)} /></div>
            </div>
            <button type="button" className="secondary" disabled={!unlockFile || unlockPassphrase.length < 12 || busy === "unlock"} onClick={() => void unlockCrosswalk()}>{busy === "unlock" ? "Unlocking…" : "Unlock in memory"}</button>
            {unlockedMappings.length > 0 && <small role="status">{unlockedMappings.length} mappings are available only until this page reloads or the selected course changes.</small>}
          </div>
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
              {busy === "document" && <p className="loading" role="status">Extracting document…</p>}
              {extractionStats && <div className="stats" aria-label="Extraction statistics"><div><strong>{extractionStats.words.toLocaleString()}</strong><span>words</span></div><div><strong>{extractionStats.characters.toLocaleString()}</strong><span>characters</span></div><div><strong>~{extractionStats.pages}</strong><span>pages</span></div><p>{documentName} extracted. Full student content is intentionally not displayed.</p></div>}
            </div>
          </div>
        </section>

        <section className="panel" aria-labelledby="grade-heading">
          <div className="section-heading"><div><span className="step">4</span><h2 id="grade-heading">Generate suggestions</h2></div><p>Identify the pseudonym, set the APA policy, and review every result before use.</p></div>
          <p className="scoring-note"><strong>Flexible scoring:</strong> Rubric rating points are anchors, not exclusive values. Suggested and professor-approved points may fall between anchors, from zero through each criterion maximum.</p>
          <div className="grade-controls">
            <div>
              {unlockedMappings.length > 0 && <><label htmlFor="identity-selector">Unlocked identity (memory only)</label><select id="identity-selector" value={unlockedMappings.some((mapping) => mapping.pseudonym === pseudonym) ? pseudonym : ""} onChange={(event) => { setPseudonym(event.target.value); setHistory([]); }}><option value="">Choose an identity label</option>{unlockedMappings.map((mapping) => <option key={mapping.pseudonym} value={mapping.pseudonym}>{mapping.identityLabel}</option>)}</select><small>Identity labels stay only in memory. Selecting one fills the pseudonym below.</small></>}
              <label htmlFor="pseudonym">Student pseudonym</label><input id="pseudonym" value={pseudonym} maxLength={120} placeholder="COURSE-SECTION-SXXXXXXXX" onChange={(event) => { setPseudonym(event.target.value); setHistory([]); }} /><small>Manual pseudonym entry remains available. A pseudonym is required only to persist a run against a stored rubric and course.</small><button type="button" className="secondary history-button" disabled={!selectedCourse || !pseudonym.trim() || busy === "history"} onClick={() => void loadHistory()}>{busy === "history" ? "Searching…" : "Find saved records"}</button>
            </div>
            <fieldset><legend>APA evaluation</legend><label className="switch-row"><input type="checkbox" checked={apaEnabled} onChange={(event) => setApaEnabled(event.target.checked)} /><span>Evaluate APA requirements</span></label><p className={apaEnabled ? "enabled-note" : "disabled-note"}>{apaEnabled ? "Enabled: APA applies only where the rubric explicitly supports it." : "Disabled: the grader must not deduct points, lower ratings, criticize, or mention APA."}</p></fieldset>
          </div>
          <button className="primary large" type="button" disabled={!selectedRubric || !submissionText || busy === "grading"} onClick={() => void gradeSubmission()}>{busy === "grading" ? "Grading locally…" : "Generate grading suggestions"}</button>
          {(!selectedRubric || !submissionText) && <small>Choose a rubric and extract a document to continue.</small>}
          {history.length > 0 && <div className="history-list" aria-label="Saved grading records">
            <h3>Saved records for {pseudonym}</h3>
            {history.map((run) => <details key={run.id}>
              <summary><strong>{run.assignmentName}</strong><span>{new Date(run.createdAt).toLocaleString()} · {run.results.reduce((sum, item) => sum + item.approvedPoints, 0)} approved points</span></summary>
              <div>{run.results.map((item, index) => <div className="history-result" key={`${run.id}-${index}`}><strong>{item.criterionName || `Criterion ${index + 1}`}: {item.approvedRating} · {item.approvedPoints}</strong><p>{item.approvedExplanation}</p></div>)}</div>
            </details>)}
          </div>}
        </section>

        {results.length > 0 && <section className="results" aria-labelledby="results-heading">
          <div className="results-title"><div><p className="eyebrow">Human review required</p><h2 id="results-heading">Criterion results</h2></div><span className="model-chip">Model: {model}</span></div>
          {results.map((result, index) => {
            const criterion = selectedRubric?.criteria.find((item) => item.sourceId === result.criterionId);
            return <article className="result-card" key={result.criterionId}>
              <div className="result-header"><div><span>Criterion {index + 1}</span><h3>{criterion?.name || result.criterionId}</h3></div><span className={result.reviewRequired ? "badge review" : "badge ready"}>{result.reviewRequired ? "Review required" : "Ready to review"}</span></div>
              <div className="suggestion-grid"><div><span>Suggested rating</span><strong>{result.suggestedRating}</strong></div><div><span>Suggested points</span><strong>{result.suggestedPoints} / {criterion?.maximumPoints ?? "—"}</strong></div><div><span>Confidence</span><strong>{Math.round(result.confidence * 100)}%</strong></div></div>
              <div className="analysis-copy"><h4>Model rationale</h4><p>{result.explanation}</p><h4>Evidence</h4>{result.evidence.length ? <ul>{result.evidence.map((evidence, evidenceIndex) => <li key={evidenceIndex}>{evidence}</li>)}</ul> : <p>No direct evidence returned.</p>}</div>
              <div className="approval-editor"><h4>Approved Canvas feedback</h4><div className="form-grid"><Field label="Approved rating" required value={result.approvedRating} onChange={(value) => updateResult(index, { approvedRating: value })} /><Field label="Approved points" type="number" min={0} step="any" required value={String(result.approvedPoints)} max={criterion?.maximumPoints ?? undefined} onChange={(value) => updateResult(index, { approvedPoints: Number(value) })} /></div>
                <label htmlFor={`explanation-${index}`}>Approved comment</label><textarea id={`explanation-${index}`} rows={4} maxLength={1500} value={result.approvedExplanation} onChange={(event) => updateResult(index, { approvedExplanation: event.target.value })} />
                <div className="button-row"><button type="button" onClick={() => void copyComment(result)}>Copy Canvas-ready comment</button><button type="button" className="secondary" disabled={!result.resultId || busy === `save-${index}`} onClick={() => void saveResult(index)}>{busy === `save-${index}` ? "Saving…" : "Save approved edits"}</button></div>
                {!result.resultId && <small>This result is not persisted. Use a stored rubric, selected course, and valid pseudonym to enable saved edits.</small>}
              </div>
            </article>;
          })}
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
