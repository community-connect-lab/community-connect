import { readFile } from 'node:fs/promises';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { AlignmentType, Document, Footer, HeadingLevel, PageNumber, Packer, Paragraph, TextRun } from 'docx';
import PptxGenJS from 'pptxgenjs';

const FIELDS = [
  ['enquiry', 'Enquiry'],
  ['relevantDetails', 'Relevant details'],
  ['uncertainties', 'Missing or uncertain information'],
  ['nextSteps', 'Suggested next steps'],
];
const FORMATS = {
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL = /^[a-z][a-z0-9._/-]{0,119}$/i;
const BLACK = '202124', GREEN = '2F8A56', PURPLE = '7350B4', GREY = '57616B';
// Static Noto Sans from https://github.com/notofonts/noto-fonts/tree/main/hinted/ttf/NotoSans.
// Redistributed under assets/fonts/OFL.txt; embed only the glyphs used by a case.
// Variable font subsetting can produce readable extraction maps but missing
// visible glyphs with pdf-lib/fontkit; use the static TrueType outlines.
const FONT_URL = new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url);
let fontBytes;

export class CaseExportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CaseExportError';
    this.code = code;
    this.status = 400;
  }
}

function invalid() {
  throw new CaseExportError('INVALID_REVIEWED_CASE', 'A complete reviewed case with valid source information is required.');
}

function text(value, limit, { required = false } = {}) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value)) invalid();
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point >= 0xd800 && point <= 0xdfff) invalid();
  }
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string') invalid();
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) invalid();
  const numbers = parts.slice(1, 7).map(Number);
  const [year, month, day, hour, minute, second] = numbers;
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (year < 1000 || local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day || local.getUTCHours() !== hour || local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second) invalid();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) invalid();
  return parsed.toISOString();
}

function modelName(value) {
  if (typeof value !== 'string' || !MODEL.test(value) || /^(?:EAA|wacid[.]|wamid[.]|sk-|Bearer)/i.test(value) || /[a-z0-9]{49}/i.test(value)) invalid();
  return value;
}

// Select known fields individually. Never serialize the source object, call IDs,
// response IDs, contacts, tokens, or arbitrary provenance into an artifact.
export function validateReviewedCase(input) {
  if (!input || input.schemaVersion !== 2 || input.project !== 'Community Connect' || input.synthetic !== true || !UUID_V4.test(input.id ?? '') || !input.source || !input.draft || input.review?.status !== 'reviewed') invalid();
  const source = {
    notes: text(input.source.notes, 12000),
    transcript: text(input.source.transcript, 36000),
    originalTranscript: text(input.source.originalTranscript, 36000),
    transport: input.source.transport,
  };
  if (!source.notes.trim() && !source.transcript.trim()) invalid();
  if (source.originalTranscript.trim() && !source.transcript.trim()) invalid();
  if (!['whatsapp', 'manual_example'].includes(source.transport)) invalid();
  source.sourceKind = source.notes.trim() && source.transcript.trim() ? 'combined' : source.transcript.trim() ? 'transcript' : 'manual_notes';
  const draft = Object.fromEntries(FIELDS.map(([key]) => [key, text(input.draft[key], 6000, { required: true })]));
  const reviewedAt = timestamp(input.review.reviewedAt);
  const exportedAt = input.exportedAt == null ? reviewedAt : timestamp(input.exportedAt);
  // Review is attested by the browser; export time can come from the server.
  // Validate each timestamp, without assuming those independent clocks agree.
  const raw = input.provenance;
  if (!raw || !['meta', 'simulation'].includes(raw.kind)) invalid();
  const provenance = { kind: raw.kind, generatedAt: timestamp(raw.generatedAt) };
  if (raw.kind === 'meta') provenance.model = modelName(raw.model);
  let transcriptionProvenance;
  if (source.transcript.trim() && input.transcriptionProvenance != null) {
    const transcription = input.transcriptionProvenance;
    if (transcription.kind !== 'meta_transcription') invalid();
    transcriptionProvenance = { kind: 'meta_transcription', model: modelName(transcription.model), generatedAt: timestamp(transcription.generatedAt) };
  }
  return { schemaVersion: 2, id: input.id.toLowerCase(), project: 'Community Connect', synthetic: true, source, draft, provenance, ...(transcriptionProvenance ? { transcriptionProvenance } : {}), review: { status: 'reviewed', reviewedAt }, exportedAt };
}

