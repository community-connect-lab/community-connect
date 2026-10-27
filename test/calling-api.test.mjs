import test from 'node:test';
import assert from 'node:assert/strict';
import { callingEnvironment, readCallingConfig, validateSdp, parseCallingEvents, createCallingClient } from '../lib/calling-api.mjs';

const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n';
const env = { WHATSAPP_VERIFY_TOKEN: 'synthetic-verification-secret-123456789', WHATSAPP_APP_SECRET: 'synthetic-app-secret-123456789', WHATSAPP_PHONE_NUMBER_ID: '123456789', WHATSAPP_ACCESS_TOKEN: 'synthetic-graph-token-123456789', AGENT_ACCESS_TOKEN: 'synthetic-agent-access-token-123456789', CALLING_PUBLIC_ORIGIN: 'http://127.0.0.1:10000' };
const config = readCallingConfig(env);
const event = (call = {}) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'calls', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: env.WHATSAPP_PHONE_NUMBER_ID }, contacts: [{ name: 'synthetic-private-contact' }], calls: [{ id: 'synthetic-call', event: 'connect', timestamp: String(Math.floor(Date.now() / 1000)), session: { sdp_type: 'offer', sdp }, ...call }] } }] }] });

test('Calling config requires distinct secrets, exact origin and phone filter; isolates the model configuration', () => {
  const result = callingEnvironment({}, { ...env, MODEL_API_KEY: 'private-model-sentinel', PORT: '3000', CALLING_PORT: '10001' });
  assert.equal(result.MODEL_API_KEY, undefined);
  assert.equal(result.PORT, '10001');
  assert.equal(callingEnvironment({ PORT: '10002' }, { CALLING_PORT: '10001' }).PORT, '10002');
  assert.equal(config.graphVersion, 'v26.0');
  for (const changed of [
    { WHATSAPP_PHONE_NUMBER_ID: '' }, { WHATSAPP_ACCESS_TOKEN: 'replace_with_your_token' },
    { AGENT_ACCESS_TOKEN: env.WHATSAPP_ACCESS_TOKEN }, { AGENT_ACCESS_TOKEN: env.WHATSAPP_VERIFY_TOKEN },
    { CALLING_PUBLIC_ORIGIN: 'http://remote.invalid' }, { CALLING_PUBLIC_ORIGIN: 'https://gateway.invalid/agent' },
    { CALLING_PUBLIC_ORIGIN: 'https://user:secret@gateway.invalid' }, { WHATSAPP_GRAPH_VERSION: 'v26.0/other' },
  ]) assert.throws(() => readCallingConfig({ ...env, ...changed }), { code: 'CALLING_CONFIG_ERROR' });
});

test('accepts one audio session; rejects multiple tracks/media, no audio, oversized and nul content', () => {
  assert.equal(validateSdp(sdp), sdp);
  for (const invalid of [null, 'private-text', sdp + 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n', sdp + 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n', sdp.replace('m=audio 9', 'm=audio 0'), sdp + '\0', sdp + 'x'.repeat(65536)]) {
    assert.throws(() => validateSdp(invalid), { code: 'INVALID_AUDIO_SESSION' });
  }
});

test('inbound parser supports connect without direction/phone contacts and emits only needed session data', () => {
  const input = event();
  const result = parseCallingEvents(input, config.phoneNumberId);
  assert.deepEqual(result, [{ kind: 'connect', callId: 'synthetic-call', offerSdp: sdp }]);
  assert.ok(!JSON.stringify(result).includes('synthetic-private-contact'));
  assert.deepEqual(parseCallingEvents(event({ event: 'terminate', session: undefined, status: ['Failed', 'Completed'] }), config.phoneNumberId), [{ kind: 'terminate', callId: 'synthetic-call' }]);
  assert.deepEqual(parseCallingEvents(input, '987654321'), []);
  assert.deepEqual(parseCallingEvents(event({ direction: 'BUSINESS_INITIATED' }), config.phoneNumberId), []);
  assert.deepEqual(parseCallingEvents(event({ session: { sdp_type: 'answer', sdp } }), config.phoneNumberId), []);
});

test('expired, future and undated connect retries cannot ring after restart; old termination still cleans up', () => {
  for (const timestamp of [undefined, '0', String(Math.floor(Date.now() / 1000) - 120), String(Math.floor(Date.now() / 1000) + 120)]) {
    assert.deepEqual(parseCallingEvents(event({ timestamp }), config.phoneNumberId), []);
  }
  assert.deepEqual(parseCallingEvents(event({ event: 'terminate', timestamp: '0' }), config.phoneNumberId), [{ kind: 'terminate', callId: 'synthetic-call' }]);
});

test('Graph client uses verified inbound action shapes and fixed host; only accept actions carry SDP', async () => {
  const requests = [];
  const client = createCallingClient(config, { fetchImpl: async (url, options) => { requests.push({ url, ...options, json: JSON.parse(options.body) }); return Response.json({ success: true }); } });
  for (const action of ['pre_accept', 'accept', 'reject', 'terminate']) await client(action, { callId: 'synthetic-call', sdp });
  for (const request of requests) {
    assert.equal(request.url, 'https://graph.facebook.com/v26.0/123456789/calls');
    assert.equal(request.headers.Authorization, `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`);
    assert.equal(request.redirect, 'error');
    assert.equal(request.json.messaging_product, 'whatsapp');
    assert.equal(request.json.call_id, 'synthetic-call');
    if (['pre_accept', 'accept'].includes(request.json.action)) assert.deepEqual(request.json.session, { sdp_type: 'answer', sdp });
    else assert.equal(request.json.session, undefined);
    assert.equal(request.json.to, undefined);
  }
});

test('unknown/ambiguous/oversized/network errors are sanitized and never cause automatic retries', async () => {
  for (const response of [Response.json({ error: { message: env.WHATSAPP_ACCESS_TOKEN } }, { status: 400 }), new Response('invalid'), Response.json({ success: false }), new Response('x'.repeat(65537))]) {
    let requests = 0;
    const client = createCallingClient(config, { fetchImpl: async () => { requests++; return response; } });
    await assert.rejects(client('accept', { callId: 'synthetic-call', sdp }), error => error.code === 'CALL_ACTION_UNCONFIRMED' && !error.message.includes(env.WHATSAPP_ACCESS_TOKEN));
    assert.equal(requests, 1);
  }
  const network = createCallingClient(config, { fetchImpl: async () => { throw new Error(env.WHATSAPP_ACCESS_TOKEN); } });
  await assert.rejects(network('reject', { callId: 'synthetic-call' }), { code: 'CALL_ACTION_UNCONFIRMED' });
  const auth = createCallingClient(config, { fetchImpl: async () => Response.json({ error: { code: 190, message: env.WHATSAPP_ACCESS_TOKEN } }, { status: 401 }) });
  await assert.rejects(auth('reject', { callId: 'synthetic-call' }), { code: 'CALL_API_AUTH', status: 502 });
});

test('Graph request deadline aborts a stalled response without retrying mutations', async () => {
  let requests = 0;
  const client = createCallingClient(config, { timeoutMs: 10, fetchImpl: async (_url, { signal }) => {
    requests++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('synthetic timeout')), { once: true }));
  } });
  await assert.rejects(client('reject', { callId: 'synthetic-call' }), { code: 'CALL_ACTION_UNCONFIRMED' });
  assert.equal(requests, 1);
});
