import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createCallingServer } from '../calling-server.mjs';
import { AppError } from '../lib/meta-api.mjs';
import { readConfig } from '../lib/config.mjs';
import { readTranscriptionConfig } from '../lib/transcription.mjs';
import { validateReviewedCase } from '../lib/case-export.mjs';

const MODEL_KEY = 'synthetic-case-model-secret-123456789';
const AGENT = 'synthetic-case-agent-123456789';
const FOREIGN_AGENT = 'synthetic-foreign-agent-123456789';
const SETTINGS = {
  port: 10000, publicOrigin: 'http://127.0.0.1:10000', graphVersion: 'v26.0', phoneNumberId: '123456789',
  verifyToken: 'synthetic-case-verify-secret-123456789012345', appSecret: 'synthetic-case-app-secret-123456789',
  accessToken: 'synthetic-case-graph-secret-123456789', agentAccessToken: 'synthetic-case-agent-secret-123456789012345',
};
const SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n';
const NOTES = 'SYNTHETIC: Caller requests Thursday collection. No change has been approved.';
const TRANSCRIPT = 'The fictional caller requested Thursday. The change has not been confirmed.';
const DRAFT = { enquiry: 'A fictional collection change was requested.', relevantDetails: 'Thursday was requested.', uncertainties: 'Availability and approval remain unconfirmed.', nextSteps: 'A worker should check availability before offering a change.' };
const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain; charset=utf-8', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
const secrets = [MODEL_KEY, SETTINGS.accessToken, SETTINGS.agentAccessToken, SETTINGS.verifyToken, SETTINGS.appSecret];

function wav() {
  const audio = Buffer.alloc(44 + 32000);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(32000, 40);
  return audio;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const sources = (changes = {}) => ({ caseId: randomUUID(), notes: NOTES, transcript: '', originalTranscript: '', ...changes });
function reviewed(source, generated, now) {
  return {
    schemaVersion: 2, id: source.caseId, project: 'Community Connect', synthetic: true,
    source: { notes: source.notes ?? '', transcript: source.transcript ?? '', originalTranscript: source.originalTranscript ?? '', ...generated.source },
    draft: { ...generated.draft }, provenance: { ...generated.provenance },
    ...(generated.transcriptionProvenance ? { transcriptionProvenance: generated.transcriptionProvenance } : {}),
    review: { status: 'reviewed', reviewedAt: new Date(now).toISOString() },
  };
}

async function start(t, options = {}) {
  let clock = Date.parse('2026-10-27T10:00:00Z');
  const modelCalls = [], asrBuffers = [], exports = [], actions = [];
  const server = createCallingServer(SETTINGS, {
    modelConfig: readConfig({ MODEL_API_KEY: MODEL_KEY }),
    transcriptionConfig: readTranscriptionConfig({ MODEL_API_KEY: MODEL_KEY }),
    caseNow: () => clock,
    sendAction: async (action, data) => { actions.push({ action, ...data }); return { success: true }; },
    generate: async input => {
      modelCalls.push(input);
      return { draft: { ...DRAFT }, provenance: { kind: 'meta', label: 'Meta Model API', model: 'muse-wonder-1.0', generatedAt: new Date(clock).toISOString() } };
    },
    transcribe: async audio => {
      asrBuffers.push(audio);
      assert.equal(audio.subarray(0, 4).toString(), 'RIFF');
      return { transcript: TRANSCRIPT, turns: [], audioDurationMs: 1000, provenance: { kind: 'meta_transcription', model: 'muse-voice-transcribe-1.0', generatedAt: new Date(clock).toISOString() } };
    },
    // Artifact content/rendering is covered by case-export.test.mjs. This fake
    // keeps HTTP tests focused while applying the real canonical-case validator.
    exportCase: async (value, format, exportOptions) => {
      const checked = validateReviewedCase(value);
      exports.push({ value: checked, format, options: exportOptions });
      return { bytes: Buffer.from(JSON.stringify(checked)), mimeType: MIME[format], filename: `community-connect-reviewed-${checked.id}.${format}` };
    },
    ...options,
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await server.callBroker.idle(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = (extra = {}) => ({ Authorization: `Bearer ${SETTINGS.agentAccessToken}`, 'X-Agent-ID': AGENT, ...extra });
  async function api(path, body, extra = {}) {
    return fetch(`${base}/agent/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: headers({ ...(body === undefined ? {} : { Origin: SETTINGS.publicOrigin, 'Content-Type': 'application/json' }), ...extra }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function webhook(event = 'connect', graphId = 'synthetic-http-graph-call') {
    const value = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'calls', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: SETTINGS.phoneNumberId }, calls: [{ id: graphId, event, timestamp: String(Math.floor(Date.now() / 1000)), ...(event === 'connect' ? { session: { sdp_type: 'offer', sdp: SDP } } : {}) }] } }] }] };
    const body = JSON.stringify(value);
    return fetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', SETTINGS.appSecret).update(body).digest('hex')}` }, body });
  }
  async function ringing() {
    assert.equal((await api('ready', { ready: true })).status, 200);
    assert.equal((await webhook()).status, 200);
    const state = await (await api('state')).json();
    assert.equal(state.call.state, 'ringing');
    return state.call.id;
  }
  async function acceptedCall({ end = true } = {}) {
    const id = await ringing();
    assert.equal((await api(`calls/${id}/answer`, { sdp: SDP })).status, 200);
    const accepted = await api(`calls/${id}/accept`, {});
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).call.state, 'active');
    if (end) assert.equal((await api(`calls/${id}/hangup`, {})).status, 200);
    return id;
  }
  async function upload(callId, { audio = wav(), agreed = 'true', extra = {} } = {}) {
    return fetch(`${base}/agent/api/case/transcribe`, {
      method: 'POST', headers: headers({ Origin: SETTINGS.publicOrigin, 'Content-Type': 'audio/wav', 'X-Call-ID': callId, ...(agreed == null ? {} : { 'X-Participants-Agreed': agreed }), ...extra }), body: audio,
    });
  }
  async function generate(source) {
    const result = await api('case/draft', source);
    assert.equal(result.status, 200);
    return result.json();
  }
  return { base, api, headers, webhook, ringing, acceptedCall, upload, generate, actions, modelCalls, asrBuffers, exports, server, now: () => clock, advance: amount => { clock += amount; } };
}