function labels(reviewed) {
  const transport = reviewed.source.transport === 'whatsapp' ? 'Live WhatsApp call' : 'Manual example (no live call)';
  const source = { manual_notes: 'Manual agent notes', transcript: 'Transcript (reviewed text)', combined: 'Manual agent notes and transcript (reviewed text)' }[reviewed.source.sourceKind];
  return { transport, source };
}

function content(reviewed, includeSources) {
  const { transport, source } = labels(reviewed);
  const metadata = [
    ['Case', reviewed.id],
    ['Data', 'Synthetic prototype'],
    ['Transport', transport],
    ['Source', source],
    ['Draft generation', reviewed.provenance.kind === 'meta' ? `Meta Model API / ${reviewed.provenance.model}` : 'Explicit simulation / no model API call'],
    ['Generated', reviewed.provenance.generatedAt],
    ['Human review', `Reviewed / ${reviewed.review.reviewedAt}`],
    ['Exported', reviewed.exportedAt],
  ];
  if (reviewed.transcriptionProvenance) {
    metadata.push(['Transcription', `Meta transcription / ${reviewed.transcriptionProvenance.model}`], ['Transcribed', reviewed.transcriptionProvenance.generatedAt]);
  } else if (reviewed.source.transcript.trim()) {
    metadata.push(['Transcription', 'Provider provenance not recorded; no provider claim is made']);
  }
  const sections = FIELDS.map(([key, heading]) => ({ heading, body: reviewed.draft[key] }));
  if (includeSources) {
    if (reviewed.source.notes.trim()) sections.push({ heading: 'Source manual agent notes', body: reviewed.source.notes });
    if (reviewed.source.transcript.trim()) sections.push({ heading: 'Transcript (reviewed / current text)', body: reviewed.source.transcript });
    if (reviewed.source.originalTranscript.trim()) sections.push({ heading: 'Original transcript (before corrections)', body: reviewed.source.originalTranscript });
  }
  return { metadata, sections, notice: includeSources ? 'Source text included at the operator’s request.' : 'Source text omitted. Only the reviewed case and source labels are included.' };
}

// Preserve every non-whitespace character; long words are split, never truncated.
function wrap(textValue, maximum, measure) {
  const result = [];
  const widths = new Map();
  const measured = value => {
    if (!widths.has(value)) widths.set(value, measure(value));
    return widths.get(value);
  };
  const spaceWidth = measured(' ');
  for (const paragraph of textValue.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
    if (!paragraph) { result.push(''); continue; }
    let line = '', lineWidth = 0;
    for (const word of paragraph.split(/\s+/u).filter(Boolean)) {
      // Shaping entire growing lines repeatedly is quadratic work. Measure each
      // word once, with a small outer margin for cross-word kerning differences.
      // Very long unbroken words are measured a character at a time instead.
      const wordWidth = word.length <= 512 ? measured(word) : Infinity;
      if (line && lineWidth + spaceWidth + wordWidth <= maximum) { line += ` ${word}`; lineWidth += spaceWidth + wordWidth; continue; }
      if (line) { result.push(line); line = ''; lineWidth = 0; }
      if (wordWidth <= maximum) { line = word; lineWidth = wordWidth; continue; }
      for (const character of word) {
        const characterWidth = measured(character);
        if (line && lineWidth + characterWidth > maximum) { result.push(line); line = ''; lineWidth = 0; }
        line += character; lineWidth += characterWidth;
      }
    }
    if (line) result.push(line);
  }
  return result;
}

