export const DRAFT_FIELDS = Object.freeze(['enquiry', 'relevantDetails', 'uncertainties', 'nextSteps']);
export const MAX_NOTES_LENGTH = 12000;
export const MAX_DRAFT_FIELD_LENGTH = 12000;

const REVIEW_STATEMENT = 'I compared this draft with the source notes, checked uncertainty and proposed next steps, and reviewed the final case.';

function validText(value, maximum) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function validateResult(result, expectedMode) {
  if (!result || !result.draft || !result.provenance || result.provenance.kind !== expectedMode) {
    throw new Error('The draft response was invalid. Your notes and existing edits are preserved.');
  }
  const draft = {};
  for (const field of DRAFT_FIELDS) {
    if (!validText(result.draft[field], MAX_DRAFT_FIELD_LENGTH)) {
      throw new Error('The draft response was incomplete. Your notes and existing edits are preserved.');
    }
    draft[field] = result.draft[field];
  }
  const provenance = {
    kind: expectedMode,
    label: expectedMode === 'simulation' ? 'SIMULATED SUMMARY — no model API call' : 'Meta Model API',
    generatedAt: result.provenance.generatedAt,
  };
  if (typeof provenance.generatedAt !== 'string' || !Number.isFinite(Date.parse(provenance.generatedAt))) {
    throw new Error('The draft response had no valid generation time. Your existing edits are preserved.');
  }
  if (expectedMode === 'meta') {
    if (!validText(result.provenance.model, 200) || !validText(result.provenance.responseId, 500)) {
      throw new Error('The draft response had no valid model provenance. Your existing edits are preserved.');
    }
    provenance.model = result.provenance.model;
    provenance.responseId = result.provenance.responseId;
  }
  return { draft, provenance };
}

/** In-memory workflow. A downloaded case is the only persistence mechanism. */
export class CaseWorkflow {
  constructor(scenario) {
    if (!scenario || !validText(scenario.notes, MAX_NOTES_LENGTH) || !validText(scenario.id, 200) || !validText(scenario.title, 500)) {
      throw new Error('The synthetic scenario could not be loaded.');
    }
    this.scenario = { id: scenario.id, title: scenario.title, notes: scenario.notes };
    this.notes = scenario.notes;
    this.mode = 'meta';
    this.draft = null;
    this.provenance = null;
    this.notesUsedForDraft = null;
    this.reviewedAt = null;
    this.sourceRevision = 0;
    this.draftRevision = 0;
    this.modeRevision = 0;
    this.requestSequence = 0;
    this.pending = null;
    this.lastAttemptSucceeded = false;
  }

  clearReview() {
    this.reviewedAt = null;
  }

  setSource(notes) {
    if (typeof notes !== 'string' || notes.length > MAX_NOTES_LENGTH) throw new Error('Agent notes are too long.');
    if (this.notes === notes) return;
    this.notes = notes;
    this.sourceRevision += 1;
    this.lastAttemptSucceeded = false;
    this.clearReview();
  }

  setMode(mode) {
    if (mode !== 'meta' && mode !== 'simulation') throw new Error('Choose a supported draft mode.');
    if (this.mode === mode) return;
    this.mode = mode;
    this.modeRevision += 1;
    this.lastAttemptSucceeded = false;
    this.clearReview();
  }

  setDraftField(field, value) {
    if (!this.draft || !DRAFT_FIELDS.includes(field) || typeof value !== 'string' || value.length > MAX_DRAFT_FIELD_LENGTH) {
      throw new Error('This draft field could not be updated.');
    }
    if (this.draft[field] === value) return;
    this.draft[field] = value;
    this.draftRevision += 1;
    this.clearReview();
  }

  startGeneration() {
    this.clearReview();
    this.lastAttemptSucceeded = false;
    if (!validText(this.notes, MAX_NOTES_LENGTH)) throw new Error('Add agent notes before generating a draft.');
    if (this.pending) throw new Error('A draft request is already in progress.');
    const request = Object.freeze({
      id: ++this.requestSequence,
      notes: this.notes,
      mode: this.mode,
      sourceRevision: this.sourceRevision,
      draftRevision: this.draftRevision,
      modeRevision: this.modeRevision,
    });
    this.pending = request;
    return request;
  }

  finishGeneration(request, result) {
    if (!this.pending || this.pending.id !== request.id) return false;
    this.pending = null;
    const unchanged = request.sourceRevision === this.sourceRevision && request.draftRevision === this.draftRevision && request.modeRevision === this.modeRevision;
    if (!unchanged) return false;
    const validated = validateResult(result, request.mode);
    this.draft = validated.draft;
    this.provenance = validated.provenance;
    this.notesUsedForDraft = request.notes;
    this.draftRevision += 1;
    this.lastAttemptSucceeded = true;
    this.clearReview();
    return true;
  }

  failGeneration(request) {
    if (!this.pending || this.pending.id !== request.id) return false;
    this.pending = null;
    this.lastAttemptSucceeded = false;
    this.clearReview();
    return true;
  }

  get reviewBlockReason() {
    if (this.pending) return 'Wait for the draft request to finish.';
    if (!this.draft) return 'Generate a draft to begin your review.';
    if (this.notes !== this.notesUsedForDraft) return 'Source notes changed. Generate a new draft before reviewing.';
    if (this.mode !== this.provenance?.kind) return 'Draft mode changed. Generate a new draft in the selected mode.';
    if (!this.lastAttemptSucceeded) return 'Generate successfully before reviewing. Your previous draft and edits are preserved.';
    if (!DRAFT_FIELDS.every((field) => validText(this.draft[field], MAX_DRAFT_FIELD_LENGTH))) return 'Complete all four draft fields before reviewing.';
    return '';
  }

  get canReview() {
    return this.reviewBlockReason === '';
  }

  setReviewed(checked, now = new Date().toISOString()) {
    if (!checked) {
      this.clearReview();
      return;
    }
    if (!this.canReview) throw new Error(this.reviewBlockReason);
    if (!Number.isFinite(Date.parse(now))) throw new Error('A valid review time is required.');
    this.reviewedAt = now;
  }

  get canExport() {
    return this.canReview && this.reviewedAt !== null;
  }

  exportCase(now = new Date().toISOString()) {
    if (!this.canExport) throw new Error(this.reviewBlockReason || 'Explicit human review is required before export.');
    return {
      schemaVersion: 1,
      project: 'Community Connect',
      scenario: { id: this.scenario.id, title: this.scenario.title, synthetic: true, callMode: 'simulated' },
      source: { type: 'synthetic_agent_notes', currentNotes: this.notes, notesUsedForDraft: this.notesUsedForDraft },
      draft: { ...this.draft },
      provenance: { ...this.provenance },
      review: { status: 'reviewed', reviewedAt: this.reviewedAt, statement: REVIEW_STATEMENT },
      exportedAt: now,
    };
  }
}

export { REVIEW_STATEMENT };
