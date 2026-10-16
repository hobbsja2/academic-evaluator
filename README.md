# Course Grading Assist

Local-first React/Node application for faculty-reviewed grading against Canvas rubrics. Ollama performs inference locally; Neon stores course, roster, rubric, and review data. Roster import writes each student's real name to `students.display_name` unencrypted, so that column is identifiable data held under the 21-day cascading purge.

## Prerequisites

- Node.js 24+
- Ollama with `qwen3:4b-instruct`
- LibreOffice (required for legacy `.doc` files)
- A Neon PostgreSQL database for persisted workflows

## Configure

1. Run `npm run setup`. This creates a Git-ignored `.env` with a random student identity key without displaying it.
2. Open `.env` locally and add the Neon pooled connection string as `DATABASE_URL`. The backend uses Neon's official serverless Pool over WebSockets, so it works where raw PostgreSQL TCP/5432 is restricted. Never commit the connection string or paste it into chat.
3. Back up `STUDENT_IDENTITY_KEY` in a password manager. Losing it prevents deterministic pseudonym regeneration.
4. Initialize the empty Neon database with `npm run db:migrate`.

## Run

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. The API listens only on `127.0.0.1:8787`. Grading a full-page submission against a large rubric on a CPU-only computer can take several minutes (around 3–4 minutes is normal); papers longer than about four pages can take 8–15 minutes because generation slows as the context fills. The default local inference timeout is 20 minutes and can be adjusted with `OLLAMA_TIMEOUT_MS` (30,000–1,800,000 milliseconds). A timeout is reported once rather than retried. Each run also returns an advisory AI-use score from 0 (more likely than not written solely by the student) to 10 (heavy AI use). The server keeps only model indicators whose quote appears verbatim in the submission and adds a repeatable stock-phrase scan. The score is saved with the run, is never evidence of misconduct, and never changes rubric points. The grading context window defaults to 16,384 tokens (about a 10-page paper) and can be adjusted with `OLLAMA_GRADING_NUM_CTX` (8,192–131,072); a submission that still does not fit returns a clear "too long" error instead of a retry. Model output is bounded so a submission cannot cause runaway generation. Known service errors are shown safely in the UI, while unexpected server errors remain masked.

## Canvas extension

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode** and choose **Load unpacked**.
3. Select the repository's `extension` folder.
4. Open the local application and select the course that should receive the capture. The course card must report **Canvas extension target: Active**.
5. Open an authenticated Canvas assignment page. The extension popup displays the selected local course before enabling capture. With the assignment directions visible, click **Capture and import**. If Canvas exposes both directions and rubric, import completes immediately. If the popup reports **rubric pending**, select **Preview Rubric** in Canvas and click **Capture and import** again. The local server stages the first capture for up to 30 minutes and merges it into the rubric capture for that selected local course. Keep the local server running and do not switch courses between the two clicks.

The selected local course—not Canvas course-ID matching—is the authoritative import destination. Every import carries a short-lived server selection token; if the UI course changes before import, the server rejects the stale capture rather than saving it to the wrong course. Rubric lists are queried and displayed only for the selected course. Use **Refresh course rubrics** after returning to the UI from an extension capture.

The extension still supports a one-step capture when an expanded rubric and directions are simultaneously readable or Canvas's same-origin Assignment API returns both. Canvas HTML directions are converted to bounded plain text before import. A directions-only stage is never written to browser storage and is removed from server memory after the matching rubric import.

The popup reports the allowlisted local course label, a privacy-safe completeness summary with criterion/rating counts, whether assignment directions were found or merged, and warnings for missing ratings, explicit maximum points, rating descriptor text, or invalid point values. It never displays captured rubric or assignment text, Canvas identifiers, source URLs, API response content, or HTML.

Faculty can review and edit assignment directions in the application before grading. Directions are saved as part of a persisted rubric version, and the exact directions used by a persisted grading run are also snapshotted with that run. For memory-only rubrics, edits last only for the current browser session.

The extension has no Canvas host permission and stores no Canvas credentials, cookies, tokens, or request headers. It acts only on the active page after an explicit click, keeps visible DOM parsing as the first capture method, and limits the fallback to a same-origin `GET` on a standard assignment or SpeedGrader URL. For official use, proceed only when the capture reports zero completeness warnings, or have faculty verify the captured rubric directly against Canvas before grading.

## Privacy and retention

- Original submissions and filenames are processed in memory and are not stored in Neon.
- Neon stores each student's name from the imported roster alongside that student's course-specific pseudonym. Grading runs reference the student row, not the name, and no name is written to a grading run or a log line. The 21-day cascading purge below is the retention control for the name column.
- Course data is deleted with cascading relationships 21 days after the course end date. Cleanup runs at startup and every six hours while the server is running.
- Assignment directions may be stored as bounded plain text with a rubric and grading run. They provide supporting context only: the rubric remains the sole scoring authority, and directions cannot create independent deductions or override the APA setting.
- Rubric rating point values are scoring anchors, not exclusive allowed scores. The local grader may recommend any defensible value from zero through the criterion maximum—including values between anchors—while using the best-fitting qualitative rating label. The professor can edit both fields and makes the final determination.
- The tool suggests grades only. A professor must review/edit every criterion and manually enter approved results in Canvas.
- When APA evaluation is disabled, the grading prompt explicitly prohibits APA-based deductions or criticism.
- When a student is selected, the feedback already saved for that student's other assignments in the course is summarised into the grading prompt as supporting context. It is sent to the model only and never displayed. `PRIOR_FEEDBACK_MAX_CHARS` bounds how much is included (default 3,000 characters, doubled for Claude); `PRIOR_FEEDBACK_MAX_CHARS=0` disables injection entirely.
