/**
 * Test stand-in for the ML service, used by tests/ml.test.js.
 * It answers /transcribe, /interpret-command, /parse-receipt, /ask and /insights with simple
 * canned logic, in the same request and response shapes the real service is expected to use.
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
  sugar: ['sugar', 'suga'],
};

const parseContext = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

const findProduct = (text, products = []) => {
  const lower = text.toLowerCase();
  return products.find((p) => {
    const name = p.name.toLowerCase();
    if (lower.includes(name)) return true;
    return Object.entries(PRODUCT_SYNONYMS).some(
      ([key, words]) => name.includes(key) && words.some((w) => lower.includes(w))
    );
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

const createMockMlApp = () => {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Optional shared-secret check, mirrors ML_API_KEY on the backend
  app.use((req, res, next) => {
    const expected = process.env.MOCK_ML_API_KEY;
    if (expected && req.get('X-API-Key') !== expected) {
      return res.status(401).json({ error: 'invalid API key' });
    }
    next();
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', mock: true }));

  app.post('/transcribe', upload.single('audio'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'audio file is required' });
    const language = req.body.language || 'en';
    res.json({
      transcript: CANNED_TRANSCRIPTS[language] || CANNED_TRANSCRIPTS.en,
      language,
      confidence: 0.91,
    });
  });

  app.post('/interpret-command', (req, res) => {
    const { text = '', language = 'en', context = {} } = req.body;
    const lower = text.toLowerCase();
    const product = findProduct(text, context.products);
    const amount = parseAmount(text);

    // Debt repayment: "<customer> paid me 5000"
    const repayment = lower.match(/^(.+?)\s+(?:paid me|paid back|repaid)\b/);
    if (repayment) {
      const spoken = repayment[1].trim();
      const customer = (context.customers || []).find((c) => c.name.toLowerCase().includes(spoken));
      return res.json({
        intent: 'record_debt_payment',
        language,
        transcript: text,
        entities: { customer: customer ? customer.name : spoken, totalAmount: amount },
        confidence: customer ? 0.88 : 0.45,
        confirmationMessage: `Record payment of ₦${(amount || 0).toLocaleString()} from ${customer ? customer.name : spoken}?`,
      });
    }

    if (/bought|buy|restock|mo ra|na sayi|azụtara/.test(lower)) {
      const quantity = parseQuantity(text);
      return res.json({
        intent: 'add_inventory',
        language,
        transcript: text,
        entities: {
          product: product ? product.name : 'Unknown product',
          productId: product ? product.id : null,
          quantity,
          unit: /carton/.test(lower) ? 'carton' : 'bag',
          totalAmount: amount,
          unitCost: amount ? Math.round(amount / quantity) : null,
        },
        confidence: product ? 0.93 : 0.4,
        confirmationMessage: `Add ${quantity} of ${product ? product.name : 'this product'}${
          amount ? ` at ₦${Math.round(amount / quantity).toLocaleString()} each` : ''
        }?`,
      });
    }

    if (/sold|sell|mo ta|na sayar/.test(lower)) {
      const quantity = parseQuantity(text);
      const credit = /credit|owe|gbese|bashi/.test(lower);
      return res.json({
        intent: 'record_sale',
        language,
        transcript: text,
        entities: {
          product: product ? product.name : 'Unknown product',
          productId: product ? product.id : null,
          quantity,
          totalAmount: product ? product.sellingPrice * quantity : amount,
          paymentStatus: credit ? 'unpaid' : 'paid',
        },
        confidence: product ? 0.9 : 0.4,
        confirmationMessage: `Record sale of ${quantity} ${product ? product.name : 'items'}?`,
      });
    }

    if (/paid|spent|expense|mo san|na biya/.test(lower)) {
      const category = /transport|bus|okada/.test(lower) ? 'transport' : /fuel|diesel|nepa|power/.test(lower) ? 'power' : 'other';
      return res.json({
        intent: 'record_expense',
        language,
        transcript: text,
        entities: { category, totalAmount: amount, note: text },
        confidence: amount ? 0.9 : 0.5,
        confirmationMessage: `Record ₦${(amount || 0).toLocaleString()} expense for ${category}?`,
      });
    }

    res.json({
      intent: 'other',
      language,
      transcript: text,
      entities: {},
      confidence: 0.3,
      confirmationMessage: 'Sorry, I did not understand. Please say it again.',
    });
  });

  app.post('/parse-receipt', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'image file is required' });
    const language = req.body.language || 'en';
    const context = parseContext(req.body.context);
    const match = (word) => findProduct(word, context.products);

    const lines = [
      { word: 'rice', fallback: 'Mama Gold Rice 50kg', quantity: 20, unit: 'bag', unitCost: 78000 },
      { word: 'oil', fallback: 'Golden Terra Vegetable Oil 25L', quantity: 10, unit: 'carton', unitCost: 45000 },
      { word: 'indomie', fallback: 'Indomie Super Pack Carton', quantity: 15, unit: 'carton', unitCost: 8200 },
    ];
    const items = lines.map((l) => {
      const product = match(l.word);
      return {
        product: product ? product.name : l.fallback,
        productId: product ? product.id : null,
        quantity: l.quantity,
        unit: l.unit,
        unitCost: l.unitCost,
        subtotal: l.quantity * l.unitCost,
      };
    });
    const total = items.reduce((sum, it) => sum + it.subtotal, 0);

    res.json({
      intent: 'add_inventory',
      language,
      transcript: 'Supplier invoice: Alaba Wholesale Mills Ltd',
      entities: { supplier: 'Alaba Wholesale Mills Ltd', totalAmount: total, items },
      confidence: 0.87,
      confirmationMessage: `Add ${items.length} items from Alaba Wholesale Mills Ltd (₦${total.toLocaleString()}) to inventory?`,
    });
  });

  app.post('/ask', (req, res) => {
    const { query = '', language = 'en', context = {} } = req.body;
    const product = findProduct(query, context.inventory);

    if (product) {
      return res.json({
        answer: `[mock-ml] You have ${product.currentStock} ${product.unit}(s) of ${product.name}, about ${product.daysOfStockLeft} days of stock.`,
        language,
        category: 'stock_inquiry',
        data: { productId: product.id, currentStock: product.currentStock, daysOfStockLeft: product.daysOfStockLeft },
      });
    }
    if (/profit/.test(query.toLowerCase()) && context.profit) {
      return res.json({
        answer: `[mock-ml] Your net profit for the last 30 days is ₦${context.profit.netProfit.toLocaleString()}.`,
        language,
        category: 'profit_inquiry',
        data: context.profit,
      });
    }
    res.json({ answer: '[mock-ml] I can answer questions about stock, profit and debts.', language, category: 'general_assistant', data: {} });
  });

  app.post('/insights', (req, res) => {
    const { language = 'en', context = {} } = req.body;
    const products = (context.salesRate && context.salesRate.products) || [];
    const insights = products
      .filter((p) => p.daysOfStockLeft !== null && p.daysOfStockLeft < 10)
      .slice(0, 2)
      .map((p) => ({
        key: `restock_before_weekend:${p.productId}`,
        type: 'restock',
        title: `[mock-ml] Order ${p.name} this week`,
        message: `[mock-ml] ${p.name} will run out in about ${Math.round(p.daysOfStockLeft)} days. Order before Friday.`,
        severity: p.daysOfStockLeft < 3 ? 'warning' : 'info',
        data: { productId: p.productId, daysOfStockLeft: p.daysOfStockLeft },
      }));
    res.json({ language, insights });
  });

  return app;
};


module.exports = { createMockMlApp };