test('case configuration is authenticated, useful and contains no runtime credentials', async t => {
  const { base, api } = await start(t);
  assert.equal((await fetch(`${base}/agent/api/case/config`)).status, 401);
  const result = await api('case/config');
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const text = await result.text();
  const config = JSON.parse(text);
  assert.equal(config.apiConfigured, true);
  assert.equal(config.transcriptionConfigured, true);
  assert.equal(config.maxAudioSeconds, 300);
  assert.ok(config.maxAudioBytes > 0);
  for (const secret of secrets) assert.ok(!text.includes(secret));
});

test('explicit model access preflight is authenticated, cached and compares keys without exposing credentials or digests', async t => {
  let checks = 0;
  const context = await start(t, { inspectAccess: async (config, { signal }) => {
    checks++; assert.equal(config.apiKey, MODEL_KEY); assert.equal(signal.aborted, false);
    return { models: ['muse-wonder-1.0', 'muse-voice-transcribe-1.0'], configuredModelListed: true };
  } });
  assert.equal((await fetch(`${context.base}/agent/api/case/access`)).status, 401);
  const digest = createHash('sha256').update(MODEL_KEY).digest('hex');
  const response = await context.api('case/access', undefined, { 'X-Model-Key-Digest': digest });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-local-model-key-matches'), 'true');
  const body = await response.json();
  assert.equal(body.localKeyMatches, true); assert.equal(body.caseModelListed, true); assert.equal(body.transcriptionModelListed, true);
  assert.deepEqual(body.availableModels, ['muse-wonder-1.0', 'muse-voice-transcribe-1.0']);
  assert.ok(!JSON.stringify(body).includes(MODEL_KEY)); assert.ok(!JSON.stringify(body).includes(digest));
  const different = await (await context.api('case/access', undefined, { 'X-Model-Key-Digest': '00'.repeat(32) })).json();
  assert.equal(different.localKeyMatches, false); assert.equal(checks, 1);
  const withoutDigest = await (await context.api('case/access')).json();
  assert.equal(withoutDigest.localKeyMatches, undefined); assert.equal(checks, 1);
  assert.equal((await context.api('case/access', undefined, { 'X-Model-Key-Digest': 'invalid' })).status, 400);
  context.advance(60001); assert.equal((await context.api('case/access')).status, 200); assert.equal(checks, 2);
  assert.equal(context.modelCalls.length, 0); assert.equal(context.asrBuffers.length, 0); assert.equal(context.actions.length, 0);
});

