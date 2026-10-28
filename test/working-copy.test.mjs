import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_WORKING_COPY_BYTES, serializeWorkingCopy, parseWorkingCopy } from '../public/agent/working-copy.mjs';

const savedAt = '2026-10-28T10:00:00.000Z';
const sources = () => ({ notes: 'SYNTHETIC: Thursday requested; no change confirmed.', transcript: 'The caller said Tuesday.' });
const document = () => JSON.parse(serializeWorkingCopy(sources(), savedAt));
const safeFailure = callback => assert.throws(callback, error => {
  assert.ok(error instanceof Error);
  assert.ok([
    'Choose a valid Community Connect working-copy JSON file.',
    'Working copies need notes or a transcript within the supported text limits.',
    'Working-copy files must be 512 KiB or smaller.',
  ].includes(error.message));
  assert.ok(!error.message.includes('PRIVATE_SENTINEL'));
  return true;
});

test('working copies round-trip notes-only, transcript-only and combined Unicode sources exactly', () => {
  for (const original of [
    { notes: '  José\trequested Thursday.\r\nNot confirmed.\n', transcript: '' },
    { notes: '', transcript: '  Ελληνικά / Привет / 東京 / 😀\nA\rB\tC  ' },
    sources(),
  ]) {
    const frozen = Object.freeze({ ...original });
    const text = serializeWorkingCopy(frozen, savedAt);
    assert.ok(text.endsWith('\n'));
    assert.ok(text.includes('\n  "app":'));
    assert.deepEqual(parseWorkingCopy(text), original);
    assert.deepEqual(frozen, original);
    const parsed = JSON.parse(text);
    assert.equal(parsed.app, 'Community Connect');
    assert.equal(parsed.format, 'source-working-copy');
    assert.equal(parsed.version, 1);
    assert.equal(parsed.synthetic, true);
    assert.equal(parsed.savedAt, savedAt);
    assert.deepEqual(Object.keys(parseWorkingCopy(text)), ['notes', 'transcript']);
  }
});

test('serializing selects only source text and never invokes extra getters or toJSON hooks', () => {
  const input = {
    ...sources(), draft: { enquiry: 'PRIVATE_SENTINEL_DRAFT' }, review: { status: 'reviewed' },
    MODEL_API_KEY: 'PRIVATE_SENTINEL_KEY', agentToken: 'PRIVATE_SENTINEL_TOKEN',
    sourceCallId: 'PRIVATE_SENTINEL_CALL', originalTranscript: 'PRIVATE_SENTINEL_ORIGINAL',
    provenance: { generationId: 'PRIVATE_SENTINEL_RECEIPT' }, audio: 'PRIVATE_SENTINEL_AUDIO',
  };
  for (const key of ['credentials', 'toJSON']) {
    Object.defineProperty(input, key, { enumerable: true, get() { throw new Error('PRIVATE_SENTINEL_GETTER'); } });
  }
  const text = serializeWorkingCopy(input, savedAt);
  assert.ok(!text.includes('PRIVATE_SENTINEL'));
  assert.deepEqual(parseWorkingCopy(text), sources());
  assert.deepEqual(Object.keys(JSON.parse(text)), ['app', 'format', 'version', 'synthetic', 'savedAt', 'sources']);
});

test('malformed JSON, non-object roots and non-string input fail without echoing contents', () => {
  for (const text of ['{ "PRIVATE_SENTINEL":', '', 'null', '[]', 'true', '42', '"PRIVATE_SENTINEL"', undefined, {}, new Uint8Array(2)]) {
    safeFailure(() => parseWorkingCopy(text));
  }
});

test('application, working-copy format, version and synthetic marker must match exactly', () => {
  for (const [key, value] of [
    ['app', 'PRIVATE_SENTINEL_OTHER_APP'], ['format', 'reviewed-case'],
    ['version', 2], ['version', '1'], ['synthetic', false], ['synthetic', 'true'],
  ]) {
    const valueToParse = document(); valueToParse[key] = value;
    safeFailure(() => parseWorkingCopy(JSON.stringify(valueToParse)));
  }
  for (const key of Object.keys(document())) {
    const incomplete = document(); delete incomplete[key];
    safeFailure(() => parseWorkingCopy(JSON.stringify(incomplete)));
  }
});

test('unknown root and source fields reject credentials, review, call proof and prototype tampering', () => {
  for (const key of ['review', 'draft', 'credentials', 'MODEL_API_KEY', 'provenance', 'sourceCallId', '__proto__', 'constructor', 'prototype']) {
    const value = document();
    Object.defineProperty(value, key, { value: { value: 'PRIVATE_SENTINEL' }, enumerable: true });
    safeFailure(() => parseWorkingCopy(JSON.stringify(value)));
    const nested = document();
    Object.defineProperty(nested.sources, key, { value: 'PRIVATE_SENTINEL', enumerable: true });
    safeFailure(() => parseWorkingCopy(JSON.stringify(nested)));
  }
  assert.equal(Object.prototype.value, undefined);
  for (const sourceValue of [null, [], 'PRIVATE_SENTINEL', { notes: 'Notes only' }, { transcript: 'Transcript only' }]) {
    const value = document(); value.sources = sourceValue;
    safeFailure(() => parseWorkingCopy(JSON.stringify(value)));
  }
});

