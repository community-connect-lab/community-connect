import { WebhookError, readWebhookConfig, summarizeWebhook } from './whatsapp-webhook.mjs';

export class CallingError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CallingError';
    this.code = code;
    this.status = status;
  }
}

const placeholder = /replace[_ -]?with|your[_ -].*(?:token|secret)|placeholder|change[_ -]?me|<[^>]+>/i;
const invalidConfig = () => new CallingError('CALLING_CONFIG_ERROR', 'Calling configuration is missing or invalid. Check the server environment.', 503);
function secret(value, minimum) {
  if (typeof value !== 'string' || value.length < minimum || value.length > 4096 || /\s/.test(value) || placeholder.test(value)) throw invalidConfig();
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
    if (error instanceof WebhookError) throw invalidConfig();
    throw error;
  }
  if (!webhook.phoneNumberId) throw invalidConfig();
  const accessToken = secret(env.WHATSAPP_ACCESS_TOKEN, 16);
  const agentAccessToken = secret(env.AGENT_ACCESS_TOKEN, 32);
  if (accessToken === agentAccessToken || agentAccessToken === webhook.verifyToken || agentAccessToken === webhook.appSecret) throw invalidConfig();
  const graphVersion = env.WHATSAPP_GRAPH_VERSION || 'v26.0';
  if (!/^v[0-9]{1,3}\.[0-9]{1,2}$/.test(graphVersion)) throw invalidConfig();
  let origin;
  try { origin = new URL(env.CALLING_PUBLIC_ORIGIN); } catch { throw invalidConfig(); }
  const local = origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if ((!local && origin.protocol !== 'https:') || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw invalidConfig();
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
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/calls`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let size = 0;
      const chunks = [];
      if (response.body) {
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 65536) { controller.abort(); throw new Error('bounded'); }
          chunks.push(Buffer.from(chunk));
        }
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('invalid'); }
      if (!response.ok || data?.success !== true) {
        const code = data?.error?.code;
        if (code === 190) throw new CallingError('CALL_API_AUTH', 'Meta could not authenticate the Calling action. Check the backend WhatsApp token.', 502);
        if ([10, 200].includes(code)) throw new CallingError('CALL_API_PERMISSION', 'Meta did not permit the Calling action. Check the app and number permissions.', 502);
        throw new Error('unconfirmed');
      }
      return { success: true };
    } catch (error) {
      if (error instanceof CallingError) throw error;
      throw new CallingError('CALL_ACTION_UNCONFIRMED', 'Meta did not confirm the call action. Use Hang up to clean up; do not retry Answer.', 502);
    } finally { clearTimeout(timer); }
  };
}
