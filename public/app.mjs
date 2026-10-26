import { CaseWorkflow, DRAFT_FIELDS, MAX_NOTES_LENGTH } from './workflow.mjs';

const $ = (id) => document.getElementById(id);
const elements = Object.fromEntries(['load-status', 'workspace', 'review-panel', 'error-message', 'agent-notes', 'notes-count', 'scenario-title', 'mode-selector', 'model-status', 'simulation-notice', 'generate-draft', 'reset-scenario', 'draft-empty', 'draft-content', 'draft-status', 'draft-provenance', 'source-changed', 'review-help', 'human-review', 'export-case', 'activity-status'].map((id) => [id, $(id)]));
const draftInputs = DRAFT_FIELDS.map((field) => $(`draft-${field}`));
let workflow;
let bootstrap;

function showError(message) {
  elements['error-message'].textContent = message;
  elements['error-message'].hidden = !message;
}

function announce(message) {
  elements['activity-status'].textContent = message;
}

function render({ syncFields = false } = {}) {
  const busy = !!workflow.pending;
  if (syncFields) {
    elements['agent-notes'].value = workflow.notes;
    for (const input of draftInputs) input.value = workflow.draft?.[input.dataset.field] || '';
  }
  elements['notes-count'].textContent = `${workflow.notes.length.toLocaleString()} / ${MAX_NOTES_LENGTH.toLocaleString()}`;
  elements['agent-notes'].disabled = busy;
  elements['reset-scenario'].disabled = busy;
  elements['mode-selector'].disabled = busy;
  draftInputs.forEach((input) => { input.disabled = busy || !workflow.draft; });
  elements['simulation-notice'].hidden = workflow.mode !== 'simulation';
  elements['model-status'].textContent = workflow.mode === 'simulation'
    ? 'Simulation is explicitly selected. No model API call will be made.'
    : bootstrap.apiConfigured
      ? `Backend key configured · model ${bootstrap.model}.`
      : 'Backend key not configured. Add the key locally and restart the backend, or explicitly choose a simulated summary.';
  elements['generate-draft'].disabled = busy || !workflow.notes.trim();
  elements['generate-draft'].textContent = busy ? 'Generating draft…' : workflow.draft ? 'Regenerate draft ↗' : 'Generate draft ↗';
  elements['workspace'].setAttribute('aria-busy', String(busy));
  elements['draft-empty'].hidden = !!workflow.draft;
  elements['draft-content'].hidden = !workflow.draft;
  elements['draft-status'].textContent = workflow.reviewedAt ? 'REVIEWED' : workflow.draft ? 'REVIEW REQUIRED' : 'AWAITING DRAFT';
  elements['draft-status'].classList.toggle('reviewed', !!workflow.reviewedAt);
  if (workflow.provenance) {
    const provenance = workflow.provenance;
    const time = new Date(provenance.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    elements['draft-provenance'].textContent = provenance.kind === 'simulation'
      ? `SIMULATED SUMMARY — no model API call · generated ${time}. Review against your source notes.`
      : `Meta Model API · ${provenance.model} · generated ${time}. AI draft requires human review.`;
    elements['draft-provenance'].classList.toggle('simulated', provenance.kind === 'simulation');
  }
  const blockReason = workflow.reviewBlockReason;
  elements['source-changed'].hidden = !workflow.draft || !blockReason || busy;
  elements['source-changed'].textContent = blockReason;
  elements['human-review'].disabled = !workflow.canReview;
  elements['human-review'].checked = !!workflow.reviewedAt;
  elements['export-case'].disabled = !workflow.canExport;
  elements['review-help'].textContent = blockReason || (workflow.reviewedAt
    ? 'Review recorded. Export this reviewed case to a JSON file on your device.'
    : 'Compare all four sections with the source notes. Edit anything needed, then explicitly confirm your review.');
}

async function generateDraft() {
  showError('');
  let request;
  try {
    request = workflow.startGeneration();
    render();
    announce(workflow.mode === 'simulation' ? 'Creating an explicitly simulated summary…' : 'Requesting a draft from the Meta Model API…');
    const response = await fetch('/api/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: request.notes, mode: request.mode }),
      // Backend permits up to 120 seconds; allow time for its safe error response.
      signal: AbortSignal.timeout(130000),
    });
    let payload;
    try { payload = await response.json(); } catch {
      throw new Error('The backend returned an unreadable response. Your notes and existing edits are preserved.');
    }
    if (!response.ok) {
      // The backend exposes only curated safe errors, never raw provider bodies.
      throw new Error(typeof payload?.error?.message === 'string' ? payload.error.message : 'Draft generation failed. Your notes and existing edits are preserved.');
    }
    const applied = workflow.finishGeneration(request, payload);
    if (!applied) {
      showError('The source, mode or draft changed during generation. The incoming response was discarded to preserve your edits. Generate again when ready.');
      announce('Incoming draft discarded. Your current notes and edits were preserved.');
    } else {
      announce(request.mode === 'simulation' ? 'Simulated summary ready. Compare it with the notes and complete human review.' : 'Meta API draft ready. Compare it with the notes and complete human review.');
    }
    render({ syncFields: applied });
  } catch (error) {
    if (request) workflow.failGeneration(request);
    const message = error.name === 'TimeoutError' || error.name === 'AbortError'
      ? 'The draft request timed out. Your notes and existing edits are preserved. Try again when ready.'
      : error instanceof TypeError
        ? 'The backend could not be reached. Keep this page open to preserve your notes and edits, check the server, then try again.'
        : error.message;
    showError(message);
    announce('Draft generation did not complete. Notes and existing edits were preserved; a fresh successful draft and review are required.');
    render();
  }
}

