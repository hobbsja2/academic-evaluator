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

Open `http://127.0.0.1:5173`. The API listens only on `127.0.0.1:8787`. The first grading request on a cold or CPU-only computer can take several minutes; the default local inference timeout is five minutes and can be adjusted with `OLLAMA_TIMEOUT_MS` (30,000–900,000 milliseconds). Known service errors are shown safely in the UI, while unexpected server errors remain masked.

## Canvas extension

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode** and choose **Load unpacked**.
3. Select the repository's `extension` folder.
4. Open an authenticated Canvas standard assignment or SpeedGrader page and click **Capture and import**. If an expanded rubric is readable, the extension parses that DOM first. It also captures assignment directions from a narrowly scoped assignment-description container when available. Otherwise—or when directions are not present in that DOM—it can make a same-origin, read-only Canvas Assignment API request using the page's existing authenticated session. Canvas HTML directions are converted to bounded plain text before import.

The popup reports a privacy-safe completeness summary with criterion/rating counts, whether assignment directions were found, and warnings for missing ratings, explicit maximum points, rating descriptor text, or invalid point values. It never displays captured rubric or assignment text, Canvas identifiers, source URLs, API response content, or HTML. A capture that cannot be matched to one locally configured course is held in server memory only and will not survive a restart; reliable course matching requires that course's Canvas course ID to be configured locally.

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
