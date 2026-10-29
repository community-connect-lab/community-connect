import { createAudioCapture, MAX_CAPTURE_BYTES, MAX_CAPTURE_SECONDS } from './audio-capture.mjs';
import { MAX_WORKING_COPY_BYTES, parseWorkingCopy, serializeWorkingCopy } from './working-copy.mjs';

export const CASE_FIELDS = Object.freeze(['enquiry', 'relevantDetails', 'uncertainties', 'nextSteps']);
export const CASE_ERROR_MESSAGES = Object.freeze({
  EXPORT_UNSUPPORTED_PDF_CHARACTER: 'PDF cannot display some characters in this case. Choose Word, PowerPoint or Text to preserve them.',
  EXPORT_FORMAT_UNSUPPORTED: 'Choose PDF, Word, PowerPoint or Text.', INVALID_EXPORT: 'Choose a supported format and a reviewed case.', INVALID_EXPORT_OPTIONS: 'Choose whether source text should be included.',
  INVALID_REVIEWED_CASE: 'Complete all four draft fields and confirm human review before exporting.', CASE_SOURCE_CHANGED: 'The sources no longer match this draft. Create a fresh draft and review it again.',
  EXPORT_BUSY: 'Another export is being prepared. Wait, then try again.', CASE_UNAVAILABLE: 'The case service is restarting. Keep this tab open and retry when ready.',
  CALL_SOURCE_EXPIRED: 'The live-call source proof expired. Start a fresh case from a new call, or save these working notes before resetting.',
  GENERATION_BUSY: 'A case is already being drafted. Wait for it to finish.', GENERATION_RATE_LIMIT: 'The draft limit was reached. Wait a minute before generating again.', INVALID_CASE_SOURCES: 'Check that notes or a transcript are present and within their displayed limits.',
  MODEL_NOT_CONFIGURED: 'Meta drafting is not configured on the gateway. Your sources remain available.', MODEL_CONFIG_ERROR: 'The gateway’s Meta model configuration needs attention. Your sources are preserved.', MODEL_AUTH_ERROR: 'Meta did not accept the gateway’s model credentials or access. Your sources are preserved.',
  MODEL_RATE_LIMITED: 'Meta’s model limit or quota was reached. Wait or check the account before retrying.', MODEL_TIMEOUT: 'Meta took too long to create a draft. Your sources and edits are preserved.', MODEL_UNAVAILABLE: 'Meta drafting is temporarily unavailable. Retry later.', MODEL_NETWORK_ERROR: 'The gateway could not reach Meta. Your sources and edits are preserved.',
  MODEL_BAD_RESPONSE: 'Meta returned an unreadable draft. Your sources and edits are preserved.', MODEL_INCOMPLETE: 'Meta did not finish the draft. No partial result was used.', MODEL_REFUSED: 'Meta declined this draft request. Your sources and edits are preserved.', MODEL_INVALID_DRAFT: 'Meta did not return four complete case sections. Your sources and edits are preserved.',
  MODEL_CANCELLED: 'Draft generation was cancelled. Your sources and edits are preserved.',
  TRANSCRIPTION_NOT_CONFIGURED: 'Call transcription is not configured. Continue with manual notes or paste a transcript you already have.', TRANSCRIPTION_CONFIG_ERROR: 'The gateway’s transcription configuration needs attention. Manual notes remain available.',
  TRANSCRIPTION_CALL_REQUIRED: 'Transcription needs a recent accepted call from this desk. Its proof may have expired; continue with manual notes if needed.', TRANSCRIPTION_AGREEMENT_REQUIRED: 'Every participant must agree before captured audio is transcribed.', TRANSCRIPTION_ALREADY_COMPLETE: 'This call has already been transcribed. Use the existing transcript, or continue with manual notes if its response was lost.',
  TRANSCRIPTION_CALL_ACTIVE: 'The call has not finished at the gateway. Wait for call end before retrying transcription.', TRANSCRIPTION_EXPIRED: 'This call’s temporary transcription window expired. Continue with manual notes or paste a transcript you already have.',
  TRANSCRIPTION_BUSY: 'Another transcription is processing. Wait before retrying.', TRANSCRIPTION_RATE_LIMITED: 'The transcription limit or quota was reached. Wait before retrying.', TRANSCRIPTION_AUTH_ERROR: 'Meta did not accept transcription access. Check the backend key and account access; manual notes are preserved.', TRANSCRIPTION_MODEL_UNAVAILABLE: 'The transcription model is unavailable to this account. Manual notes still work.',
  TRANSCRIPTION_REQUEST_REJECTED: 'Meta did not accept the transcription request. Check the gateway configuration and model access before retrying. Your notes are preserved.',
  TRANSCRIPTION_AUDIO_TOO_LARGE: 'Captured audio exceeds the upload limit. Continue with manual notes or use a shorter future capture.', TRANSCRIPTION_AUDIO_TOO_LONG: 'Captured audio exceeds the duration limit. Continue with manual notes or use a shorter future capture.', INVALID_TRANSCRIPTION_AUDIO: 'The recording was not a supported mono PCM WAV file. Manual notes are preserved.',
  TRANSCRIPTION_TIMEOUT: 'Transcription took too long. Your manual notes are preserved; retry when ready.', TRANSCRIPTION_NETWORK_ERROR: 'The gateway could not reach Meta transcription. Your manual notes are preserved.', TRANSCRIPTION_UNAVAILABLE: 'Meta transcription is temporarily unavailable. Retry later or continue with notes.', TRANSCRIPTION_BAD_RESPONSE: 'Meta could not provide a usable transcript. Your notes are preserved.', TRANSCRIPTION_EMPTY: 'Meta returned no speech text. Continue with manual notes or try a clearer future capture.', TRANSCRIPTION_CANCELLED: 'Transcription was cancelled. Your manual notes are preserved.',
});
const LIMITS = { notes: 12000, transcript: 36000 };
export const CASE_REVIEW_STATEMENT = 'I compared this draft with the available sources, checked the facts, clearly flagged unresolved conflicts and uncertainty, and reviewed the proposed next steps and final case.';
const validText = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const safeProvenance = (value, kind) => {
  if (!value || value.kind !== kind || !validText(value.model, 200)) throw new Error('The Meta response did not include valid provenance.');
  const result = { kind, model: value.model };
  for (const name of ['generationId', 'transcriptionId', 'responseId', 'generatedAt', 'transcribedAt', 'label']) if (typeof value[name] === 'string' && value[name].length <= 500) result[name] = value[name];
  return result;
};

