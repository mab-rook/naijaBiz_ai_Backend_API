const Joi = require('joi');
const AppError = require('../utils/AppError');

const objectId = Joi.string().pattern(/^[a-f\d]{24}$/i);
const language = Joi.string().valid('en', 'yo', 'ha', 'ig');
const date = Joi.date().iso();
const dateKey = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const nonNegative = Joi.number().min(0);
const positive = Joi.number().greater(0);
const name = Joi.string().trim().min(1).max(200);
const unit = Joi.string().trim().min(1).max(50);
const looseUrl = Joi.string().trim().max(2048).allow('');
const phone = Joi.string().trim().pattern(/^[+()\d .-]{7,24}$/);

const itemSchema = Joi.object({
  productId: objectId,
  productName: name,
  product: name,
  category: Joi.string().trim().max(100),
  quantity: Joi.number().required(),
  unit: unit,
  unitCost: nonNegative,
  unitPrice: nonNegative,
  subtotal: nonNegative,
}).or('productId', 'productName', 'product');

const rangeQuery = {
  from: dateKey,
  to: dateKey,
};

const schemas = {
  authRegister: Joi.object({
    name: name.required(),
    phone: phone.required(),
    password: Joi.string().min(6).max(128).required(),
    businessName: Joi.string().trim().max(200),
    preferredLanguage: language,
    category: Joi.string().trim().max(100),
  }),
  authLogin: Joi.object({
    phone: phone.required(),
    password: Joi.string().min(1).max(128).required(),
  }),
  refresh: Joi.object({
    refreshToken: Joi.string().max(256),
  }),
  logout: Joi.object({
    refreshToken: Joi.string().max(256),
  }),
  language: Joi.object({
    language: language.required(),
  }),
  empty: Joi.object({}),
  productListQuery: Joi.object({
    category: Joi.string().trim().max(100),
    lowStock: Joi.string().valid('true', 'false'),
  }),
  productId: Joi.object({ id: objectId.required() }),
  productCreate: Joi.object({
    name: name.required(),
    category: Joi.string().trim().max(100),
    unit,
    sellingPrice: nonNegative.required(),
    costPrice: nonNegative.required(),
    currentStock: nonNegative,
    minimumStock: nonNegative,
    imageUrl: looseUrl,
  }),
  productUpdate: Joi.object({
    name,
    category: Joi.string().trim().max(100),
    unit,
    sellingPrice: nonNegative,
    costPrice: nonNegative,
    minimumStock: nonNegative,
    imageUrl: looseUrl,
  }).min(1).unknown(true),
  movementCreate: Joi.object({
    productId: objectId.required(),
    type: Joi.string().trim().min(1).required(),
    quantity: Joi.number().required(),
    unitCost: nonNegative,
    note: Joi.string().trim().max(500),
  }),
  movementQuery: Joi.object({
    productId: objectId,
    type: Joi.string().valid('purchase', 'sale', 'damaged', 'expired', 'adjustment'),
  }),
  saleCreate: Joi.object({
    items: Joi.array().items(Joi.object({
      productId: objectId.required(),
      quantity: Joi.number().required(),
      unitPrice: nonNegative,
    })).min(1).required(),
    customerName: name,
    customerPhone: Joi.string().trim().max(24),
    total: nonNegative,
    amountPaid: nonNegative,
    paymentStatus: Joi.string().valid('paid', 'partial', 'unpaid'),
    notes: Joi.string().trim().max(2000),
  }),
  saleQuery: Joi.object({
    startDate: date,
    endDate: date,
    paymentStatus: Joi.string().valid('paid', 'partial', 'unpaid'),
  }),
  purchaseCreate: Joi.object({
    supplier: Joi.string().trim().max(200),
    items: Joi.array().items(itemSchema).min(1).required(),
    total: nonNegative,
    source: Joi.string().valid('manual', 'voice', 'text', 'receipt'),
    receiptImageUrl: looseUrl,
  }),
  expenseCreate: Joi.object({
    category: Joi.string().valid('rent', 'transport', 'power', 'wages', 'repairs', 'security', 'food', 'other').required(),
    amount: positive.required(),
    note: Joi.string().trim().max(1000),
    date,
  }),
  expenseQuery: Joi.object({
    category: Joi.string().valid('rent', 'transport', 'power', 'wages', 'repairs', 'security', 'food', 'other'),
    startDate: date,
    endDate: date,
  }),
  debtPayment: Joi.object({
    debtId: objectId.required(),
    amount: positive.required(),
    note: Joi.string().trim().max(500),
  }),
  debtId: Joi.object({ debtId: objectId.required() }),
  reminderQuery: Joi.object({ language }),
  customerCreate: Joi.object({
    name: name.required(),
    phone: Joi.string().trim().max(24).allow(''),
  }),
  dashboardQuery: Joi.object({ timeRange: Joi.string().valid('today', '7d', '30d', '90d') }),
  alertListQuery: Joi.object({ unreadOnly: Joi.string().valid('true', 'false') }),
  alertId: Joi.object({ id: objectId.required() }),
  aiText: Joi.object({
    text: Joi.string().trim().min(1).max(10000).required(),
    language,
  }),
  aiVoice: Joi.object({
    transcript: Joi.string().trim().max(10000).allow(''),
    language,
  }),
  aiReceipt: Joi.object({
    receiptData: Joi.alternatives().try(Joi.string().max(10000), Joi.object()),
    receiptImageUrl: looseUrl,
    language,
  }),
  aiActionId: Joi.object({ id: objectId.required() }),
  aiEdit: Joi.object({
    intent: Joi.string().trim().max(50),
    entities: Joi.object().unknown(true),
  }),
  aiAsk: Joi.object({
    query: Joi.string().trim().min(1).max(5000).required(),
    language,
  }),
  aiActionsQuery: Joi.object({
    status: Joi.string().valid('proposed', 'executing', 'confirmed', 'rejected'),
    inputType: Joi.string().valid('voice', 'text', 'receipt'),
  }),
  reportRange: Joi.object(rangeQuery),
  cashFlowQuery: Joi.object({ ...rangeQuery, interval: Joi.string().valid('day', 'week') }),
  topProductsQuery: Joi.object({
    ...rangeQuery,
    by: Joi.string().valid('revenue', 'quantity', 'profit'),
    limit: Joi.number().integer().min(1).max(50),
  }),
  salesRateQuery: Joi.object({ days: Joi.number().integer().min(1).max(180) }),
  dailySalesQuery: Joi.object({
    days: Joi.number().integer().min(1).max(366),
    productId: objectId,
  }),
};

const validateRequest = (schemasBySegment = {}) => (req, res, next) => {
  for (const [segment, schema] of Object.entries(schemasBySegment)) {
    const { error, value } = schema.validate(req[segment] || {}, {
      abortEarly: false,
      convert: true,
      allowUnknown: false,
      stripUnknown: false,
    });

    if (error) {
      const details = error.details
        .map((detail) => `${segment}.${detail.path.join('.') || 'value'} ${detail.message.replace(/^"[^"]+" /, '')}`)
        .join('; ');
      return next(new AppError(400, `Invalid request: ${details}`, 'VALIDATION_ERROR'));
    }

    if (segment === 'body') req.body = value;
  }
  return next();
};

module.exports = { validateRequest, schemas };
