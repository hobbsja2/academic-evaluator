# Course Grading Assist

Local-first React/Node application for faculty-reviewed grading against Canvas rubrics. Ollama performs inference locally; Neon stores course, pseudonym, rubric, and review data.

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

Open `http://127.0.0.1:5173`. The API listens only on `127.0.0.1:8787`. Grading a full-page submission against a large rubric on a CPU-only computer can take several minutes (around 3–4 minutes is normal); the default local inference timeout is seven minutes and can be adjusted with `OLLAMA_TIMEOUT_MS` (30,000–900,000 milliseconds). Model output is bounded so a submission cannot cause runaway generation. Known service errors are shown safely in the UI, while unexpected server errors remain masked.

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
- Neon receives course-specific pseudonyms, not student names, email addresses, Canvas IDs, SIS IDs, or roster rows.
- **Encrypted crosswalk export is recommended.** The complete identifiable CSV is protected with a passphrase before download. The passphrase is never stored and cannot be recovered, so keep it separately in an approved password manager.
- An encrypted crosswalk can be unlocked in the app when an identity label is needed. Decryption occurs in server memory, and the returned identity-label/pseudonym mappings remain only in React memory until the page reloads or the selected course changes. They are not saved to Neon, localStorage, sessionStorage, or IndexedDB.
- Plaintext CSV export remains available as an explicitly acknowledged fallback. It contains identifiable, unencrypted student data and must be stored outside this repository in an approved secure location.
- Course data is deleted with cascading relationships 21 days after the course end date. Cleanup runs at startup and every six hours while the server is running.
- Assignment directions may be stored as bounded plain text with a rubric and grading run. They provide supporting context only: the rubric remains the sole scoring authority, and directions cannot create independent deductions or override the APA setting.
- Rubric rating point values are scoring anchors, not exclusive allowed scores. The local grader may recommend any defensible value from zero through the criterion maximum—including values between anchors—while using the best-fitting qualitative rating label. The professor can edit both fields and makes the final determination.
- The tool suggests grades only. A professor must review/edit every criterion and manually enter approved results in Canvas.
- When APA evaluation is disabled, the grading prompt explicitly prohibits APA-based deductions or criticism.
