import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveObjectURL } from 'node:buffer';
import { mountCaseDesk } from '../public/agent/case-desk.mjs';
import { parseWorkingCopy, serializeWorkingCopy } from '../public/agent/working-copy.mjs';

// Exercise the real UI event/render bindings using the page's actual element
// IDs. This adapter does not test browser layout or native download handling.
const html = await readFile(new URL('../public/agent/index.html', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let attempt = 0; attempt < 40 && !predicate(); attempt++) await tick();
  assert.ok(predicate(), 'expected UI state was reached');
}
const savedSources = { notes: 'Fictional José requested Thursday.\nNo change confirmed.', transcript: 'The fictional caller said Tuesday.\tPlease check.' };
const savedFile = () => new File([serializeWorkingCopy(savedSources)], 'synthetic-saved-notes.json', { type: 'application/json' });

class Element {
  constructor(tagName, attributes, owner) {
    this.tagName = tagName.toUpperCase(); this.owner = owner;
    this.isFile = attributes.type === 'file'; this._value = attributes.value ?? '';
    this.checked = 'checked' in attributes; this.disabled = 'disabled' in attributes; this.hidden = 'hidden' in attributes;
    this.textContent = ''; this.dataset = {}; this.files = []; this.listeners = new Map(); this.clicks = 0;
  }
  get value() { return this._value; }
  set value(value) { this._value = value; if (this.isFile && value === '') this.files = []; }
  set innerHTML(_) { throw new Error('Source text must be rendered as text, not HTML.'); }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  emit(name) { return Promise.all((this.listeners.get(name) ?? []).map(listener => listener({ target: this }))); }
  click() {
    if (this.disabled) return false;
    this.clicks++;
    if (this.tagName === 'A') {
      this.owner.downloads.push({ filename: this.download, blob: resolveObjectURL(this.href) });
      return true;
    }
    return this.emit('click');
  }
  remove() { this.owner.appended.delete(this); }
  async select(file) {
    assert.equal(this.isFile, true);
    const selectedPath = `selected/${file.name}`;
    if (this._value === selectedPath) return false;
    this._value = selectedPath; this.files = [file];
    await this.emit('change');
    return true;
  }
}

function fakeDocument() {
  const document = {
    elements: new Map(), downloads: [], appended: new Set(),
    getElementById(id) { return this.elements.get(id) ?? null; },
    createElement(tagName) { return new Element(tagName, {}, this); },
  };
  document.body = { append: element => document.appended.add(element) };
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const attributes = {};
    for (const attribute of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attributes[attribute[1]] = attribute[2] ?? '';
    if (attributes.id) document.elements.set(attributes.id, new Element(match[1], attributes, document));
  }
  return document;
}

function fixture(t) {
  const document = fakeDocument(), requests = [], confirmations = [];
  let confirmReplacement = true, generation = 0;
  const window = {
    listeners: new Map(),
    addEventListener(name, listener) { this.listeners.set(name, listener); },
    confirm(message) { confirmations.push(message); return confirmReplacement; },
  };
  const desk = mountCaseDesk(document, { window, request: async (path, options) => {
    requests.push({ path, options });
    if (path === '/case/config') return { apiConfigured: true, transcriptionConfigured: true, model: 'synthetic-ui-model' };
    if (path === '/case/draft') return {
      draft: { enquiry: 'A fictional collection request.', relevantDetails: 'Thursday was requested.', uncertainties: 'Tuesday conflicts with Thursday.', nextSteps: 'A worker should confirm the day.' },
      provenance: { kind: 'meta', model: 'synthetic-ui-model', generationId: `synthetic-ui-receipt-${++generation}`, generatedAt: '2026-10-28T10:00:00.000Z' },
      source: { transport: 'manual_example' },
    };
    throw new Error('Unexpected request in working-copy UI check.');
  } });
  t.after(() => desk.dispose());
  const get = id => document.getElementById(id);
  return {
    desk, document, get, requests, confirmations,
    set confirmReplacement(value) { confirmReplacement = value; },
    async type(id, text) { get(id).value = text; await get(id).emit('input'); },
    async connect() { desk.setConnectionState({ connected: true, call: null }); await until(() => Boolean(desk.snapshot().config)); },
    async choose(file) {
      await get('load-working-notes').click();
      assert.equal(await get('working-copy-file').select(file), true);
      await until(() => !desk.snapshot().loadingWorkingCopy);
    },
    async generate() {
      const count = requests.filter(item => item.path === '/case/draft').length;
      await get('merge-create').click();
      await until(() => !desk.snapshot().generating && requests.filter(item => item.path === '/case/draft').length === count + 1);
      assert.ok(desk.snapshot().draft);
    },
    async review() { get('case-reviewed').checked = true; await get('case-reviewed').emit('change'); },
  };
}

test('Save to resume UI downloads source-only JSON while retaining the readable TXT backup', async t => {
  const f = fixture(t);
  assert.equal(f.get('save-resumable-notes').disabled, true);
  await f.type('agent-notes', savedSources.notes); await f.type('call-transcript', savedSources.transcript);
  assert.equal(f.get('transcript-origin').textContent, 'Manually entered/pasted test transcript · no automatic transcription');
  assert.equal(f.get('save-resumable-notes').disabled, false);
  await f.get('save-resumable-notes').click();
  assert.equal(f.document.downloads.length, 1);
  const download = f.document.downloads[0];
  assert.match(download.filename, /^community-connect-resumable-notes-.*[.]json$/);
  assert.match(download.blob.type, /^application\/json/);
  assert.deepEqual(parseWorkingCopy(await download.blob.text()), savedSources);
  assert.equal(f.requests.length, 0);
  await f.get('save-working-notes').click();
  assert.equal(f.document.downloads.length, 2);
  assert.match(f.document.downloads[1].filename, /[.]txt$/);
  assert.match(await f.document.downloads[1].blob.text(), /Not a reviewed case/);
});

