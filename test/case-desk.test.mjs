import test from 'node:test';
import assert from 'node:assert/strict';
import { CaseDeskWorkflow, createCaseDesk, CASE_FIELDS } from '../public/agent/case-desk.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function until(predicate) { for (let i = 0; i < 30 && !predicate(); i++) await tick(); assert.ok(predicate(), 'expected async checkpoint'); }
let sequence = 0;
const workflow = () => new CaseDeskWorkflow({ uuid: () => `synthetic-case-${++sequence}`, now: () => '2026-10-28T10:00:00.000Z' });
const draftResponse = (extra = {}) => ({ draft: { enquiry: 'A fictional collection change.', relevantDetails: 'Thursday was requested.', uncertainties: 'Availability has not been confirmed.', nextSteps: 'Check availability before promising a change.' }, provenance: { kind: 'meta', model: 'synthetic-meta-model', generationId: 'synthetic-generation-receipt', generatedAt: '2026-10-28T10:00:00.000Z' }, ...extra });
const transcriptResponse = text => ({ transcript: text, provenance: { kind: 'meta_transcription', model: 'synthetic-speech-model', transcribedAt: '2026-10-28T10:00:00.000Z' } });
function generateModel(model, response = draftResponse()) { const attempt = model.beginDraft(); assert.equal(model.completeDraft(attempt, response), true); }

test('notes-only, transcript-only and combined drafts preserve current sources and explicit provenance', () => {
  for (const kind of ['manual_notes', 'transcript', 'combined']) {
    const model = workflow();
    if (kind !== 'transcript') model.setSource('notes', 'Correction: no booking was confirmed.');
    if (kind !== 'manual_notes') model.setSource('transcript', 'The caller requested Thursday.');
    const attempt = model.beginDraft(); assert.equal(attempt.payload.sourceKind, kind); assert.equal(attempt.payload.caseId, model.id);
    model.completeDraft(attempt, draftResponse({ source: { sourceKind: kind, transport: 'manual_example' } })); model.setReviewed(true);
    const exported = model.exportCase(); assert.equal(exported.source.sourceKind, kind); assert.equal(exported.synthetic, true); assert.equal(exported.provenance.kind, 'meta');
    assert.equal(exported.provenance.generationId, 'synthetic-generation-receipt'); assert.equal(exported.source.transport, 'manual_example');
    assert.ok(!JSON.stringify(exported).includes('simulated'));
  }
});

test('source and draft edits revoke review; source edit then restore still requires regeneration', () => {
  const model = workflow(); model.setSource('notes', 'Synthetic original.'); generateModel(model); model.setReviewed(true); model.exportCase();
  model.setDraftField('enquiry', 'Human-corrected enquiry.'); assert.throws(() => model.exportCase(), /Review/); model.setReviewed(true); model.exportCase();
  model.setSource('notes', 'Different.'); model.setSource('notes', 'Synthetic original.');
  assert.match(model.reviewBlockReason, /fresh draft/); assert.throws(() => model.setReviewed(true));
});

test('failed regeneration preserves edits but cannot export the old approval', () => {
  const model = workflow(); model.setSource('notes', 'Synthetic original.'); generateModel(model); model.setDraftField('nextSteps', 'Human next step.'); model.setReviewed(true);
  const attempt = model.beginDraft(); model.failDraft(attempt);
  assert.equal(model.draft.nextSteps, 'Human next step.'); assert.match(model.reviewBlockReason, /generation failed/); assert.throws(() => model.exportCase());
});

test('malformed transcription provenance cannot partially replace a reviewed human draft', () => {
  const model = workflow(); model.setSource('notes', 'Synthetic source notes.');
  model.applyTranscript({ caseId: model.id, transcriptRevision: 0, callId: 'accepted-call' }, transcriptResponse('Original machine transcript.'));
  const oldTranscription = { ...model.transcriptionProvenance };
  generateModel(model, draftResponse({ source: { sourceKind: 'combined', transport: 'whatsapp' }, transcriptionProvenance: oldTranscription }));
  model.setDraftField('nextSteps', 'Keep this human correction.'); model.setReviewed(true);
  const previous = { draft: { ...model.draft }, provenance: { ...model.provenance }, transcriptionProvenance: { ...model.transcriptionProvenance }, transport: model.transport, draftRevision: model.draftRevision };
  const attempt = model.beginDraft();
  assert.throws(() => model.completeDraft(attempt, draftResponse({
    draft: { ...draftResponse().draft, enquiry: 'Must not overwrite the prior draft.' },
    provenance: { ...draftResponse().provenance, generationId: 'different-generation-receipt' },
    source: { sourceKind: 'combined', transport: 'manual_example' }, transcriptionProvenance: { kind: 'meta_transcription', model: '' },
  })), /valid provenance/);
  assert.deepEqual(model.draft, previous.draft); assert.deepEqual(model.provenance, previous.provenance);
  assert.deepEqual(model.transcriptionProvenance, previous.transcriptionProvenance); assert.equal(model.transport, previous.transport); assert.equal(model.draftRevision, previous.draftRevision);
  assert.equal(model.pending, null); assert.equal(model.reviewedAt, null); assert.equal(model.lastAttemptSucceeded, false); assert.throws(() => model.exportCase());
});