export class CaseDeskWorkflow {
  constructor({ uuid = () => crypto.randomUUID(), now = () => new Date().toISOString() } = {}) { this.uuid = uuid; this.now = now; this.reset(); }
  reset() {
    this.id = this.uuid(); this.notes = ''; this.transcript = ''; this.originalTranscript = ''; this.transcriptCallId = null; this.sourceCallId = null;
    this.transport = 'manual_example'; this.draft = null; this.provenance = null; this.transcriptionProvenance = null; this.reviewedAt = null; this.restoredSources = false;
    this.sourceRevision = 0; this.transcriptRevision = 0; this.draftRevision = 0; this.requestSequence = 0; this.pending = null; this.lastSuccessfulRevision = -1; this.lastAttemptSucceeded = false;
  }
  get sourceKind() { return this.notes.trim() && this.transcript.trim() ? 'combined' : this.transcript.trim() ? 'transcript' : 'manual_notes'; }
  get hasWork() { return Boolean(this.notes || this.transcript || this.originalTranscript || this.draft); }
  setSource(name, value) {
    if (!Object.hasOwn(LIMITS, name) || typeof value !== 'string' || value.length > LIMITS[name]) throw new Error('The source text exceeds its limit.');
    if (this[name] === value) return;
    this[name] = value; this.sourceRevision++; if (name === 'transcript') this.transcriptRevision++;
    this.reviewedAt = null;
  }
  setDraftField(name, value) {
    if (!CASE_FIELDS.includes(name) || !this.draft || typeof value !== 'string' || value.length > 6000) throw new Error('Each draft field must contain at most 6,000 characters.');
    if (this.draft[name] === value) return;
    this.draft[name] = value; this.draftRevision++; this.reviewedAt = null;
  }
  beginDraft() {
    if (!this.notes.trim() && !this.transcript.trim()) throw new Error('Add notes or a transcript before creating a draft.');
    const request = { id: ++this.requestSequence, caseId: this.id, sourceRevision: this.sourceRevision, draftRevision: this.draftRevision, payload: {
      caseId: this.id, notes: this.notes, transcript: this.transcript, originalTranscript: this.transcript.trim() ? this.originalTranscript : '',
      ...(this.sourceCallId ? { sourceCallId: this.sourceCallId } : {}),
      ...(this.transcript.trim() && this.transcriptCallId ? { transcriptCallId: this.transcriptCallId } : {}), sourceKind: this.sourceKind,
    } };
    this.pending = request; this.lastAttemptSucceeded = false; this.reviewedAt = null;
    return request;
  }
  completeDraft(request, payload) {
    if (this.pending !== request) return false;
    if (request.caseId !== this.id || request.sourceRevision !== this.sourceRevision || request.draftRevision !== this.draftRevision) { this.pending = null; return false; }
    let validated;
    try {
      if (!payload?.draft || !CASE_FIELDS.every(field => validText(payload.draft[field], 6000))) throw new Error('The Meta draft was incomplete. Your existing edits are preserved.');
      const provenance = safeProvenance(payload.provenance, 'meta');
      if (!validText(provenance.generationId, 200)) throw new Error('The draft receipt is missing. Generate a fresh draft before review.');
      validated = {
        draft: Object.fromEntries(CASE_FIELDS.map(field => [field, payload.draft[field]])), provenance,
        transport: ['whatsapp', 'manual_example'].includes(payload.source?.transport) ? payload.source.transport : this.transport,
        transcriptionProvenance: payload.transcriptionProvenance ? safeProvenance(payload.transcriptionProvenance, 'meta_transcription') : null,
      };
    } finally { this.pending = null; }
    this.draft = validated.draft; this.provenance = validated.provenance; this.transport = validated.transport; this.transcriptionProvenance = validated.transcriptionProvenance;
    this.lastSuccessfulRevision = this.sourceRevision; this.lastAttemptSucceeded = true; this.reviewedAt = null; this.draftRevision++;
    return true;
  }
  failDraft(request) { if (this.pending === request) { this.pending = null; this.lastAttemptSucceeded = false; this.reviewedAt = null; } }
  applyTranscript({ caseId, transcriptRevision, callId }, payload) {
    if (caseId !== this.id || (this.sourceCallId && this.sourceCallId !== callId)) return 'stale';
    if (!validText(payload?.transcript, LIMITS.transcript)) throw new Error('The transcript was empty or exceeded its limit.');
    const provenance = safeProvenance(payload.provenance, 'meta_transcription');
    this.originalTranscript = payload.transcript; this.transcriptionProvenance = provenance; this.transcriptCallId = callId;
    this.sourceRevision++; this.reviewedAt = null;
    if (this.transcriptRevision !== transcriptRevision) return 'original_only';
    this.setSource('transcript', payload.transcript); return 'inserted';
  }
  get reviewBlockReason() {
    if (this.pending) return 'Wait for draft generation to finish.';
    if (!this.draft) return 'Create a draft before reviewing it.';
    if (!this.lastAttemptSucceeded || this.lastSuccessfulRevision !== this.sourceRevision) return 'Sources changed or generation failed. Create a fresh draft before review.';
    if (!CASE_FIELDS.every(field => validText(this.draft[field], 6000))) return 'Complete all four draft sections before review.';
    return '';
  }
  setReviewed(checked) { if (!checked) { this.reviewedAt = null; return; } if (this.reviewBlockReason) throw new Error(this.reviewBlockReason); this.reviewedAt = this.now(); }
  exportCase() {
    if (this.reviewBlockReason || !this.reviewedAt) throw new Error(this.reviewBlockReason || 'Review the case before exporting.');
    return { schemaVersion: 2, id: this.id, project: 'Community Connect', synthetic: true,
      source: { notes: this.notes, transcript: this.transcript, originalTranscript: this.transcript.trim() ? this.originalTranscript : '', ...(this.transcript.trim() && this.transcriptCallId ? { transcriptCallId: this.transcriptCallId } : {}), ...(this.sourceCallId ? { sourceCallId: this.sourceCallId } : {}), sourceKind: this.sourceKind, transport: this.transport },
      draft: { ...this.draft }, provenance: { ...this.provenance }, ...(this.transcriptionProvenance ? { transcriptionProvenance: { ...this.transcriptionProvenance } } : {}),
      review: { status: 'reviewed', reviewedAt: this.reviewedAt, statement: CASE_REVIEW_STATEMENT }, exportedAt: this.now(),
    };
  }
}

