import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, generateDraft, requestModelText, safeModelDiagnostic } from '../lib/meta-api.mjs';

// Deliberately fake test-only sentinel; no real credential is used by these tests.
const SENTINEL_KEY = 'unit-test-private-key-sentinel';
const config = { apiKey: SENTINEL_KEY, apiUrl: 'https://api.meta.ai/v1/responses', model: 'muse-wonder-1.0', timeoutMs: 1000 };
const request = { input: 'SYNTHETIC: reply OK.', instructions: 'Return OK.', maxOutputTokens: 128 };
const draft = {
  enquiry: 'Caller asks to change a food parcel collection time.',
  relevantDetails: 'The agent says availability needs to be checked.',
  uncertainties: 'No new collection time is confirmed.',
  nextSteps: 'A human agent could check available collection times.',
};
function envelope(text = 'OK', extra = {}) {
  return {
    id: 'resp_synthetic_test', object: 'response', status: 'completed', model: config.model,
    output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }],
    ...extra,
  };
}
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}
const fakeFetch = (payload, status) => async () => jsonResponse(payload, status);
async function rejectsSafely(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    assert.ok(!error.message.includes(SENTINEL_KEY));
    assert.ok(!JSON.stringify(error).includes(SENTINEL_KEY));
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('request uses configured Meta endpoint, backend bearer credential, no storage or tools', async () => {
  let call;
  const result = await requestModelText(config, request, { fetchImpl: async (url, options) => {
    call = { url, options };
    return jsonResponse(envelope());
  } });
  assert.deepEqual(result, { text: 'OK', model: config.model, responseId: 'resp_synthetic_test' });
  assert.equal(call.url, config.apiUrl);
  assert.equal(call.options.headers.Authorization, `Bearer ${SENTINEL_KEY}`);
  assert.equal(call.options.redirect, 'error');
  const body = JSON.parse(call.options.body);
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
  assert.equal(body.model, config.model);
  assert.equal(body.max_output_tokens, 128);
  assert.equal(body.tools, undefined);
  assert.ok(!JSON.stringify(result).includes(SENTINEL_KEY));
});

test('parser reads all assistant output_text blocks, skipping leading reasoning and non-assistant messages', async () => {
  const payload = envelope('', { output: [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Must not appear.' }] },
    { type: 'message', role: 'user', content: [{ type: 'output_text', text: 'Ignore.' }] },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'O' }, { type: 'output_text', text: 'K' }] },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '!' }] },
  ] });
  assert.equal((await requestModelText(config, request, { fetchImpl: fakeFetch(payload) })).text, 'OK!');
});

test('generates four source-grounded editable fields and records live provenance', async () => {
  let instructions;
  let source;
  const result = await generateDraft('SYNTHETIC: Collection change requested; nothing confirmed.', config, { fetchImpl: async (_, options) => {
    const body = JSON.parse(options.body);
    instructions = body.instructions;
    source = body.input;
    assert.equal(body.max_output_tokens, 4096);
    return jsonResponse(envelope(JSON.stringify(draft)));
  } });
  assert.deepEqual(result.draft, draft);
  assert.equal(result.provenance.kind, 'meta');
  assert.equal(result.provenance.model, config.model);
  assert.equal(result.provenance.responseId, 'resp_synthetic_test');
  assert.match(result.provenance.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(instructions, /untrusted source data/);
  assert.match(instructions, /Do not invent/);
  assert.match(source, /SYNTHETIC AGENT NOTES/);
});

test('accepts one fenced JSON object but does not scrape JSON out of unrelated prose', async () => {
  const result = await generateDraft('SYNTHETIC notes', config, { fetchImpl: fakeFetch(envelope('```json\n' + JSON.stringify(draft) + '\n```')) });
  assert.deepEqual(result.draft, draft);
  await rejectsSafely(() => generateDraft('SYNTHETIC notes', config, { fetchImpl: fakeFetch(envelope('Some prose ' + JSON.stringify(draft))) }), 'MODEL_INVALID_DRAFT');
});

test('rejects missing, placeholder or invalid configuration before making a request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('Should not call'); };
  for (const apiKey of ['', 'replace_with_your_meta_model_api_key']) {
    await rejectsSafely(() => requestModelText({ ...config, apiKey }, request, { fetchImpl }), 'MODEL_NOT_CONFIGURED');
  }
  for (const apiUrl of ['http://api.meta.ai/v1/responses', 'https://attacker.invalid/v1/responses', 'https://api.meta.ai@attacker.invalid/v1/responses', config.apiUrl + '?secret=x']) {
    await rejectsSafely(() => requestModelText({ ...config, apiUrl }, request, { fetchImpl }), 'MODEL_CONFIG_ERROR');
  }
  assert.equal(calls, 0);
});