test('model key comparison remains available when the provider model catalogue rejects the request', async t => {
  const context = await start(t, { inspectAccess: async () => { throw new AppError('MODEL_BAD_RESPONSE', 'Meta rejected the model access check.'); } });
  const digest = createHash('sha256').update(MODEL_KEY).digest('hex');
  const result = await context.api('case/access', undefined, { 'X-Model-Key-Digest': digest });
  assert.equal(result.status, 502); assert.equal(result.headers.get('x-local-model-key-matches'), 'true');
  const body = await result.text();
  assert.ok(!body.includes(MODEL_KEY)); assert.ok(!body.includes(digest));
});

test('case routes inherit agent authentication and exact-origin mutation restrictions', async t => {
  const { api, modelCalls } = await start(t);
  assert.equal((await api('case/draft', sources(), { Authorization: 'Bearer incorrect' })).status, 401);
  assert.equal((await api('case/draft', sources(), { Origin: 'https://other.invalid' })).status, 403);
  assert.equal((await api('case/draft', sources(), { Origin: '' })).status, 403);
  assert.equal((await api('case/draft', sources(), { 'X-Agent-ID': 'short' })).status, 400);
  assert.deepEqual(modelCalls, []);
});

test('manual-only, transcript-only and combined sources normalize honestly in one generation each', async t => {
  const { generate, modelCalls } = await start(t);
  for (const [source, expected] of [
    [sources(), 'manual_notes'],
    [sources({ notes: '', transcript: TRANSCRIPT, originalTranscript: TRANSCRIPT }), 'transcript'],
    [sources({ transcript: TRANSCRIPT, originalTranscript: TRANSCRIPT, sourceKind: 'verified' }), 'combined'],
  ]) {
    const result = await generate(source);
    assert.equal(result.source.sourceKind, expected);
    assert.equal(result.source.transport, 'manual_example');
    assert.equal(result.transcriptionProvenance, undefined);
    assert.ok(result.provenance.generationId);
    assert.equal(modelCalls.at(-1).sourceKind, expected);
  }
  assert.equal(modelCalls.length, 3);
});

test('reviewed human edits export in all four formats without additional model or transcription requests', async t => {
  const context = await start(t);
  const source = sources();
  const generated = await context.generate(source);
  const value = reviewed(source, generated, context.now());
  const unreviewed = { ...value, review: { status: 'unreviewed' } };
  assert.equal((await context.api('case/export', { case: unreviewed, format: 'pdf' })).status, 400);
  value.draft.enquiry = 'HUMAN EDIT: the fictional caller requested a change; no approval is recorded.';
  for (const format of ['pdf', 'docx', 'txt', 'pptx']) {
    const result = await context.api('case/export', { case: value, format, includeSources: true });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-type'), MIME[format]);
    assert.match(result.headers.get('content-disposition'), new RegExp(`\\.${format}"$`));
    const exported = JSON.parse(await result.text());
    assert.equal(exported.draft.enquiry, value.draft.enquiry);
    assert.equal(exported.review.status, 'reviewed');
  }
  assert.equal(context.exports.length, 4);
  assert.ok(context.exports.every(item => item.options.includeSources === true));
  assert.equal(context.modelCalls.length, 1);
  assert.equal(context.asrBuffers.length, 0);
});

test('unknown JSON keys, invalid sources/content types and excessive request bodies fail before generation', async t => {
  const { base, api, headers, modelCalls } = await start(t);
  for (const value of [sources({ extra: true }), sources({ notes: '', transcript: '' }), sources({ notes: 'x'.repeat(12001) }), sources({ caseId: 'not-a-case' }), sources({ sourceCallId: randomUUID(), transcriptCallId: randomUUID() })]) {
    assert.equal((await api('case/draft', value)).status, 400);
  }
  const type = await api('case/draft', sources(), { 'Content-Type': 'text/plain' });
  assert.equal(type.status, 415);
  const oversized = await fetch(`${base}/agent/api/case/draft`, { method: 'POST', headers: headers({ Origin: SETTINGS.publicOrigin, 'Content-Type': 'application/json' }), body: 'x'.repeat(512 * 1024 + 1) });
  assert.equal(oversized.status, 413);
  assert.deepEqual(modelCalls, []);
});