test('generation cannot overwrite concurrent source or draft edits, or a newer case', () => {
  const model = workflow(); model.setSource('notes', 'Original.'); generateModel(model);
  const attempt = model.beginDraft(); model.setDraftField('enquiry', 'Keep my edit.'); assert.equal(model.completeDraft(attempt, draftResponse()), false); assert.equal(model.draft.enquiry, 'Keep my edit.');
  const next = model.beginDraft(); model.setSource('notes', 'Changed while waiting.'); assert.equal(model.completeDraft(next, draftResponse()), false);
  const oldCase = model.beginDraft(); model.reset(); model.setSource('notes', 'New case notes.'); assert.equal(model.completeDraft(oldCase, draftResponse()), false); assert.equal(model.draft, null);
});

test('all four draft sections obey the same 6000-character export limit', () => {
  const model = workflow(); model.setSource('notes', 'Synthetic notes.'); generateModel(model);
  for (const field of CASE_FIELDS) assert.throws(() => model.setDraftField(field, 'x'.repeat(6001)), /6,000/);
  const attempt = model.beginDraft(); assert.throws(() => model.completeDraft(attempt, draftResponse({ draft: { ...draftResponse().draft, enquiry: 'x'.repeat(6001) } })), /incomplete/);
});

test('machine original is retained without replacing transcript edits made while ASR waited', () => {
  const model = workflow(); model.setSource('notes', 'Manual notes.');
  const proof = { caseId: model.id, transcriptRevision: model.transcriptRevision, callId: 'opaque-accepted-call' };
  model.setSource('transcript', 'My careful manual correction.');
  assert.equal(model.applyTranscript(proof, transcriptResponse('Original machine speech text.')), 'original_only');
  assert.equal(model.transcript, 'My careful manual correction.'); assert.equal(model.originalTranscript, 'Original machine speech text.');
  model.reset(); assert.equal(model.applyTranscript(proof, transcriptResponse('Old machine response.')), 'stale'); assert.equal(model.transcript, '');
});

test('notes-only use omits old transcript proof; canonical absent ASR provenance clears stale claims', () => {
  const model = workflow(); model.setSource('notes', 'Only these notes are current.');
  model.applyTranscript({ caseId: model.id, transcriptRevision: 0, callId: 'accepted-call' }, transcriptResponse('Old transcript.'));
  model.setSource('transcript', ''); model.sourceCallId = 'accepted-call';
  const attempt = model.beginDraft(); assert.equal(attempt.payload.originalTranscript, ''); assert.ok(!('transcriptCallId' in attempt.payload)); assert.equal(attempt.payload.sourceCallId, 'accepted-call');
  model.completeDraft(attempt, draftResponse({ source: { sourceKind: 'manual_notes', transport: 'whatsapp' } }));
  assert.equal(model.transcriptionProvenance, null); model.setReviewed(true);
  const exported = model.exportCase(); assert.equal(exported.source.transport, 'whatsapp'); assert.equal(exported.source.originalTranscript, ''); assert.ok(!('transcriptCallId' in exported.source)); assert.ok(!('transcriptionProvenance' in exported));
  assert.equal(model.originalTranscript, 'Old transcript.', 'local comparison text is preserved');
});

