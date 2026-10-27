import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { exportReviewedCase, validateReviewedCase } from '../lib/case-export.mjs';

const id = '14e041a2-4092-4b97-bd98-837bc7cc608f';
const approved = 'APPROVED EDIT: café — José’s Thursday request remains unconfirmed.';
const fixture = () => ({
  schemaVersion: 2, id, project: 'Community Connect', synthetic: true,
  source: { notes: 'PRIVATE_SOURCE_NOTES_SENTINEL: fictional collection request.', transcript: '', transport: 'whatsapp', sourceKind: 'transcript', transcriptCallId: 'PRIVATE_CALL_ID_SENTINEL', phoneNumber: 'PRIVATE_PHONE_SENTINEL' },
  draft: { enquiry: approved, relevantDetails: 'Reviewed facts: A < B & C. The agent corrected this paragraph.', uncertainties: 'Thursday availability has not been confirmed.', nextSteps: 'A worker should check availability before offering a change.' },
  provenance: { kind: 'meta', model: 'muse-wonder-1.0', generatedAt: '2026-10-27T10:00:00Z', responseId: 'PRIVATE_RESPONSE_ID_SENTINEL', accessToken: 'PRIVATE_TOKEN_SENTINEL' },
  review: { status: 'reviewed', reviewedAt: '2026-10-27T10:05:00Z', statement: 'PRIVATE_EXTRA_STATEMENT_SENTINEL' },
  exportedAt: '2026-10-27T10:06:00Z',
});

// Parse actual Office ZIP contents without adding a production ZIP dependency.
function unzip(bytes) {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'ZIP end directory exists');
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const files = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10), size = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const local = bytes.readUInt32LE(cursor + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + size);
    assert.ok([0, 8].includes(method), 'supported Office ZIP compression');
    files.set(name, method === 8 ? inflateRawSync(compressed) : compressed);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const unescapeXml = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function xmlText(xml) {
  return [...xml.matchAll(/<(?:a:t|w:t)(?:\s[^>]*)?>([\s\S]*?)<\/(?:a:t|w:t)>/g)].map(match => unescapeXml(match[1])).join('\n');
}
const compact = value => value.replace(/\s+/gu, ' ').trim();

// Read the PDF's real embedded-font ToUnicode maps and page content streams.
async function pdfText(bytes) {
  const document = await PDFDocument.load(bytes);
  const text = [];
  const checkedFonts = new Set();
  for (const page of document.getPages()) {
    const fonts = page.node.Resources().lookup(PDFName.of('Font'), PDFDict);
    const unicode = new Map();
    for (const [, reference] of fonts.entries()) {
      const font = document.context.lookup(reference, PDFDict);
      const map = font.lookup(PDFName.of('ToUnicode'), PDFRawStream);
      const source = Buffer.from(decodePDFRawStream(map).decode()).toString('ascii');
      let embeddedFont;
      if (!checkedFonts.has(reference.toString())) {
        const descendant = font.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict);
        const descriptor = descendant.lookup(PDFName.of('FontDescriptor'), PDFDict);
        const program = descriptor.lookup(PDFName.of('FontFile2'), PDFRawStream);
        embeddedFont = fontkit.create(decodePDFRawStream(program).decode());
        checkedFonts.add(reference.toString());
      }
      for (const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const pair of block[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>/gi)) {
          const utf16 = Buffer.from(pair[2], 'hex');
          const character = utf16.swap16().toString('utf16le');
          unicode.set(pair[1].toUpperCase(), character);
          // Extraction maps alone miss broken visible glyphs. Decode every
          // used visible outline from the actual embedded subset font as well.
          if (embeddedFont && /[\p{L}\p{N}\p{P}\p{S}\p{M}]/u.test(character)) {
            assert.ok(embeddedFont.getGlyph(parseInt(pair[1], 16)).path.commands.length > 0, `embedded outline exists for ${character}`);
          }
        }
      }
    }
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
    for (const reference of streams) {
      const stream = document.context.lookup(reference, PDFRawStream);
      const source = Buffer.from(decodePDFRawStream(stream).decode()).toString('ascii');
      for (const token of source.matchAll(/<([\da-f]+)>/gi)) {
        const encoded = token[1].toUpperCase();
        text.push((encoded.match(/.{1,4}/g) ?? []).map(glyph => unicode.get(glyph) ?? '').join(''));
      }
    }
  }
  return { document, text: text.join('\n') };
}

test('validates reviewed canonical cases and derives labels without exporting identifiers or unknown metadata', () => {
  const checked = validateReviewedCase(fixture());
  assert.equal(checked.source.sourceKind, 'manual_notes');
  assert.equal(checked.source.transport, 'whatsapp');
  assert.equal(checked.synthetic, true);
  const serialised = JSON.stringify(checked);
  for (const sentinel of ['PRIVATE_CALL_ID', 'PRIVATE_PHONE', 'PRIVATE_RESPONSE_ID', 'PRIVATE_TOKEN', 'PRIVATE_EXTRA_STATEMENT']) assert.ok(!serialised.includes(sentinel));
  assert.equal(checked.review.reviewedAt, '2026-10-27T10:05:00.000Z');
});

