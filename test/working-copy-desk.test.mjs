import test from 'node:test';
import assert from 'node:assert/strict';
import { CaseDeskWorkflow, createCaseDesk } from '../public/agent/case-desk.mjs';
import { MAX_WORKING_COPY_BYTES, parseWorkingCopy, serializeWorkingCopy } from '../public/agent/working-copy.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const savedSources = { notes: 'Fictional María requested Thursday.\nAvailability is unconfirmed.', transcript: 'The fictional caller said Tuesday.' };
const file = (sources = savedSources) => new File([serializeWorkingCopy(sources)], 'saved-notes.json', { type: 'application/json' });
const draft = () => ({
  draft: { enquiry: 'A fictional transport request.', relevantDetails: 'The notes say Thursday.', uncertainties: 'The transcript says Tuesday; confirm the intended day.', nextSteps: 'A worker should confirm availability.' },
  provenance: { kind: 'meta', model: 'synthetic-meta-model', generationId: 'synthetic-receipt', generatedAt: '2026-10-28T10:00:00.000Z' },
  source: { transport: 'manual_example' },
});
function fixture(options = {}) {
  const requests = [], downloads = [];
  const workflow = new CaseDeskWorkflow();
  const desk = createCaseDesk({
    workflow,
    confirmRestore: options.confirmRestore ?? (() => true),
    confirmDiscard: () => true,
    request: async (path, init) => {
      requests.push({ path, init });
      if (options.request) { const result = options.request(path, init); if (result !== undefined) return result; }
      if (path === '/case/config') return { apiConfigured: true, transcriptionConfigured: true, model: 'synthetic-meta-model' };
      if (path === '/case/draft') return draft();
      if (path === '/case/export') return new Blob(['synthetic reviewed export']);
      throw new Error('Unexpected test request');
    },
    download: (blob, name) => downloads.push({ blob, name }),
  });
  return { desk, workflow, requests, downloads, async connect() { desk.setConnectionState({ connected: true, call: null }); await tick(); } };
}
async function approvedFixture(options) {
  const f = fixture(options);
  await f.connect();
  f.desk.setSource('notes', 'Current fictional case; preserve this until replacement is confirmed.');
  await f.desk.generate(); f.desk.setReviewed(true);
  assert.equal(f.desk.snapshot().canExport, true);
  return f;
}

test('resumable download round-trips separate sources while the existing TXT snapshot remains available', async () => {
  const f = await approvedFixture();
  f.desk.setSource('notes', savedSources.notes); f.desk.setSource('transcript', savedSources.transcript);
  const before = f.requests.length;
  assert.equal(f.desk.saveResumableCopy(), true);
  assert.match(f.downloads[0].name, /^community-connect-resumable-notes-.*[.]json$/);
  assert.match(f.downloads[0].blob.type, /^application\/json/);
  assert.deepEqual(parseWorkingCopy(await f.downloads[0].blob.text()), savedSources);
  assert.ok(!(await f.downloads[0].blob.text()).includes('synthetic-receipt'));
  f.desk.saveWorkingNotes();
  assert.match(f.downloads[1].name, /working-copy[.]txt$/);
  assert.match(await f.downloads[1].blob.text(), /UNREVIEWED WORKING DRAFT/);
  assert.equal(f.requests.length, before);
});

test('a saved file resumes after reload without server access, approval or old call/model claims', async () => {
  const old = fixture();
  old.desk.setSource('notes', savedSources.notes); old.desk.setSource('transcript', savedSources.transcript);
  old.desk.saveResumableCopy();
  const reloaded = fixture();
  const oldId = reloaded.workflow.id;
  assert.equal(await reloaded.desk.loadWorkingCopy(new File([old.downloads[0].blob], 'resume.json')), true);
  assert.notEqual(reloaded.workflow.id, oldId);
  assert.equal(reloaded.workflow.notes, savedSources.notes);
  assert.equal(reloaded.workflow.transcript, savedSources.transcript);
  for (const key of ['draft', 'provenance', 'transcriptionProvenance', 'sourceCallId', 'transcriptCallId', 'reviewedAt']) assert.equal(reloaded.workflow[key], null);
  assert.equal(reloaded.workflow.originalTranscript, '');
  assert.equal(reloaded.workflow.transport, 'manual_example');
  assert.equal(reloaded.desk.snapshot().canExport, false);
  assert.equal(reloaded.desk.snapshot().restoredSources, true);
  assert.equal(reloaded.requests.length, 0);
  assert.throws(() => reloaded.workflow.setReviewed(true), /Create a draft/);
});

test('restoring replaces a reviewed case only after confirmation and requires a fresh generation and review', async () => {
  let confirmations = 0;
  const f = await approvedFixture({ confirmRestore: () => { confirmations++; return true; } });
  const previousId = f.workflow.id, before = f.requests.length;
  f.workflow.originalTranscript = 'Old machine text'; f.workflow.sourceCallId = 'old-call'; f.workflow.transcriptCallId = 'old-call';
  f.workflow.transcriptionProvenance = { kind: 'meta_transcription', model: 'old-asr-model' };
  assert.equal(await f.desk.loadWorkingCopy(file()), true);
  assert.equal(confirmations, 1); assert.notEqual(f.workflow.id, previousId);
  assert.equal(f.requests.length, before);
  assert.equal(f.desk.snapshot().canExport, false);
  await f.desk.exportReviewed('txt');
  assert.equal(f.requests.length, before);
  await f.desk.generate();
  assert.deepEqual(f.requests.at(-1).init.body.notes, savedSources.notes);
  assert.deepEqual(f.requests.at(-1).init.body.transcript, savedSources.transcript);
  assert.ok(!('sourceCallId' in f.requests.at(-1).init.body));
  assert.equal(f.desk.snapshot().canExport, false);
  f.desk.setReviewed(true);
  assert.equal(f.desk.snapshot().canExport, true);
});