function deskFixture(t, options = {}) {
  const model = workflow(), requests = [], downloads = [], recorders = [];
  let handler, confirmed = options.confirmed ?? true, confirmations = 0;
  const desk = createCaseDesk({ workflow: model, view: { render() {} }, confirmDiscard: () => { confirmations++; return confirmed; }, download: (blob, name) => downloads.push({ blob, name }),
    captureFactory: callbacks => {
      const recorder = { index: recorders.length, started: false, disposed: false, async prepare() {}, async start() { recorder.started = true; }, setRemoteStream() {}, async dispose() { recorder.disposed = true; }, async stop() { const fallback = { blob: new Blob([new Uint8Array(60)], { type: 'audio/wav' }), seconds: 2, reason: 'stopped' }; const result = options.stop ? (await options.stop(recorder)) ?? fallback : fallback; callbacks.onEnded(result); return result; } };
      recorders.push(recorder); return recorder;
    },
    request: async (path, requestOptions = {}) => {
      requests.push({ path, options: requestOptions });
      if (handler) { const response = await handler(path, requestOptions); if (response !== undefined) return response; }
      if (path === '/case/config') return { apiConfigured: true, transcriptionConfigured: true, model: 'synthetic-meta-model', maxAudioBytes: 16000000, maxAudioSeconds: 300 };
      if (path === '/case/draft') return draftResponse({ source: { sourceKind: requestOptions.body.sourceKind, transport: requestOptions.body.sourceCallId ? 'whatsapp' : 'manual_example' } });
      if (path === '/case/transcribe') return transcriptResponse('Machine transcript from an agreed synthetic call.');
      if (path === '/case/export') return new Blob(['synthetic-reviewed-file']);
      throw new Error('Unexpected fixture request');
    },
  });
  t.after(() => desk.dispose());
  return { desk, model, requests, downloads, recorders, set handler(value) { handler = value; }, set confirmed(value) { confirmed = value; }, get confirmations() { return confirmations; },
    async connect() { desk.setConnectionState({ connected: true, call: null }); await until(() => Boolean(desk.snapshot().config)); },
    async acceptCall(id = 'accepted-call') { desk.setConnectionState({ connected: true, call: { id, state: 'ringing' } }); assert.equal(desk.beforeAnswer(), true); desk.setConnectionState({ connected: true, call: { id, state: 'active' } }); await desk.onAcceptedCall({ callId: id, microphoneStream: {}, remoteStream: {} }); },
    async endCall(id = 'accepted-call') { desk.setConnectionState({ connected: true, call: { id, state: 'ended' } }); await desk.onCallEnded({ callId: id }); },
  };
}

test('without opt-in, accepted calls never create a recorder or upload audio', async t => {
  const f = deskFixture(t); await f.connect(); await f.acceptCall(); await f.endCall();
  assert.equal(f.recorders.length, 0); assert.ok(!f.requests.some(item => item.path === '/case/transcribe'));
});

test('agreed capture starts only after accepted callback and uploads only after call end', async t => {
  const f = deskFixture(t); await f.connect(); f.desk.setCaptureAgreement(true);
  f.desk.setConnectionState({ connected: true, call: { id: 'accepted-call', state: 'ringing' } }); f.desk.beforeAnswer();
  assert.equal(f.recorders[0].started, false); assert.ok(!f.requests.some(item => item.path === '/case/transcribe'));
  f.desk.setConnectionState({ connected: true, call: { id: 'accepted-call', state: 'active' } });
  await f.desk.onAcceptedCall({ callId: 'accepted-call', microphoneStream: {}, remoteStream: {} }); assert.equal(f.recorders[0].started, true);
  await f.desk.stopCapture(); assert.ok(!f.requests.some(item => item.path === '/case/transcribe'));
  await f.endCall();
  const upload = f.requests.find(item => item.path === '/case/transcribe');
  assert.equal(upload.options.contentType, 'audio/wav'); assert.equal(upload.options.headers['X-Call-ID'], 'accepted-call'); assert.equal(upload.options.headers['X-Participants-Agreed'], 'true'); assert.equal(upload.options.timeout, 250000);
  assert.ok(upload.options.rawBody instanceof Blob); assert.equal(f.desk.snapshot().hasAudio, false); assert.match(f.desk.snapshot().transcript, /Machine transcript/);
});

test('discarding captured audio prevents transcription and preserves manual notes', async t => {
  const f = deskFixture(t); await f.connect(); f.desk.setSource('notes', 'Keep these manual notes.'); f.desk.setCaptureAgreement(true); await f.acceptCall();
  f.desk.discardAudio(); await f.endCall();
  assert.equal(f.recorders[0].disposed, true); assert.ok(!f.requests.some(item => item.path === '/case/transcribe')); assert.equal(f.model.notes, 'Keep these manual notes.');
});