test('transcription requires actual broker acceptance, call end, participant agreement and the owning agent', async t => {
  const { api, ringing, upload, asrBuffers } = await start(t);
  const id = await ringing();
  assert.equal((await upload(id)).status, 403);
  assert.equal((await api(`calls/${id}/answer`, { sdp: SDP })).status, 200);
  assert.equal((await upload(id)).status, 403);
  assert.equal((await api(`calls/${id}/accept`, {})).status, 200);
  const active = await upload(id);
  assert.equal(active.status, 409);
  assert.equal((await active.json()).error.code, 'TRANSCRIPTION_CALL_ACTIVE');
  assert.equal((await api(`calls/${id}/hangup`, {})).status, 200);
  assert.equal((await upload(id, { agreed: null })).status, 400);
  assert.equal((await upload(id, { extra: { 'X-Agent-ID': FOREIGN_AGENT } })).status, 403);
  assert.equal((await upload(randomUUID())).status, 403);
  assert.equal(asrBuffers.length, 0);
});

test('successful post-call transcription zeroes audio and prevents a second paid transcription for that call', async t => {
  const { acceptedCall, upload, asrBuffers } = await start(t);
  const id = await acceptedCall();
  const result = await upload(id);
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.transcript, TRANSCRIPT);
  assert.equal(body.provenance.kind, 'meta_transcription');
  assert.equal(asrBuffers.length, 1);
  assert.ok(asrBuffers[0].every(byte => byte === 0));
  const replay = await upload(id);
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error.code, 'TRANSCRIPTION_ALREADY_COMPLETE');
  assert.equal(asrBuffers.length, 1);
});

test('failed transcription releases its busy guard for an explicit retry and zeroes audio on both outcomes', async t => {
  const buffers = [];
  const context = await start(t, { transcribe: async audio => {
    buffers.push(audio);
    if (buffers.length === 1) throw new AppError('TRANSCRIPTION_UNAVAILABLE', 'Synthetic temporary transcription failure.');
    return { transcript: TRANSCRIPT, turns: [], audioDurationMs: 1000, provenance: { kind: 'meta_transcription', model: 'muse-voice-transcribe-1.0', generatedAt: '2026-10-27T10:00:00Z' } };
  } });
  const id = await context.acceptedCall();
  const failed = await context.upload(id);
  assert.equal(failed.status, 502);
  assert.ok(buffers[0].every(byte => byte === 0));
  assert.equal((await context.upload(id)).status, 200);
  assert.ok(buffers[1].every(byte => byte === 0));
  assert.equal((await context.upload(id)).status, 409);
  assert.equal(buffers.length, 2);
});

test('transcription rejection exposes only fixed support diagnostics and leaves retry available', async t => {
  const events = [], buffers = [];
  let attempts = 0;
  const context = await start(t, {
    onDiagnostic: event => events.push(event),
    transcribe: async audio => {
      buffers.push(audio); attempts++;
      if (attempts === 1) {
        const error = new AppError('TRANSCRIPTION_REQUEST_REJECTED', 'Meta rejected the transcription upload. Your notes are preserved.');
        error.diagnostic = { stage: 'upstream_http', reason: 'request_rejected', httpStatus: 400, transcript: 'private-speech-sentinel', sessionId: 'private-session-sentinel', accessToken: MODEL_KEY };
        throw error;
      }
      return { transcript: TRANSCRIPT, turns: [], audioDurationMs: 1000, provenance: { kind: 'meta_transcription', model: 'muse-voice-transcribe-1.0', generatedAt: '2026-10-27T10:00:00Z' } };
    },
  });
  const id = await context.acceptedCall();
  const rejected = await context.upload(id);
  assert.equal(rejected.status, 502);
  const body = await rejected.json();
  assert.equal(body.error.code, 'TRANSCRIPTION_REQUEST_REJECTED');
  assert.deepEqual(body.error.diagnostic, { stage: 'upstream_http', reason: 'request_rejected', httpStatus: 400 });
  assert.deepEqual(events, [{ event: 'transcription_failed', code: 'TRANSCRIPTION_REQUEST_REJECTED', stage: 'upstream_http', reason: 'request_rejected', httpStatus: 400 }]);
  assert.ok(!JSON.stringify([body, events]).includes('private-'));
  assert.ok(!JSON.stringify([body, events]).includes(MODEL_KEY));
  assert.ok(buffers[0].every(byte => byte === 0));
  assert.equal((await context.upload(id)).status, 200);
  assert.equal(attempts, 2);
  assert.ok(buffers[1].every(byte => byte === 0));
});