async function makePdf(reviewed, material) {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  fontBytes ??= readFile(FONT_URL);
  const font = await document.embedFont(await fontBytes, { subset: true });
  const supported = new Set(font.getCharacterSet());
  const allText = ['Community Connect', 'Reviewed case', material.notice, ...material.metadata.flat(), ...material.sections.flatMap(section => [section.heading, section.body])].join('\n');
  for (const character of allText) {
    if (!['\n', '\r', '\t'].includes(character) && !supported.has(character.codePointAt(0))) {
      throw new CaseExportError('EXPORT_UNSUPPORTED_PDF_CHARACTER', 'The PDF font cannot display part of this text. Choose Word, PowerPoint or TXT to preserve all characters.');
    }
  }
  document.setTitle('Community Connect reviewed case');
  document.setAuthor('Community Connect');
  document.setSubject('Human-reviewed synthetic prototype case');
  document.setCreator('Community Connect');
  document.setProducer('Community Connect / pdf-lib');
  document.setCreationDate(new Date(reviewed.exportedAt));
  document.setModificationDate(new Date(reviewed.exportedAt));
  const colour = hex => rgb(...hex.match(/../g).map(part => parseInt(part, 16) / 255));
  const width = 595.28, height = 841.89, margin = 48, lineHeight = 15;
  let page, y;
  const newPage = () => {
    page = document.addPage([width, height]); y = height - margin;
    page.drawRectangle({ x: margin, y: height - 30, width: width - 2 * margin, height: 3, color: colour(GREEN) });
  };
  const line = (value, size = 10.5, fill = BLACK) => {
    if (y < margin + 20) newPage();
    if (value) page.drawText(value, { x: margin, y, size, font, color: colour(fill) });
    y -= size > 14 ? size + 10 : lineHeight;
  };
  const paragraph = (value, size = 10.5, fill = BLACK) => {
    for (const valueLine of wrap(value, width - 2 * margin - 4, valueText => font.widthOfTextAtSize(valueText, size))) line(valueLine, size, fill);
  };
  newPage(); line('Community Connect', 22); line('Reviewed case', 14, PURPLE); y -= 7;
  for (const [key, value] of material.metadata) paragraph(`${key}: ${value}`, 9, GREY);
  y -= 5; paragraph(material.notice, 9, GREY); y -= 12;
  for (const section of material.sections) {
    // The HTTP gateway also handles call signalling and its short agent lease.
    // Yield between sections/pages so a long valid export cannot starve it.
    await yieldToEventLoop();
    if (y < margin + 70) newPage();
    line(section.heading, 13);
    page.drawLine({ start: { x: margin, y: y + 7 }, end: { x: margin + 42, y: y + 7 }, thickness: 1.6, color: colour(PURPLE) });
    y -= 7;
    for (const bodyLine of wrap(section.body, width - 2 * margin - 4, value => font.widthOfTextAtSize(value, 10.5))) {
      if (y < margin + 20) { await yieldToEventLoop(); newPage(); line(`${section.heading} (continued)`, 12); }
      line(bodyLine);
    }
    y -= 15;
  }
  const pages = document.getPages();
  pages.forEach((item, index) => item.drawText(`Community Connect | Reviewed case | ${index + 1} / ${pages.length}`, { x: margin, y: 25, size: 8, font, color: colour(GREY) }));
  return Buffer.from(await document.save());
}

async function makeDocx(material) {
  const metadata = material.metadata.map(([key, value]) => new Paragraph({ spacing: { after: 70 }, children: [new TextRun({ text: `${key}: `, bold: true }), new TextRun(value)] }));
  const sections = material.sections.flatMap(section => [
    new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1, keepNext: true }),
    ...section.body.replace(/\r\n?/g, '\n').split('\n').map(value => new Paragraph({ children: [new TextRun(value)], spacing: { after: 100 }, widowControl: true })),
  ]);
  const document = new Document({
    creator: 'Community Connect', title: 'Community Connect reviewed case', description: 'Human-reviewed synthetic prototype case',
    styles: {
      default: { document: { run: { font: 'Aptos', size: 22, color: BLACK }, paragraph: { spacing: { line: 280 } } } },
      paragraphStyles: [
        { id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', run: { size: 42, bold: true, color: BLACK }, paragraph: { spacing: { after: 160 } } },
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', run: { size: 28, bold: true, color: BLACK }, paragraph: { spacing: { before: 280, after: 130 }, keepNext: true } },
      ],
    },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1000, right: 1000, bottom: 1000, left: 1000 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'Community Connect | ', size: 18, color: GREY }), new TextRun({ children: [PageNumber.CURRENT], size: 18, color: GREY })] })] }) },
      children: [new Paragraph({ text: 'Community Connect', heading: HeadingLevel.TITLE }), new Paragraph({ children: [new TextRun({ text: 'REVIEWED CASE / SYNTHETIC PROTOTYPE', bold: true, color: PURPLE })], spacing: { after: 200 } }), ...metadata, new Paragraph({ children: [new TextRun({ text: material.notice, italics: true, color: GREY })], spacing: { after: 200 } }), ...sections],
    }],
  });
  return Packer.toBuffer(document);
}