test('requires review, safe random case identifier, source, valid dates and bounded complete draft text', async () => {
  const changes = [
    value => { value.review.status = 'draft'; }, value => { value.review.reviewedAt = '2026-02-30T10:00:00Z'; },
    value => { value.id = 'phone-123456789'; }, value => { value.id = '14e041a2-4092-1b97-bd98-837bc7cc608f'; },
    value => { value.synthetic = false; }, value => { value.source.transport = 'unknown'; },
    value => { value.source.notes = ''; }, value => { value.source.notes = 'x'.repeat(12001); },
    value => { value.source.transcript = 'x'.repeat(36001); }, value => { value.source.originalTranscript = 'unpaired original'; },
    value => { value.draft.enquiry = ' '; }, value => { value.draft.nextSteps = 'x'.repeat(6001); },
    value => { value.draft.enquiry = 'Invalid\0XML'; }, value => { value.draft.enquiry = '\ud800'; },
    value => { value.provenance.model = 'EAA_PRIVATE_TOKEN_SENTINEL'; }, value => { value.provenance.generatedAt = 'bad'; },
    value => { value.exportedAt = 'not-an-ISO-timestamp'; },
  ];
  for (const change of changes) {
    const value = fixture(); change(value);
    await assert.rejects(exportReviewedCase(value, 'txt'), { code: 'INVALID_REVIEWED_CASE', status: 400 });
  }
  await assert.rejects(exportReviewedCase(fixture(), '../pdf'), { code: 'EXPORT_FORMAT_UNSUPPORTED' });
  await assert.rejects(exportReviewedCase(fixture(), ['pdf']), { code: 'EXPORT_FORMAT_UNSUPPORTED' });
  await assert.rejects(exportReviewedCase(fixture(), 'txt', { includeSources: 'false' }), { code: 'INVALID_EXPORT_OPTIONS' });
  await assert.rejects(exportReviewedCase(fixture(), 'txt', null), { code: 'INVALID_EXPORT_OPTIONS' });
});

test('valid review and export dates do not assume browser and server clocks are synchronized', async () => {
  const value = fixture();
  value.review.reviewedAt = '2026-10-27T10:11:00Z';
  value.exportedAt = '2026-10-27T10:06:00Z';
  const result = await exportReviewedCase(value, 'txt');
  const plain = result.bytes.toString('utf8');
  assert.match(plain, /Human review: Reviewed \/ 2026-10-27T10:11:00[.]000Z/);
  assert.match(plain, /Exported: 2026-10-27T10:06:00[.]000Z/);
});

test('TXT is UTF-8, preserves approved edits and source labels, excludes source bodies by default', async () => {
  const result = await exportReviewedCase(fixture(), 'txt');
  assert.ok(Buffer.isBuffer(result.bytes));
  assert.equal(result.filename, `${id}.txt`);
  assert.equal(result.mimeType, 'text/plain; charset=utf-8');
  const text = result.bytes.toString('utf8');
  assert.ok(text.includes(approved));
  assert.match(text, /Synthetic prototype/); assert.match(text, /Live WhatsApp call/); assert.match(text, /Manual agent notes/);
  assert.ok(!text.includes('PRIVATE_SOURCE_NOTES')); assert.ok(!text.includes('Transcription:'));
  assert.ok(!text.includes('PRIVATE_CALL_ID')); assert.ok(!text.includes('PRIVATE_RESPONSE_ID')); assert.ok(!text.includes('PRIVATE_TOKEN'));
  assert.deepEqual((await exportReviewedCase(fixture(), 'txt')).bytes, result.bytes);
});