test('cancelling replacement or rejecting malformed files preserves current text, draft and approval', async () => {
  for (const cancelled of [true, false]) {
    let confirmations = 0;
    const f = await approvedFixture({ confirmRestore: () => { confirmations++; return false; } });
    const previous = { id: f.workflow.id, notes: f.workflow.notes, draft: { ...f.workflow.draft }, reviewedAt: f.workflow.reviewedAt };
    const candidate = cancelled ? file() : new File(['{"notes":"private-invalid-file-sentinel"}'], 'invalid.json');
    assert.equal(await f.desk.loadWorkingCopy(candidate), false);
    assert.deepEqual({ id: f.workflow.id, notes: f.workflow.notes, draft: f.workflow.draft, reviewedAt: f.workflow.reviewedAt }, previous);
    assert.equal(f.desk.snapshot().canExport, true);
    assert.equal(confirmations, cancelled ? 1 : 0);
    assert.ok(!f.desk.snapshot().error.includes('private-invalid-file-sentinel'));
  }
});

test('oversized files are rejected before reading; invalid UTF-8 cannot corrupt current notes', async () => {
  const f = await approvedFixture();
  const notes = f.workflow.notes;
  let reads = 0;
  assert.equal(await f.desk.loadWorkingCopy({ size: MAX_WORKING_COPY_BYTES + 1, arrayBuffer() { reads++; } }), false);
  assert.equal(reads, 0);
  assert.equal(await f.desk.loadWorkingCopy(new File([new Uint8Array([0xc3, 0x28])], 'broken.json')), false);
  assert.equal(f.workflow.notes, notes);
  assert.equal(f.desk.snapshot().canExport, true);
});

test('a slow import cannot overwrite source or draft edits made while the file opens', async () => {
  for (const draftEdit of [false, true]) {
    const f = await approvedFixture();
    const pending = deferred();
    const reading = f.desk.loadWorkingCopy({ size: file().size, arrayBuffer: () => pending.promise });
    assert.equal(f.desk.snapshot().loadingWorkingCopy, true);
    if (draftEdit) f.desk.setDraftField('enquiry', 'Keep this new human edit.');
    else f.desk.setSource('notes', 'Keep these new notes.');
    pending.resolve(await file().arrayBuffer());
    assert.equal(await reading, false);
    assert.equal(draftEdit ? f.workflow.draft.enquiry : f.workflow.notes, draftEdit ? 'Keep this new human edit.' : 'Keep these new notes.');
    assert.match(f.desk.snapshot().error, /case changed/);
    assert.equal(f.desk.snapshot().loadingWorkingCopy, false);
  }
});

test('calls that arrive during file reading prevent replacement, and loading is blocked during call setup', async () => {
  for (const state of ['ringing', 'connecting', 'active', 'ending', 'uncertain']) {
    const f = fixture(); f.desk.setSource('notes', 'Keep these current notes.');
    const pending = deferred();
    const reading = f.desk.loadWorkingCopy({ size: file().size, arrayBuffer: () => pending.promise });
    f.desk.setConnectionState({ connected: true, call: { id: 'another-call', state } });
    pending.resolve(await file().arrayBuffer());
    assert.equal(await reading, false);
    assert.equal(f.workflow.notes, 'Keep these current notes.');
    assert.equal(await f.desk.loadWorkingCopy(file()), false);
  }
});

test('restored notes cannot be attached to a new call until New case clears them', async () => {
  const f = fixture();
  assert.equal(await f.desk.loadWorkingCopy(file({ notes: 'Saved case notes only.', transcript: '' })), true);
  f.desk.setConnectionState({ connected: true, call: { id: 'new-call', state: 'ringing' } });
  assert.equal(f.desk.beforeAnswer(), false);
  assert.equal(await f.desk.onAcceptedCall({ callId: 'new-call' }), false);
  assert.equal(f.workflow.sourceCallId, null);
  assert.equal(f.workflow.notes, 'Saved case notes only.');
  f.desk.setSource('notes', '');
  assert.equal(f.desk.beforeAnswer(), false);
  assert.equal(f.desk.newCase(), true);
  assert.equal(f.workflow.restoredSources, false);
  assert.equal(f.desk.beforeAnswer(), true);
});

test('loading during generation is refused without touching the selected file or current draft request', async () => {
  const pending = deferred();
  const f = fixture({ request: path => path === '/case/draft' ? pending.promise : undefined });
  await f.connect(); f.desk.setSource('notes', 'Current case notes.');
  const generating = f.desk.generate();
  let reads = 0;
  assert.equal(await f.desk.loadWorkingCopy({ size: 100, arrayBuffer() { reads++; } }), false);
  assert.equal(reads, 0);
  pending.resolve(draft()); await generating;
  assert.ok(f.workflow.draft);
  assert.equal(f.workflow.notes, 'Current case notes.');
});

test('disconnecting during file reading prevents a late replacement', async () => {
  const f = fixture(); await f.connect(); f.desk.setSource('notes', 'Keep existing notes.');
  const pending = deferred();
  const reading = f.desk.loadWorkingCopy({ size: file().size, arrayBuffer: () => pending.promise });
  f.desk.setConnectionState({ connected: false, call: null });
  pending.resolve(await file().arrayBuffer());
  assert.equal(await reading, false);
  assert.equal(f.workflow.notes, 'Keep existing notes.');
  assert.equal(f.desk.snapshot().loadingWorkingCopy, false);
});
