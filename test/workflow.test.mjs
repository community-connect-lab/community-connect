import test from 'node:test';
import assert from 'node:assert/strict';
import { CaseWorkflow } from '../public/workflow.mjs';

const scenario = { id: 'synthetic-001', title: 'Synthetic collection enquiry', notes: 'SYNTHETIC: Caller asks to change collection time. No change confirmed.' };
const fields = { enquiry: 'Change collection time.', relevantDetails: 'No change confirmed.', uncertainties: 'Alternative availability unknown.', nextSteps: 'Agent to check availability before agreeing a time.' };
const realResult = () => ({ draft: { ...fields }, provenance: { kind: 'meta', label: 'Meta Model API', model: 'test-model', responseId: 'response_synthetic', generatedAt: '2026-10-26T12:00:00Z' } });
const simulationResult = () => ({ draft: { ...fields }, provenance: { kind: 'simulation', label: 'Simulation', generatedAt: '2026-10-26T12:00:00Z' } });

function withDraft() {
  const workflow = new CaseWorkflow(scenario);
  const request = workflow.startGeneration();
  assert.equal(workflow.finishGeneration(request, realResult()), true);
  return workflow;
}

test('JSON export requires an existing draft and explicit human review', () => {
  const workflow = new CaseWorkflow(scenario);
  assert.equal(workflow.canReview, false);
  assert.throws(() => workflow.setReviewed(true), /Generate a draft/);
  assert.throws(() => workflow.exportCase(), /Generate a draft/);
  const request = workflow.startGeneration();
  workflow.finishGeneration(request, realResult());
  assert.equal(workflow.canReview, true);
  assert.equal(workflow.canExport, false);
  assert.throws(() => workflow.exportCase(), /Explicit human review/);
  workflow.setReviewed(true, '2026-10-26T12:05:00Z');
  assert.equal(workflow.canExport, true);
  const exported = workflow.exportCase('2026-10-26T12:06:00Z');
  assert.equal(exported.scenario.synthetic, true);
  assert.equal(exported.scenario.callMode, 'simulated');
  assert.equal(exported.source.currentNotes, scenario.notes);
  assert.equal(exported.source.notesUsedForDraft, scenario.notes);
  assert.deepEqual(exported.draft, fields);
  assert.equal(exported.review.status, 'reviewed');
  assert.equal(exported.review.reviewedAt, '2026-10-26T12:05:00Z');
  assert.equal(exported.provenance.kind, 'meta');
  exported.draft.enquiry = 'Changed outside the workflow';
  assert.equal(workflow.draft.enquiry, fields.enquiry);
});

test('editing any draft field revokes review and retains the edit for re-review/export', () => {
  const workflow = withDraft();
  workflow.setReviewed(true);
  workflow.setDraftField('enquiry', 'Agent-refined enquiry.');
  assert.equal(workflow.reviewedAt, null);
  assert.equal(workflow.canExport, false);
  assert.equal(workflow.canReview, true);
  workflow.setReviewed(true);
  assert.equal(workflow.exportCase().draft.enquiry, 'Agent-refined enquiry.');
  workflow.setDraftField('uncertainties', '');
  assert.equal(workflow.canReview, false);
  assert.throws(() => workflow.setReviewed(true), /Complete all four/);
});

test('source edits require regeneration, not merely another review checkbox', () => {
  const workflow = withDraft();
  workflow.setReviewed(true);
  workflow.setSource(`${scenario.notes} SYNTHETIC: caller prefers afternoon.`);
  assert.equal(workflow.canReview, false);
  assert.equal(workflow.canExport, false);
  assert.throws(() => workflow.setReviewed(true), /Source notes changed/);
  assert.equal(workflow.notesUsedForDraft, scenario.notes);
  const request = workflow.startGeneration();
  workflow.finishGeneration(request, realResult());
  assert.equal(workflow.canReview, true);
  assert.equal(workflow.canExport, false);
  workflow.setReviewed(true);
  assert.equal(workflow.exportCase().source.notesUsedForDraft, workflow.notes);
});

test('regeneration immediately revokes review; failure preserves notes and all draft edits', () => {
  const workflow = withDraft();
  workflow.setDraftField('nextSteps', 'Agent-edited next steps retained.');
  workflow.setReviewed(true);
  const before = { ...workflow.draft };
  const request = workflow.startGeneration();
  assert.equal(workflow.canExport, false);
  assert.equal(workflow.canReview, false);
  workflow.failGeneration(request);
  assert.equal(workflow.notes, scenario.notes);
  assert.deepEqual(workflow.draft, before);
  assert.equal(workflow.reviewedAt, null);
  assert.equal(workflow.canReview, false);
  assert.throws(() => workflow.exportCase(), /Generate successfully/);
});

