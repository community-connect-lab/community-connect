import { WebhookError, readWebhookConfig, summarizeWebhook } from './whatsapp-webhook.mjs';

export class CallingError extends Error {
  constructor(code, message, status = 400, diagnostic) {
    super(message);
    this.name = 'CallingError';
    this.code = code;
    this.status = status;
    const safe = safeCallingDiagnostic(diagnostic);
    if (Object.keys(safe).length) this.diagnostic = Object.freeze(safe);
  }
}

const callFailureMessages = Object.freeze({
  CALL_API_AUTH: 'Meta could not authenticate the Calling action. Check the backend WhatsApp token.',
  CALL_API_PERMISSION: 'Meta did not permit the Calling action. Check messaging permission and access to this number.',
  CALL_API_REJECTED: 'Meta rejected the Calling action. Check the safe diagnostic codes.',
  CALL_API_TIMEOUT: 'Meta did not confirm the Calling action before the deadline. Use Hang up for cleanup.',
  CALL_API_NETWORK: 'The Calling request could not be confirmed over the network. Use Hang up for cleanup.',
  CALL_ACTION_UNCONFIRMED: 'Meta did not confirm the call action. Use Hang up to clean up; do not retry Answer.',
});

export function safeCallFailureCode(code) {
  return Object.hasOwn(callFailureMessages, code) ? code : 'CALL_ACTION_UNCONFIRMED';
}

export function safeCallingDiagnostic(value) {
  const safe = {};
  if (!value || typeof value !== 'object') return safe;
  // Do not copy raw Meta messages, details, trace IDs, identifiers or request data.
  for (const name of ['action', 'httpStatus', 'metaCode', 'metaSubcode']) {
    const property = Object.getOwnPropertyDescriptor(value, name);
    if (!property || !Object.hasOwn(property, 'value')) continue;
    const item = property.value;
    if (name === 'action') {
      if (['pre_accept', 'accept', 'reject', 'terminate'].includes(item)) safe.action = item;
    } else if (Number.isInteger(item) && item >= (name === 'httpStatus' ? 100 : 0) && item <= (name === 'httpStatus' ? 599 : 999999999)) safe[name] = item;
  }
  return safe;
}

function callFailure(code, diagnostic) {
  const safeCode = safeCallFailureCode(code);
  return new CallingError(safeCode, callFailureMessages[safeCode], 502, diagnostic);
}

const placeholder = /replace[_ -]?with|your[_ -].*(?:token|secret)|placeholder|change[_ -]?me|<[^>]+>/i;
const configHints = Object.freeze({
  WHATSAPP_VERIFY_TOKEN: 'Check the existing verification token: at least 32 characters and no placeholder or line breaks.',
  WHATSAPP_APP_SECRET: 'Set this app\'s secret: at least 16 characters and no placeholder or line breaks.',
  WHATSAPP_PHONE_NUMBER_ID: 'Set the numeric Phone number ID from API Setup, not a telephone number or WABA ID.',
  PORT: 'Use a numeric port between 1 and 65535.',
  WHATSAPP_ACCESS_TOKEN: 'Set the backend WhatsApp Graph API token, at least 16 characters, without whitespace or a placeholder.',
  AGENT_ACCESS_TOKEN: 'Set a separate random token of at least 32 characters, without whitespace or a placeholder; do not reuse another token or app secret.',
  WHATSAPP_GRAPH_VERSION: 'Use a Graph version such as v26.0.',
  CALLING_PUBLIC_ORIGIN: 'Use the exact HTTPS service origin, without a path, credentials, query or fragment; HTTP is allowed only on localhost.',
});
const invalidConfig = field => new CallingError('CALLING_CONFIG_ERROR', Object.hasOwn(configHints, field) ? `${field}: ${configHints[field]}` : 'Calling configuration is missing or invalid. Check the server environment.', 503);
function secret(value, minimum, field) {
  if (typeof value !== 'string' || value.length < minimum || value.length > 4096 || /\s/.test(value) || placeholder.test(value)) throw invalidConfig(field);
  return value;
}

export function callingEnvironment(env = process.env, local = {}) {
  const result = {};
  for (const key of ['WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_GRAPH_VERSION', 'AGENT_ACCESS_TOKEN', 'CALLING_PUBLIC_ORIGIN']) {
    result[key] = env[key] ?? local[key];
  }
  result.PORT = env.PORT ?? env.CALLING_PORT ?? local.CALLING_PORT ?? '10000';
  return result;
}