function exportCase() {
  showError('');
  try {
    const reviewedCase = workflow.exportCase();
    const blob = new Blob([`${JSON.stringify(reviewedCase, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.download = `community-connect-${workflow.provenance.kind === 'simulation' ? 'SIMULATED-' : ''}reviewed-case-${stamp}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    // Leave enough time for the browser to consume the URL, without keeping case data stored.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce('Reviewed case downloaded as JSON. It includes the source notes, final draft, generation source and review time.');
  } catch (error) {
    showError(error.message);
  }
}

async function initialise() {
  try {
    const response = await fetch('/api/bootstrap', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('The synthetic scenario could not be loaded. Check the backend and reload this page.');
    bootstrap = await response.json();
    if (typeof bootstrap.apiConfigured !== 'boolean' || typeof bootstrap.model !== 'string') throw new Error('The backend configuration response was invalid.');
    workflow = new CaseWorkflow(bootstrap.scenario);
    elements['scenario-title'].textContent = workflow.scenario.title;
    elements['agent-notes'].addEventListener('input', (event) => {
      workflow.setSource(event.target.value);
      render();
    });
    elements['reset-scenario'].addEventListener('click', () => {
      workflow.setSource(workflow.scenario.notes);
      render({ syncFields: true });
      announce('Original synthetic notes restored. Generate and review a fresh draft if the source changed.');
    });
    document.querySelectorAll('input[name="draft-mode"]').forEach((radio) => radio.addEventListener('change', (event) => {
      if (event.target.checked) workflow.setMode(event.target.value);
      showError('');
      render();
    }));
    draftInputs.forEach((input) => input.addEventListener('input', (event) => {
      workflow.setDraftField(event.target.dataset.field, event.target.value);
      render();
    }));
    elements['human-review'].addEventListener('change', (event) => {
      try {
        workflow.setReviewed(event.target.checked);
        render();
        announce(workflow.reviewedAt ? 'Human review confirmed. JSON export is now available.' : 'Review confirmation removed. Export is disabled.');
      } catch (error) {
        showError(error.message);
        render();
      }
    });
    elements['generate-draft'].addEventListener('click', generateDraft);
    elements['export-case'].addEventListener('click', exportCase);
    window.addEventListener('beforeunload', (event) => {
      if (workflow.draft || workflow.notes !== workflow.scenario.notes) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
    elements['load-status'].hidden = true;
    elements['workspace'].hidden = false;
    elements['review-panel'].hidden = false;
    render({ syncFields: true });
  } catch {
    elements['load-status'].hidden = true;
    showError('Could not load the synthetic scenario. Start the backend, open its local URL, then reload this page.');
  }
}

initialise();