function approximateWidth(value) {
  let total = 0;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (/\p{Mark}/u.test(character) || point === 0x200d || point === 0xfe0f) continue;
    total += point > 0x2e7f ? 2 : /[MW@%]/.test(character) ? 1.65 : /[il.,'!| ]/.test(character) ? 0.5 : 1;
  }
  return total;
}

async function makePptx(reviewed, material) {
  const presentation = new PptxGenJS();
  presentation.layout = 'LAYOUT_WIDE';
  presentation.author = 'Community Connect';
  presentation.company = 'Community Connect';
  presentation.title = 'Community Connect reviewed case';
  presentation.subject = 'Human-reviewed synthetic prototype case';
  presentation.lang = 'en-GB';
  presentation.theme = { headFontFace: 'Aptos', bodyFontFace: 'Aptos', lang: 'en-GB' };
  const { transport, source } = labels(reviewed);
  const model = reviewed.provenance.kind === 'meta' ? `Meta Model API / ${reviewed.provenance.model}` : 'Explicit simulation / no model API call';
  let slideNumber = 0;
  for (const section of material.sections) {
    const lines = wrap(section.body, 68, approximateWidth);
    for (let offset = 0, part = 1; offset < lines.length; offset += 10, part++) {
      const slide = presentation.addSlide();
      slideNumber++;
      slide.background = { color: 'FFFFFF' };
      slide.addShape('rect', { x: 0, y: 0, w: 0.15, h: 7.5, fill: { color: GREEN }, line: { color: GREEN } });
      slide.addText('COMMUNITY CONNECT / REVIEWED CASE', { x: 0.6, y: 0.3, w: 12, h: 0.25, margin: 0, fontSize: 13, color: PURPLE, bold: true });
      slide.addText(part === 1 ? section.heading : `${section.heading} (continued ${part})`, { x: 0.6, y: 0.82, w: 12, h: 0.7, margin: 0, fontSize: 28, bold: true, color: BLACK, valign: 'mid' });
      slide.addText(`Synthetic prototype | ${transport}\n${source} | ${model}`, { x: 0.6, y: 1.6, w: 12, h: 0.5, margin: 0, fontSize: 12, color: GREY });
      slide.addText(lines.slice(offset, offset + 10).join('\n'), { x: 0.6, y: 2.3, w: 12, h: 3.9, margin: 0, fontSize: 20, color: BLACK, valign: 'top', breakLine: false, lineSpacingMultiple: 1.1, paraSpaceAfter: 0, fit: 'none' });
      slide.addText(`Case ${reviewed.id}\nHuman review: ${reviewed.review.reviewedAt}`, { x: 0.6, y: 6.55, w: 10.8, h: 0.45, margin: 0, fontSize: 11, color: GREY });
      slide.addText(String(slideNumber), { x: 12.1, y: 6.65, w: 0.5, h: 0.25, margin: 0, fontSize: 11, color: PURPLE, align: 'right' });
      slide.addNotes([...material.metadata.map(([key, value]) => `${key}: ${value}`), material.notice]);
    }
  }
  return Buffer.from(await presentation.write({ outputType: 'nodebuffer', compression: true }));
}

/** Deterministic content/layout generation; no AI request or external write occurs. */
export async function exportReviewedCase(input, format, options = {}) {
  if (typeof format !== 'string' || !Object.hasOwn(FORMATS, format)) throw new CaseExportError('EXPORT_FORMAT_UNSUPPORTED', 'Choose PDF, Word, PowerPoint or TXT.');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new CaseExportError('INVALID_EXPORT_OPTIONS', 'Choose explicitly whether to include source text.');
  const { includeSources = false } = options;
  if (typeof includeSources !== 'boolean') throw new CaseExportError('INVALID_EXPORT_OPTIONS', 'Choose explicitly whether to include source text.');
  const reviewed = validateReviewedCase(input);
  const material = content(reviewed, includeSources);
  let bytes;
  if (format === 'txt') bytes = Buffer.from(['Community Connect — Reviewed case', ...material.metadata.map(([key, value]) => `${key}: ${value}`), '', material.notice, ...material.sections.flatMap(section => ['', section.heading, section.body]), ''].join('\n'), 'utf8');
  else if (format === 'pdf') bytes = await makePdf(reviewed, material);
  else if (format === 'docx') bytes = await makeDocx(material);
  else bytes = await makePptx(reviewed, material);
  return { bytes: Buffer.from(bytes), mimeType: FORMATS[format], filename: `${reviewed.id}.${format}` };
}
