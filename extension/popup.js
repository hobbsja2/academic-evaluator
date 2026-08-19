const captureButton = document.querySelector('#capture');
const activeCourseElement = document.querySelector('#active-course');
const statusElement = document.querySelector('#status');
const summaryElement = document.querySelector('#summary');
const captureCountsElement = document.querySelector('#capture-counts');
const completenessElement = document.querySelector('#completeness');
const importUrl = 'http://127.0.0.1:8787/api/rubrics/import';
const directionsImportUrl = 'http://127.0.0.1:8787/api/rubrics/directions/import';
const activeCourseUrl = 'http://127.0.0.1:8787/api/courses/active';
let activeCourse = null;

function setStatus(message, kind = '') {
  statusElement.textContent = message;
  statusElement.className = kind;
}

function clearSummary() {
  summaryElement.hidden = true;
  captureCountsElement.textContent = '';
  completenessElement.textContent = '';
  completenessElement.className = '';
}

function safeCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function renderSummary(diagnostics) {
  const criteria = safeCount(diagnostics?.parsedCriterionCount);
  const ratings = safeCount(diagnostics?.ratingCount);
  const malformed = safeCount(diagnostics?.malformedCriterionCount);
  const missingRatings = safeCount(diagnostics?.missingRatingCount);
  const missingMaximums = safeCount(diagnostics?.missingMaximumPointsCount);
  const missingDescriptors = safeCount(diagnostics?.missingRatingDescriptionCount);
  const invalidPoints = safeCount(diagnostics?.invalidPointCount);
  const directionsCaptured = diagnostics?.assignmentDirectionsCaptured === true;

  captureCountsElement.textContent = `${criteria} criteria · ${ratings} ratings · assignment directions ${directionsCaptured ? 'captured' : 'not found'}`;
  const warnings = [];
  if (malformed) warnings.push(`${malformed} malformed criteria`);
  if (missingRatings) warnings.push(`${missingRatings} criteria without ratings`);
  if (missingMaximums) warnings.push(`${missingMaximums} criteria without explicit maximum points`);
  if (missingDescriptors) warnings.push(`${missingDescriptors} ratings without descriptor text`);
  if (invalidPoints) warnings.push(`${invalidPoints} invalid point values ignored`);

  if (missingRatings || missingMaximums || missingDescriptors) {
    completenessElement.textContent = `Verification required: ${warnings.join('; ')}.`;
    completenessElement.className = 'warning';
  } else if (warnings.length) {
    completenessElement.textContent = `Review recommended: ${warnings.join('; ')}.`;
    completenessElement.className = 'warning';
  } else {
    completenessElement.textContent = 'No completeness warnings detected.';
    completenessElement.className = 'complete';
  }
  summaryElement.hidden = false;
}

async function jsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function courseLabel(course) {
  return `${course.code} · Section ${course.section} · ${course.term}`;
}

async function refreshActiveCourse() {
  let response;
  try {
    response = await fetch(activeCourseUrl, { method: 'GET', cache: 'no-store' });
  } catch {
    activeCourse = null;
    activeCourseElement.textContent = 'Local application unavailable.';
    captureButton.disabled = true;
    throw new Error('Open the local application and select a course before capturing.');
  }
  const payload = await jsonResponse(response).catch(() => null);
  const course = payload?.activeCourse;
  if (!response.ok || !course || typeof course.id !== 'string' ||
      typeof course.code !== 'string' || typeof course.section !== 'string' ||
      typeof course.term !== 'string' || typeof course.token !== 'string') {
    activeCourse = null;
    activeCourseElement.textContent = 'No local course selected.';
    captureButton.disabled = true;
    throw new Error('Select a course in the local application before capturing.');
  }
  activeCourse = course;
  activeCourseElement.textContent = `Saving to: ${courseLabel(course)}`;
  captureButton.disabled = false;
  return course;
}

async function captureActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url || '')) {
      throw new Error('Open a Canvas assignment or SpeedGrader page first.');
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['canvas-rubric-parser.js']
    });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => globalThis.captureCanvasRubric()
    });
    if (!result?.ok) {
      throw new Error(result?.error ||
        'No readable expanded rubric or authenticated assignment rubric was found.');
    }
    return result;
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error('Could not read the active page.');
  }
}

async function importRubric(data, selectedCourseToken) {
  try {
    const response = await fetch(importUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, selectedCourseToken })
    });
    const payload = await jsonResponse(response);
    if (!response.ok) {
      const serverError = typeof payload?.error === 'string' ? payload.error.trim() : '';
      throw new Error(serverError || `Import failed (${response.status}).`);
    }
    if (!payload || payload.persisted !== true || !payload.course) {
      throw new Error('The local importer returned an invalid response.');
    }
    return payload;
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error('Could not reach the local importer.');
  }
}

async function importDirections(data, selectedCourseToken) {
  try {
    const response = await fetch(directionsImportUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, selectedCourseToken })
    });
    const payload = await jsonResponse(response);
    if (!response.ok || payload?.staged !== true) {
      const serverError = typeof payload?.error === 'string' ? payload.error.trim() : '';
      throw new Error(serverError || `Directions import failed (${response.status}).`);
    }
    return payload;
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error('Could not stage assignment directions locally.');
  }
}

function renderDirectionsStaged(payload, diagnostics) {
  captureCountsElement.textContent = 'Assignment directions captured · rubric pending';
  completenessElement.textContent = 'Within 30 minutes, select Preview Rubric in Canvas, then run Capture and import again.';
  completenessElement.className = 'warning';
  summaryElement.hidden = false;
  const target = payload?.course ? courseLabel(payload.course) : 'the selected local course';
  setStatus(`Directions staged for ${target}.`, 'success');
  if (diagnostics) diagnostics.assignmentDirectionsCaptured = true;
}

function renderImportResult(payload, diagnostics) {
  if (payload.directionsMerged && diagnostics) diagnostics.assignmentDirectionsCaptured = true;
  renderSummary(diagnostics);
  if (payload.persisted) {
    const version = Number.isFinite(payload.version) ? ` as rubric version ${payload.version}` : '';
    const merged = payload.directionsMerged ? ' Staged assignment directions were merged.' : '';
    setStatus(`Saved to ${courseLabel(payload.course)}${version}.${merged}`, 'success');
  }
}

async function captureAndImport() {
  try {
    const selectedCourse = await refreshActiveCourse();
    const result = await captureActiveTab();
    if (result.captureType === 'directions-only') {
      setStatus('Staging assignment directions locally…');
      const payload = await importDirections(result.data, selectedCourse.token);
      renderDirectionsStaged(payload, result.diagnostics);
      return;
    }
    setStatus(`Importing rubric into ${courseLabel(selectedCourse)}…`);
    const payload = await importRubric(result.data, selectedCourse.token);
    renderImportResult(payload, result.diagnostics);
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error('Capture failed.');
  }
}

void refreshActiveCourse().catch((error) => {
  setStatus(error instanceof Error ? error.message : 'Select a course in the local application.', 'warning');
});

captureButton.addEventListener('click', async () => {
  captureButton.disabled = true;
  clearSummary();
  setStatus('Reading the Canvas rubric and assignment directions…');
  try {
    await captureAndImport();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Capture failed.', 'error');
  } finally {
    captureButton.disabled = !activeCourse;
  }
});
