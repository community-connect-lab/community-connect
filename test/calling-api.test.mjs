import test from 'node:test';
import assert from 'node:assert/strict';
import { callingEnvironment, readCallingConfig, validateSdp, parseCallingEvents, createCallingClient, safeCallingDiagnostic } from '../lib/calling-api.mjs';

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

test('configuration errors identify the exact setting while preserving the existing validation rules', () => {
  const cases = [
    ['WHATSAPP_ACCESS_TOKEN', undefined], ['WHATSAPP_ACCESS_TOKEN', ''], ['WHATSAPP_ACCESS_TOKEN', 'short'],
    ['AGENT_ACCESS_TOKEN', 'short'], ['AGENT_ACCESS_TOKEN', env.WHATSAPP_ACCESS_TOKEN],
    ['AGENT_ACCESS_TOKEN', env.WHATSAPP_VERIFY_TOKEN], ['AGENT_ACCESS_TOKEN', env.WHATSAPP_APP_SECRET],
    ['WHATSAPP_VERIFY_TOKEN', 'short'], ['WHATSAPP_APP_SECRET', undefined],
    ['WHATSAPP_PHONE_NUMBER_ID', ''], ['WHATSAPP_PHONE_NUMBER_ID', 'invalid-id'],
    ['PORT', '0'], ['PORT', '65536'], ['PORT', 'invalid'],
    ['WHATSAPP_GRAPH_VERSION', 'invalid'], ['CALLING_PUBLIC_ORIGIN', 'http://remote.invalid'],
  ];
  for (const [field, value] of cases) {
    assert.throws(() => readCallingConfig({ ...env, [field]: value }), error => {
      assert.equal(error.code, 'CALLING_CONFIG_ERROR');
      assert.equal(error.status, 503);
      assert.ok(error.message.startsWith(`${field}:`), `${field} must be named`);
      return true;
    });
  }
  assert.equal(readCallingConfig(env).accessToken, env.WHATSAPP_ACCESS_TOKEN);
});

test('actionable configuration diagnostics never include secret values, fragments or malformed URL content', () => {
  const sentinel = 'PRIVATE_SENTINEL_89c4f71e';
  for (const [field, value] of [
    ['WHATSAPP_ACCESS_TOKEN', `${sentinel} with whitespace`],
    ['AGENT_ACCESS_TOKEN', `${sentinel} with whitespace`],
    ['WHATSAPP_VERIFY_TOKEN', `${sentinel}\nprivate-token-extension`],
    ['WHATSAPP_APP_SECRET', `${sentinel}\nprivate-secret-extension`],
    ['CALLING_PUBLIC_ORIGIN', `https://${sentinel}:private-password@gateway.invalid/private-path?private-query=yes`],
    ['WHATSAPP_PHONE_NUMBER_ID', sentinel], ['WHATSAPP_GRAPH_VERSION', sentinel],
  ]) {
    assert.throws(() => readCallingConfig({ ...env, [field]: value }), error => {
      const serialized = JSON.stringify({ message: error.message, ...error });
      assert.ok(serialized.includes(field));
      for (const privateValue of [sentinel, 'private-password', 'private-path', 'private-query', env.WHATSAPP_ACCESS_TOKEN, env.AGENT_ACCESS_TOKEN]) assert.ok(!serialized.includes(privateValue));
      return true;
    });
  }
  const selected = callingEnvironment({ WHATSAPP_ACCESS_TOKEN: '' }, env);
  assert.throws(() => readCallingConfig(selected), error => error.message.startsWith('WHATSAPP_ACCESS_TOKEN:'));
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
  for (const [response, expectedCode] of [[Response.json({ error: { message: env.WHATSAPP_ACCESS_TOKEN } }, { status: 400 }), 'CALL_API_REJECTED'], [new Response('invalid'), 'CALL_ACTION_UNCONFIRMED'], [Response.json({ success: false }), 'CALL_ACTION_UNCONFIRMED'], [new Response('x'.repeat(65537)), 'CALL_ACTION_UNCONFIRMED']]) {
    let requests = 0;
    const client = createCallingClient(config, { fetchImpl: async () => { requests++; return response; } });
    await assert.rejects(client('accept', { callId: 'synthetic-call', sdp }), error => error.code === expectedCode && !error.message.includes(env.WHATSAPP_ACCESS_TOKEN));
    assert.equal(requests, 1);
  }
  const network = createCallingClient(config, { fetchImpl: async () => { throw new Error(env.WHATSAPP_ACCESS_TOKEN); } });
  await assert.rejects(network('reject', { callId: 'synthetic-call' }), { code: 'CALL_API_NETWORK' });
  const auth = createCallingClient(config, { fetchImpl: async () => Response.json({ error: { code: 190, message: env.WHATSAPP_ACCESS_TOKEN } }, { status: 401 }) });
  await assert.rejects(auth('reject', { callId: 'synthetic-call' }), { code: 'CALL_API_AUTH', status: 502 });
});

test('Graph request deadline aborts a stalled response without retrying mutations', async () => {
  let requests = 0;
  const client = createCallingClient(config, { timeoutMs: 10, fetchImpl: async (_url, { signal }) => {
    requests++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('synthetic timeout')), { once: true }));
  } });
  await assert.rejects(client('reject', { callId: 'synthetic-call' }), { code: 'CALL_API_TIMEOUT' });
  assert.equal(requests, 1);
});

test('Meta permission failures retain only the action and safe numeric diagnostics', async () => {
  for (const metaCode of [10, 200]) {
    const client = createCallingClient(config, { fetchImpl: async () => Response.json({ error: { code: metaCode, error_subcode: 123456, message: env.WHATSAPP_ACCESS_TOKEN, error_data: { details: sdp }, fbtrace_id: 'private-trace' } }, { status: 403 }) });
    await assert.rejects(client('pre_accept', { callId: 'synthetic-call', sdp }), error => {
      assert.equal(error.code, 'CALL_API_PERMISSION');
      assert.deepEqual(error.diagnostic, { action: 'pre_accept', httpStatus: 403, metaCode, metaSubcode: 123456 });
      const serialized = JSON.stringify(error);
      for (const value of [env.WHATSAPP_ACCESS_TOKEN, sdp, 'synthetic-call', 'private-trace']) assert.ok(!serialized.includes(value));
      return true;
    });
  }
});

test('numeric diagnostic sanitizer rejects strings, out-of-range values, inherited fields, accessors and extras', () => {
  let getterRead = false;
  const candidate = Object.assign(Object.create({ action: 'accept' }), { httpStatus: '403', metaCode: -1, metaSubcode: 1000000000, token: env.WHATSAPP_ACCESS_TOKEN, message: sdp });
  assert.deepEqual(safeCallingDiagnostic(candidate), {});
  Object.defineProperty(candidate, 'metaCode', { get() { getterRead = true; return 10; } });
  assert.deepEqual(safeCallingDiagnostic(candidate), {});
  assert.equal(getterRead, false);
  assert.deepEqual(safeCallingDiagnostic({ action: 'terminate', httpStatus: 403, metaCode: 200, metaSubcode: 1.5, raw: sdp }), { action: 'terminate', httpStatus: 403, metaCode: 200 });
});
