import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError, inspectModelAccess } from './meta-api.mjs';
import { readConfig, isApiKeyConfigured } from './config.mjs';
import { generateCaseDraft, readCaseSources, UUID } from './case-draft.mjs';
import { readTranscriptionConfig, transcribeAudio, validateRawWav } from './transcription.mjs';
import { exportReviewedCase } from './case-export.mjs';

const fingerprint = value => createHash('sha256').update(value).digest('hex');
const sourceDigest = source => fingerprint(JSON.stringify([source.notes ?? '', source.transcript ?? '', source.originalTranscript ?? '']));
const problem = (code, message, status = 400) => new AppError(code, message, status);
const AUDIO_TTL = 15 * 60 * 1000;
const RECEIPT_TTL = 4 * 60 * 60 * 1000;

// Only hashes and fixed provenance are retained, not notes, audio or case text.
export function createCaseService({
  modelConfig = readConfig({}), transcriptionConfig = readTranscriptionConfig({}),
  generate = generateCaseDraft, transcribe = transcribeAudio, exportCase = exportReviewedCase, inspectAccess = inspectModelAccess,
  now = Date.now,
} = {}) {
  const accepted = new Map(), receipts = new Map(), controllers = new Set();
  let generating = false, transcribing = false, exporting = false, closed = false;
  let inspecting = false, accessCache = null;
  let generationWindow = now(), generationCount = 0;
  function sweep() {
    const time = now();
    for (const [key, value] of accepted) if (value.expiresAt <= time) accepted.delete(key);
    for (const [key, value] of receipts) if (value.expiresAt <= time) receipts.delete(key);
  }
  function boundedPut(map, key, value, maximum) {
    map.delete(key); map.set(key, value);
    while (map.size > maximum) map.delete(map.keys().next().value);
  }
  function rememberAccepted(agentId, callId) {
    if (closed || !UUID.test(callId)) return;
    sweep();
    const key = `${agentId}:${callId}`;
    if (!accepted.has(key)) boundedPut(accepted, key, { expiresAt: now() + RECEIPT_TTL, transcribeUntil: now() + AUDIO_TTL, used: false, busy: false, ended: false }, 64);
  }
  function observeState(agentId, state) {
    // The broker permits only one current call. A different/null current call
    // therefore proves a previously accepted call has finished, even if a new
    // offer arrived between the termination webhook and the next browser poll.
    for (const [key, proof] of accepted) {
      if (key.startsWith(`${agentId}:`) && (state?.call?.id !== key.slice(agentId.length + 1) || state.call.state === 'ended')) proof.ended = true;
    }
  }
  function activity(request, response) {
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => { if (!response.writableEnded) controller.abort(); };
    request.once('aborted', abort); response.once('close', abort);
    return { signal: controller.signal, done() { controllers.delete(controller); request.removeListener('aborted', abort); response.removeListener('close', abort); } };
  }
  async function handle({ request, response, pathname, agentId, readJson, readBody, reply }) {
    if (!pathname.startsWith('/agent/api/case/')) return false;
    if (closed) throw problem('CASE_UNAVAILABLE', 'The case service is restarting. Your edits remain in this tab.', 503);
    sweep();
    if (pathname === '/agent/api/case/config' && request.method === 'GET') {
      reply(response, 200, { apiConfigured: isApiKeyConfigured(modelConfig?.apiKey), transcriptionConfigured: isApiKeyConfigured(transcriptionConfig?.apiKey), model: modelConfig?.model ?? '', maxAudioBytes: transcriptionConfig?.maxAudioBytes ?? 16 * 1024 * 1024, maxAudioSeconds: transcriptionConfig?.maxAudioDurationSeconds ?? 300 });
      return true;
    }
    if (pathname === '/agent/api/case/access' && request.method === 'GET') {
      if (!isApiKeyConfigured(modelConfig?.apiKey)) throw problem('MODEL_NOT_CONFIGURED', 'Configure the backend Model API key before checking model access.', 503);
      const suppliedDigest = request.headers['x-model-key-digest'];
      if (suppliedDigest !== undefined && (typeof suppliedDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(suppliedDigest))) throw problem('INVALID_ACCESS_CHECK', 'Use a valid local key comparison digest.', 400);
      // An operator can compare its local key without sending the key itself.
      // Neither key nor digest is returned, logged or included in the cache.
      const comparison = suppliedDigest === undefined ? {} : { localKeyMatches: timingSafeEqual(Buffer.from(suppliedDigest, 'hex'), Buffer.from(fingerprint(modelConfig.apiKey), 'hex')) };
      if (suppliedDigest !== undefined) response.setHeader('X-Local-Model-Key-Matches', String(comparison.localKeyMatches));
      if (accessCache?.expiresAt > now()) { reply(response, 200, { ...accessCache.value, ...comparison }); return true; }
      if (inspecting) throw problem('MODEL_ACCESS_BUSY', 'A model access check is already running. Try again shortly.', 429);
      inspecting = true;
      const operation = activity(request, response);
      try {
        // Explicit operator check only. No audio, notes or model generation is
        // sent, and this never selects or changes the configured models.
        const catalog = await inspectAccess(modelConfig, { signal: operation.signal });
        if (closed || operation.signal.aborted) throw problem('MODEL_CANCELLED', 'The model access check was cancelled.', 499);
        const value = {
          checkedAt: new Date(now()).toISOString(),
          caseModel: modelConfig.model, transcriptionModel: transcriptionConfig.model,
          caseModelListed: catalog.models.includes(modelConfig.model),
          transcriptionModelListed: catalog.models.includes(transcriptionConfig.model),
          availableModels: catalog.models,
        };
        accessCache = { expiresAt: now() + 60000, value };
        reply(response, 200, { ...value, ...comparison });
      } finally { operation.done(); inspecting = false; }
      return true;
    }
    if (request.method !== 'POST') { request.resume(); throw problem('METHOD_NOT_ALLOWED', 'Use the supported case action method.', 405); }
    if (pathname === '/agent/api/case/draft') {
      const sources = readCaseSources(await readJson(request, 512 * 1024));
      if (!isApiKeyConfigured(modelConfig?.apiKey)) throw problem('MODEL_NOT_CONFIGURED', 'Add MODEL_API_KEY to the gateway backend and restart. Your notes and transcript have been kept.', 503);
      if (generating) throw problem('GENERATION_BUSY', 'A case is already being drafted. Your sources have been kept.', 429);
      if (now() - generationWindow >= 60000) { generationWindow = now(); generationCount = 0; }
      if (generationCount >= 12) throw problem('GENERATION_RATE_LIMIT', 'Wait a minute before generating another case. Your sources have been kept.', 429);
      for (const id of [sources.sourceCallId, sources.transcriptCallId].filter(Boolean)) if (!accepted.has(`${agentId}:${id}`)) throw problem('CALL_SOURCE_EXPIRED', 'This call context has expired or the service restarted. Save your work before starting a new case.', 409);
      // Snapshot validated metadata before the provider wait: a sweep during
      // generation must not relabel an accepted WhatsApp call as a manual case.
      const call = sources.sourceCallId ?? sources.transcriptCallId;
      const asrProof = sources.transcriptCallId ? accepted.get(`${agentId}:${sources.transcriptCallId}`) : null;
      const transcriptionProvenance = sources.transcript.trim() && asrProof?.transcriptDigest && fingerprint(sources.originalTranscript) === asrProof.transcriptDigest ? { ...asrProof.provenance } : undefined;
      const source = { sourceKind: sources.sourceKind, transport: call ? 'whatsapp' : 'manual_example' };
      generating = true; generationCount++;
      const operation = activity(request, response);
      try {
        const result = await generate(sources, modelConfig, { signal: operation.signal });
        if (closed || operation.signal.aborted) throw problem('MODEL_CANCELLED', 'Case generation was cancelled. Your sources have been kept.', 499);
        const generationId = randomUUID();
        const provenance = { ...result.provenance, generationId };
        boundedPut(receipts, generationId, { agentId, caseId: sources.caseId, digest: sourceDigest(sources), source, provenance, transcriptionProvenance, expiresAt: now() + RECEIPT_TTL }, 128);
        reply(response, 200, { draft: result.draft, provenance, source, ...(transcriptionProvenance ? { transcriptionProvenance } : {}) });
      } finally { operation.done(); generating = false; }
      return true;
    }
    if (pathname === '/agent/api/case/transcribe') {
      if (!isApiKeyConfigured(transcriptionConfig?.apiKey)) { request.resume(); throw problem('TRANSCRIPTION_NOT_CONFIGURED', 'Add the backend Model API key before transcription. Manual notes remain available.', 503); }
      const id = request.headers['x-call-id'];
      const proof = typeof id === 'string' && UUID.test(id) ? accepted.get(`${agentId}:${id}`) : null;
      if (!proof) { request.resume(); throw problem('TRANSCRIPTION_CALL_REQUIRED', 'Transcription needs a recently accepted call from this desk.', 403); }
      if (!proof.ended) { request.resume(); throw problem('TRANSCRIPTION_CALL_ACTIVE', 'Finish the call before sending audio for transcription.', 409); }
      if (proof.transcribeUntil <= now()) { request.resume(); throw problem('TRANSCRIPTION_EXPIRED', 'The temporary transcription window has expired. Manual notes remain available.', 409); }
      if (request.headers['x-participants-agreed'] !== 'true') { request.resume(); throw problem('TRANSCRIPTION_AGREEMENT_REQUIRED', 'Confirm every participant agreed before transcribing.', 400); }
      if (proof.used) { request.resume(); throw problem('TRANSCRIPTION_ALREADY_COMPLETE', 'This call has already been transcribed. Use the existing transcript.', 409); }
      if (transcribing || proof.busy) { request.resume(); throw problem('TRANSCRIPTION_BUSY', 'Another transcription is processing. Manual notes have been kept.', 429); }
      if (!/^audio\/wav(?:\s*;|$)/i.test(request.headers['content-type'] || '')) { request.resume(); throw problem('INVALID_CONTENT_TYPE', 'Upload supported PCM WAV audio.', 415); }
      const limit = transcriptionConfig.maxAudioBytes;
      const declared = Number(request.headers['content-length']);
      if (declared > limit) { request.resume(); throw problem('TRANSCRIPTION_AUDIO_TOO_LARGE', 'The recording exceeds the audio limit.', 413); }
      transcribing = true; proof.busy = true;
      const operation = activity(request, response);
      let audio;
      try {
        audio = await readBody(request, limit, 110000);
        validateRawWav(audio, transcriptionConfig);
        const result = await transcribe(audio, transcriptionConfig, { signal: operation.signal });
        if (closed || operation.signal.aborted) throw problem('TRANSCRIPTION_CANCELLED', 'Transcription was cancelled. Manual notes have been kept.', 499);
        proof.used = true; proof.transcriptDigest = fingerprint(result.transcript); proof.provenance = result.provenance;
        reply(response, 200, result);
      } finally { audio?.fill(0); operation.done(); proof.busy = false; transcribing = false; }
      return true;
    }
    if (pathname === '/agent/api/case/export') {
      const data = await readJson(request, 512 * 1024);
      if (Object.keys(data).some(key => !['case', 'format', 'includeSources'].includes(key)) || !data.case || typeof data.case !== 'object' || !['pdf', 'docx', 'txt', 'pptx'].includes(data.format) || (data.includeSources !== undefined && typeof data.includeSources !== 'boolean')) throw problem('INVALID_EXPORT', 'Choose a reviewed case and supported export format.');
      const receipt = receipts.get(data.case.provenance?.generationId);
      if (!receipt || receipt.agentId !== agentId || receipt.caseId !== data.case.id || receipt.digest !== sourceDigest(data.case.source || {})) throw problem('CASE_SOURCE_CHANGED', 'Generate from the current sources and review before exporting. Your edits have been kept.', 409);
      if (exporting) throw problem('EXPORT_BUSY', 'Another export is being prepared. Your case has been kept.', 429);
      exporting = true;
      try {
        const reviewed = { ...data.case, source: { ...data.case.source, ...receipt.source }, provenance: receipt.provenance, transcriptionProvenance: receipt.transcriptionProvenance, exportedAt: new Date(now()).toISOString() };
        const result = await exportCase(reviewed, data.format, { includeSources: data.includeSources === true });
        response.writeHead(200, { 'Content-Type': result.mimeType, 'Content-Disposition': `attachment; filename="${result.filename}"`, 'Content-Length': result.bytes.length });
        response.end(result.bytes);
      } finally { exporting = false; }
      return true;
    }
    request.resume(); throw problem('NOT_FOUND', 'Case action not found.', 404);
  }
  return { handle, rememberAccepted, observeState, sweep, close() { closed = true; accepted.clear(); receipts.clear(); accessCache = null; for (const controller of controllers) controller.abort(); controllers.clear(); } };
}
