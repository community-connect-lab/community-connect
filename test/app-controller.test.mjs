import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// These tests run the real browser controller with a small DOM adapter. They do
// not simulate layout, browser download handling, or a real Meta API response.
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const fields = ['enquiry', 'relevantDetails', 'uncertainties', 'nextSteps'];
const scenario = {
  id: 'synthetic-controller-001',
  title: 'Synthetic food parcel collection enquiry',
  notes: 'SYNTHETIC DEMO: Caller asks to change collection time. No new time has been confirmed.',
};
let moduleSequence = 0;

class Element {
  constructor(tagName, attributes = {}, owner) {
    this.tagName = tagName.toUpperCase();
    this.owner = owner;
    this.id = attributes.id;
    this.dataset = attributes['data-field'] ? { field: attributes['data-field'] } : {};
    this.value = attributes.value || '';
    this.checked = 'checked' in attributes;
    this.disabled = 'disabled' in attributes;
    this.hidden = 'hidden' in attributes;
    this.textContent = '';
    this.attributes = new Map(Object.entries(attributes));
    this.listeners = new Map();
    this.classes = new Set((attributes.class || '').split(/\s+/).filter(Boolean));
    this.classList = {
      toggle: (name, force) => {
        const add = force ?? !this.classes.has(name);
        if (add) this.classes.add(name); else this.classes.delete(name);
        return add;
      },
      contains: (name) => this.classes.has(name),
    };
  }

  set innerHTML(_) { throw new Error('Controller must not insert provider/source text as HTML.'); }
  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) || [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  emit(name) {
    return Promise.all((this.listeners.get(name) || []).map((handler) => handler({ target: this })));
  }
  click() {
    if (this.tagName === 'A') this.owner.downloads.push({ href: this.href, filename: this.download, element: this });
    else return this.emit('click');
  }
  remove() {
    this.removed = true;
    this.owner.appended.delete(this);
  }
}

function fakeDocument() {
  const document = {
    elements: new Map(), radios: [], downloads: [], appended: new Set(),
    getElementById(id) { return this.elements.get(id) || null; },
    querySelectorAll(selector) {
      assert.equal(selector, 'input[name="draft-mode"]', 'the adapter should only handle the controller selector');
      return this.radios;
    },
    createElement(tagName) { return new Element(tagName, {}, this); },
  };
  document.body = { append: (element) => document.appended.add(element) };
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const [, tagName, attributeText] = match;
    const attributes = {};
    for (const attribute of attributeText.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attributes[attribute[1]] = attribute[2] ?? '';
    if (!attributes.id && !(tagName === 'input' && attributes.name === 'draft-mode')) continue;
    const element = new Element(tagName, attributes, document);
    const afterTag = match.index + match[0].length;
    const endTag = html.indexOf(`</${tagName}`, afterTag);
    if (endTag >= 0 && tagName !== 'input') {
      element.textContent = html.slice(afterTag, endTag).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
    }
    if (attributes.id) document.elements.set(attributes.id, element);
    if (tagName === 'input' && attributes.name === 'draft-mode') document.radios.push(element);
  }
  return document;
}