test('failed audio-only transcription counts as work and requires confirmation before New case', async t => {
  const f = deskFixture(t, { confirmed: false }); await f.connect(); f.desk.setCaptureAgreement(true); await f.acceptCall();
  f.handler = path => { if (path === '/case/transcribe') throw Object.assign(new Error('private-provider-sentinel'), { kind: 'action', publicCode: 'TRANSCRIPTION_AUTH_ERROR' }); };
  await f.endCall(); assert.equal(f.desk.snapshot().hasAudio, true); assert.equal(f.desk.snapshot().hasWork, true); assert.equal(f.desk.snapshot().hasWorkingText, false);
  assert.equal(f.desk.newCase(), false); assert.equal(f.confirmations, 1); assert.equal(f.desk.snapshot().hasAudio, true); assert.ok(!f.desk.snapshot().error.includes('sentinel'));
});

test('late generation and transcription cannot overwrite edits, including after disconnect/reset', async t => {
  const f = deskFixture(t); await f.connect(); f.desk.setSource('notes', 'Original notes.');
  const generation = deferred(); f.handler = path => path === '/case/draft' ? generation.promise : undefined;
  const pending = f.desk.generate(); await until(() => f.desk.snapshot().generating); f.desk.setSource('notes', 'Keep my newer notes.'); generation.resolve(draftResponse()); await pending;
  assert.equal(f.desk.snapshot().draft, null); assert.equal(f.desk.snapshot().notes, 'Keep my newer notes.');
  const old = deferred(); f.handler = path => path === '/case/draft' ? old.promise : undefined;
  const oldGeneration = f.desk.generate(); await until(() => f.desk.snapshot().generating);
  f.desk.setConnectionState({ connected: false, call: null }); assert.equal(f.desk.snapshot().generating, false); assert.equal(f.desk.newCase(), true);
  f.desk.setSource('notes', 'New case.'); old.resolve(draftResponse()); await oldGeneration; assert.equal(f.desk.snapshot().draft, null); assert.equal(f.desk.snapshot().notes, 'New case.');
});

test('reviewed exports use selected format and receipt; PDF Unicode errors recommend lossless alternatives', async t => {
  const f = deskFixture(t); await f.connect(); f.desk.setSource('notes', 'Synthetic case notes.'); await f.desk.generate();
  await f.desk.exportReviewed('pdf'); assert.equal(f.downloads.length, 0);
  f.desk.setReviewed(true); await f.desk.exportReviewed('docx', true);
  const exported = f.requests.find(item => item.path === '/case/export'); assert.equal(exported.options.body.format, 'docx'); assert.equal(exported.options.body.includeSources, true); assert.equal(exported.options.body.case.provenance.generationId, 'synthetic-generation-receipt'); assert.equal(f.downloads.length, 1);
  f.handler = (path, options) => { if (path === '/case/export' && options.body.format === 'pdf') throw Object.assign(new Error('raw-private-provider-data'), { kind: 'action', publicCode: 'EXPORT_UNSUPPORTED_PDF_CHARACTER' }); };
  await f.desk.exportReviewed('pdf'); assert.match(f.desk.snapshot().error, /Word, PowerPoint or Text/); assert.ok(!f.desk.snapshot().error.includes('private'));
  await f.desk.exportReviewed('txt'); assert.equal(f.downloads.length, 2); assert.equal(f.desk.snapshot().error, '');
});

test('an ASR response preserves transcript edits made during upload and never enters a newer case', async t => {
  const f = deskFixture(t); await f.connect(); f.desk.setCaptureAgreement(true); await f.acceptCall();
  const transcription = deferred(); f.handler = path => path === '/case/transcribe' ? transcription.promise : undefined;
  const ending = f.endCall(); await until(() => f.desk.snapshot().transcribing);
  f.desk.setSource('transcript', 'Keep my typed correction.'); transcription.resolve(transcriptResponse('Original machine words.')); await ending;
  assert.equal(f.desk.snapshot().transcript, 'Keep my typed correction.'); assert.equal(f.desk.snapshot().originalTranscript, 'Original machine words.');
  assert.match(f.desk.snapshot().message, /edited transcript was preserved/);
  f.desk.newCase(); f.handler = undefined; f.desk.setCaptureAgreement(true); await f.acceptCall('second-accepted-call');
  const old = deferred(); f.handler = path => path === '/case/transcribe' ? old.promise : undefined;
  const oldEnding = f.endCall('second-accepted-call'); await until(() => f.desk.snapshot().transcribing);
  f.desk.setConnectionState({ connected: false, call: null }); assert.equal(f.desk.newCase(), true); f.desk.setSource('notes', 'New case stays here.');
  old.resolve(transcriptResponse('Obsolete transcription.')); await oldEnding;
  assert.equal(f.desk.snapshot().transcript, ''); assert.equal(f.desk.snapshot().notes, 'New case stays here.'); assert.equal(f.desk.snapshot().hasAudio, false);
});