test('model rejection exposes allowlisted support metadata without provider messages or credentials', async t => {
  const events = [];
  const context = await start(t, {
    onDiagnostic: event => events.push(event),
    generate: async () => {
      const error = new AppError('MODEL_BAD_RESPONSE', 'Meta rejected the request. Your sources are preserved.');
      error.diagnostic = { stage: 'upstream_http', reason: 'request_rejected', httpStatus: 402, responseFormat: 'json', providerType: 'billing_error', providerCode: 'billing_not_configured', providerParam: null, message: 'private-provider-sentinel', accessToken: MODEL_KEY };
      throw error;
    },
  });
  const rejected = await context.api('case/draft', sources());
  assert.equal(rejected.status, 502);
  const body = await rejected.json();
  const expected = { stage: 'upstream_http', reason: 'request_rejected', httpStatus: 402, responseFormat: 'json', providerType: 'billing_error', providerCode: 'billing_not_configured' };
  assert.equal(body.error.code, 'MODEL_BAD_RESPONSE');
  assert.deepEqual(body.error.diagnostic, expected);
  assert.deepEqual(events, [{ event: 'model_request_failed', code: 'MODEL_BAD_RESPONSE', ...expected }]);
  assert.ok(!JSON.stringify([body, events]).includes('private-provider-sentinel'));
  assert.ok(!JSON.stringify([body, events]).includes(MODEL_KEY));
});

