/**
 * Test stand-in for the ML service, used by tests/ml.test.js.
 * Same paths and request/response shapes as the real ML service (its /openapi.json):
 * /transcribe, /interpret, /parse-receipt, /ask, /insights, /forecast and /health,
 * with simple canned logic instead of real models.
 */
const express = require('express');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const CANNED_TRANSCRIPTS = {
  en: 'I bought 10 bags of rice for 800,000 naira',
  yo: 'Mo ra apo iresi 10 fun 800000 naira',
  ha: 'Na sayi buhun shinkafa 10 akan 800000 naira',
  ig: 'Azụtara m akpa osikapa 10 maka 800000 naira',
};

const PRODUCT_SYNONYMS = {
  rice: ['rice', 'iresi', 'shinkafa', 'osikapa'],
  oil: ['oil', 'ororo', 'mai'],
  indomie: ['indomie', 'noodle', 'noodles'],
  coke: ['coke', 'coca-cola'],
};

const parseCatalogue = (raw) => {
  if (Array.isArray(raw)) return raw;
  try {
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
};

const findProduct = (text, catalogue = []) => {
  const lower = text.toLowerCase();
  return catalogue.find((p) => {
    const name = p.name.toLowerCase();
    if (lower.includes(name)) return true;
    return Object.entries(PRODUCT_SYNONYMS).some(([key, words]) => name.includes(key) && words.some((w) => lower.includes(w)));
  });
};

const parseAmount = (text) => {
  const lower = text.toLowerCase().replace(/,/g, '');
  const million = lower.match(/(\d+(?:\.\d+)?)\s*million/);
  if (million) return parseFloat(million[1]) * 1000000;
  const numbers = (lower.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  return numbers.length ? Math.max(...numbers) : null;
};

const parseQuantity = (text) => {
  const match = text.replace(/,/g, '').match(/\b(\d{1,4})\b/);
  return match ? parseInt(match[1], 10) : 1;
};

const proposal = (intent, language, transcript, entities, confidence, message) => ({
  intent,
  language,
  transcript,
  entities: {
    product: null, matched_product_id: null, matched_product_name: null, quantity: null, unit: null,
    total_amount: null, unit_cost: null, customer: null, category: null, paid: null,
    ...entities,
  },
  confidence,
  low_confidence: confidence < 0.6,
  missing_fields: [],
  confirmation_message: message,
});

const createMockMlApp = () => {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Same shared-key check as the real service
  app.use((req, res, next) => {
    const expected = process.env.MOCK_ML_API_KEY;
    if (expected && req.get('X-API-Key') !== expected) return res.status(401).json({ detail: 'Invalid API key' });
    next();
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', mock: true }));

  app.post('/transcribe', upload.single('audio'), (req, res) => {
    if (!req.file) return res.status(422).json({ detail: 'audio is required' });
    const language = req.body.language || 'en';
    res.json({ transcript: CANNED_TRANSCRIPTS[language] || CANNED_TRANSCRIPTS.en, language, confidence: 0.91 });
  });

  app.post('/interpret', (req, res) => {
    const { text = '', language = 'en', catalogue = [] } = req.body;
    const lower = text.toLowerCase();
    const product = findProduct(text, catalogue);
    const amount = parseAmount(text);
    const matched = product ? { product: product.name, matched_product_id: product.id, matched_product_name: product.name } : {};

    const repayment = lower.match(/^(.+?)\s+(?:paid me|paid back|repaid)\b/);
    if (repayment) {
      return res.json(proposal('record_debt_payment', language, text, { customer: repayment[1].trim(), total_amount: amount }, 0.88,
        `Record payment of ₦${(amount || 0).toLocaleString()} from ${repayment[1].trim()}?`));
    }
    if (/bought|buy|restock|mo ra|na sayi|azụtara/.test(lower)) {
      const quantity = parseQuantity(text);
      return res.json(proposal('add_inventory', language, text, {
        ...matched, quantity, unit: /carton/.test(lower) ? 'carton' : 'bag', total_amount: amount,
        unit_cost: amount ? Math.round(amount / quantity) : null,
      }, product ? 0.93 : 0.4, `Add ${quantity} of ${product ? product.name : 'this product'}?`));
    }
    if (/sold|sell|mo ta|na sayar/.test(lower)) {
      const quantity = parseQuantity(text);
      return res.json(proposal('record_sale', language, text, { ...matched, quantity, paid: !/credit|owe|gbese|bashi/.test(lower) },
        product ? 0.9 : 0.4, `Record sale of ${quantity} ${product ? product.name : 'items'}?`));
    }
    if (/paid|spent|expense|mo san|na biya/.test(lower)) {
      const category = /transport|bus|okada/.test(lower) ? 'transport' : 'other';
      return res.json(proposal('record_expense', language, text, { category, total_amount: amount }, amount ? 0.9 : 0.5,
        `Record ₦${(amount || 0).toLocaleString()} expense for ${category}?`));
    }
    res.json(proposal('unknown', language, text, {}, 0.3, 'Sorry, I did not understand. Please say it again.'));
  });

  app.post('/parse-receipt', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(422).json({ detail: 'image is required' });
    const catalogue = parseCatalogue(req.body.catalogue_json);
    const lines = [
      { word: 'rice', name: 'Mama Gold Rice 50kg', quantity: 20, unit: 'bag', unit_price: 78000 },
      { word: 'oil', name: 'Golden Terra Vegetable Oil 25L', quantity: 10, unit: 'carton', unit_price: 45000 },
      { word: 'indomie', name: 'Indomie Super Pack Carton', quantity: 15, unit: 'carton', unit_price: 8200 },
    ];
    const items = lines.map((l) => {
      const product = findProduct(l.word, catalogue);
      return { name: l.name, quantity: l.quantity, unit: l.unit, unit_price: l.unit_price, line_total: l.quantity * l.unit_price, matched_product_id: product ? product.id : null };
    });
    const total = items.reduce((sum, it) => sum + it.line_total, 0);
    res.json({ supplier: 'Alaba Wholesale Mills Ltd', items, total, currency: 'NGN', confidence: 0.87, warnings: [], raw_text: '', confirmation_message: '' });
  });

  app.post('/ask', (req, res) => {
    const { question = '', language = 'en', snapshot = {} } = req.body;
    const product = findProduct(question, snapshot.products || []);
    if (product) {
      return res.json({
        answer: `[mock-ml] You have ${product.stock} ${product.unit}(s) of ${product.name}.`,
        language,
        facts_used: { product_id: product.id, stock: product.stock, avg_daily_sales: product.avg_daily_sales },
      });
    }
    res.json({ answer: '[mock-ml] I can answer questions about stock, profit and debts.', language, facts_used: {} });
  });

  app.post('/insights', (req, res) => {
    const products = (req.body.snapshot && req.body.snapshot.products) || [];
    const alerts = products
      .filter((p) => p.avg_daily_sales > 0 && p.stock / p.avg_daily_sales < 10)
      .slice(0, 2)
      .map((p) => ({
        type: 'restock',
        severity: p.stock / p.avg_daily_sales < 3 ? 'high' : 'low',
        message: `[mock-ml] ${p.name} will run out in about ${Math.round(p.stock / p.avg_daily_sales)} days. Order before Friday.`,
        product_id: p.id,
      }));
    res.json({ alerts });
  });

  app.post('/forecast', (req, res) => {
    const { snapshot = {}, purchase_price: price = null } = req.body;
    const flows = snapshot.monthly_net_cashflow || [];
    const avg = flows.length ? flows.reduce((a, b) => a + b, 0) / flows.length : null;
    res.json({
      stock: (snapshot.products || []).map((p) => ({ product_id: p.id, product_name: p.name, days_left: p.avg_daily_sales ? p.stock / p.avg_daily_sales : null, restock_advice: '' })),
      avg_monthly_net_cashflow: avg,
      next_month_net_cashflow: avg,
      health_score: 70,
      affordability: price === null ? null : { can_afford: avg !== null && price <= avg * 0.4, safe_min: 0, safe_max: Math.max(0, (avg || 0) * 0.4), explanation: '[mock-ml]' },
    });
  });

  return app;
};

module.exports = { createMockMlApp };
