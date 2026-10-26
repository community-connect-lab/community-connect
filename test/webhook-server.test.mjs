import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createWebhookServer, webhookEnvironment } from '../webhook-server.mjs';

const config = { verifyToken: 'verification-secret-only-for-unit-tests-123456789', appSecret: 'app-secret-only-for-unit-tests-123456789', phoneNumberId: '123456789', port: 10000 };
const event = () => ({ object: 'whatsapp_business_account', entry: [{ id: 'synthetic_waba', changes: [{ field: 'calls', value: { metadata: { phone_number_id: config.phoneNumberId }, calls: [{ id: 'synthetic-call', from: 'synthetic-caller', session: { sdp: 'synthetic-session' } }] } }] }] });
const signature = body => `sha256=${createHmac('sha256', config.appSecret).update(body).digest('hex')}`;
async function start(t, options = {}) {
  const server = createWebhookServer(config, options);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
function post(base, body, suppliedSignature = signature(body), contentType = 'application/json') {
  return fetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': contentType, 'X-Hub-Signature-256': suppliedSignature }, body });
}

test('Meta challenge returns exact text; bad mode/token and duplicate query parameters fail safely', async t => {
  const base = await start(t);
  const query = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': config.verifyToken, 'hub.challenge': '987654321' });
  const success = await fetch(`${base}/webhooks/whatsapp?${query}`);
  assert.equal(success.status, 200);
  assert.equal(await success.text(), '987654321');
  assert.match(success.headers.get('content-type'), /text\/plain/);
  for (const altered of [new URLSearchParams({ ...Object.fromEntries(query), 'hub.verify_token': 'wrong' }), new URLSearchParams({ ...Object.fromEntries(query), 'hub.mode': 'wrong' }), new URLSearchParams(`${query}&hub.verify_token=other`)]) {
    const response = await fetch(`${base}/webhooks/whatsapp?${altered}`);
    assert.ok(response.status >= 400);
    const text = await response.text();
    assert.ok(!text.includes(config.verifyToken));
    assert.ok(!text.includes(config.appSecret));
  }
});

test('valid raw-body signature acknowledges events and exposes only fixed counts to the handler', async t => {
  const summaries = [];
  const base = await start(t, { onEvent: summary => summaries.push(summary) });
  const body = JSON.stringify(event());
  const response = await post(base, body);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true });
  assert.deepEqual(summaries, [{ entries: 1, changes: 1, calls: 1, messages: 0, ignoredChanges: 0 }]);
  assert.ok(!JSON.stringify(summaries).includes('synthetic-caller'));
  assert.ok(!JSON.stringify(summaries).includes('synthetic-session'));
});

test('missing, malformed or mismatched signatures fail before parsing/processing', async t => {
  let invoked = false;
  const base = await start(t, { onEvent: () => { invoked = true; } });
  const body = JSON.stringify(event());
  for (const supplied of ['', 'bad', 'sha256=abcd', signature(body + ' ')]) assert.equal((await post(base, body, supplied)).status, 403);
  assert.equal(invoked, false);
});

test('signed malformed JSON, oversized bodies, unsupported methods/content types and routes are rejected', async t => {
  const base = await start(t);
  assert.equal((await post(base, '{')).status, 400);
  assert.equal((await post(base, 'x'.repeat(1024 * 1024 + 1))).status, 413);
  assert.equal((await post(base, JSON.stringify(event()), undefined, 'text/plain')).status, 415);
  assert.equal((await fetch(`${base}/webhooks/whatsapp`, { method: 'DELETE' })).status, 405);
  for (const path of ['/', '/.env', '/server.mjs', '/api/bootstrap', '/api/draft', '/app.mjs']) assert.equal((await fetch(base + path)).status, 404);
});

test('health contains no secrets or case data; unexpected handler failure is sanitized', async t => {
  const base = await start(t, { onEvent: () => { throw new Error(config.appSecret); } });
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', service: 'community-connect-webhook', callHandling: 'not_implemented' });
  const failed = await post(base, JSON.stringify(event()));
  assert.equal(failed.status, 500);
  const text = await failed.text();
  assert.ok(!text.includes(config.appSecret));
  assert.ok(!text.includes(config.verifyToken));
});

test('webhook environment isolates model/Graph secrets and local notes port while honoring Render PORT', () => {
  const local = { PORT: '3000', WEBHOOK_PORT: '10001', MODEL_API_KEY: 'model-secret-sentinel', WHATSAPP_ACCESS_TOKEN: 'graph-secret-sentinel', WHATSAPP_VERIFY_TOKEN: config.verifyToken, WHATSAPP_APP_SECRET: config.appSecret };
  const result = webhookEnvironment({}, local);
  assert.equal(result.PORT, '10001');
  assert.equal(result.MODEL_API_KEY, undefined);
  assert.equal(result.WHATSAPP_ACCESS_TOKEN, undefined);
  assert.equal(webhookEnvironment({ PORT: '10000' }, local).PORT, '10000');
  assert.equal(webhookEnvironment({}, { PORT: '3000' }).PORT, '10000');
});