test('optional sources preserve corrected and original transcript labels and simulation has no model claim', async () => {
  const value = fixture();
  value.source.transcript = 'CURRENT_TRANSCRIPT_SENTINEL: café corrected.';
  value.source.originalTranscript = 'ORIGINAL_TRANSCRIPT_SENTINEL: initial recognition.';
  value.transcriptionProvenance = { kind: 'meta_transcription', model: 'muse-voice-transcribe', generatedAt: '2026-10-27T09:59:00Z', callId: 'PRIVATE_CALL_ID_SENTINEL' };
  const without = (await exportReviewedCase(value, 'txt')).bytes.toString('utf8');
  assert.ok(!without.includes('CURRENT_TRANSCRIPT_SENTINEL')); assert.ok(!without.includes('ORIGINAL_TRANSCRIPT_SENTINEL'));
  const withSources = (await exportReviewedCase(value, 'txt', { includeSources: true })).bytes.toString('utf8');
  assert.match(withSources, /Transcript \(reviewed \/ current text\)/); assert.match(withSources, /Original transcript \(before corrections\)/);
  for (const sentinel of ['PRIVATE_SOURCE_NOTES', 'CURRENT_TRANSCRIPT_SENTINEL', 'ORIGINAL_TRANSCRIPT_SENTINEL']) assert.ok(withSources.includes(sentinel));
  assert.ok(!withSources.includes('PRIVATE_CALL_ID'));
  value.source.transport = 'manual_example'; value.provenance = { kind: 'simulation', generatedAt: '2026-10-27T10:00:00Z', model: 'PRIVATE_TOKEN_SENTINEL' };
  const simulated = (await exportReviewedCase(value, 'txt')).bytes.toString('utf8');
  assert.match(simulated, /Manual example \(no live call\)/); assert.match(simulated, /Explicit simulation \/ no model API call/);
  assert.ok(!simulated.includes('PRIVATE_TOKEN_SENTINEL'));
});

test('all formats append current and original source text only when requested', async () => {
  const value = fixture();
  value.source.transcript = 'CORRECTED_TRANSCRIPT_SENTINEL: Thursday remains unconfirmed.';
  value.source.originalTranscript = 'ORIGINAL_TRANSCRIPT_SENTINEL: initial machine wording.';
  value.transcriptionProvenance = { kind: 'meta_transcription', model: 'muse-voice-transcribe', generatedAt: '2026-10-27T09:59:00Z' };
  for (const format of ['pdf', 'docx', 'pptx', 'txt']) {
    const { bytes } = await exportReviewedCase(value, format, { includeSources: true });
    let plain;
    if (format === 'pdf') plain = (await pdfText(bytes)).text;
    else if (format === 'txt') plain = bytes.toString('utf8');
    else {
      const files = unzip(bytes);
      plain = format === 'docx' ? xmlText(files.get('word/document.xml').toString('utf8')) : [...files].filter(([name]) => /^ppt\/slides\/slide\d+[.]xml$/.test(name)).map(([, content]) => xmlText(content.toString('utf8'))).join('\n');
    }
    for (const sentinel of ['PRIVATE_SOURCE_NOTES_SENTINEL', 'CORRECTED_TRANSCRIPT_SENTINEL', 'ORIGINAL_TRANSCRIPT_SENTINEL']) assert.ok(compact(plain).includes(sentinel), `${format} preserves ${sentinel}`);
    assert.match(plain, /Original transcript \(before corrections\)/);
    assert.ok(!plain.includes('PRIVATE_CALL_ID_SENTINEL'));
  }
});

test('source labels and transcription claims follow actual source text, never an arbitrary sourceKind label', async () => {
  const value = fixture();
  value.transcriptionProvenance = { kind: 'meta_transcription', model: 'muse-voice-transcribe', generatedAt: '2026-10-27T09:59:00Z' };
  const manual = (await exportReviewedCase(value, 'txt')).bytes.toString('utf8');
  assert.match(manual, /Source: Manual agent notes/);
  assert.ok(!manual.includes('Meta transcription')); assert.ok(!manual.includes('muse-voice-transcribe'));
  value.source.notes = ''; value.source.transcript = 'Reviewed transcript source.'; delete value.transcriptionProvenance;
  const transcript = (await exportReviewedCase(value, 'txt')).bytes.toString('utf8');
  assert.match(transcript, /Source: Transcript \(reviewed text\)/);
  assert.match(transcript, /Provider provenance not recorded/);
  assert.ok(!transcript.includes('Meta transcription'));
});

test('PDF opens with embedded Unicode font, extracts approved Latin/Greek/Cyrillic edits and paginates long cases', async () => {
  const value = fixture();
  value.draft.enquiry = `${approved} Ελληνικά Привет.`;
  value.draft.relevantDetails = 'Approved long detail with café. '.repeat(160);
  const result = await exportReviewedCase(value, 'pdf');
  assert.equal(result.mimeType, 'application/pdf'); assert.equal(result.filename, `${id}.pdf`);
  const parsed = await pdfText(result.bytes);
  assert.ok(parsed.document.getPageCount() > 1);
  assert.ok(compact(parsed.text).includes(compact(value.draft.enquiry)));
  assert.ok(compact(parsed.text).includes('A worker should check availability before offering a change.'));
  assert.ok(!parsed.text.includes('PRIVATE_SOURCE_NOTES')); assert.ok(!parsed.text.includes('PRIVATE_CALL_ID'));
  assert.ok(compact(parsed.text).includes(compact(value.review.reviewedAt.replace('Z', '.000Z'))));
});

