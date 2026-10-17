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
  timeoutMs: Number(process.env.ML_TIMEOUT_MS) || 30000, // speech and LLM calls can be slow on a cold start
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

/*
 * The ML service's API (see its /docs) uses snake_case and its own response shapes.
 * The functions below translate to and from the backend's AI action format, so the rest of the
 * backend does not depend on the ML service's field names.
 */

const SEVERITIES = { critical: 'critical', high: 'critical', warning: 'warning', medium: 'warning' };

const dropEmpty = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));

const toCatalogue = (context = {}) => (context.products || []).map((p) => ({ id: String(p.id), name: p.name }));

/** ML ActionProposal -> backend AI action */
const fromProposal = (p = {}) => {
  const e = p.entities || {};
  return {
    intent: p.intent === 'unknown' ? 'other' : p.intent,
    language: p.language,
    transcript: p.transcript,
    entities: dropEmpty({
      product: e.matched_product_name || e.product,
      productId: e.matched_product_id,
      quantity: e.quantity,
      unit: e.unit,
      totalAmount: e.total_amount,
      unitCost: e.unit_cost,
      customer: e.customer,
      category: e.category,
      paymentStatus: e.paid === false ? 'unpaid' : e.paid === true ? 'paid' : undefined,
    }),
    confidence: p.confidence,
    confirmationMessage: p.confirmation_message,
    missingFields: p.missing_fields || [],
  };
};

/** ML ReceiptResponse -> backend add_inventory action */
const fromReceipt = (r = {}, language) => {
  const items = (r.items || []).map((i) =>
    dropEmpty({
      product: i.name,
      productId: i.matched_product_id,
      quantity: i.quantity,
      unit: i.unit,
      unitCost: i.unit_price,
      subtotal: i.line_total,
    })
  );
  const supplier = r.supplier || null;
  return {
    intent: 'add_inventory',
    language,
    transcript: supplier ? `Supplier invoice: ${supplier}` : 'Supplier invoice',
    entities: dropEmpty({ supplier, totalAmount: r.total, items }),
    confidence: r.confidence,
    confirmationMessage:
      r.confirmation_message ||
      `Add ${items.length} item(s)${supplier ? ` from ${supplier}` : ''} to inventory${r.total ? ` (Total: ₦${Number(r.total).toLocaleString('en-NG')})` : ''}?`,
    warnings: r.warnings || [],
  };
};

const titleFromType = (type = 'insight') => {
  const words = String(type).replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Speech-to-text (N-ATLaS ASR). Returns { transcript, language, confidence } */
const transcribe = ({ file, language }) =>
  post('/transcribe', { file: { ...file, field: 'audio' }, fields: { language } });

/** Text command -> backend AI action */
const interpretCommand = async ({ text, language, context }) =>
  fromProposal(
    await post('/interpret', {
      json: { text, language, business_id: context && context.businessId, catalogue: toCatalogue(context) },
    })
  );

/** Receipt / invoice photo -> backend add_inventory action with entities.items[] */
const parseReceipt = async ({ file, language, context }) =>
  fromReceipt(
    await post('/parse-receipt', {
      file: { ...file, field: 'image' },
      fields: {
        business_id: context && context.businessId,
        catalogue_json: JSON.stringify(toCatalogue(context)),
      },
    }),
    language
  );

/** "Ask My Business": question + BusinessSnapshot -> { answer, language, category, data } */
const ask = async ({ query, language, snapshot }) => {
  const res = await post('/ask', {
    json: { question: query, language, business_id: snapshot && snapshot.business_id, snapshot },
  });
  return { answer: res.answer, language: res.language, category: 'general_assistant', data: res.facts_used || {} };
};

/** BusinessSnapshot -> { insights: [{ key, type, title, message, severity, data }] } */
const insights = async ({ snapshot }) => {
  const res = await post('/insights', { json: { snapshot } });
  return {
    insights: (res.alerts || []).map((a) => ({
      key: `${a.type}:${a.product_id || 'business'}`,
      type: a.type,
      title: titleFromType(a.type),
      message: a.message,
      severity: SEVERITIES[String(a.severity).toLowerCase()] || 'info',
      data: a.product_id ? { productId: a.product_id } : {},
    })),
  };
};

/** BusinessSnapshot (+ optional purchase price) -> stock days left, cash-flow forecast, health score, affordability */
const forecast = ({ snapshot, purchasePrice }) =>
  post('/forecast', { json: { snapshot, purchase_price: purchasePrice ?? null } });

module.exports = {
  isEnabled,
  resetAvailability,
  transcribe,
  interpretCommand,
  parseReceipt,
  ask,
  insights,
  forecast,
};
