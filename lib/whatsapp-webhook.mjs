import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const MAX_SECRET_LENGTH = 4096;
const MAX_ITEMS = 1000;
const PLACEHOLDER = /replace[_ -]?with|your[_ -].*(?:token|secret)|placeholder|change[_ -]?me|example|<[^>]+>/i;

export class WebhookError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebhookError';
    this.code = code;
    this.status = status;
  }
}

function configError() {
  return new WebhookError('WEBHOOK_CONFIG_ERROR', 'Webhook configuration is missing or invalid. Check the server environment.', 503);
}

function requiredSecret(value, minimumLength) {
  if (typeof value !== 'string' || value.length < minimumLength || value.length > MAX_SECRET_LENGTH ||
      !value.trim() || /[\r\n]/.test(value) || PLACEHOLDER.test(value)) {
    throw configError();
  }
  return value;
}

function validPhoneNumberId(value) {
  return typeof value === 'string' && /^[0-9]{1,128}$/.test(value);
}

export function readWebhookConfig(env) {
  if (!env || typeof env !== 'object') throw configError();
  const verifyToken = requiredSecret(env.WHATSAPP_VERIFY_TOKEN, 32);
  const appSecret = requiredSecret(env.WHATSAPP_APP_SECRET, 16);
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (phoneNumberId != null && phoneNumberId !== '' && !validPhoneNumberId(phoneNumberId)) throw configError();
  const portText = env.PORT == null || env.PORT === '' ? '10000' : String(env.PORT);
  if (!/^[0-9]{1,5}$/.test(portText)) throw configError();
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw configError();
  return { verifyToken, appSecret, ...(phoneNumberId ? { phoneNumberId } : {}), port };
}

function verificationError(status = 400) {
  return new WebhookError('WEBHOOK_VERIFICATION_FAILED', 'Webhook verification failed.', status);
}

export function verifyChallenge(searchParams, verifyToken) {
  const expected = requiredSecret(verifyToken, 32);
  if (!(searchParams instanceof URLSearchParams)) throw verificationError();
  const names = new Set();
  for (const name of searchParams.keys()) {
    if (names.has(name)) throw verificationError();
    names.add(name);
  }
  const challenge = searchParams.get('hub.challenge');
  if (searchParams.get('hub.mode') !== 'subscribe' || !/^[0-9]{1,128}$/.test(challenge ?? '')) {
    throw verificationError();
  }
  const supplied = searchParams.get('hub.verify_token');
  if (typeof supplied !== 'string' || !supplied || supplied.length > MAX_SECRET_LENGTH || /[\r\n]/.test(supplied)) {
    throw verificationError(401);
  }
  // Hash both strings so the comparison itself always processes equal-length buffers.
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  const suppliedDigest = createHash('sha256').update(supplied, 'utf8').digest();
  if (!timingSafeEqual(expectedDigest, suppliedDigest)) throw verificationError(401);
  return challenge;
}

export function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!(rawBody instanceof Uint8Array) || typeof signatureHeader !== 'string' || !/^sha256=[a-fA-F0-9]{64}$/.test(signatureHeader)) {
    return false;
  }
  try {
    requiredSecret(appSecret, 16);
    const expected = createHmac('sha256', appSecret).update(rawBody).digest();
    const supplied = Buffer.from(signatureHeader.slice(7), 'hex');
    return timingSafeEqual(expected, supplied);
  } catch {
    return false;
  }
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function payloadError() {
  return new WebhookError('WEBHOOK_PAYLOAD_INVALID', 'The webhook payload is invalid.', 400);
}

function eventCount(value) {
  if (value == null) return 0;
  if (!Array.isArray(value) || value.length > MAX_ITEMS || !value.every(isObject)) throw payloadError();
  return value.length;
}

export function summarizeWebhook(payload, expectedPhoneNumberId) {
  if (expectedPhoneNumberId != null && !validPhoneNumberId(expectedPhoneNumberId)) throw configError();
  if (!isObject(payload) || payload.object !== 'whatsapp_business_account' ||
      !Array.isArray(payload.entry) || payload.entry.length > MAX_ITEMS) {
    throw payloadError();
  }
  // Only aggregate counts escape this function. Never return IDs, contact details,
  // messages, SDP, or any other part of the incoming event.
  const counts = { entries: payload.entry.length, changes: 0, calls: 0, messages: 0, ignoredChanges: 0 };
  for (const entry of payload.entry) {
    if (!isObject(entry) || !Array.isArray(entry.changes) || entry.changes.length > MAX_ITEMS) throw payloadError();
    counts.changes += entry.changes.length;
    for (const change of entry.changes) {
      if (!isObject(change)) throw payloadError();
      const value = change.value;
      if (!['calls', 'messages'].includes(change.field)) {
        counts.ignoredChanges++;
        continue;
      }
      if (!isObject(value)) throw payloadError();
      if ((expectedPhoneNumberId != null && value.metadata?.phone_number_id !== expectedPhoneNumberId) ||
          (value.messaging_product != null && value.messaging_product !== 'whatsapp')) {
        counts.ignoredChanges++;
        continue;
      }
      const count = eventCount(change.field === 'calls' ? value.calls : value.messages);
      if (change.field === 'calls') counts.calls += count;
      else counts.messages += count;
      // Delivery statuses and unrelated changes are acknowledged but not retained.
      if (count === 0) counts.ignoredChanges++;
    }
  }
  return counts;
}
