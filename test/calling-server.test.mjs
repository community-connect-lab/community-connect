import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createCallingServer } from '../calling-server.mjs';

const config = {
  port: 10000, publicOrigin: 'http://127.0.0.1:10000', graphVersion: 'v26.0', phoneNumberId: '123456789',
  verifyToken: 'synthetic-verify-secret-123456789012345', appSecret: 'synthetic-app-secret-123456789',
  accessToken: 'synthetic-graph-secret-123456789', agentAccessToken: 'synthetic-agent-secret-123456789012345',
};
const agent = 'synthetic-agent-123456789';
const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n';
function payload(event = 'connect', phoneId = config.phoneNumberId) {
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'calls', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneId }, contacts: [{ name: 'synthetic-private-contact' }], calls: [{ id: 'synthetic-graph-call', event, timestamp: String(Math.floor(Date.now() / 1000)), ...(event === 'connect' ? { session: { sdp_type: 'offer', sdp } } : {}) }] } }] }] };
}
async function start(t, options = {}) {
  const actions = [];
  const summaries = [];
  const diagnostics = [];
  const server = createCallingServer(config, { sendAction: async (action, data) => { actions.push({ action, ...data }); return { success: true }; }, onSummary: item => summaries.push(item), onDiagnostic: item => diagnostics.push(item), ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await server.callBroker.idle(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(path, body, headers = {}) {
    return fetch(`${base}/agent/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${config.agentAccessToken}`, 'X-Agent-ID': agent, ...(body === undefined ? {} : { Origin: config.publicOrigin, 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function webhook(data, signature) {
    const body = JSON.stringify(data);
    return fetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature ?? `sha256=${createHmac('sha256', config.appSecret).update(body).digest('hex')}` }, body });
  }
  return { server, base, api, webhook, actions, summaries, diagnostics };
}

test('gateway preserves callback verification and health; only explicit public agent assets are served', async t => {
  const { base } = await start(t);
  const query = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': config.verifyToken, 'hub.challenge': '12345' });
  assert.equal(await (await fetch(`${base}/webhooks/whatsapp?${query}`)).text(), '12345');
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.callHandling, 'agent_gateway');
  for (const path of ['/agent', '/agent/styles.css', '/agent/app.mjs']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    const body = await response.text();
    for (const value of [config.accessToken, config.appSecret, config.agentAccessToken, config.verifyToken]) assert.ok(!body.includes(value));
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  for (const path of ['/.env', '/.env.example', '/calling-server.mjs', '/lib/calling-api.mjs', '/api/draft', '/publication-drafts/privacy.html']) assert.equal((await fetch(base + path)).status, 404);
});

test('agent APIs reject missing/incorrect credentials, query tokens, cross-origin mutations and invalid bodies', async t => {
  const { base, api, actions } = await start(t);
  assert.equal((await fetch(`${base}/agent/api/state?token=${config.agentAccessToken}`)).status, 401);
  assert.equal((await api('state', undefined, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await api('ready', { ready: true }, { Origin: 'https://other.invalid' })).status, 403);
  assert.equal((await api('ready', { ready: true }, { Origin: '' })).status, 403);
  assert.equal((await api('ready', { ready: 'true' })).status, 400);
  assert.equal((await api('ready', { ready: true }, { 'X-Agent-ID': 'invalid' })).status, 400);
  const state = await api('state');
  assert.equal(state.status, 200);
  assert.equal(state.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await state.json(), { ready: false, busy: false, call: null });
  assert.deepEqual(actions, []);
});

test('signed inbound offer reaches only the ready owner; human Answer and connected acceptance use separate actions', async t => {
  const { api, webhook, actions, summaries } = await start(t);
  assert.equal((await api('ready', { ready: true })).status, 200);
  assert.equal((await webhook(payload())).status, 200);
  const state = await (await api('state')).json();
  assert.equal(state.call.state, 'ringing');
  assert.ok(!JSON.stringify(state).includes('synthetic-graph-call'));
  assert.ok(!JSON.stringify(state).includes('synthetic-private-contact'));
  assert.ok(!JSON.stringify(state).includes(sdp));
  assert.deepEqual(actions, []);
  assert.deepEqual(await (await api(`calls/${state.call.id}/offer`)).json(), { sdp });
  const other = await (await api('state', undefined, { 'X-Agent-ID': 'another-agent-123456789' })).json();
  assert.equal(other.busy, true);
  assert.equal(other.call, null);
  assert.equal((await api(`calls/${state.call.id}/answer`, { sdp: 'invalid' })).status, 400);
  assert.deepEqual(actions, []);
  assert.equal((await api(`calls/${state.call.id}/accept`, {})).status, 409);
  const answered = await api(`calls/${state.call.id}/answer`, { sdp });
  assert.equal((await answered.json()).call.state, 'connecting');
  assert.deepEqual(actions.map(item => item.action), ['pre_accept']);
  const accepted = await api(`calls/${state.call.id}/accept`, {});
  assert.equal((await accepted.json()).call.state, 'active');
  assert.deepEqual(actions.map(item => item.action), ['pre_accept', 'accept']);
  assert.equal((await api(`calls/${state.call.id}/hangup`, {})).status, 200);
  assert.deepEqual(actions.map(item => item.action), ['pre_accept', 'accept', 'terminate']);
  assert.equal((await (await api('state')).json()).call.state, 'ended');
  assert.deepEqual(summaries, [{ entries: 1, changes: 1, calls: 1, messages: 0, ignoredChanges: 0 }]);
});

test('invalid signatures and wrong-phone events cannot create calls; retries are acknowledged without duplicate ringing', async t => {
  const { api, webhook, server, actions } = await start(t);
  await api('ready', { ready: true });
  assert.equal((await webhook(payload(), 'sha256=' + '0'.repeat(64))).status, 403);
  assert.equal((await webhook(payload('connect', '987654321'))).status, 200);
  assert.equal((await (await api('state')).json()).call, null);
  await webhook(payload());
  const id = (await (await api('state')).json()).call.id;
  await webhook(payload());
  assert.equal((await (await api('state')).json()).call.id, id);
  await webhook(payload('terminate'));
  await webhook(payload());
  assert.equal((await (await api('state')).json()).call.state, 'ended');
  await server.callBroker.idle();
  assert.deepEqual(actions, []);
});

test('webhook acknowledges promptly while a no-agent technical rejection is still pending', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const { webhook, server } = await start(t, { sendAction: async () => waiting });
  const response = await webhook(payload());
  assert.equal(response.status, 200);
  release({ success: true });
  await server.callBroker.idle();
});

test('remote termination during pre-accept returns ended and cannot be resurrected by late provider success', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const { api, webhook } = await start(t, { sendAction: async () => waiting });
  await api('ready', { ready: true });
  await webhook(payload());
  const id = (await (await api('state')).json()).call.id;
  const pending = api(`calls/${id}/answer`, { sdp });
  while ((await (await api('state')).json()).call.state === 'ringing') await new Promise(resolve => setImmediate(resolve));
  await webhook(payload('terminate'));
  release({ success: true });
  assert.equal((await (await pending).json()).call.state, 'ended');
});

test('provider failures expose only generic state and fixed diagnostics, never provider text or tokens', async t => {
  const { api, webhook, diagnostics } = await start(t, { sendAction: async () => { throw new Error(config.accessToken); } });
  await api('ready', { ready: true });
  await webhook(payload());
  const id = (await (await api('state')).json()).call.id;
  const response = await api(`calls/${id}/answer`, { sdp });
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.ok(!body.includes(config.accessToken));
  assert.deepEqual(diagnostics, [{ event: 'calling_action_failed', code: 'CALL_ACTION_UNCONFIRMED' }]);
  assert.equal((await (await api('state')).json()).call.state, 'uncertain');
});