test('classifies upstream failures without relaying upstream bodies, headers, or secrets', async () => {
  for (const [status, code] of [[401, 'MODEL_AUTH_ERROR'], [403, 'MODEL_AUTH_ERROR'], [429, 'MODEL_RATE_LIMITED'], [500, 'MODEL_UNAVAILABLE'], [503, 'MODEL_UNAVAILABLE'], [400, 'MODEL_BAD_RESPONSE'], [302, 'MODEL_BAD_RESPONSE']]) {
    await rejectsSafely(() => requestModelText(config, request, { fetchImpl: fakeFetch({ error: SENTINEL_KEY }, status) }), code);
  }
  await rejectsSafely(() => requestModelText(config, request, { fetchImpl: async () => { throw new Error(`network ${SENTINEL_KEY}`); } }), 'MODEL_NETWORK_ERROR');
});

test('model diagnostics copy only exact allowlisted own data values without invoking getters', () => {
  let getterCalls = 0;
  const value = Object.assign(Object.create({ providerCode: 'invalid_api_key' }), {
    stage: 'upstream_http', reason: 'request_rejected', httpStatus: 402, responseFormat: 'json',
    providerType: 'billing_error', providerParam: 'model', message: SENTINEL_KEY, rawBody: SENTINEL_KEY,
  });
  Object.defineProperty(value, 'providerCode', { get() { getterCalls++; return 'billing_not_configured'; } });
  assert.deepEqual(safeModelDiagnostic(value), {
    stage: 'upstream_http', reason: 'request_rejected', responseFormat: 'json', providerType: 'billing_error', providerParam: 'model', httpStatus: 402,
  });
  assert.equal(getterCalls, 0);
  for (const invalid of [null, [], SENTINEL_KEY, { httpStatus: '402', stage: SENTINEL_KEY, responseFormat: 'application/json', providerType: SENTINEL_KEY, providerCode: SENTINEL_KEY, providerParam: 'input.private' }, { httpStatus: 600 }]) {
    assert.deepEqual(safeModelDiagnostic(invalid), {});
  }
});

test('upstream JSON errors preserve HTTP status and exact taxonomy without provider messages', async () => {
  await assert.rejects(() => requestModelText(config, request, { fetchImpl: fakeFetch({
    error: { type: 'billing_error', code: 'billing_not_configured', param: 'model', message: 'PRIVATE_PROVIDER_MESSAGE', request_id: 'PRIVATE_ID' },
  }, 402) }), error => {
    assert.equal(error.code, 'MODEL_BAD_RESPONSE');
    assert.equal(error.status, 502);
    assert.deepEqual(error.diagnostic, {
      stage: 'upstream_http', reason: 'request_rejected', responseFormat: 'json', providerType: 'billing_error', providerCode: 'billing_not_configured', providerParam: 'model', httpStatus: 402,
    });
    assert.ok(!JSON.stringify(error).includes('PRIVATE_'));
    return true;
  });
});

test('unrecognized provider fields and a credential echo cannot enter model diagnostics', async () => {
  for (const payload of [
    { error: { type: SENTINEL_KEY, code: 'private_new_code', param: 'input.private', message: SENTINEL_KEY } },
    { error: { type: 'billing_error', code: 'billing_not_configured', param: 'model', message: SENTINEL_KEY } },
    { error: { type: ['billing_error'], code: { value: 'billing_not_configured' }, param: 123 } },
  ]) {
    await assert.rejects(() => requestModelText(config, request, { fetchImpl: fakeFetch(payload, 400) }), error => {
      assert.deepEqual(error.diagnostic, { stage: 'upstream_http', reason: 'request_rejected', responseFormat: 'json', httpStatus: 400 });
      assert.ok(!JSON.stringify(error).includes(SENTINEL_KEY));
      return true;
    });
  }
});

