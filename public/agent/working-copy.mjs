export const MAX_WORKING_COPY_BYTES = 512 * 1024;

const ROOT_KEYS = ['app', 'format', 'version', 'synthetic', 'savedAt', 'sources'];
const SOURCE_KEYS = ['notes', 'transcript'];
const INVALID_FILE = 'Choose a valid Community Connect working-copy JSON file.';
const INVALID_SOURCES = 'Working copies need notes or a transcript within the supported text limits.';
const TOO_LARGE = 'Working-copy files must be 512 KiB or smaller.';
const encoder = new TextEncoder();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function exactKeys(value, allowed) {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every(key => allowed.includes(key));
}

function checkSize(text) {
  if (text.length > MAX_WORKING_COPY_BYTES || encoder.encode(text).byteLength > MAX_WORKING_COPY_BYTES) {
    throw new Error(TOO_LARGE);
  }
}

function validSource(value, maximum) {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]/u.test(value)) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
    } else if (code >= 0xDC00 && code <= 0xDFFF) return false;
  }
  return true;
}

function validateSources(notes, transcript) {
  if (!validSource(notes, 12000) || !validSource(transcript, 36000) || (!notes.trim() && !transcript.trim())) {
    throw new Error(INVALID_SOURCES);
  }
  return { notes, transcript };
}

function timestamp(value) {
  if (typeof value !== 'string') throw new Error(INVALID_FILE);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error(INVALID_FILE);
  const local = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  const localDate = new Date(local);
  if (!Number.isFinite(localDate.getTime()) || localDate.toISOString() !== local ||
      (match[3] !== 'Z' && (Number(match[3].slice(1, 3)) > 23 || Number(match[3].slice(4, 6)) > 59))) {
    throw new Error(INVALID_FILE);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(INVALID_FILE);
  const normalized = parsed.toISOString();
  if (normalized.length !== 24) throw new Error(INVALID_FILE);
  return normalized;
}

// Select only source strings. Extra workflow fields, getters and toJSON hooks
// must never be copied into a download or invoked by JSON.stringify.
export function serializeWorkingCopy(source, savedAt = new Date().toISOString()) {
  if (!record(source)) throw new Error(INVALID_SOURCES);
  let notes, transcript;
  try {
    const notesField = Object.getOwnPropertyDescriptor(source, 'notes');
    const transcriptField = Object.getOwnPropertyDescriptor(source, 'transcript');
    if (!notesField || !transcriptField || !Object.hasOwn(notesField, 'value') || !Object.hasOwn(transcriptField, 'value')) {
      throw new Error(INVALID_SOURCES);
    }
    notes = notesField.value; transcript = transcriptField.value;
  } catch {
    throw new Error(INVALID_SOURCES);
  }
  const sources = validateSources(notes, transcript);
  const text = JSON.stringify({
    app: 'Community Connect', format: 'source-working-copy', version: 1,
    synthetic: true, savedAt: timestamp(savedAt), sources,
  }, null, 2) + '\n';
  checkSize(text);
  return text;
}

export function parseWorkingCopy(text) {
  if (typeof text !== 'string') throw new Error(INVALID_FILE);
  checkSize(text);
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(INVALID_FILE); }
  if (!exactKeys(value, ROOT_KEYS) || value.app !== 'Community Connect' || value.format !== 'source-working-copy' ||
      value.version !== 1 || value.synthetic !== true || !exactKeys(value.sources, SOURCE_KEYS)) {
    throw new Error(INVALID_FILE);
  }
  timestamp(value.savedAt);
  return validateSources(value.sources.notes, value.sources.transcript);
}