test('New case during initial configuration cannot leave the desk permanently unconfigured', async t => {
  const f = deskFixture(t), oldConfig = deferred(); let requests = 0;
  f.handler = path => { if (path === '/case/config' && ++requests === 1) return oldConfig.promise; };
  f.desk.setConnectionState({ connected: true, call: null }); assert.equal(f.desk.newCase(), true);
  await until(() => Boolean(f.desk.snapshot().config));
  oldConfig.resolve({ apiConfigured: false, transcriptionConfigured: false }); await tick();
  assert.equal(f.desk.snapshot().config.apiConfigured, true);
});

test('capture agreement is per call and resets when a call ends before acceptance', async t => {
  const f = deskFixture(t); await f.connect(); f.desk.setCaptureAgreement(true);
  f.desk.setConnectionState({ connected: true, call: { id: 'unanswered-call', state: 'ringing' } }); f.desk.beforeAnswer();
  f.desk.setConnectionState({ connected: true, call: { id: 'unanswered-call', state: 'ended' } }); await f.desk.onCallEnded({ callId: 'unanswered-call' });
  assert.equal(f.desk.snapshot().captureAgreement, false); assert.equal(f.recorders[0].disposed, true);
  await f.acceptCall('next-call'); assert.equal(f.recorders.length, 1, 'next call does not inherit consent or capture');
});

test('an old export cannot download after edit and reapproval even if review timestamps collide', async t => {
  const f = deskFixture(t); await f.connect(); f.desk.setSource('notes', 'Synthetic notes.'); await f.desk.generate(); f.desk.setReviewed(true);
  const originalReview = f.model.reviewedAt, exporting = deferred();
  f.handler = path => path === '/case/export' ? exporting.promise : undefined;
  const pending = f.desk.exportReviewed('txt'); await until(() => f.desk.snapshot().exporting);
  f.desk.setDraftField('nextSteps', 'New human-approved next step.'); f.desk.setReviewed(true);
  assert.equal(f.model.reviewedAt, originalReview, 'fixture deliberately fixes the clock');
  exporting.resolve(new Blob(['obsolete-file'])); await pending; assert.equal(f.downloads.length, 0);
});

test('capture-only A finalization blocks B before Answer and defensively preserves A source ownership', async t => {
  const finishing = deferred(); let stopReached = false;
  const f = deskFixture(t, { stop: () => { stopReached = true; return finishing.promise; } });
  await f.connect(); f.desk.setCaptureAgreement(true); await f.acceptCall('call-A');
  f.desk.setConnectionState({ connected: true, call: { id: 'call-A', state: 'ended' } }); const endingA = f.desk.onCallEnded({ callId: 'call-A' });
  await until(() => stopReached); assert.equal(f.desk.snapshot().hasAudio, false); assert.equal(f.desk.snapshot().hasWork, true);
  f.desk.setConnectionState({ connected: true, call: { id: 'call-B', state: 'ringing' } });
  assert.equal(f.desk.beforeAnswer(), false); assert.equal(f.model.sourceCallId, 'call-A');
  assert.equal(await f.desk.onAcceptedCall({ callId: 'call-B', microphoneStream: {}, remoteStream: {} }), false); assert.equal(f.model.sourceCallId, 'call-A');
  finishing.resolve({ blob: new Blob(['synthetic-A-audio'], { type: 'audio/wav' }), seconds: 2, reason: 'stopped' }); await endingA;
  assert.equal(f.model.sourceCallId, 'call-A'); assert.equal(f.model.transcriptCallId, 'call-A');
  assert.equal(f.requests.find(item => item.path === '/case/transcribe').options.headers['X-Call-ID'], 'call-A');
  assert.equal(f.desk.beforeAnswer(), false); assert.equal(f.desk.newCase(), true); await f.acceptCall('call-B');
  assert.equal(f.model.sourceCallId, 'call-B'); assert.equal(f.model.transcript, '');
});