test('HTML, unknown, malformed and oversized upstream errors retain their original classification', async () => {
  for (const [response, format, status] of [
    [new Response('<html>PRIVATE_PROVIDER_MESSAGE</html>', { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } }), 'html', 400],
    [new Response('PRIVATE_PROVIDER_MESSAGE', { status: 404 }), 'other', 404],
    [new Response('{malformed', { status: 422, headers: { 'Content-Type': 'application/json' } }), 'json', 422],
    [new Response('x', { status: 401, headers: { 'Content-Type': 'application/json', 'Content-Length': '2000000' } }), 'json', 401],
    [new Response('x'.repeat(1048577), { status: 403, headers: { 'Content-Type': 'application/problem+json' } }), 'json', 403],
  ]) {
    await assert.rejects(() => requestModelText(config, request, { fetchImpl: async () => response }), error => {
      assert.equal(error.code, status === 401 || status === 403 ? 'MODEL_AUTH_ERROR' : 'MODEL_BAD_RESPONSE');
      assert.deepEqual(error.diagnostic, { stage: 'upstream_http', reason: 'request_rejected', responseFormat: format, httpStatus: status });
      assert.ok(!JSON.stringify(error).includes('PRIVATE_PROVIDER_MESSAGE'));
      return true;
    });
  }
});

test('timeout and explicit cancellation still cover optional upstream error body reads', async () => {
  for (const cancelRequest of [false, true]) {
    const controller = new AbortController();
    let bodyCancelled = false;
    await rejectsSafely(() => requestModelText({ ...config, timeoutMs: 20 }, request, {
      signal: controller.signal,
      fetchImpl: async () => {
        if (cancelRequest) setTimeout(() => controller.abort(), 5);
        return new Response(new ReadableStream({
          pull: () => new Promise(() => {}),
          cancel() { bodyCancelled = true; },
        }), { status: 402, headers: { 'Content-Type': 'application/json' } });
      },
    }), cancelRequest ? 'MODEL_CANCELLED' : 'MODEL_TIMEOUT');
    assert.equal(bodyCancelled, true);
  }
});

test('times out a stalled request and aborts the network operation', async () => {
  let signal;
  await rejectsSafely(() => requestModelText({ ...config, timeoutMs: 15 }, request, { fetchImpl: async (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } }), 'MODEL_TIMEOUT');
  assert.equal(signal.aborted, true);
});

test('timeout also covers stalled response body reads', async () => {
  let cancelled = false;
  await rejectsSafely(() => requestModelText({ ...config, timeoutMs: 15 }, request, { fetchImpl: async () => new Response(new ReadableStream({
    pull: () => new Promise(() => {}),
    cancel() { cancelled = true; },
  })) }), 'MODEL_TIMEOUT');
  assert.equal(cancelled, true);
});

test('rejects incomplete/failed/queued responses and partial messages', async () => {
  for (const status of ['incomplete', 'failed', 'queued', 'in_progress', 'cancelled', undefined]) {
    await rejectsSafely(() => requestModelText(config, request, { fetchImpl: fakeFetch(envelope('partial', { status })) }), 'MODEL_INCOMPLETE');
  }
  const payload = envelope('partial');
  payload.output[0].status = 'incomplete';
  await rejectsSafely(() => requestModelText(config, request, { fetchImpl: fakeFetch(payload) }), 'MODEL_INCOMPLETE');
});

test('rejects refusals even when they contain other output text', async () => {
  const payload = envelope('partial');
  payload.output[0].content.push({ type: 'refusal', refusal: SENTINEL_KEY });
  await rejectsSafely(() => requestModelText(config, request, { fetchImpl: fakeFetch(payload) }), 'MODEL_BAD_RESPONSE');
  payload.output[0].content[1].refusal = 'Cannot summarize';
  await rejectsSafely(() => requestModelText(config, request, { fetchImpl: fakeFetch(payload) }), 'MODEL_REFUSED');
});