test('invalid audio, unsupported type and declared oversized audio never reach the transcription provider', async t => {
  const { acceptedCall, upload, base, headers, asrBuffers } = await start(t);
  const id = await acceptedCall();
  assert.equal((await upload(id, { audio: Buffer.from('invalid') })).status, 400);
  assert.equal((await upload(id, { extra: { 'Content-Type': 'audio/mpeg' } })).status, 415);
  const oversized = await new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/agent/api/case/transcribe`, {
      method: 'POST', headers: headers({ Origin: SETTINGS.publicOrigin, 'Content-Type': 'audio/wav', 'X-Call-ID': id, 'X-Participants-Agreed': 'true', 'Content-Length': String(16 * 1024 * 1024 + 1) }),
    }, response => {
      let text = '';
      response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => { resolve({ status: response.statusCode, text }); request.destroy(); });
    });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('The oversized header was not rejected promptly.')));
    request.end();
  });
  assert.equal(oversized.status, 413);
  assert.equal(JSON.parse(oversized.text).error.code, 'TRANSCRIPTION_AUDIO_TOO_LARGE');
  assert.equal(asrBuffers.length, 0);
});

test('another transcription is blocked while one is pending and call-state polling remains responsive', async t => {
  const entered = deferred(), release = deferred();
  const context = await start(t, { transcribe: async audio => {
    entered.resolve(); await release.promise;
    return { transcript: TRANSCRIPT, turns: [], audioDurationMs: 1000, provenance: { kind: 'meta_transcription', model: 'muse-voice-transcribe-1.0', generatedAt: '2026-10-27T10:00:00Z' } };
  } });
  const id = await context.acceptedCall();
  const first = context.upload(id);
  await entered.promise;
  const duplicate = await context.upload(id);
  assert.equal(duplicate.status, 429);
  assert.equal((await context.api('state')).status, 200);
  release.resolve();
  assert.equal((await first).status, 200);
});

test('export receipts reject changed sources, wrong cases, wrong agents and unknown request keys', async t => {
  const context = await start(t);
  const source = sources();
  const generated = await context.generate(source);
  const value = reviewed(source, generated, context.now());
  for (const altered of [
    { ...value, source: { ...value.source, notes: `${NOTES} Changed source.` } },
    { ...value, id: randomUUID() },
    { ...value, provenance: { ...value.provenance, generationId: randomUUID() } },
  ]) {
    const result = await context.api('case/export', { case: altered, format: 'txt' });
    assert.equal(result.status, 409);
    assert.equal((await result.json()).error.code, 'CASE_SOURCE_CHANGED');
  }
  assert.equal((await context.api('case/export', { case: value, format: 'txt' }, { 'X-Agent-ID': FOREIGN_AGENT })).status, 409);
  assert.equal((await context.api('case/export', { case: value, format: 'txt', force: true })).status, 400);
  assert.equal((await context.api('case/export', { case: value, format: 'unsupported' })).status, 400);
  assert.equal(context.exports.length, 0);
  value.source.transport = 'whatsapp';
  value.provenance.model = 'forged-model';
  const valid = await context.api('case/export', { case: value, format: 'txt' });
  assert.equal(valid.status, 200);
  assert.equal(context.exports[0].value.source.transport, 'manual_example');
  assert.equal(context.exports[0].value.provenance.model, 'muse-wonder-1.0');
});

test('generation receipts expire after four hours without silently regenerating or exporting stale cases', async t => {
  const context = await start(t);
  const source = sources();
  const generated = await context.generate(source);
  const value = reviewed(source, generated, context.now());
  context.advance(4 * 60 * 60 * 1000 - 1);
  assert.equal((await context.api('case/export', { case: value, format: 'txt' })).status, 200);
  context.advance(1);
  assert.equal((await context.api('case/export', { case: value, format: 'txt' })).status, 409);
  assert.equal(context.modelCalls.length, 1);
});

test('transcription call proof expires after fifteen minutes while recent accepted-call metadata can still label notes', async t => {
  const context = await start(t);
  const id = await context.acceptedCall();
  context.advance(15 * 60 * 1000);
  const expiredAudio = await context.upload(id);
  assert.equal(expiredAudio.status, 409);
  assert.equal((await expiredAudio.json()).error.code, 'TRANSCRIPTION_EXPIRED');
  const result = await context.generate(sources({ sourceCallId: id }));
  assert.equal(result.source.transport, 'whatsapp');
  assert.equal(context.asrBuffers.length, 0);
  context.advance(4 * 60 * 60 * 1000);
  const expired = await context.api('case/draft', sources({ sourceCallId: id }));
  assert.equal(expired.status, 409);
  assert.equal((await expired.json()).error.code, 'CALL_SOURCE_EXPIRED');
});

test('a caller termination webhook permits post-call transcription without requiring an intervening state poll', async t => {
  const context = await start(t);
  const id = await context.acceptedCall({ end: false });
  assert.equal((await context.webhook('terminate')).status, 200);
  const result = await context.upload(id);
  assert.equal(result.status, 200);
  assert.equal(context.asrBuffers.length, 1);
  assert.ok(context.asrBuffers[0].every(byte => byte === 0));
});

test('a rapid next call cannot hide the previous termination or consume the new ringing call during transcription', async t => {
  const context = await start(t);
  const firstId = await context.acceptedCall({ end: false });
  assert.equal((await context.webhook('terminate')).status, 200);
  assert.equal((await context.webhook('connect', 'synthetic-second-http-graph-call')).status, 200);
  // Intentionally do not poll /state between termination, the second offer and
  // this upload: the old proof must remain valid after broker.current changes.
  const result = await context.upload(firstId);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).transcript, TRANSCRIPT);
  assert.equal(context.asrBuffers.length, 1);
  assert.ok(context.asrBuffers[0].every(byte => byte === 0));
  const state = await (await context.api('state')).json();
  assert.equal(state.call.state, 'ringing');
  assert.notEqual(state.call.id, firstId);
  assert.deepEqual(context.actions.map(value => value.action), ['pre_accept', 'accept']);
});

test('hosted generation has a finite per-minute request limit and becomes available after its window resets', async t => {
  const context = await start(t);
  for (let index = 0; index < 12; index++) await context.generate(sources());
  const limited = await context.api('case/draft', sources());
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, 'GENERATION_RATE_LIMIT');
  assert.equal(context.modelCalls.length, 12);
  context.advance(60000);
  await context.generate(sources());
  assert.equal(context.modelCalls.length, 13);
});

test('ASR provenance requires the original transcript digest and survives human corrections to current text', async t => {
  const context = await start(t);
  const id = await context.acceptedCall();
  const transcription = await (await context.upload(id)).json();
  const source = sources({ transcript: `${TRANSCRIPT} HUMAN CORRECTION: Tuesday was requested instead.`, originalTranscript: transcription.transcript, sourceCallId: id, transcriptCallId: id });
  const generated = await context.generate(source);
  assert.equal(generated.source.transport, 'whatsapp');
  assert.equal(generated.source.sourceKind, 'combined');
  assert.equal(generated.transcriptionProvenance.model, 'muse-voice-transcribe-1.0');
  const value = reviewed(source, generated, context.now());
  value.transcriptionProvenance.model = 'forged-transcription-model';
  const result = await context.api('case/export', { case: value, format: 'txt' });
  assert.equal(result.status, 200);
  const checked = JSON.parse(await result.text());
  assert.equal(checked.transcriptionProvenance.model, 'muse-voice-transcribe-1.0');
  assert.equal(checked.source.transcript, source.transcript);
  assert.equal(checked.source.originalTranscript, TRANSCRIPT);
  assert.ok(!JSON.stringify(checked).includes('synthetic-http-graph-call'));
  const altered = await context.generate({ ...source, caseId: randomUUID(), originalTranscript: 'Unverified replacement original transcript.' });
  assert.equal(altered.transcriptionProvenance, undefined);
});

test('call metadata expiring during generation cannot relabel captured WhatsApp or transcription provenance', async t => {
  const entered = deferred(), release = deferred();
  let generationCalls = 0;
  const context = await start(t, { generate: async () => {
    generationCalls++; entered.resolve(); await release.promise;
    return { draft: { ...DRAFT }, provenance: { kind: 'meta', model: 'muse-wonder-1.0', generatedAt: '2026-10-27T10:00:00Z' } };
  } });
  const id = await context.acceptedCall();
  const transcription = await (await context.upload(id)).json();
  const source = sources({ transcript: transcription.transcript, originalTranscript: transcription.transcript, sourceCallId: id, transcriptCallId: id });
  const pending = context.api('case/draft', source);
  await entered.promise;
  context.advance(4 * 60 * 60 * 1000 + 1);
  // This request sweeps expired metadata while the original model request is
  // still pending. It must not alter that request's validated source snapshot.
  assert.equal((await context.api('case/config')).status, 200);
  release.resolve();
  const response = await pending;
  assert.equal(response.status, 200);
  const generated = await response.json();
  assert.equal(generated.source.transport, 'whatsapp');
  assert.equal(generated.source.sourceKind, 'combined');
  assert.equal(generated.transcriptionProvenance.model, 'muse-voice-transcribe-1.0');
  const value = reviewed(source, generated, context.now());
  assert.equal((await context.api('case/export', { case: value, format: 'txt' })).status, 200);
  assert.equal(context.exports[0].value.source.transport, 'whatsapp');
  assert.equal(context.exports[0].value.transcriptionProvenance.model, 'muse-voice-transcribe-1.0');
  assert.equal((await context.api('case/draft', { ...source, caseId: randomUUID() })).status, 409);
  assert.equal(generationCalls, 1);
});

test('generation is serialized without blocking call polling and unknown provider errors are sanitized', async t => {
  const entered = deferred(), release = deferred();
  let count = 0;
  const context = await start(t, { generate: async () => {
    count++; entered.resolve(); await release.promise;
    throw new Error(MODEL_KEY);
  } });
  const first = context.api('case/draft', sources());
  await entered.promise;
  assert.equal((await context.api('case/draft', sources())).status, 429);
  assert.equal((await context.api('state')).status, 200);
  release.resolve();
  const failed = await first;
  assert.equal(failed.status, 500);
  const text = await failed.text();
  assert.ok(!text.includes(MODEL_KEY));
  assert.equal(count, 1);
});

test('missing model credentials disable only case processing, leaving health and accepted calls available', async t => {
  const context = await start(t, { modelConfig: readConfig({}), transcriptionConfig: readTranscriptionConfig({}) });
  assert.equal((await fetch(`${context.base}/health`)).status, 200);
  const config = await (await context.api('case/config')).json();
  assert.equal(config.apiConfigured, false);
  assert.equal(config.transcriptionConfigured, false);
  assert.equal((await context.api('case/draft', sources())).status, 503);
  const id = await context.acceptedCall();
  assert.equal((await context.upload(id)).status, 503);
  assert.deepEqual(context.actions.map(item => item.action), ['pre_accept', 'accept', 'terminate']);
  assert.equal(context.modelCalls.length, 0);
  assert.equal(context.asrBuffers.length, 0);
});