test('an upload for A blocks B until A processing completes and its case is cleared', async t => {
  const upload = deferred(), f = deskFixture(t); await f.connect(); f.desk.setCaptureAgreement(true); await f.acceptCall('call-A');
  f.handler = path => path === '/case/transcribe' ? upload.promise : undefined;
  const ending = f.endCall('call-A'); await until(() => f.desk.snapshot().transcribing);
  f.desk.setConnectionState({ connected: true, call: { id: 'call-B', state: 'ringing' } }); assert.equal(f.desk.beforeAnswer(), false);
  assert.equal(await f.desk.onAcceptedCall({ callId: 'call-B', microphoneStream: {}, remoteStream: {} }), false);
  upload.resolve(transcriptResponse('Transcript belongs to A.')); await ending;
  assert.equal(f.model.transcript, 'Transcript belongs to A.'); assert.equal(f.model.sourceCallId, 'call-A'); assert.equal(f.model.transcriptCallId, 'call-A');
});

test('discard and New case let B capture safely while late A finalization cannot stop or clear B', async t => {
  const finishA = deferred(), finishB = deferred(); let aStopping = false, bStopping = false;
  const f = deskFixture(t, { stop: recorder => { if (recorder.index === 0) { aStopping = true; return finishA.promise; } bStopping = true; return finishB.promise; } });
  await f.connect(); f.desk.setCaptureAgreement(true); await f.acceptCall('call-A');
  const endingA = f.endCall('call-A'); await until(() => aStopping);
  f.desk.discardAudio(); assert.equal(f.desk.newCase(), true); f.desk.setCaptureAgreement(true); await f.acceptCall('call-B');
  assert.equal(f.recorders[1].started, true); const stoppingB = f.desk.stopCapture(); await until(() => bStopping);
  finishA.resolve({ blob: new Blob(['obsolete-A']), seconds: 1, reason: 'stopped' }); await endingA;
  assert.equal(f.recorders[1].disposed, false); assert.equal(f.desk.snapshot().captureState, 'stopping');
  assert.equal(f.desk.stopCapture(), stoppingB, 'old stop finally must not clear B’s pending finalization');
  assert.equal(f.model.sourceCallId, 'call-B'); assert.equal(f.model.transcript, '');
  finishB.resolve({ blob: new Blob(['current-B']), seconds: 1, reason: 'stopped' }); await stoppingB; await f.endCall('call-B');
  const uploads = f.requests.filter(item => item.path === '/case/transcribe'); assert.equal(uploads.length, 1); assert.equal(uploads[0].options.headers['X-Call-ID'], 'call-B');
});

test('an empty completed call can be followed by another call without forced New case', async t => {
  const f = deskFixture(t); await f.connect(); await f.acceptCall('empty-A'); await f.endCall('empty-A');
  assert.equal(f.desk.snapshot().hasWork, false); await f.acceptCall('empty-B'); assert.equal(f.model.sourceCallId, 'empty-B');
});

test('transcription cannot enter a case now bound to another accepted call', () => {
  const model = workflow(); model.sourceCallId = 'call-B';
  assert.equal(model.applyTranscript({ caseId: model.id, transcriptRevision: 0, callId: 'call-A' }, transcriptResponse('A must stay out.')), 'stale');
  assert.equal(model.transcript, ''); assert.equal(model.originalTranscript, '');
});

test('working copy preserves every human-edited draft field without approving an export', async t => {
  const f = deskFixture(t); await f.connect(); f.desk.setSource('notes', 'Synthetic source notes.'); await f.desk.generate();
  for (const field of CASE_FIELDS) f.desk.setDraftField(field, `Human edited ${field}.`);
  f.desk.saveWorkingNotes(); const text = await f.downloads[0].blob.text();
  assert.match(text, /UNREVIEWED WORKING DRAFT — not an approved case/);
  for (const field of CASE_FIELDS) assert.ok(text.includes(`Human edited ${field}.`));
  assert.match(f.downloads[0].name, /working-copy[.]txt$/); assert.equal(f.model.reviewedAt, null);
  assert.throws(() => f.model.exportCase(), /Review/);
});
