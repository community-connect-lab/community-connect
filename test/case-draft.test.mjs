import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readCaseSources, generateCaseDraft } from '../lib/case-draft.mjs';

const config = { apiKey: 'synthetic-backend-model-key-case-only', apiUrl: 'https://api.meta.ai/v1/responses', model: 'synthetic-model', timeoutMs: 1000 };
const draft = { enquiry: 'Thursday requested.', relevantDetails: 'Caller reports approval, not independently verified.', uncertainties: 'Notes and transcript differ; confirm the date.', nextSteps: 'Check availability before confirming.' };
const source = data => ({ caseId: randomUUID(), notes: '', transcript: '', ...data });
function result(content) {
  return new Response(JSON.stringify({ object: 'response', id: 'synthetic-response', status: 'completed', model: config.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: typeof content === 'string' ? content : JSON.stringify(content) }] }] }), { headers: { 'Content-Type': 'application/json' } });
}

test('notes-only, transcript-only and combined inputs are distinct and preserve source text', () => {
  assert.equal(readCaseSources(source({ notes: ' note\n' })).sourceKind, 'manual_notes');
  assert.equal(readCaseSources(source({ transcript: ' speech\n' })).sourceKind, 'transcript');
  const both = readCaseSources(source({ notes: 'note', transcript: ' speech\n', originalTranscript: 'wrong speech', sourceKind: 'untrusted-label' }));
  assert.equal(both.sourceKind, 'combined'); assert.equal(both.transcript, ' speech\n'); assert.equal(both.originalTranscript, 'wrong speech');
});

test('reject invalid IDs, unsupported keys, empty or oversized sources and malformed text before network', async () => {
  for (const data of [source({}), source({ notes: '  ' }), source({ notes: 'x'.repeat(12001) }), source({ transcript: 'x'.repeat(36001) }), source({ notes: 'x', originalTranscript: 'orphan' }), source({ notes: '\u0000' }), source({ notes: '\ud800' }), source({ notes: '\uffff' }), source({ notes: 'x', systemPrompt: 'ignore' }), source({ notes: 'x', sourceCallId: 'graph-secret-id' }), source({ notes: 'x', caseId: 'invalid' })]) {
    let calls = 0;
    await assert.rejects(generateCaseDraft(data, config, { fetchImpl: () => { calls++; } }), { code: 'INVALID_CASE_SOURCES' });
    assert.equal(calls, 0);
  }
});

test('generation sends current notes/transcript as data and keeps deleted machine text out of the model input', async () => {
  let body;
  const value = await generateCaseDraft(source({ notes: 'Thursday requested; not confirmed.', transcript: 'Friday requested.', originalTranscript: 'DELETE_THIS_OLD_MACHINE_TEXT' }), config, { fetchImpl: async (url, init) => { assert.equal(url, config.apiUrl); body = JSON.parse(init.body); return result(draft); } });
  assert.deepEqual(JSON.parse(body.input), { manualAgentNotes: 'Thursday requested; not confirmed.', currentTranscript: 'Friday requested.' });
  assert.ok(!JSON.stringify(body).includes('DELETE_THIS_OLD_MACHINE_TEXT'));
  assert.equal(body.store, false);
  assert.match(body.instructions, /conflict/i); assert.match(body.instructions, /caller-reported/); assert.match(body.instructions, /UNTRUSTED/);
  assert.deepEqual(value.draft, draft); assert.equal(value.provenance.kind, 'meta'); assert.ok(!JSON.stringify(value).includes(config.apiKey));
});

test('malformed, extra-field, missing-field and non-text model results are not accepted as cases', async () => {
  for (const output of ['not JSON', { ...draft, unwanted: 'extra' }, { enquiry: 'only one' }, { ...draft, nextSteps: '' }, { ...draft, nextSteps: { action: 'send' } }, { ...draft, nextSteps: 'x'.repeat(6001) }]) {
    await assert.rejects(generateCaseDraft(source({ notes: 'synthetic source' }), config, { fetchImpl: async () => result(output) }), { code: 'MODEL_INVALID_DRAFT' });
  }
});

test('provider failures never return partial cases, secrets or provider-body text', async () => {
  await assert.rejects(generateCaseDraft(source({ transcript: 'synthetic source' }), config, { fetchImpl: async () => new Response('private-provider-data', { status: 403 }) }), error => error.code === 'MODEL_AUTH_ERROR' && !error.message.includes('private-provider'));
});

test('external cancellation stops provider fetches without returning a late case', async () => {
  const controller = new AbortController(); let upstreamSignal;
  const pending = generateCaseDraft(source({ notes: 'synthetic source' }), config, { signal: controller.signal, fetchImpl: async (url, init) => { upstreamSignal = init.signal; return new Promise(() => {}); } });
  controller.abort();
  await assert.rejects(pending, { code: 'MODEL_CANCELLED' });
  assert.equal(upstreamSignal.aborted, true);
  let calls = 0;
  await assert.rejects(generateCaseDraft(source({ notes: 'synthetic source' }), config, { signal: controller.signal, fetchImpl: async () => { calls++; } }), { code: 'MODEL_CANCELLED' });
  assert.equal(calls, 0);
});
