const captureButton = document.querySelector('#capture');
const statusElement = document.querySelector('#status');
const summaryElement = document.querySelector('#summary');
const captureCountsElement = document.querySelector('#capture-counts');
const completenessElement = document.querySelector('#completeness');
const importUrl = 'http://127.0.0.1:8787/api/rubrics/import';

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

  captureCountsElement.textContent = `${criteria} criteria · ${ratings} ratings`;
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

async function importRubric(data) {
  try {
    const response = await fetch(importUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const payload = await jsonResponse(response);
    if (!response.ok) {
      const serverError = typeof payload?.error === 'string' ? payload.error.trim() : '';
      throw new Error(serverError || `Import failed (${response.status}).`);
    }
    if (!payload || typeof payload.persisted !== 'boolean') {
      throw new Error('The local importer returned an invalid response.');
    }
    return payload;
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error('Could not reach the local importer.');
  }
}

function renderImportResult(payload, diagnostics) {
  renderSummary(diagnostics);
  if (payload.persisted) {
    const version = Number.isFinite(payload.version) ? ` as version ${payload.version}` : '';
    setStatus(`Persisted locally${version}.`, 'success');
    return;
  }
  setStatus(
    'Captured in server memory only; it will not survive a restart. Course matching requires the Canvas course ID to be configured locally.',
    'warning'
  );
}

async function captureAndImport() {
  try {
    const result = await captureActiveTab();
    setStatus('Importing rubric…');
    const payload = await importRubric(result.data);
    renderImportResult(payload, result.diagnostics);
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error('Capture failed.');
  }
}

captureButton.addEventListener('click', async () => {
  captureButton.disabled = true;
  clearSummary();
  setStatus('Reading an expanded Canvas rubric or retrieving the active assignment rubric…');
  try {
    await captureAndImport();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Capture failed.', 'error');
  } finally {
    captureButton.disabled = false;
  }
});