function draftResult(mode = 'meta') {
  return {
    draft: {
      enquiry: 'Caller requests a different collection time.',
      relevantDetails: 'The agent has not confirmed another collection time.',
      uncertainties: 'Alternative collection availability is not recorded.',
      nextSteps: 'A person should check availability before agreeing to a change.',
    },
    provenance: mode === 'simulation'
      ? { kind: 'simulation', label: 'SIMULATION — no model API call', generatedAt: '2026-10-26T12:00:00Z' }
      : { kind: 'meta', label: 'Meta Model API', model: 'synthetic-test-model', responseId: 'synthetic-response-001', generatedAt: '2026-10-26T12:00:00Z' },
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

async function loadController(t) {
  const document = fakeDocument();
  const requests = [];
  const queuedDrafts = [];
  const blobs = new Map();
  const revoked = [];
  const cleanupTimers = [];
  const descriptors = new Map(['document', 'window', 'fetch', 'setTimeout'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const urlDescriptors = new Map(['createObjectURL', 'revokeObjectURL'].map((key) => [key, Object.getOwnPropertyDescriptor(URL, key)]));
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
    for (const [key, descriptor] of urlDescriptors) {
      if (descriptor) Object.defineProperty(URL, key, descriptor); else delete URL[key];
    }
  });
  globalThis.document = document;
  globalThis.window = { listeners: new Map(), addEventListener(name, handler) { this.listeners.set(name, handler); } };
  globalThis.setTimeout = (callback, delay) => {
    cleanupTimers.push({ callback, delay });
    return cleanupTimers.length;
  };
  URL.createObjectURL = (blob) => {
    const url = `blob:controller-test/${blobs.size + 1}`;
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = (url) => revoked.push(url);
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === '/api/bootstrap') return jsonResponse({ scenario, apiConfigured: true, model: 'synthetic-test-model' });
    assert.equal(url, '/api/draft', 'tests must never make an external request');
    assert.ok(queuedDrafts.length, 'each generation needs an explicitly mocked result');
    const next = queuedDrafts.shift();
    return typeof next === 'function' ? next() : next;
  };
  const moduleUrl = new URL('../public/app.mjs', import.meta.url);
  moduleUrl.searchParams.set('controller-test', String(++moduleSequence));
  await import(moduleUrl.href);
  // initialise() is intentionally an unawaited browser entry point. Wait for
  // its mocked fetch/json microtasks, without timers or external resources.
  for (let attempt = 0; attempt < 20 && document.getElementById('workspace').hidden; attempt += 1) await Promise.resolve();
  assert.equal(document.getElementById('workspace').hidden, false, document.getElementById('error-message').textContent);
  const get = (id) => document.getElementById(id);
  const input = async (id, value) => { get(id).value = value; await get(id).emit('input'); };
  const review = async () => { get('human-review').checked = true; await get('human-review').emit('change'); };
  const generate = async (result = draftResult()) => { queuedDrafts.push(jsonResponse(result)); await get('generate-draft').emit('click'); };
  return { document, get, input, review, generate, queuedDrafts, requests, blobs, revoked, cleanupTimers };
}

test('actual controller input handlers revoke review and enforce source regeneration', async (t) => {
  const app = await loadController(t);
  assert.equal(app.get('agent-notes').value, scenario.notes);
  assert.equal(app.get('human-review').disabled, true);
  assert.equal(app.get('export-case').disabled, true);
  await app.generate();
  assert.deepEqual(JSON.parse(app.requests.find((request) => request.url === '/api/draft').options.body), { notes: scenario.notes, mode: 'meta' });
  assert.equal(app.get('human-review').disabled, false);
  assert.equal(app.get('export-case').disabled, true);
  for (const field of fields) {
    await app.review();
    assert.equal(app.get('export-case').disabled, false);
    await app.input(`draft-${field}`, `Human-edited ${field}.`);
    assert.equal(app.get('human-review').checked, false, `${field} edits revoke the checkbox`);
    assert.equal(app.get('export-case').disabled, true, `${field} edits revoke export`);
  }
  await app.review();
  await app.input('agent-notes', `${scenario.notes} SYNTHETIC: afternoon is preferred.`);
  assert.equal(app.get('human-review').checked, false);
  assert.equal(app.get('human-review').disabled, true);
  assert.equal(app.get('export-case').disabled, true);
  assert.match(app.get('source-changed').textContent, /Source notes changed/);
  assert.equal(app.get('draft-enquiry').value, 'Human-edited enquiry.');
  // A programmatic event must not bypass the state guard, even though a real
  // browser would already prevent interaction with these disabled controls.
  await app.review();
  await app.get('export-case').emit('click');
  assert.equal(app.get('human-review').checked, false);
  assert.equal(app.document.downloads.length, 0);
});

test('regeneration invalidates immediately and HTTP failure preserves every edited field', async (t) => {
  const app = await loadController(t);
  await app.generate();
  const edits = Object.fromEntries(fields.map((field) => [field, `Preserve this edited ${field}.`]));
  for (const [field, value] of Object.entries(edits)) await app.input(`draft-${field}`, value);
  await app.review();
  assert.equal(app.get('export-case').disabled, false);
  let resolveFailure;
  app.queuedDrafts.push(new Promise((resolve) => { resolveFailure = resolve; }));
  const pending = app.get('generate-draft').emit('click');
  assert.equal(app.get('human-review').checked, false);
  assert.equal(app.get('human-review').disabled, true);
  assert.equal(app.get('export-case').disabled, true);
  assert.equal(app.get('agent-notes').disabled, true);
  assert.equal(app.get('draft-enquiry').disabled, true);
  resolveFailure(jsonResponse({ error: { code: 'RATE_LIMITED', message: 'The model API is rate limited. Try again later.' } }, 429));
  await pending;
  assert.equal(app.get('agent-notes').value, scenario.notes);
  for (const [field, value] of Object.entries(edits)) assert.equal(app.get(`draft-${field}`).value, value);
  assert.equal(app.get('agent-notes').disabled, false);
  assert.equal(app.get('draft-enquiry').disabled, false);
  assert.equal(app.get('error-message').hidden, false);
  assert.match(app.get('error-message').textContent, /rate limited/);
  assert.equal(app.get('human-review').disabled, true);
  assert.equal(app.get('export-case').disabled, true);
  await app.get('export-case').emit('click');
  assert.equal(app.document.downloads.length, 0);
});

test('transport and unreadable-response failures preserve controller inputs without silently simulating', async (t) => {
  const app = await loadController(t);
  await app.generate();
  await app.input('draft-relevantDetails', 'Retain this agent correction after all failed requests.');
  for (const failure of [
    () => Promise.reject(new TypeError('Synthetic transport failure.')),
    () => Promise.resolve(new Response('Synthetic non-JSON error body.', { status: 502 })),
  ]) {
    app.queuedDrafts.push(failure);
    await app.get('generate-draft').emit('click');
    assert.equal(app.get('agent-notes').value, scenario.notes);
    assert.equal(app.get('draft-relevantDetails').value, 'Retain this agent correction after all failed requests.');
    assert.equal(app.get('error-message').hidden, false);
    assert.equal(app.get('export-case').disabled, true);
    assert.match(app.get('draft-provenance').textContent, /Meta Model API/);
    assert.equal(app.get('simulation-notice').hidden, true);
  }
  assert.ok(app.requests.filter((request) => request.url === '/api/draft').every((request) => JSON.parse(request.options.body).mode === 'meta'));
});

test('export handler builds a JSON Blob from current source, all human edits, provenance and review', async (t) => {
  const app = await loadController(t);
  const updatedNotes = `${scenario.notes}\nSYNTHETIC: Agent will check the afternoon collection window.`;
  await app.input('agent-notes', updatedNotes);
  const response = draftResult();
  await app.generate(response);
  const editedDraft = {
    enquiry: 'Human-reviewed collection time enquiry.',
    relevantDetails: 'No alternative time confirmed.\nSource says the agent will check availability.',
    uncertainties: 'Availability remains unknown. <script>This is literal text.</script>',
    nextSteps: 'Check available slots.\nAsk a human to confirm a new time before agreeing.',
  };
  for (const [field, value] of Object.entries(editedDraft)) await app.input(`draft-${field}`, value);
  await app.review();
  assert.equal(app.get('export-case').disabled, false);
  await app.get('export-case').emit('click');
  assert.equal(app.document.downloads.length, 1);
  const download = app.document.downloads[0];
  assert.match(download.filename, /^community-connect-reviewed-case-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/);
  assert.equal(download.element.removed, true);
  assert.equal(app.document.appended.size, 0);
  const blob = app.blobs.get(download.href);
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, 'application/json');
  const exported = JSON.parse(await blob.text());
  assert.deepEqual(exported.draft, editedDraft);
  assert.deepEqual(exported.source, { type: 'synthetic_agent_notes', currentNotes: updatedNotes, notesUsedForDraft: updatedNotes });
  assert.deepEqual(exported.provenance, response.provenance);
  assert.equal(exported.scenario.synthetic, true);
  assert.equal(exported.scenario.callMode, 'simulated');
  assert.equal(exported.review.status, 'reviewed');
  assert.ok(Number.isFinite(Date.parse(exported.review.reviewedAt)));
  assert.ok(Number.isFinite(Date.parse(exported.exportedAt)));
  assert.match(app.get('activity-status').textContent, /includes the source notes/);
  assert.equal(app.cleanupTimers.length, 1);
  assert.equal(app.cleanupTimers[0].delay, 1000);
  app.cleanupTimers[0].callback();
  assert.deepEqual(app.revoked, [download.href]);
});

