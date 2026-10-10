const mongoose = require('mongoose');
const Product = require('../products/productModel');
const Customer = require('../debts/customerModel');
const Debt = require('../debts/debtModel');
const { getStockSummary } = require('../inventory/stockService');
const { getDashboardMetrics } = require('../dashboard/financialService');
const { getDebtLedger } = require('../debts/debtService');
const { escapeRegex } = require('../../common/utils/regex');
const mlService = require('./mlService');
const localAi = require('./localAiService');

/**
 * AI orchestration: try the ML service first, fall back to the local rule-based parser.
 * Whatever produced the proposal, it is normalised to the agreed AI action schema and its
 * product / customer / debt names are resolved to this business's database ids.
 */

const INTENTS = [
  'add_inventory',
  'record_sale',
  'record_expense',
  'query',
  'record_debt_payment',
  'affordability_check',
  'other',
];
const LANGUAGES = ['en', 'yo', 'ha', 'ig'];

const getConfidenceThreshold = () => Number(process.env.ML_CONFIDENCE_THRESHOLD) || 0.6;

const toNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[₦,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const logFallback = (operation, err) => {
  console.warn(`[ai] ML ${operation} failed, using local fallback: ${err.message}`);
};

/** Product and customer names the ML service can match spoken words against */
const buildCatalogContext = async (businessId) => {
  const [products, customers] = await Promise.all([
    Product.find({ businessId }).select('name unit category sellingPrice costPrice currentStock'),
    Customer.find({ businessId }).select('name'),
  ]);
  return {
    businessId: String(businessId),
    currency: 'NGN',
    products: products.map((p) => ({
      id: String(p._id),
      name: p.name,
      unit: p.unit,
      category: p.category,
      sellingPrice: p.sellingPrice,
      costPrice: p.costPrice,
      currentStock: p.currentStock,
    })),
    customers: customers.map((c) => ({ id: String(c._id), name: c.name })),
  };
};

/** Business data snapshot so the ML service can answer "Ask My Business" questions */
const buildBusinessSnapshot = async (businessId) => {
  const [metrics, stock, debts] = await Promise.all([
    getDashboardMetrics(businessId, '30d'),
    getStockSummary(businessId),
    getDebtLedger(businessId),
  ]);
  return {
    businessId: String(businessId),
    currency: 'NGN',
    period: 'last_30_days',
    revenue: metrics.revenue,
    expenses: metrics.expenses,
    profit: metrics.profit,
    cashPosition: metrics.cashPosition,
    inventory: stock.products.map((p) => ({
      id: String(p._id),
      name: p.name,
      unit: p.unit,
      currentStock: p.currentStock,
      minimumStock: p.minimumStock,
      sellingPrice: p.sellingPrice,
      costPrice: p.costPrice,
      daysOfStockLeft: p.daysOfStockLeft,
      status: p.status,
    })),
    debts: {
      totalOutstanding: debts.totalOutstandingAmount,
      activeDebtors: debts.activeDebtorsCount,
      debtors: debts.debts
        .filter((d) => d.balanceRemaining > 0)
        .map((d) => ({ customer: d.customer.name, balance: d.balanceRemaining, daysOutstanding: d.daysOutstanding })),
    },
  };
};

const normalizeItem = (item = {}) => {
  const quantity = toNumber(item.quantity);
  const unitCost = toNumber(item.unitCost);
  const subtotal = toNumber(item.subtotal) ?? (quantity && unitCost ? quantity * unitCost : null);
  return {
    productName: item.productName || item.product || null,
    productId: item.productId || null,
    quantity,
    unit: item.unit || 'piece',
    unitCost: unitCost ?? (quantity && subtotal ? Math.round(subtotal / quantity) : null),
    subtotal,
  };
};

/** Coerce an ML response into the AI action schema; never trust it as-is */
const normalizeAction = (raw = {}, language) => {
  const entities = { ...(raw.entities || {}) };
  for (const key of ['quantity', 'totalAmount', 'amountPaid', 'unitCost']) {
    if (key in entities) entities[key] = toNumber(entities[key]);
  }
  if (!entities.unitCost && entities.quantity && entities.totalAmount) {
    entities.unitCost = Math.round(entities.totalAmount / entities.quantity);
  }
  if (Array.isArray(entities.items)) {
    entities.items = entities.items.map(normalizeItem);
    if (!entities.totalAmount) {
      entities.totalAmount = entities.items.reduce((sum, it) => sum + (it.subtotal || 0), 0);
    }
  }

  const confidence = toNumber(raw.confidence);
  const intent = INTENTS.includes(raw.intent) ? raw.intent : 'other';

  return {
    intent,
    language: LANGUAGES.includes(raw.language) ? raw.language : language,
    transcript: raw.transcript || '',
    entities,
    confidence: confidence === null ? 0.5 : Math.min(1, Math.max(0, confidence)),
    confirmationMessage:
      raw.confirmationMessage ||
      (intent === 'other' ? 'Sorry, I did not understand that. Please try again.' : `Confirm ${intent.replace(/_/g, ' ')}?`),
    suggestedAction: raw.suggestedAction || {},
  };
};

const findProduct = async (businessId, productId, name) => {
  if (productId && mongoose.isValidObjectId(productId)) {
    const byId = await Product.findOne({ _id: productId, businessId });
    if (byId) return byId;
  }
  if (!name) return null;
  return (
    (await Product.findOne({ businessId, name: new RegExp(`^${escapeRegex(name)}$`, 'i') })) ||
    (await Product.findOne({ businessId, name: new RegExp(escapeRegex(name), 'i') }))
  );
};

/** Map names to this business's ids (ids from the ML service are re-checked, never trusted) */
const resolveEntities = async (businessId, action) => {
  const { entities } = action;

  if (entities.product || entities.productId) {
    const product = await findProduct(businessId, entities.productId, entities.product);
    entities.productId = product ? product._id : null;
    if (product) entities.product = product.name;
  }

  if (Array.isArray(entities.items)) {
    for (const item of entities.items) {
      const product = await findProduct(businessId, item.productId, item.productName);
      item.productId = product ? product._id : null;
      if (product) item.productName = product.name;
    }
  }

  if (entities.customer || entities.customerId) {
    let customer = null;
    if (entities.customerId && mongoose.isValidObjectId(entities.customerId)) {
      customer = await Customer.findOne({ _id: entities.customerId, businessId });
    }
    if (!customer && entities.customer) {
      customer = await Customer.findOne({ businessId, name: new RegExp(escapeRegex(entities.customer), 'i') });
    }
    entities.customerId = customer ? customer._id : null;
    if (customer) entities.customer = customer.name;
  }

  if (action.intent === 'record_debt_payment' && !entities.debtId && entities.customerId) {
    const openDebt = await Debt.findOne({
      businessId,
      customerId: entities.customerId,
      status: { $ne: 'paid' },
    }).sort({ createdDate: 1 });
    entities.debtId = openDebt ? openDebt._id : null;
  }

  return action;
};

const withReviewFlag = (action) => ({
  ...action,
  lowConfidence: action.confidence < getConfidenceThreshold(),
});

/**
 * Speech-to-text. Returns { transcript, language, confidence, engine } or null when the
 * audio cannot be transcribed (the local fallback has no speech recognition).
 */
const transcribeAudio = async (file, language) => {
  if (!file || !mlService.isEnabled()) return null;
  try {
    const result = await mlService.transcribe({ file, language });
    if (!result || !result.transcript) return null;
    return {
      transcript: String(result.transcript),
      language: LANGUAGES.includes(result.language) ? result.language : language,
      confidence: toNumber(result.confidence) ?? 0.5,
      engine: 'ml',
    };
  } catch (err) {
    logFallback('transcribe', err);
    return null;
  }
};

/** Text (typed or transcribed) -> proposed action */
const interpretCommand = async (businessId, text, language) => {
  let action = null;
  let engine = 'local';

  if (mlService.isEnabled()) {
    try {
      const context = await buildCatalogContext(businessId);
      action = normalizeAction(await mlService.interpretCommand({ text, language, context }), language);
      engine = 'ml';
    } catch (err) {
      logFallback('interpret-command', err);
    }
  }
  if (!action) {
    action = normalizeAction(await localAi.parseCommandNLP(businessId, text, language), language);
  }

  action.transcript = action.transcript || text;
  await resolveEntities(businessId, action);
  return withReviewFlag({ ...action, engine });
};

/** Receipt photo -> proposed add_inventory action with line items */
const parseReceipt = async (businessId, { file, language, receiptData }) => {
  let action = null;
  let engine = 'local';

  if (file && mlService.isEnabled()) {
    try {
      const context = await buildCatalogContext(businessId);
      action = normalizeAction(await mlService.parseReceipt({ file, language, context }), language);
      engine = 'ml';
    } catch (err) {
      logFallback('parse-receipt', err);
    }
  }
  if (!action) {
    // Local fallback cannot read images: it returns the rehearsed demo invoice
    action = normalizeAction(await localAi.parseReceipt(businessId, receiptData), language);
  }

  await resolveEntities(businessId, action);
  return withReviewFlag({ ...action, engine });
};

/** "Ask My Business" question -> plain-language answer (no data changed) */
const askMyBusiness = async (businessId, query, language) => {
  if (mlService.isEnabled()) {
    try {
      const context = await buildBusinessSnapshot(businessId);
      const result = await mlService.ask({ query, language, context });
      if (result && result.answer) {
        return {
          query,
          language: LANGUAGES.includes(result.language) ? result.language : language,
          category: result.category || 'general_assistant',
          answer: String(result.answer),
          data: result.data || {},
          engine: 'ml',
        };
      }
      throw new Error('response had no "answer"');
    } catch (err) {
      logFallback('ask', err);
    }
  }
  const local = await localAi.answerAskMyBusiness(businessId, query, language);
  return { ...local, engine: 'local' };
};

module.exports = {
  resolveEntities,
  transcribeAudio,
  interpretCommand,
  parseReceipt,
  askMyBusiness,
};