const errorCopy = error => error?.kind === 'auth' ? 'Connect your desk again before using the case workspace.' : typeof error?.publicCode === 'string' && Object.hasOwn(CASE_ERROR_MESSAGES, error.publicCode) ? CASE_ERROR_MESSAGES[error.publicCode] : error?.kind === 'network' ? 'The gateway could not be reached. Your source text and edits are preserved.' : error instanceof Error && !error.kind ? error.message : 'The case request did not complete. Your source text and edits are preserved.';

export function createCaseDesk({ request, view = { render() {} }, workflow = new CaseDeskWorkflow(),
  captureFactory = createAudioCapture, download = () => {}, confirmDiscard = () => false, confirmRestore = () => false } = {}) {
  let connected = false, liveCall = null, sourceCallId = null, config = null, configRequest = null;
  let capture = null, preparedCapture = null, preparedProof = null, captureEpoch = 0, captureProof = null, stoppingCapture = null, wave = null, captureAgreement = false, captureState = 'off', seconds = 0;
  let generating = false, transcribing = false, exporting = false, transcriptionRetryable = true, epoch = 0, message = 'Write manual notes during the call. Add an optional transcript after it ends.', error = '', transcriptionError = '';
  let loadingWorkingCopy = false;
  const accepted = state => ['connecting', 'active', 'ending', 'uncertain'].includes(state);
  const replacingBlocked = () => generating || transcribing || exporting || Boolean(stoppingCapture) || Boolean(liveCall && liveCall.state !== 'ended') || ['recording', 'starting', 'stopping'].includes(captureState);
  const hasWork = () => workflow.hasWork || Boolean(wave || capture || preparedCapture || stoppingCapture || transcribing || generating || exporting || workflow.pending);
  function clearEmptyCallBinding(callId) {
    if (!hasWork() && [sourceCallId, preparedProof?.callId, captureProof?.callId].some(id => id && id !== callId)) {
      captureEpoch++; sourceCallId = null; workflow.sourceCallId = null; preparedProof = captureProof = null; workflow.sourceRevision++;
    }
  }
  function belongsToAnotherCall(callId) {
    if (!hasWork()) return false;
    const identities = [sourceCallId, preparedProof?.callId, captureProof?.callId, wave?.callId].filter(Boolean);
    return identities.some(id => id !== callId) || (Boolean(capture || preparedCapture || stoppingCapture || transcribing) && !identities.includes(callId));
  }
  function refuseAnotherCall(callId) {
    if (!belongsToAnotherCall(callId)) return false;
    error = 'A previous case or capture is still open. Finish its processing, save a working copy, then choose New case before answering another call.'; render(); return true;
  }
  const snapshot = () => ({ connected, liveCall: liveCall ? { ...liveCall } : null, config, notes: workflow.notes, transcript: workflow.transcript, originalTranscript: workflow.originalTranscript,
    draft: workflow.draft ? { ...workflow.draft } : null, provenance: workflow.provenance, transcriptionProvenance: workflow.transcriptionProvenance,
    reviewBlockReason: workflow.reviewBlockReason, reviewed: Boolean(workflow.reviewedAt), canExport: !workflow.reviewBlockReason && Boolean(workflow.reviewedAt),
    hasWork: hasWork(), hasWorkingText: workflow.hasWork, sourceKind: workflow.sourceKind, transport: workflow.transport, generating, transcribing, exporting, captureAgreement, captureState, seconds, hasAudio: Boolean(wave), transcriptionRetryable, message, error, transcriptionError,
    loadingWorkingCopy, canLoadWorkingCopy: !loadingWorkingCopy && !replacingBlocked(), hasResumableSources: Boolean(workflow.notes.trim() || workflow.transcript.trim()), restoredSources: workflow.restoredSources });
  const render = () => view.render(snapshot());
  const setError = caught => { error = errorCopy(caught); render(); };
  function setSource(name, value) { try { workflow.setSource(name, value); error = ''; render(); } catch (caught) { setError(caught); } }
  function setDraftField(name, value) { try { workflow.setDraftField(name, value); error = ''; render(); } catch (caught) { setError(caught); } }
  async function loadConfig() {
    if (!connected || configRequest) return;
    const currentEpoch = epoch;
    const pendingConfig = request('/case/config', { timeout: 10000 }); configRequest = pendingConfig;
    try { const data = await pendingConfig; if (currentEpoch !== epoch || !connected) return; config = { apiConfigured: data?.apiConfigured === true, transcriptionConfigured: data?.transcriptionConfigured === true, model: typeof data?.model === 'string' ? data.model.slice(0, 200) : '', maxAudioBytes: Math.min(MAX_CAPTURE_BYTES, Number(data?.maxAudioBytes) || MAX_CAPTURE_BYTES), maxAudioSeconds: Math.min(MAX_CAPTURE_SECONDS, Number(data?.maxAudioSeconds) || MAX_CAPTURE_SECONDS) }; render(); }
    catch (caught) { if (currentEpoch === epoch) setError(caught); }
    finally { if (configRequest === pendingConfig) configRequest = null; }
  }
  function setConnectionState(state) {
    const changed = connected !== state.connected; connected = state.connected; liveCall = state.call ? { ...state.call } : null;
    if (changed && connected) { error = ''; void loadConfig(); }
    if (changed && !connected) {
      epoch++; config = null; configRequest = null; captureAgreement = false; captureEpoch++;
      if (workflow.pending) workflow.failDraft(workflow.pending);
      generating = transcribing = exporting = false;
      void (capture ?? preparedCapture)?.dispose(); capture = preparedCapture = null; preparedProof = null; wave = null; captureProof = null; stoppingCapture = null; captureState = 'off'; transcriptionError = ''; message = 'Desk disconnected. Audio capture was discarded; your text is preserved.';
    }
    render();
  }
  function setCaptureAgreement(checked) {
    if (accepted(liveCall?.state) || captureState === 'recording' || captureState === 'starting') return;
    captureAgreement = Boolean(checked);
    if (!captureAgreement && preparedCapture) { captureEpoch++; void preparedCapture.dispose(); preparedCapture = null; preparedProof = null; }
    error = ''; render();
  }
  function beforeAnswer() {
    if (loadingWorkingCopy || workflow.restoredSources) { error = 'Saved notes are open or loading. Finish this case, then choose New case before answering another call.'; render(); return false; }
    clearEmptyCallBinding(liveCall?.id);
    if (refuseAnotherCall(liveCall?.id)) return false;
    if (!sourceCallId && (workflow.draft || workflow.transcript || workflow.originalTranscript)) { error = 'A previous case is still open. Save a working copy, then choose New case before answering another call.'; render(); return false; }
    if (!captureAgreement) return true;
    if (!config?.transcriptionConfigured) { error = 'Call transcription is not configured. Untick optional capture to answer using manual notes.'; render(); return false; }
    if (preparedCapture) { void preparedCapture.dispose(); preparedCapture = null; preparedProof = null; }
    captureEpoch++; transcriptionRetryable = true;
    const myCaptureEpoch = captureEpoch;
    const proofForThisCapture = { callId: liveCall?.id, caseId: workflow.id, transcriptRevision: workflow.transcriptRevision };
    preparedProof = proofForThisCapture;
    preparedCapture = captureFactory({ maxSeconds: config.maxAudioSeconds, maxBytes: config.maxAudioBytes,
      onProgress: progress => { if (myCaptureEpoch === captureEpoch) { seconds = progress.seconds; render(); } },
      onError: caught => { if (myCaptureEpoch === captureEpoch) { captureState = 'error'; wave = null; captureAgreement = false; error = errorCopy(caught); render(); } },
      onEnded: result => { if (myCaptureEpoch === captureEpoch && sourceCallId === proofForThisCapture.callId && workflow.id === proofForThisCapture.caseId) { wave = { ...result, ...proofForThisCapture }; captureState = 'stopped'; captureAgreement = false; message = result.reason === 'limit' ? 'The five-minute capture limit was reached. The call can continue; transcription starts after it ends.' : 'Capture stopped. Transcription starts after the call ends.'; render(); } },
    });
    void preparedCapture.prepare().catch(caught => { if (myCaptureEpoch === captureEpoch) { captureState = 'error'; error = 'PCM audio capture is unavailable in this browser. The call continues with manual notes.'; captureAgreement = false; render(); } });
    return true;
  }
  async function onAcceptedCall({ callId, microphoneStream, remoteStream }) {
    if (loadingWorkingCopy || workflow.restoredSources) { error = 'Saved notes belong to a separate case. Choose New case before using another call as a source.'; render(); return false; }
    clearEmptyCallBinding(callId);
    if (refuseAnotherCall(callId)) return false;
    sourceCallId = callId; workflow.sourceCallId = callId; workflow.transport = 'whatsapp'; workflow.sourceRevision++; workflow.reviewedAt = null;
    if (!captureAgreement || !preparedCapture) { captureAgreement = false; render(); return; }
    const currentCapture = preparedCapture, currentEpoch = captureEpoch;
    captureProof = preparedProof ?? { callId, caseId: workflow.id, transcriptRevision: workflow.transcriptRevision };
    preparedCapture = null; preparedProof = null; capture = currentCapture; captureState = 'starting'; seconds = 0; render();
    try { await currentCapture.start({ microphoneStream, remoteStream }); if (currentEpoch !== captureEpoch) { await currentCapture.dispose(); return; } captureState = 'recording'; message = 'Capturing the accepted call for transcription. You can stop capture at any time.'; error = ''; render(); }
    catch { if (currentEpoch === captureEpoch) { await currentCapture.dispose(); capture = null; captureState = 'error'; captureAgreement = false; error = 'Audio capture could not start. The call and manual notes remain available.'; render(); } }
  }
  function onRemoteStream(stream) { (capture ?? preparedCapture)?.setRemoteStream(stream); }
  function stopCapture() {
    if (stoppingCapture) return stoppingCapture;
    if (!capture || !['recording', 'starting'].includes(captureState)) return Promise.resolve();
    if (captureState === 'starting') { captureEpoch++; void capture.dispose(); capture = null; captureState = 'off'; captureAgreement = false; message = 'The call ended before capture started. Manual notes are preserved.'; render(); return Promise.resolve(); }
    captureState = 'stopping'; captureAgreement = false; render();
    const currentCapture = capture, currentEpoch = captureEpoch, proofForThisStop = captureProof;
    const pendingStop = (async () => {
      try { await Promise.resolve(); if (currentEpoch !== captureEpoch) return; const result = await currentCapture.stop(); if (currentEpoch !== captureEpoch || proofForThisStop?.callId !== sourceCallId || proofForThisStop?.caseId !== workflow.id) return; if (result && !wave) wave = { ...result, ...proofForThisStop }; captureState = 'stopped'; message = 'Capture stopped. Transcription starts after the call ends.'; render(); }
      catch (caught) { if (currentEpoch === captureEpoch) { captureState = 'error'; wave = null; setError(caught); } }
      finally { if (capture === currentCapture) { void currentCapture.dispose(); capture = null; } if (stoppingCapture === pendingStop) stoppingCapture = null; }
    })();
    stoppingCapture = pendingStop;
    return pendingStop;
  }
  async function onCallEnded({ callId }) {
    if (sourceCallId !== callId && preparedProof?.callId !== callId && liveCall?.id !== callId) return;
    const currentEpoch = epoch, currentCaseId = workflow.id, currentCaptureEpoch = captureEpoch;
    captureAgreement = false;
    if (sourceCallId !== callId) { if (preparedCapture && preparedProof?.callId === callId) { captureEpoch++; void preparedCapture.dispose(); preparedCapture = null; preparedProof = null; } render(); return; }
    await stopCapture();
    if (currentEpoch !== epoch || currentCaptureEpoch !== captureEpoch || currentCaseId !== workflow.id || sourceCallId !== callId) return;
    if (capture && captureProof?.callId === callId && captureProof.caseId === currentCaseId) { void capture.dispose(); capture = null; }
    if (wave?.callId === callId && wave.caseId === currentCaseId && connected) await transcribe();
  }
  function discardAudio() {
    if (transcribing) return;
    captureEpoch++; void (capture ?? preparedCapture)?.dispose(); capture = preparedCapture = null; preparedProof = null; wave = null; captureProof = null; stoppingCapture = null;
    captureAgreement = false; captureState = 'off'; seconds = 0; error = ''; transcriptionError = ''; message = 'Captured audio discarded. No transcription will be requested for this capture.'; render();
  }
  async function transcribe() {
    if (!connected || !wave || !transcriptionRetryable || transcribing || accepted(liveCall?.state)) return;
    const currentWave = wave, currentEpoch = epoch;
    if (currentWave.caseId !== workflow.id || !currentWave.callId || !(currentWave.blob instanceof Blob) || currentWave.blob.size > (config?.maxAudioBytes ?? MAX_CAPTURE_BYTES)) { wave = null; transcriptionError = 'The captured call no longer belongs to this case.'; render(); return; }
    transcribing = true; error = ''; transcriptionError = ''; workflow.reviewedAt = null; message = 'Transcribing the captured call with Meta. Manual notes remain editable.'; render();
    try {
      const payload = await request('/case/transcribe', { method: 'POST', rawBody: currentWave.blob, contentType: 'audio/wav', headers: { 'X-Call-ID': currentWave.callId, 'X-Participants-Agreed': 'true' }, timeout: 250000 });
      if (currentEpoch !== epoch) return;
      const result = workflow.applyTranscript(currentWave, payload);
      wave = null; captureState = 'off'; message = result === 'inserted' ? 'Transcript ready. Correct it against your notes before creating the case draft.' : result === 'original_only' ? 'Your edited transcript was preserved. The original machine transcript is available for comparison.' : 'The old transcription was discarded because a new case is open.';
    } catch (caught) { if (currentEpoch === epoch) { transcriptionError = errorCopy(caught); transcriptionRetryable = !['TRANSCRIPTION_EXPIRED', 'TRANSCRIPTION_ALREADY_COMPLETE', 'TRANSCRIPTION_CALL_REQUIRED'].includes(caught?.publicCode); message = transcriptionRetryable ? 'Transcription did not complete. Manual notes are preserved; captured audio remains in memory for retry.' : 'This capture cannot be transcribed again. Continue with manual notes, or discard the audio.'; } }
    finally { if (currentEpoch === epoch) { transcribing = false; render(); } }
  }
  async function generate() {
    if (!connected || !config?.apiConfigured || generating || transcribing || loadingWorkingCopy || accepted(liveCall?.state)) return;
    let attempt; const currentEpoch = epoch;
    try { attempt = workflow.beginDraft(); generating = true; error = ''; message = 'Meta is creating an editable case draft from the current sources.'; render();
      const payload = await request('/case/draft', { method: 'POST', body: attempt.payload, timeout: 120000 });
      if (currentEpoch !== epoch) return;
      message = workflow.completeDraft(attempt, payload) ? 'Case draft ready. Check all four sections against the sources and flag unresolved conflicts before confirming review.' : 'Sources or draft edits changed. The incoming draft was discarded; your edits are preserved.';
    } catch (caught) { if (attempt) workflow.failDraft(attempt); if (currentEpoch === epoch) { error = errorCopy(caught); message = 'Draft generation did not complete. Sources and previous draft edits are preserved.'; } }
    finally { if (currentEpoch === epoch) { generating = false; render(); } }
  }
  function setReviewed(checked) { try { workflow.setReviewed(checked); error = ''; render(); } catch (caught) { setError(caught); } }
  async function exportReviewed(format = 'pdf', includeSources = false) {
    if (!connected || exporting || generating || transcribing || loadingWorkingCopy || !['pdf', 'docx', 'txt', 'pptx'].includes(format)) return;
    const currentEpoch = epoch;
    try { const reviewed = workflow.exportCase(); const version = { source: workflow.sourceRevision, draft: workflow.draftRevision, generation: workflow.provenance?.generationId }; exporting = true; error = ''; render();
      const result = await request('/case/export', { method: 'POST', body: { format, includeSources: Boolean(includeSources), case: reviewed }, responseType: 'blob', timeout: 60000 });
      if (currentEpoch !== epoch || reviewed.id !== workflow.id || reviewed.review.reviewedAt !== workflow.reviewedAt || version.source !== workflow.sourceRevision || version.draft !== workflow.draftRevision || version.generation !== workflow.provenance?.generationId) return;
      const blob = result?.blob ?? result;
      if (!(blob instanceof Blob)) throw new Error('The case export could not be read.');
      download(blob, `community-connect-reviewed-case-${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`); message = 'Reviewed case downloaded. Source text is included only if you selected it.';
    } catch (caught) { if (currentEpoch === epoch) setError(caught); }
    finally { if (currentEpoch === epoch) { exporting = false; render(); } }
  }
  function saveWorkingNotes() { const workingDraft = workflow.draft ? `\nUNREVIEWED WORKING DRAFT — not an approved case\n${CASE_FIELDS.map(field => `\n${{ enquiry: 'ENQUIRY', relevantDetails: 'RELEVANT DETAILS', uncertainties: 'UNCERTAINTIES', nextSteps: 'PROPOSED NEXT STEPS' }[field]}\n${workflow.draft[field]}\n`).join('')}` : ''; download(new Blob([`COMMUNITY CONNECT — WORKING SYNTHETIC COPY\nNot a reviewed case.\n\nMANUAL NOTES\n${workflow.notes}\n\nEDITED TRANSCRIPT\n${workflow.transcript}\n\nORIGINAL MACHINE TRANSCRIPT\n${workflow.originalTranscript}\n${workingDraft}`], { type: 'text/plain;charset=utf-8' }), 'community-connect-working-copy.txt'); }
  function resetCase(nextMessage) {
    epoch++; captureEpoch++; void (capture ?? preparedCapture)?.dispose(); capture = preparedCapture = null; preparedProof = null; wave = null; sourceCallId = null; captureProof = null; transcriptionRetryable = true;
    workflow.reset(); captureState = 'off'; captureAgreement = false; seconds = 0; error = ''; transcriptionError = ''; message = nextMessage;
    if (connected && !config) { configRequest = null; void loadConfig(); }
  }
  function saveResumableCopy() {
    try {
      const text = serializeWorkingCopy({ notes: workflow.notes, transcript: workflow.transcript }, workflow.now());
      download(new Blob([text], { type: 'application/json;charset=utf-8' }), 'community-connect-resumable-notes-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
      error = ''; message = 'Resumable notes saved. Use Load saved notes to reopen the notes and current transcript; create a fresh draft and review before export.'; render(); return true;
    } catch (caught) { setError(caught); return false; }
  }
  async function loadWorkingCopy(file) {
    if (loadingWorkingCopy || replacingBlocked()) { error = 'Finish the current call or processing before loading saved notes.'; render(); return false; }
    if (!file || !Number.isInteger(file.size) || file.size < 1 || file.size > MAX_WORKING_COPY_BYTES || typeof file.arrayBuffer !== 'function') {
      error = 'Choose a resumable JSON file from Save to resume, no larger than 512 KB. The TXT working copy is a readable backup.'; render(); return false;
    }
    const currentEpoch = epoch, caseId = workflow.id, sourceRevision = workflow.sourceRevision, draftRevision = workflow.draftRevision;
    const unchanged = () => currentEpoch === epoch && caseId === workflow.id && sourceRevision === workflow.sourceRevision && draftRevision === workflow.draftRevision && !replacingBlocked();
    loadingWorkingCopy = true; error = ''; render();
    try {
      let content;
      try {
        const bytes = await file.arrayBuffer();
        if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > MAX_WORKING_COPY_BYTES) throw new Error();
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch { throw new Error('The saved file could not be read as UTF-8 text. Choose a resumable JSON file from Save to resume.'); }
      const sources = parseWorkingCopy(content);
      if (!unchanged()) throw new Error('The case changed while the file was opening. Your current work is preserved; choose the file again when ready.');
      if (hasWork() && !confirmRestore()) { message = 'Loading cancelled. Your current work is unchanged.'; return false; }
      if (!unchanged()) throw new Error('The case changed while the file was opening. Your current work is preserved; choose the file again when ready.');
      resetCase('Saved notes loaded as a new case. Check the notes and pasted transcript, create a fresh Meta draft, then review before exporting.');
      workflow.setSource('notes', sources.notes); workflow.setSource('transcript', sources.transcript); workflow.restoredSources = true;
      return true;
    } catch (caught) { if (currentEpoch === epoch) setError(caught); return false; }
    finally { loadingWorkingCopy = false; render(); }
  }
  function newCase() {
    if (loadingWorkingCopy || generating || transcribing || exporting || stoppingCapture || accepted(liveCall?.state) || ['recording', 'starting', 'stopping'].includes(captureState)) return false;
    if (hasWork() && !confirmDiscard()) return false;
    resetCase('New case started. The previous case was cleared after your confirmation.');
    render(); return true;
  }
  function dispose() { epoch++; captureEpoch++; void (capture ?? preparedCapture)?.dispose(); capture = preparedCapture = null; wave = null; }
  render();
  return { snapshot, setConnectionState, setSource, setDraftField, setCaptureAgreement, beforeAnswer, onAcceptedCall, onRemoteStream, onAudioClosed: stopCapture, stopCapture, discardAudio, onCallEnded, transcribe, generate, setReviewed, exportReviewed, saveWorkingNotes, saveResumableCopy, loadWorkingCopy, newCase, dispose };
}

export function mountCaseDesk(document, { request, window = globalThis } = {}) {
  const get = id => document.getElementById(id);
  const text = (id, value) => { if (get(id).textContent !== value) get(id).textContent = value; };
  const download = (blob, filename) => { const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  const desk = createCaseDesk({ request, download,
    confirmDiscard: () => window.confirm('Start a new case and clear this tab’s notes, transcript, draft and any captured audio? Choose Cancel to save a working copy first. That download contains text only, not audio.'),
    confirmRestore: () => window.confirm('Load saved notes as a new case? This replaces the current notes, transcript and draft, and discards any temporary audio. Choose Cancel to save your current work first.'),
    view: { render(state) {
    if (get('agent-notes').value !== state.notes) get('agent-notes').value = state.notes;
    if (get('call-transcript').value !== state.transcript) get('call-transcript').value = state.transcript;
    text('notes-count', `${state.notes.length.toLocaleString()} / 12,000`); text('transcript-count', `${state.transcript.length.toLocaleString()} / 36,000`);
    get('capture-agreement').checked = state.captureAgreement; get('capture-agreement').disabled = !state.connected || !state.config?.transcriptionConfigured || acceptedForUi(state.liveCall?.state) || ['recording', 'starting', 'stopping'].includes(state.captureState);
    get('stop-capture').hidden = !['recording', 'starting', 'stopping'].includes(state.captureState); get('stop-capture').disabled = state.captureState === 'stopping';
    get('discard-audio').hidden = state.transcribing || (!state.hasAudio && !['recording', 'starting', 'stopping'].includes(state.captureState));
    text('capture-status', state.transcribing ? 'Capture stopped · transcribing with Meta' : state.captureState === 'recording' ? `CAPTURING · ${Math.floor(state.seconds / 60)}:${String(Math.floor(state.seconds % 60)).padStart(2, '0')} / 5:00` : state.captureState === 'starting' ? 'Starting agreed capture…' : state.captureState === 'stopped' ? state.liveCall?.state === 'ended' ? 'Capture stopped · audio kept in memory' : 'Capture stopped · waiting for call end' : state.captureState === 'error' ? 'Capture unavailable · manual notes preserved' : state.captureState === 'stopping' ? 'Finalizing captured audio…' : state.captureAgreement ? 'Capture enabled — waiting for the call to connect.' : 'Optional capture is off');
    get('capture-status').dataset.recording = String(state.captureState === 'recording');
    get('retry-transcription').hidden = !state.hasAudio || !state.transcriptionRetryable || state.transcribing || acceptedForUi(state.liveCall?.state);
    text('transcription-status', state.transcribing ? 'Transcribing captured audio with Meta…' : state.transcriptionError && state.hasAudio ? state.transcriptionRetryable ? 'Captured audio is kept in this tab. Retry when ready.' : 'Continue with manual notes, or discard this audio.' : state.hasAudio ? state.liveCall?.state === 'ended' ? 'Captured audio is ready to transcribe.' : 'Captured audio will be transcribed after the call ends.' : '');
    text('transcription-error', state.transcriptionError); get('transcription-error').hidden = !state.transcriptionError;
    text('transcription-info', !state.connected ? 'Connect the desk to check transcription availability.' : !state.config ? 'Checking transcription availability…' : state.config.transcriptionConfigured ? 'Opt in before Answer. Captured audio is sent to Meta after the call ends, then cleared from this tab on success.' : 'Transcription is not configured. You can use manual notes or paste a transcript you already have.');
    get('original-transcript-panel').hidden = !state.originalTranscript; text('original-transcript', state.originalTranscript);
    text('transcript-origin', state.transcriptionProvenance ? `Meta transcript${state.originalTranscript !== state.transcript ? ' · edited by the agent' : ' · check for errors'}` : state.originalTranscript ? 'Original machine text retained · not attested for this draft' : state.transcript.trim() ? 'Manually entered/pasted test transcript · no automatic transcription' : 'No automatic transcript yet');
    const both = state.sourceKind === 'combined'; text('merge-create', state.generating ? 'Creating draft…' : both ? 'Merge and create draft' : state.sourceKind === 'transcript' ? 'Create draft from transcript' : 'Create draft from notes');
    get('merge-create').disabled = !state.connected || !state.config?.apiConfigured || state.generating || state.transcribing || state.loadingWorkingCopy || acceptedForUi(state.liveCall?.state) || !(state.notes.trim() || state.transcript.trim());
    text('case-model-status', !state.connected ? 'Connect your desk to create a Meta draft.' : !state.config ? 'Checking Meta configuration…' : state.config.apiConfigured ? `Meta Model API${state.config.model ? ` · ${state.config.model}` : ''}` : 'Meta drafting is not configured. Your notes remain available.');
    get('case-draft-fields').hidden = !state.draft; get('case-draft-empty').hidden = Boolean(state.draft);
    for (const field of CASE_FIELDS) { const input = get(`case-${field}`); if (state.draft && input.value !== state.draft[field]) input.value = state.draft[field]; }
    text('case-provenance', state.provenance ? `Meta Model API · ${state.provenance.model} · ${state.transport === 'whatsapp' ? 'live WhatsApp context' : 'manual example'} · human review required` : 'An editable draft will appear here.');
    text('case-review-help', state.reviewed ? 'Human review confirmed. Further source or draft edits require fresh approval.' : state.reviewBlockReason || 'Compare the draft with the available sources, check the facts, flag unresolved conflicts and review proposed next steps.');
    get('case-reviewed').checked = state.reviewed; get('case-reviewed').disabled = Boolean(state.reviewBlockReason) || state.transcribing;
    get('export-reviewed').disabled = !state.connected || !state.canExport || state.exporting || state.generating || state.transcribing || state.loadingWorkingCopy;
    text('export-reviewed', state.exporting ? 'Preparing download…' : 'Export reviewed case');
    get('new-case').disabled = state.loadingWorkingCopy || state.generating || state.transcribing || state.exporting || acceptedForUi(state.liveCall?.state) || ['recording', 'starting', 'stopping'].includes(state.captureState);
    get('save-working-notes').disabled = !state.hasWorkingText;
    get('save-resumable-notes').disabled = !state.hasResumableSources;
    get('load-working-notes').disabled = !state.canLoadWorkingCopy;
    text('load-working-notes', state.loadingWorkingCopy ? 'Loading notes…' : 'Load saved notes');
    if (state.restoredSources && state.transcript.trim()) text('transcript-origin', 'Loaded transcript text · no automatic transcription proof · review against your notes');
    text('case-activity', state.message); text('case-error', state.error); get('case-error').hidden = !state.error;
  } } });
  get('agent-notes').addEventListener('input', event => desk.setSource('notes', event.target.value));
  get('call-transcript').addEventListener('input', event => desk.setSource('transcript', event.target.value));
  for (const field of CASE_FIELDS) get(`case-${field}`).addEventListener('input', event => desk.setDraftField(field, event.target.value));
  get('capture-agreement').addEventListener('change', event => desk.setCaptureAgreement(event.target.checked));
  get('stop-capture').addEventListener('click', () => { void desk.stopCapture(); });
  get('discard-audio').addEventListener('click', () => desk.discardAudio());
  get('retry-transcription').addEventListener('click', () => { void desk.transcribe(); });
  get('merge-create').addEventListener('click', () => { void desk.generate(); });
  get('case-reviewed').addEventListener('change', event => desk.setReviewed(event.target.checked));
  get('export-reviewed').addEventListener('click', () => { void desk.exportReviewed(get('export-format').value, get('include-sources').checked); });
  get('save-working-notes').addEventListener('click', () => desk.saveWorkingNotes()); get('new-case').addEventListener('click', () => desk.newCase());
  get('save-resumable-notes').addEventListener('click', () => desk.saveResumableCopy());
  get('load-working-notes').addEventListener('click', () => { const input = get('working-copy-file'); input.value = ''; input.click(); });
  get('working-copy-file').addEventListener('change', event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void desk.loadWorkingCopy(file); });
  window.addEventListener('beforeunload', event => { if (desk.snapshot().hasWork) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => desk.dispose());
  return desk;
}

function acceptedForUi(state) { return ['connecting', 'active', 'ending', 'uncertain'].includes(state); }