test('rejects malformed JSON envelopes, missing/empty output, and upstream error payloads', async () => {
  await rejectsSafely(() => requestModelText(config, request, { fetchImpl: async () => new Response('not json') }), 'MODEL_BAD_RESPONSE');
  for (const payload of [null, [], {}, envelope('', { output: [] }), envelope('', { output: null }), envelope('   '), envelope('OK', { error: { message: 'failed' } }), envelope('OK', { id: null })]) {
    await rejectsSafely(() => requestModelText(config, request, { fetchImpl: fakeFetch(payload) }), 'MODEL_BAD_RESPONSE');
  }
});

test('rejects malformed, missing, non-string, empty, extra, or oversized draft fields', async () => {
  for (const output of ['not json', JSON.stringify({ enquiry: 'Only one field' }), JSON.stringify({ ...draft, nextSteps: [] }), JSON.stringify({ ...draft, uncertainties: '' }), JSON.stringify({ ...draft, extra: 'unexpected' }), JSON.stringify({ ...draft, enquiry: 'x'.repeat(6001) })]) {
    await rejectsSafely(() => generateDraft('SYNTHETIC notes', config, { fetchImpl: fakeFetch(envelope(output)) }), 'MODEL_INVALID_DRAFT');
  }
});

test('rejects invalid source notes without issuing a model request', async () => {
  for (const notes of ['', '  ', null, 'x'.repeat(12001)]) {
    await rejectsSafely(() => generateDraft(notes, config, { fetchImpl: async () => { throw new Error('must not call'); } }), 'INVALID_NOTES');
  }
});

test('does not expose a key echoed in output text or response metadata', async () => {
  for (const payload of [envelope(SENTINEL_KEY), envelope('OK', { model: SENTINEL_KEY }), envelope('OK', { id: SENTINEL_KEY })]) {
    await rejectsSafely(() => requestModelText(config, request, { fetchImpl: fakeFetch(payload) }), 'MODEL_BAD_RESPONSE');
  }
});

test('rejects oversized responses before attempting to parse them', async () => {
  await rejectsSafely(() => requestModelText(config, request, { fetchImpl: async () => new Response('x', { headers: { 'Content-Length': '2000000' } }) }), 'MODEL_BAD_RESPONSE');
  await rejectsSafely(() => requestModelText(config, request, { fetchImpl: async () => new Response('x'.repeat(1048577)) }), 'MODEL_BAD_RESPONSE');
});

test('bounds streamed bodies with no content-length and cancels before reading the rest', async () => {
  let chunksRead = 0;
  let cancelled = false;
  let requestSignal;
  const body = new ReadableStream({
    pull(stream) {
      chunksRead++;
      // Nine 128 KiB chunks exceed the 1 MiB limit; much more remains available.
      stream.enqueue(new Uint8Array(128 * 1024));
      if (chunksRead === 100) stream.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await rejectsSafely(() => requestModelText(config, request, { fetchImpl: async (_, options) => {
    requestSignal = options.signal;
    const response = new Response(body);
    assert.equal(response.headers.get('content-length'), null);
    // Enforce use of the streaming reader instead of an unbounded convenience method.
    response.text = () => { throw new Error('Unbounded text() must not be called'); };
    return response;
  } }), 'MODEL_BAD_RESPONSE');
  assert.equal(chunksRead, 9);
  assert.equal(cancelled, true);
  assert.equal(requestSignal.aborted, true);
});

test('stream decoder preserves UTF-8 characters split between byte chunks', async () => {
  const source = new TextEncoder().encode(JSON.stringify(envelope('Café ☕')));
  let offset = 0;
  const body = new ReadableStream({
    pull(stream) {
      if (offset === source.length) return stream.close();
      stream.enqueue(source.slice(offset, ++offset));
    },
  });
  const result = await requestModelText(config, request, { fetchImpl: async () => new Response(body) });
  assert.equal(result.text, 'Café ☕');
});
