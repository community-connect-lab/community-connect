import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { WebhookError, readWebhookConfig, verifyChallenge, verifySignature, summarizeWebhook } from '../lib/whatsapp-webhook.mjs';

const VERIFY_TOKEN = 'synthetic-unit-verification-token-9f71c2a3';
const APP_SECRET = 'synthetic-unit-app-secret-4d6839b2';
const PHONE_ID = '123456789012345';
const validEnv = { WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN, WHATSAPP_APP_SECRET: APP_SECRET };
const signature = (body, secret = APP_SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
function query(values = {}) {
  return new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '123456789', ...values });
}
function assertSafeError(operation, status) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof WebhookError);
    if (status != null) assert.equal(error.status, status);
    for (const secret of [VERIFY_TOKEN, APP_SECRET, 'sensitive-input-sentinel']) {
      assert.ok(!error.message.includes(secret));
      assert.ok(!JSON.stringify(error).includes(secret));
    }
    assert.equal(error.cause, undefined);
    return true;
  });
}
function event(field, items, phoneNumberId = PHONE_ID) {
  return { field, value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, [field]: items } };
}
function payload(changes = []) {
  return { object: 'whatsapp_business_account', entry: [{ id: 'synthetic-waba-id', changes }] };
}

test('loads valid webhook configuration, defaults port and keeps phone filter optional', () => {
  assert.deepEqual(readWebhookConfig(validEnv), { verifyToken: VERIFY_TOKEN, appSecret: APP_SECRET, port: 10000 });
  assert.deepEqual(readWebhookConfig({ ...validEnv, PORT: '443', WHATSAPP_PHONE_NUMBER_ID: PHONE_ID }), {
    verifyToken: VERIFY_TOKEN, appSecret: APP_SECRET, phoneNumberId: PHONE_ID, port: 443,
  });
});

test('rejects missing, short, oversized, placeholder, newline or whitespace-only secrets safely', () => {
  for (const variable of ['WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET']) {
    for (const value of [undefined, '', 'short', ' '.repeat(50), 'x'.repeat(4097), 'replace_with_your_webhook_token_12345678', '<your_app_secret_goes_here_123456789>', VERIFY_TOKEN + '\r\n']) {
      assertSafeError(() => readWebhookConfig({ ...validEnv, [variable]: value }), 503);
    }
  }
  assertSafeError(() => readWebhookConfig(null), 503);
});

test('rejects invalid port and nonnumeric phone-number configuration', () => {
  for (const PORT of ['0', '65536', '-1', '1.5', '1e4', 'abc', ' 10000', '10000\n']) {
    assertSafeError(() => readWebhookConfig({ ...validEnv, PORT }), 503);
  }
  for (const WHATSAPP_PHONE_NUMBER_ID of ['+12345', '123 456', 'sensitive-input-sentinel', '123\n']) {
    assertSafeError(() => readWebhookConfig({ ...validEnv, WHATSAPP_PHONE_NUMBER_ID }), 503);
  }
});

test('returns the exact ASCII digit challenge after successful token verification', () => {
  assert.equal(verifyChallenge(query(), VERIFY_TOKEN), '123456789');
  assert.equal(verifyChallenge(query({ 'hub.challenge': '000001' }), VERIFY_TOKEN), '000001');
  assert.equal(verifyChallenge(query({ 'hub.challenge': '9'.repeat(128) }), VERIFY_TOKEN), '9'.repeat(128));
});

test('rejects incorrect or missing verification tokens with safe authentication errors', () => {
  for (const value of ['wrong-token', '', 'sensitive-input-sentinel', 'x'.repeat(4097), VERIFY_TOKEN + '\r\n']) {
    assertSafeError(() => verifyChallenge(query({ 'hub.verify_token': value }), VERIFY_TOKEN), 401);
  }
  const missing = query();
  missing.delete('hub.verify_token');
  assertSafeError(() => verifyChallenge(missing, VERIFY_TOKEN), 401);
  assertSafeError(() => verifyChallenge(query(), undefined), 503);
});

test('rejects invalid mode, non-digit/long challenge, malformed query objects and duplicates', () => {
  for (const values of [{ 'hub.mode': 'unsubscribe' }, { 'hub.mode': 'Subscribe' }, { 'hub.challenge': '' }, { 'hub.challenge': '9'.repeat(129) }, { 'hub.challenge': '１２３' }, { 'hub.challenge': '123\n' }, { 'hub.challenge': '<script>' }]) {
    assertSafeError(() => verifyChallenge(query(values), VERIFY_TOKEN), 400);
  }
  for (const name of ['hub.mode', 'hub.verify_token', 'hub.challenge', 'extra']) {
    const params = query();
    params.append(name, 'duplicate');
    if (name === 'extra') params.append(name, 'duplicate');
    assertSafeError(() => verifyChallenge(params, VERIFY_TOKEN), 400);
  }
  assertSafeError(() => verifyChallenge({}, VERIFY_TOKEN), 400);
});