test('PDF never silently replaces unsupported characters; other formats preserve them', async () => {
  const value = fixture(); value.draft.enquiry = 'Approved Unicode edit: 東京 😀.';
  await assert.rejects(exportReviewedCase(value, 'pdf'), error => error.code === 'EXPORT_UNSUPPORTED_PDF_CHARACTER' && !error.message.includes('東京'));
  assert.ok((await exportReviewedCase(value, 'txt')).bytes.toString('utf8').includes(value.draft.enquiry));
  const document = unzip((await exportReviewedCase(value, 'docx')).bytes);
  assert.ok(xmlText(document.get('word/document.xml').toString('utf8')).includes(value.draft.enquiry));
  const slides = unzip((await exportReviewedCase(value, 'pptx')).bytes);
  assert.ok(xmlText(slides.get('ppt/slides/slide1.xml').toString('utf8')).includes(value.draft.enquiry));
});

test('maximum-size PDF sources remain complete while yielding to gateway heartbeat work', async () => {
  const value = fixture();
  const bounded = (length, ending) => 'Confirmed facts and uncertainty. '.repeat(Math.ceil(length / 32)).slice(0, length - ending.length) + ending;
  value.source.notes = bounded(12000, 'NOTES_END_SENTINEL');
  value.source.transcript = bounded(36000, 'CURRENT_END_SENTINEL');
  value.source.originalTranscript = bounded(36000, 'ORIGINAL_END_SENTINEL');
  for (const field of Object.keys(value.draft)) value.draft[field] = bounded(6000, `${field.toUpperCase()}_END_SENTINEL`);
  let active = true, heartbeatTicks = 0;
  const heartbeat = () => { if (active) { heartbeatTicks++; setImmediate(heartbeat); } };
  setImmediate(heartbeat);
  let result;
  try { result = await exportReviewedCase(value, 'pdf', { includeSources: true }); }
  finally { active = false; }
  assert.ok(heartbeatTicks >= 3, 'other gateway work gets event-loop turns during rendering');
  const parsed = await pdfText(result.bytes);
  assert.ok(parsed.document.getPageCount() > 10);
  for (const ending of ['NOTES_END_SENTINEL', 'CURRENT_END_SENTINEL', 'ORIGINAL_END_SENTINEL', 'ENQUIRY_END_SENTINEL', 'NEXTSTEPS_END_SENTINEL']) assert.ok(parsed.text.includes(ending));
});

test('Word is editable Office XML with approved text, escaped characters, and opt-in source appendices', async () => {
  const value = fixture();
  const result = await exportReviewedCase(value, 'docx');
  assert.equal(result.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const files = unzip(result.bytes);
  assert.ok(files.has('[Content_Types].xml'));
  const xml = files.get('word/document.xml').toString('utf8'), plain = xmlText(xml);
  for (const body of Object.values(value.draft)) assert.ok(plain.includes(body));
  assert.match(xml, /A &lt; B &amp; C/); assert.ok(!plain.includes('PRIVATE_SOURCE_NOTES'));
  const all = [...files.values()].map(bytes => bytes.toString('utf8')).join('\n');
  for (const sentinel of ['PRIVATE_CALL_ID', 'PRIVATE_RESPONSE_ID', 'PRIVATE_TOKEN']) assert.ok(!all.includes(sentinel));
  const included = unzip((await exportReviewedCase(value, 'docx', { includeSources: true })).bytes);
  assert.ok(xmlText(included.get('word/document.xml').toString('utf8')).includes(value.source.notes));
});

test('PowerPoint has four readable topics, adds continuation slides, and keeps the final approved words', async () => {
  const value = fixture(); value.draft.enquiry = `${'The approved case preserves uncertainty. '.repeat(140)}FINAL_APPROVED_WORDS`;
  const result = await exportReviewedCase(value, 'pptx');
  assert.equal(result.mimeType, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  const files = unzip(result.bytes);
  const slides = [...files].filter(([name]) => /^ppt\/slides\/slide\d+[.]xml$/.test(name)).sort(([a], [b]) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  assert.ok(slides.length > 4);
  const plain = slides.map(([, bytes]) => xmlText(bytes.toString('utf8'))).join('\n');
  assert.match(plain, /Enquiry \(continued/); assert.match(plain, /FINAL_APPROVED_WORDS/);
  for (const key of ['relevantDetails', 'uncertainties', 'nextSteps']) assert.ok(compact(plain).includes(compact(value.draft[key])));
  for (const [, bytes] of slides) { assert.ok(!bytes.toString('utf8').includes('fit="shrink"')); assert.ok(!bytes.toString('utf8').includes('PRIVATE_SOURCE_NOTES')); }
  const normal = unzip((await exportReviewedCase(fixture(), 'pptx')).bytes);
  assert.equal([...normal.keys()].filter(name => /^ppt\/slides\/slide\d+[.]xml$/.test(name)).length, 4);
});