export function readCallingConfig(env) {
  let webhook;
  try { webhook = readWebhookConfig(env); } catch (error) {
    if (error instanceof WebhookError) throw invalidConfig(error.configField);
    throw error;
  }
  if (!webhook.phoneNumberId) throw invalidConfig('WHATSAPP_PHONE_NUMBER_ID');
  const accessToken = secret(env.WHATSAPP_ACCESS_TOKEN, 16, 'WHATSAPP_ACCESS_TOKEN');
  const agentAccessToken = secret(env.AGENT_ACCESS_TOKEN, 32, 'AGENT_ACCESS_TOKEN');
  if (accessToken === agentAccessToken || agentAccessToken === webhook.verifyToken || agentAccessToken === webhook.appSecret) throw invalidConfig('AGENT_ACCESS_TOKEN');
  const graphVersion = env.WHATSAPP_GRAPH_VERSION || 'v26.0';
  if (!/^v[0-9]{1,3}\.[0-9]{1,2}$/.test(graphVersion)) throw invalidConfig('WHATSAPP_GRAPH_VERSION');
  let origin;
  try { origin = new URL(env.CALLING_PUBLIC_ORIGIN); } catch { throw invalidConfig('CALLING_PUBLIC_ORIGIN'); }
  const local = origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if ((!local && origin.protocol !== 'https:') || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw invalidConfig('CALLING_PUBLIC_ORIGIN');
  return { ...webhook, accessToken, agentAccessToken, graphVersion, publicOrigin: origin.origin };
}

export function validateSdp(sdp) {
  const media = typeof sdp === 'string' ? sdp.split(/\r?\n/).filter(line => line.startsWith('m=')) : [];
  if (typeof sdp !== 'string' || Buffer.byteLength(sdp, 'utf8') > 65536 || !/^v=0\r?\n/.test(sdp) || media.length !== 1 || !/^m=audio (?!0(?: |$))[0-9]+ /.test(media[0]) || sdp.includes('\0')) {
    throw new CallingError('INVALID_AUDIO_SESSION', 'A valid audio-only WebRTC session is required.');
  }
  return sdp;
}

function callId(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\x00-\x20\x7f]/.test(value)) {
    throw new CallingError('INVALID_CALL_EVENT', 'The call event is invalid.');
  }
  return value;
}

// Called only after raw-body signature validation. Return no contacts or numbers.
export function parseCallingEvents(payload, phoneNumberId, { now = Date.now } = {}) {
  summarizeWebhook(payload, phoneNumberId);
  const events = [];
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const value = change.value;
      if (change.field !== 'calls' || value?.metadata?.phone_number_id !== phoneNumberId || (value.messaging_product && value.messaging_product !== 'whatsapp')) continue;
      for (const call of value.calls || []) {
        if (call.direction === 'BUSINESS_INITIATED') continue;
        if (call.event === 'terminate') events.push({ kind: 'terminate', callId: callId(call.id) });
        else if (call.event === 'connect') {
          // The documented inbound connect example omits direction and contacts.
          if (call.session?.sdp_type !== 'offer') continue;
          const timestamp = /^[0-9]{1,13}$/.test(String(call.timestamp ?? '')) ? Number(call.timestamp) * 1000 : NaN;
          // Old retries must not ring again after process restart loses tombstones.
          if (!Number.isFinite(timestamp) || now() - timestamp > 60000 || timestamp - now() > 30000) continue;
          events.push({ kind: 'connect', callId: callId(call.id), offerSdp: validateSdp(call.session.sdp) });
        }
      }
    }
  }
  return events;
}

export function createCallingClient(config, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  return async function sendAction(action, { callId: id, sdp } = {}) {
    if (!['pre_accept', 'accept', 'reject', 'terminate'].includes(action)) throw new CallingError('INVALID_CALL_ACTION', 'Unsupported call action.');
    const body = { messaging_product: 'whatsapp', call_id: callId(id), action };
    if (action === 'pre_accept' || action === 'accept') body.session = { sdp_type: 'answer', sdp: validateSdp(sdp) };
    const controller = new AbortController();
    let timedOut = false;
    let diagnostic = { action };
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetchImpl(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/calls`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      diagnostic = safeCallingDiagnostic({ action, httpStatus: response.status });
      let size = 0;
      const chunks = [];
      if (response.body) {
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 65536) { controller.abort(); throw callFailure('CALL_ACTION_UNCONFIRMED', diagnostic); }
          chunks.push(Buffer.from(chunk));
        }
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw callFailure('CALL_ACTION_UNCONFIRMED', diagnostic); }
      if (!response.ok || data?.success !== true) {
        const code = data?.error?.code;
        diagnostic = safeCallingDiagnostic({ ...diagnostic, metaCode: code, metaSubcode: data?.error?.error_subcode });
        if (code === 190) throw callFailure('CALL_API_AUTH', diagnostic);
        if ([10, 200].includes(code) || response.status === 403) throw callFailure('CALL_API_PERMISSION', diagnostic);
        throw callFailure(response.ok ? 'CALL_ACTION_UNCONFIRMED' : 'CALL_API_REJECTED', diagnostic);
      }
      return { success: true };
    } catch (error) {
      if (error instanceof CallingError) throw error;
      throw callFailure(timedOut ? 'CALL_API_TIMEOUT' : 'CALL_API_NETWORK', diagnostic);
    } finally { clearTimeout(timer); }
  };
}