test('validates exact raw-body HMAC signatures, including Unicode bytes', () => {
  const body = Buffer.from('{"synthetic":"Café ☕"}', 'utf8');
  assert.equal(verifySignature(body, signature(body), APP_SECRET), true);
  assert.equal(verifySignature(body, signature(body).slice(0, 7) + signature(body).slice(7).toUpperCase(), APP_SECRET), true);
  assert.equal(verifySignature(new Uint8Array(body), signature(body), APP_SECRET), true);
  assert.equal(verifySignature(Buffer.alloc(0), signature(Buffer.alloc(0)), APP_SECRET), true);
  assert.equal(verifySignature(Buffer.from(body.toString().replace('Café', 'Cafe')), signature(body), APP_SECRET), false);
  assert.equal(verifySignature(body, signature(body, 'different-synthetic-app-secret'), APP_SECRET), false);
  assert.equal(verifySignature(body.toString(), signature(body), APP_SECRET), false);
});

test('rejects malformed signatures and invalid app secrets without throwing', () => {
  const body = Buffer.from('{}');
  for (const header of [undefined, null, [], '', 'sha1=' + 'a'.repeat(64), 'SHA256=' + 'a'.repeat(64), 'sha256=' + 'g'.repeat(64), 'sha256=' + 'a'.repeat(63), 'sha256=' + 'a'.repeat(65), ' ' + signature(body), signature(body) + '\n', signature(body) + ', ' + signature(body)]) {
    assert.equal(verifySignature(body, header, APP_SECRET), false);
  }
  for (const secret of [undefined, '', 'short', 'replace_with_your_app_secret']) {
    assert.equal(verifySignature(body, signature(body), secret), false);
  }
});

test('summarizes Meta call/message notifications as fixed aggregate counts only', () => {
  const raw = payload([
    event('calls', [{ id: 'sensitive-input-sentinel', from: '+10000000000', session: { sdp: 'sensitive SDP' }, event: 'connect' }]),
    event('messages', [{ text: { body: 'sensitive message' } }, { text: { body: 'another message' } }]),
    { field: 'account_update', value: { arbitrary: 'sensitive metadata' } },
  ]);
  assert.deepEqual(summarizeWebhook(raw, PHONE_ID), { entries: 1, changes: 3, calls: 1, messages: 2, ignoredChanges: 1 });
  assert.equal(JSON.stringify(summarizeWebhook(raw)).includes('sensitive'), false);
  assert.deepEqual(raw.entry[0].changes[0].value.calls[0].session, { sdp: 'sensitive SDP' });
});

test('ignores different/missing phone IDs, status-only notifications and non-WhatsApp products', () => {
  const changes = [
    event('calls', [{}], '999999999999999'),
    { field: 'calls', value: { calls: [{}] } },
    { field: 'messages', value: { metadata: { phone_number_id: PHONE_ID }, statuses: [{ status: 'delivered' }] } },
    { field: 'calls', value: { metadata: { phone_number_id: PHONE_ID }, messaging_product: 'other', calls: [{}] } },
  ];
  assert.deepEqual(summarizeWebhook(payload(changes), PHONE_ID), { entries: 1, changes: 4, calls: 0, messages: 0, ignoredChanges: 4 });
});

test('accepts empty and batched envelopes without retaining event content', () => {
  assert.deepEqual(summarizeWebhook({ object: 'whatsapp_business_account', entry: [] }), { entries: 0, changes: 0, calls: 0, messages: 0, ignoredChanges: 0 });
  const raw = payload([event('calls', [{}])]);
  raw.entry.push({ changes: [event('messages', [{}])] });
  assert.deepEqual(summarizeWebhook(raw), { entries: 2, changes: 2, calls: 1, messages: 1, ignoredChanges: 0 });
});

test('rejects malformed envelopes and bounded-array violations using safe errors', () => {
  for (const raw of [null, [], {}, { object: 'other', entry: [] }, { object: 'whatsapp_business_account', entry: {} }, { object: 'whatsapp_business_account', entry: Array(1001).fill({ changes: [] }) }, payload(null), payload([null]), payload([{ field: 'calls', value: null }]), payload([event('calls', 'sensitive-input-sentinel')]), payload([event('messages', [null])]), payload(Array(1001).fill({ field: 'unused' })), payload([event('calls', Array(1001).fill({}))])]) {
    assertSafeError(() => summarizeWebhook(raw), 400);
  }
  assertSafeError(() => summarizeWebhook(payload(), 'sensitive-input-sentinel'), 503);
});