test('explicit simulation selection labels the draft and JSON and changes the download filename', async (t) => {
  const app = await loadController(t);
  const metaRadio = app.document.radios.find((radio) => radio.value === 'meta');
  const simulationRadio = app.document.radios.find((radio) => radio.value === 'simulation');
  assert.equal(metaRadio.checked, true);
  assert.equal(app.get('simulation-notice').hidden, true);
  metaRadio.checked = false;
  simulationRadio.checked = true;
  await simulationRadio.emit('change');
  assert.equal(app.get('simulation-notice').hidden, false);
  assert.match(app.get('simulation-notice').textContent, /SIMULATED SUMMARY SELECTED/);
  await app.generate(draftResult('simulation'));
  const request = app.requests.find((entry) => entry.url === '/api/draft');
  assert.deepEqual(JSON.parse(request.options.body), { notes: scenario.notes, mode: 'simulation' });
  assert.match(app.get('draft-provenance').textContent, /SIMULATED SUMMARY/);
  assert.equal(app.get('draft-provenance').classList.contains('simulated'), true);
  await app.review();
  await app.get('export-case').emit('click');
  const download = app.document.downloads[0];
  assert.match(download.filename, /^community-connect-SIMULATED-reviewed-case-.*\.json$/);
  const exported = JSON.parse(await app.blobs.get(download.href).text());
  assert.equal(exported.provenance.kind, 'simulation');
  assert.match(exported.provenance.label, /SIMULATED SUMMARY/);
  assert.equal('model' in exported.provenance, false);
  assert.equal('responseId' in exported.provenance, false);
  simulationRadio.checked = false;
  metaRadio.checked = true;
  await metaRadio.emit('change');
  assert.equal(app.get('human-review').checked, false);
  assert.equal(app.get('human-review').disabled, true);
  assert.equal(app.get('export-case').disabled, true);
  // The existing draft keeps its truthful provenance after the next mode is selected.
  assert.match(app.get('draft-provenance').textContent, /SIMULATED SUMMARY/);
});
