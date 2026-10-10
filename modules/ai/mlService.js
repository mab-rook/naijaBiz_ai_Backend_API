const fs = require('fs');
const path = require('path');

/**
 * HTTP client for the ML engineer's "AI Business Brain" service.
 *
 * Every call throws on failure; aiService.js catches it and falls back to localAiService.js.
 * After a network error, timeout or 5xx, the ML service is skipped for ML_COOLDOWN_MS so a
 * dead service does not add a timeout to every merchant request during the demo.
 */

let unavailableUntil = 0;

const getConfig = () => ({
  baseUrl: (process.env.ML_SERVICE_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.ML_API_KEY || '',
  timeoutMs: Number(process.env.ML_TIMEOUT_MS) || 15000,
  cooldownMs: Number(process.env.ML_COOLDOWN_MS) || 60000,
});

const isEnabled = () => Boolean(getConfig().baseUrl) && Date.now() >= unavailableUntil;

const markUnavailable = () => {
  unavailableUntil = Date.now() + getConfig().cooldownMs;
};

// Used by tests to reset the circuit breaker between scenarios
const resetAvailability = () => {
  unavailableUntil = 0;
};

const post = async (endpoint, { json, file, fields = {} }) => {
  const { baseUrl, apiKey, timeoutMs } = getConfig();
  if (!baseUrl) throw new Error('ML_SERVICE_URL is not configured');

  const headers = {};
  if (apiKey) headers['X-API-Key'] = apiKey;

  let body;
  if (file) {
    body = new FormData();
    const blob = await fs.openAsBlob(file.path, { type: file.mimetype || 'application/octet-stream' });
    body.append(file.field, blob, file.originalname || path.basename(file.path));
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      body.append(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }

  let res;
  try {
    res = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    markUnavailable();
    throw new Error(`ML service unreachable at ${endpoint}: ${err.message}`);
  }

  if (res.status >= 500) markUnavailable();
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ML service ${endpoint} returned ${res.status} ${detail.slice(0, 200)}`);
  }
  return res.json();
};

/** Speech-to-text (N-ATLaS ASR). Returns { transcript, language, confidence } */
const transcribe = ({ file, language }) =>
  post('/transcribe', { file: { ...file, field: 'audio' }, fields: { language } });

/** Text command -> AI action schema */
const interpretCommand = ({ text, language, context }) =>
  post('/interpret-command', { json: { text, language, context } });

/** Receipt / invoice photo -> AI action schema with intent "add_inventory" and entities.items[] */
const parseReceipt = ({ file, language, context }) =>
  post('/parse-receipt', { file: { ...file, field: 'image' }, fields: { language, context } });

/** "Ask My Business" question + business data snapshot -> { answer, category, data } */
const ask = ({ query, language, context }) => post('/ask', { json: { query, language, context } });

/** Business data snapshot -> { insights: [{ key, type, title, message, messageLocalized?, severity, data? }] } */
const insights = ({ businessId, language, context }) => post('/insights', { json: { businessId, language, context } });

module.exports = {
  isEnabled,
  resetAvailability,
  transcribe,
  interpretCommand,
  parseReceipt,
  ask,
  insights,
};