test('Load saved notes UI replaces an approved draft with unapproved sources and honest transcript labels', async t => {
  const f = fixture(t); await f.connect();
  await f.type('agent-notes', 'Current fictional case before replacement.');
  await f.generate(); await f.review();
  assert.equal(f.get('export-reviewed').disabled, false);
  const oldId = f.desk.snapshot().provenance.generationId, requestCount = f.requests.length;
  await f.choose(savedFile());
  assert.equal(f.get('working-copy-file').clicks, 1);
  assert.equal(f.get('working-copy-file').value, '');
  assert.equal(f.get('agent-notes').value, savedSources.notes);
  assert.equal(f.get('call-transcript').value, savedSources.transcript);
  assert.equal(f.get('transcript-origin').textContent, 'Loaded transcript text · no automatic transcription proof · review against your notes');
  assert.ok(!f.get('transcript-origin').textContent.includes('Meta transcript'));
  assert.equal(f.get('original-transcript-panel').hidden, true);
  assert.equal(f.get('case-draft-fields').hidden, true);
  assert.equal(f.get('case-reviewed').checked, false);
  assert.equal(f.get('case-reviewed').disabled, true);
  assert.equal(f.get('export-reviewed').disabled, true);
  assert.equal(f.desk.snapshot().draft, null);
  assert.equal(f.desk.snapshot().provenance, null);
  assert.equal(f.requests.length, requestCount, 'loading a local file makes no server request');
  assert.equal(f.confirmations.length, 1);
  assert.equal(f.get('merge-create').disabled, false);
  await f.generate();
  assert.notEqual(f.desk.snapshot().provenance.generationId, oldId);
  const payload = f.requests.at(-1).options.body;
  assert.equal(payload.notes, savedSources.notes); assert.equal(payload.transcript, savedSources.transcript);
  assert.equal(payload.originalTranscript, '');
  assert.ok(!('sourceCallId' in payload)); assert.ok(!('transcriptCallId' in payload));
  assert.equal(f.get('case-reviewed').checked, false);
  assert.equal(f.get('export-reviewed').disabled, true);
  await f.review();
  assert.equal(f.get('export-reviewed').disabled, false);
});

test('saved notes can load before connecting and unlock fresh generation only after connection', async t => {
  const f = fixture(t); await f.choose(savedFile());
  assert.equal(f.requests.length, 0);
  assert.equal(f.get('agent-notes').value, savedSources.notes);
  assert.equal(f.get('merge-create').disabled, true);
  await f.connect();
  assert.equal(f.get('merge-create').disabled, false);
  await f.generate();
  assert.equal(f.get('case-draft-fields').hidden, false);
  assert.equal(f.get('case-reviewed').checked, false);
  assert.equal(f.get('export-reviewed').disabled, true);
});

test('empty selection, cancelled replacement and invalid file preserve the currently reviewed case', async t => {
  const f = fixture(t); await f.connect();
  await f.type('agent-notes', 'Keep these fictional notes.');
  await f.type('call-transcript', 'Keep this manually pasted transcript.');
  await f.generate(); await f.review();
  const before = f.desk.snapshot(), requestCount = f.requests.length;
  const unchanged = () => {
    assert.equal(f.get('agent-notes').value, before.notes);
    assert.equal(f.get('call-transcript').value, before.transcript);
    assert.deepEqual(f.desk.snapshot().draft, before.draft);
    assert.deepEqual(f.desk.snapshot().provenance, before.provenance);
    assert.equal(f.get('case-reviewed').checked, true);
    assert.equal(f.get('export-reviewed').disabled, false);
    assert.equal(f.requests.length, requestCount);
  };
  await f.get('load-working-notes').click();
  await f.get('working-copy-file').emit('change');
  unchanged();
  assert.equal(f.confirmations.length, 0);
  f.confirmReplacement = false;
  await f.choose(savedFile());
  unchanged();
  assert.equal(f.confirmations.length, 1);
  assert.equal(f.get('working-copy-file').value, '');
  await f.choose(new File(['{"private-invalid-file-sentinel":true}'], 'invalid-notes.json'));
  unchanged();
  assert.equal(f.confirmations.length, 1, 'invalid files never prompt to discard the current case');
  assert.equal(f.get('case-error').hidden, false);
  assert.ok(!f.get('case-error').textContent.includes('private-invalid-file-sentinel'));
  assert.equal(f.get('working-copy-file').value, '');
});

test('file input is cleared before and after selection so the same saved file can be loaded again', async t => {
  const f = fixture(t), file = savedFile(), input = f.get('working-copy-file');
  input.value = 'an-old-selection.json';
  await f.get('load-working-notes').click();
  assert.equal(input.value, '');
  assert.equal(input.clicks, 1);
  assert.equal(await input.select(file), true);
  await until(() => !f.desk.snapshot().loadingWorkingCopy);
  assert.equal(input.value, '');
  assert.deepEqual(input.files, []);
  await f.choose(file);
  assert.equal(input.clicks, 2);
  assert.equal(input.value, '');
  assert.equal(f.get('agent-notes').value, savedSources.notes);
  assert.equal(f.get('call-transcript').value, savedSources.transcript);
  assert.equal(f.confirmations.length, 1);
  assert.equal(f.get('case-error').hidden, true);
});