test('successfully regenerating a reviewed case still requires fresh human review', () => {
  const workflow = withDraft();
  workflow.setReviewed(true);
  const request = workflow.startGeneration();
  workflow.finishGeneration(request, realResult());
  assert.equal(workflow.canReview, true);
  assert.equal(workflow.canExport, false);
});

test('editing and then restoring source or mode still requires a fresh generation', () => {
  const workflow = withDraft();
  workflow.setSource('A temporary synthetic edit.');
  workflow.setSource(scenario.notes);
  assert.equal(workflow.canReview, false);
  assert.equal(workflow.canExport, false);
  const request = workflow.startGeneration();
  workflow.finishGeneration(request, realResult());
  workflow.setMode('simulation');
  workflow.setMode('meta');
  assert.equal(workflow.canReview, false);
});

test('simulation requires explicit mode selection and is labelled in the exported case', () => {
  const workflow = withDraft();
  assert.equal(workflow.mode, 'meta');
  workflow.setReviewed(true);
  workflow.setMode('simulation');
  assert.equal(workflow.canReview, false);
  assert.equal(workflow.canExport, false);
  const request = workflow.startGeneration();
  workflow.finishGeneration(request, simulationResult());
  workflow.setReviewed(true);
  const exported = workflow.exportCase();
  assert.equal(exported.provenance.kind, 'simulation');
  assert.match(exported.provenance.label, /SIMULATED SUMMARY/);
  assert.equal('model' in exported.provenance, false);
  workflow.setMode('meta');
  assert.equal(workflow.canReview, false);
});

test('source, mode and draft changes during a request discard the response without overwriting edits', () => {
  for (const mutation of [
    (workflow) => workflow.setSource('New SYNTHETIC notes that supersede the pending request.'),
    (workflow) => workflow.setMode('simulation'),
    (workflow) => workflow.setDraftField('relevantDetails', 'Keep these agent edits.'),
  ]) {
    const workflow = withDraft();
    const request = workflow.startGeneration();
    mutation(workflow);
    const preserved = { notes: workflow.notes, draft: { ...workflow.draft } };
    assert.equal(workflow.finishGeneration(request, realResult()), false);
    assert.equal(workflow.pending, null);
    assert.equal(workflow.notes, preserved.notes);
    assert.deepEqual(workflow.draft, preserved.draft);
    assert.equal(workflow.canExport, false);
    assert.equal(workflow.canReview, false);
  }
});

test('outdated response cannot replace a newer draft or clear its pending request', () => {
  const workflow = withDraft();
  const older = workflow.startGeneration();
  workflow.failGeneration(older);
  const current = workflow.startGeneration();
  assert.equal(workflow.finishGeneration(older, realResult()), false);
  assert.equal(workflow.pending.id, current.id);
  const result = realResult();
  result.draft.enquiry = 'Current request result.';
  workflow.finishGeneration(current, result);
  assert.equal(workflow.draft.enquiry, 'Current request result.');
});

test('malformed or mode-mismatched responses preserve prior draft and block review', () => {
  for (const invalid of [null, {}, { draft: {} }, simulationResult(), { ...realResult(), draft: { ...fields, nextSteps: '' } }, { ...realResult(), provenance: { ...realResult().provenance, generatedAt: 'not-a-date' } }]) {
    const workflow = withDraft();
    workflow.setDraftField('enquiry', 'Keep this edit.');
    const request = workflow.startGeneration();
    assert.throws(() => workflow.finishGeneration(request, invalid), /draft response/);
    assert.equal(workflow.draft.enquiry, 'Keep this edit.');
    assert.equal(workflow.pending, null);
    assert.equal(workflow.canExport, false);
    assert.equal(workflow.canReview, false);
  }
});

test('blank notes and oversized fields cannot bypass workflow validation', () => {
  const workflow = withDraft();
  workflow.setReviewed(true);
  workflow.setSource('   ');
  assert.throws(() => workflow.startGeneration(), /Add agent notes/);
  assert.equal(workflow.canExport, false);
  assert.throws(() => workflow.setSource('x'.repeat(12001)), /too long/);
  assert.throws(() => workflow.setDraftField('enquiry', 'x'.repeat(12001)), /could not be updated/);
  assert.throws(() => workflow.setMode('silent-fallback'), /supported draft mode/);
});