test('source limits count UTF-16 characters consistently with the existing editor', () => {
  const boundary = { notes: '😀'.repeat(6000), transcript: 'é'.repeat(36000) };
  assert.deepEqual(parseWorkingCopy(serializeWorkingCopy(boundary, savedAt)), boundary);
  for (const invalid of [
    { notes: 'x'.repeat(12001), transcript: '' },
    { notes: '', transcript: 'x'.repeat(36001) },
    { notes: ' \t\r\n', transcript: '\n\t ' },
    { notes: 123, transcript: 'PRIVATE_SENTINEL' },
    { notes: 'PRIVATE_SENTINEL', transcript: null },
  ]) {
    safeFailure(() => serializeWorkingCopy(invalid, savedAt));
    const value = document(); value.sources = invalid;
    safeFailure(() => parseWorkingCopy(JSON.stringify(value)));
  }
});

test('forbidden controls, XML noncharacters and unpaired surrogates are rejected in either source', () => {
  for (const text of ['\u0000', '\u0008', '\u000B', '\u000C', '\u001B', '\u001F', '\u007F', '\u0085', '\u009F', '\uFFFE', '\uFFFF', '\uD800', '\uDC00', '\uD800A', 'A\uDC00', '\uD800\uD800']) {
    for (const key of ['notes', 'transcript']) {
      const invalid = { ...sources(), [key]: 'PRIVATE_SENTINEL' + text };
      safeFailure(() => serializeWorkingCopy(invalid, savedAt));
      const value = document(); value.sources = invalid;
      safeFailure(() => parseWorkingCopy(JSON.stringify(value)));
    }
  }
});

test('timestamps accept real ISO instants and reject calendar normalization or malformed offsets', () => {
  for (const time of ['2026-10-28T10:00:00Z', '2024-02-29T10:00:00.12Z', '2026-10-28T11:00:00+01:00']) {
    const text = serializeWorkingCopy(sources(), time);
    assert.equal(JSON.parse(text).savedAt, new Date(time).toISOString());
    const value = document(); value.savedAt = time;
    assert.deepEqual(parseWorkingCopy(JSON.stringify(value)), sources());
  }
  for (const time of [
    'PRIVATE_SENTINEL', null, 123, '2026-02-30T10:00:00Z', '2026-02-29T10:00:00Z',
    '2026-00-01T10:00:00Z', '2026-13-01T10:00:00Z', '2026-10-00T10:00:00Z',
    '2026-10-28T24:00:00Z', '2026-10-28T10:60:00Z', '2026-10-28T10:00:60Z',
    '2026-10-28', '2026-10-28T10:00:00', '2026-10-28T10:00:00.1234Z',
    '2026-10-28T10:00:00+24:00', '2026-10-28T10:00:00+01:60',
  ]) {
    safeFailure(() => serializeWorkingCopy(sources(), time));
    const value = document(); value.savedAt = time;
    safeFailure(() => parseWorkingCopy(JSON.stringify(value)));
  }
});

test('file size limit includes UTF-8 bytes and whitespace before parsing JSON', () => {
  assert.equal(MAX_WORKING_COPY_BYTES, 512 * 1024);
  const text = serializeWorkingCopy(sources(), savedAt);
  const atLimit = text + ' '.repeat(MAX_WORKING_COPY_BYTES - new TextEncoder().encode(text).byteLength);
  assert.deepEqual(parseWorkingCopy(atLimit), sources());
  safeFailure(() => parseWorkingCopy(atLimit + ' '));
  const unicode = serializeWorkingCopy({ notes: 'é'.repeat(12000), transcript: 'é'.repeat(36000) }, savedAt);
  const byteOverflow = unicode + ' '.repeat(MAX_WORKING_COPY_BYTES - unicode.length);
  assert.equal(byteOverflow.length, MAX_WORKING_COPY_BYTES);
  assert.ok(new TextEncoder().encode(byteOverflow).byteLength > MAX_WORKING_COPY_BYTES);
  safeFailure(() => parseWorkingCopy(byteOverflow));
});

test('invalid serializer objects and accessors cannot expose thrown private values', () => {
  for (const value of [null, undefined, [], 'PRIVATE_SENTINEL', Object.create(sources())]) {
    safeFailure(() => serializeWorkingCopy(value, savedAt));
  }
  const accessor = { transcript: '' };
  Object.defineProperty(accessor, 'notes', { get() { throw new Error('PRIVATE_SENTINEL'); } });
  safeFailure(() => serializeWorkingCopy(accessor, savedAt));
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('PRIVATE_SENTINEL'); } });
  safeFailure(() => serializeWorkingCopy(proxy, savedAt));
});
