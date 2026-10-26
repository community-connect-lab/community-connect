import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { AppError } from '../lib/meta-api.mjs';
import { readConfig, isApiKeyConfigured, META_API_URL } from '../lib/config.mjs';
import { scenario } from '../lib/scenario.mjs';
import { CaseWorkflow } from '../public/workflow.mjs';
import { request as httpRequest } from 'node:http';

const TEST_KEY = 'server-test-only-secret-sentinel';
const config = { apiKey: TEST_KEY, apiUrl: META_API_URL, model: 'muse-wonder-1.0', timeoutMs: 1000 };
async function start(t, options = {}, overrides = {}) {
  const server = createApp({ ...config, ...overrides }, options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (base, body, extra = {}) => fetch(`${base}/api/draft`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...extra,
});

test('bootstrap and allowlisted browser assets never expose backend credentials or files', async t => {
  const base = await start(t);
  const bootstrap = await fetch(`${base}/api/bootstrap`);
  assert.equal(bootstrap.status, 200);
  const body = await bootstrap.json();
  assert.deepEqual(body, { scenario, apiConfigured: true, model: config.model });
  for (const path of ['/', '/styles.css', '/app.mjs', '/workflow.mjs', '/brand-icon.svg']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.ok(!(await response.text()).includes(TEST_KEY), path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  }
  for (const path of ['/.env', '/Community%20Connect.env', '/.env.example', '/.git/config', '/lib/config.mjs', '/server.mjs', '/assets/meta-app-icon.svg', '/assets/meta-app-icon-1024.png', '/../.env', '/%2e%2e%2f.env']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
    assert.ok(!(await response.text()).includes(TEST_KEY));
  }
});

test('real generation is explicit, forwards only notes to backend, and returns labelled provenance', async t => {
  const result = { draft: { enquiry: 'Request', relevantDetails: 'Facts', uncertainties: 'Missing', nextSteps: 'Proposal' }, provenance: { kind: 'meta', label: 'Meta Model API', model: config.model, responseId: 'resp_test', generatedAt: new Date().toISOString() } };
  let calls = 0;
  const base = await start(t, { generate: async (notes, suppliedConfig) => {
    calls++;
    assert.equal(notes, scenario.notes);
    assert.equal(suppliedConfig.apiKey, TEST_KEY);
    return result;
  } });
  const response = await post(base, { notes: scenario.notes, mode: 'meta' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  assert.equal(calls, 1);
});

test('simulation is explicitly selected, source-grounded, labelled, and never calls Meta', async t => {
  const base = await start(t, { generate: () => { throw new Error('Simulation must not call Meta.'); } });
  const notes = 'SYNTHETIC DEMO\nCaller asks for a new collection time.\nNo availability is confirmed.';
  const response = await post(base, { notes, mode: 'simulation' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provenance.kind, 'simulation');
  assert.match(body.provenance.label, /SIMULATION/);
  assert.equal(body.draft.enquiry, 'Caller asks for a new collection time.');
  assert.ok(body.draft.relevantDetails.includes(notes));
  assert.equal(body.provenance.model, undefined);
});

test('missing key does not silently fall back, while explicit simulation remains usable', async t => {
  const base = await start(t, { generate: () => { throw new Error('Must not run.'); } }, { apiKey: '' });
  assert.equal((await (await fetch(`${base}/api/bootstrap`)).json()).apiConfigured, false);
  const response = await post(base, { notes: scenario.notes, mode: 'meta' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'MODEL_NOT_CONFIGURED');
  assert.equal((await post(base, { notes: scenario.notes, mode: 'simulation' })).status, 200);
});

test('bad inputs, oversized input, extra key/config fields and invalid mode are rejected before calling Meta', async t => {
  const base = await start(t, { generate: () => { throw new Error('Validation must run first.'); } });
  for (const body of [null, [], {}, { notes: '', mode: 'meta' }, { notes: ' '.repeat(2), mode: 'meta' }, { notes: 'x'.repeat(12001), mode: 'meta' }, { notes: scenario.notes }, { notes: scenario.notes, mode: 'auto' }, { notes: scenario.notes, mode: 'meta', apiKey: 'do-not-accept-client-credentials' }]) {
    assert.equal((await post(base, body)).status, 400);
  }
  const malformed = await fetch(`${base}/api/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const oversized = await post(base, { notes: 'x'.repeat(70000), mode: 'meta' });
  assert.equal(oversized.status, 413);
  assert.equal((await fetch(`${base}/api/draft`)).status, 405);
  assert.equal((await post(base, {}, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
});

test('browser requests from another origin or a nonlocal Host are rejected', async t => {
  const base = await start(t);
  const body = { notes: scenario.notes, mode: 'meta' };
  const headers = { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' };
  assert.equal((await post(base, body, { headers })).status, 403);
  // Native HTTP preserves the supplied Host; fetch normalizes it to the URL host.
  const hostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/api/bootstrap`, { headers: { Host: 'untrusted.example' } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await post(base, body, { headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

test('safe API errors cross the boundary; unexpected errors never leak their content', async t => {
  let safe = true;
  const base = await start(t, { generate: async () => {
    if (safe) throw new AppError('MODEL_RATE_LIMITED', 'Meta quota reached; edits are preserved.', 503);
    throw new Error(`raw upstream body with ${TEST_KEY}`);
  } });
  const response = await post(base, { notes: scenario.notes, mode: 'meta' });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: 'MODEL_RATE_LIMITED', message: 'Meta quota reached; edits are preserved.' } });
  safe = false;
  const unexpected = await post(base, { notes: scenario.notes, mode: 'meta' });
  assert.equal(unexpected.status, 500);
  const text = await unexpected.text();
  assert.ok(!text.includes(TEST_KEY));
  assert.ok(!text.includes('raw upstream'));
});

test('concurrent real requests cannot accidentally start multiple model calls', async t => {
  let release;
  let started;
  const begin = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const base = await start(t, { generate: async () => { started(); return pending; } });
  const first = post(base, { notes: scenario.notes, mode: 'meta' });
  await begin;
  const second = await post(base, { notes: scenario.notes, mode: 'meta' });
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, 'GENERATION_BUSY');
  release({ draft: {}, provenance: {} });
  assert.equal((await first).status, 200);
});

test('configuration rejects unsafe endpoints and non-synthetic mode; secret placeholders are not configured', () => {
  assert.equal(isApiKeyConfigured(''), false);
  assert.equal(isApiKeyConfigured('replace_with_your_meta_model_api_key'), false);
  assert.equal(isApiKeyConfigured(TEST_KEY), true);
  assert.equal(readConfig({ MODEL_API_KEY: TEST_KEY }).model, 'muse-wonder-1.0');
  assert.equal(readConfig({ MODEL_API_KEY: TEST_KEY }).apiKey, TEST_KEY);
  for (const env of [{ MODEL_API_URL: 'http://localhost:9000' }, { MODEL_API_URL: 'https://evil.example' }, { PORT: 'invalid' }, { MODEL_API_TIMEOUT_MS: '0' }, { DEMO_MODE: 'false' }, { MODEL_API_MODEL: '<invalid>' }]) {
    assert.throws(() => readConfig(env), AppError);
  }
});

test('maximum-length simulation crosses the HTTP/UI boundary and can be reviewed and exported', async t => {
  const base = await start(t);
  const workflow = new CaseWorkflow({ ...scenario, notes: 'x'.repeat(12000) });
  workflow.setMode('simulation');
  const generation = workflow.startGeneration();
  const response = await post(base, { notes: generation.notes, mode: generation.mode });
  assert.equal(response.status, 200);
  assert.equal(workflow.finishGeneration(generation, await response.json()), true);
  assert.equal(workflow.canExport, false);
  workflow.setReviewed(true);
  const exported = workflow.exportCase();
  assert.equal(exported.source.notesUsedForDraft.length, 12000);
  assert.equal(exported.draft.relevantDetails.length, 12000);
  assert.equal(exported.provenance.kind, 'simulation');
});
