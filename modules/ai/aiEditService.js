const AIAction = require('./aiActionModel');
const { resolveEntities } = require('./aiService');
const { notPending } = require('./actionExecutorService');
const AppError = require('../../common/utils/AppError');

/**
 * "Edit" on the confirmation card: the merchant corrects what the AI understood before confirming.
 * Only allowed while the action is still 'proposed'. Every edit is kept in editHistory.
 */

const EDITABLE_INTENTS = ['add_inventory', 'record_sale', 'record_expense', 'record_debt_payment'];

const EDITABLE_FIELDS = {
  add_inventory: ['product', 'productId', 'quantity', 'unit', 'totalAmount', 'unitCost', 'supplier', 'items'],
  record_sale: ['product', 'productId', 'quantity', 'unit', 'totalAmount', 'amountPaid', 'customer', 'customerId', 'paymentStatus', 'note'],
  record_expense: ['totalAmount', 'category', 'note'],
  record_debt_payment: ['customer', 'customerId', 'debtId', 'totalAmount', 'note'],
};

const EXPENSE_CATEGORIES = ['rent', 'transport', 'power', 'wages', 'repairs', 'security', 'food', 'other'];
const PAYMENT_STATUSES = ['paid', 'partial', 'unpaid'];

const bad = (message) => new AppError(400, message, 'INVALID_EDIT');

const checkNumber = (value, field, { positive = false } = {}) => {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || (positive && n === 0)) {
    throw bad(`"${field}" must be a ${positive ? 'positive' : 'non-negative'} number`);
  }
  return n;
};

const checkText = (value, field) => {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim()) throw bad(`"${field}" must be a non-empty string`);
  return value.trim();
};

const validateItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) throw bad('"items" must be a non-empty array');
  return items.map((item, i) => {
    if (!item || typeof item !== 'object') throw bad(`items[${i}] must be an object`);
    const productName = checkText(item.productName ?? item.product ?? null, `items[${i}].productName`);
    if (!productName && !item.productId) throw bad(`items[${i}] needs a productName`);
    const quantity = checkNumber(item.quantity ?? null, `items[${i}].quantity`, { positive: true });
    const unitCost = checkNumber(item.unitCost ?? null, `items[${i}].unitCost`);
    if (quantity === null || unitCost === null) throw bad(`items[${i}] needs quantity and unitCost`);
    return {
      productName,
      // A renamed line must be matched again by name, so only keep the id if the name wasn't sent
      productId: item.productName || item.product ? null : item.productId,
      quantity,
      unit: item.unit ? checkText(item.unit, `items[${i}].unit`) : 'piece',
      unitCost,
      subtotal: quantity * unitCost,
    };
  });
};

/** Validate the merchant's changes and merge them into the current entities */
const applyEdits = (intent, current, edits) => {
  const allowed = EDITABLE_FIELDS[intent];
  const unknown = Object.keys(edits).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw bad(`Cannot edit ${unknown.join(', ')} for ${intent}. Editable fields: ${allowed.join(', ')}`);
  }

  const next = { ...current };
  const has = (k) => Object.prototype.hasOwnProperty.call(edits, k);

  for (const field of ['quantity']) {
    if (has(field)) next[field] = checkNumber(edits[field], field, { positive: true });
  }
  for (const field of ['totalAmount', 'amountPaid', 'unitCost']) {
    if (has(field)) next[field] = checkNumber(edits[field], field);
  }
  for (const field of ['product', 'unit', 'supplier', 'customer', 'note']) {
    if (has(field)) next[field] = edits[field] === null || edits[field] === '' ? null : checkText(edits[field], field);
  }
  if (has('category')) {
    if (!EXPENSE_CATEGORIES.includes(edits.category)) throw bad(`"category" must be one of ${EXPENSE_CATEGORIES.join(', ')}`);
    next.category = edits.category;
  }
  if (has('paymentStatus')) {
    if (!PAYMENT_STATUSES.includes(edits.paymentStatus)) throw bad(`"paymentStatus" must be one of ${PAYMENT_STATUSES.join(', ')}`);
    next.paymentStatus = edits.paymentStatus;
  }
  if (has('items')) {
    next.items = validateItems(edits.items);
    next.totalAmount = next.items.reduce((sum, it) => sum + it.subtotal, 0);
  }

  // A changed name must be resolved again, so drop the old id unless a new one was sent
  if (has('product')) next.productId = has('productId') ? edits.productId : null;
  else if (has('productId')) next.productId = edits.productId;
  if (has('customer')) {
    next.customerId = has('customerId') ? edits.customerId : null;
    next.debtId = has('debtId') ? edits.debtId : null;
  } else if (has('customerId')) {
    next.customerId = edits.customerId;
    next.debtId = has('debtId') ? edits.debtId : null;
  } else if (has('debtId')) next.debtId = edits.debtId;

  // Keep quantity, unit cost and total consistent
  if (intent === 'add_inventory' && !has('items') && next.quantity) {
    if (has('unitCost') && !has('totalAmount') && next.unitCost !== null) next.totalAmount = next.unitCost * next.quantity;
    else if (next.totalAmount) next.unitCost = Math.round(next.totalAmount / next.quantity);
  }
  if (intent === 'record_sale' && has('quantity') && !has('totalAmount') && current.totalAmount && current.quantity) {
    next.totalAmount = Math.round((current.totalAmount / current.quantity) * next.quantity);
  }

  return next;
};

/** Business checks that need resolved ids: fail at edit time instead of at confirm time */
const checkResolvable = (intent, entities) => {
  if (intent === 'record_sale') {
    if (!entities.productId) {
      throw new AppError(422, `Product "${entities.product || ''}" is not in your inventory.`, 'PRODUCT_NOT_FOUND');
    }
    if (['unpaid', 'partial'].includes(entities.paymentStatus) && !entities.customer) {
      throw new AppError(422, "A credit sale needs the customer's name.", 'CUSTOMER_REQUIRED');
    }
    if (entities.paymentStatus === 'partial' && entities.amountPaid == null) {
      throw new AppError(422, 'Please enter the amount already paid.', 'AMOUNT_REQUIRED');
    }
  }
  if (intent === 'record_debt_payment' && !entities.debtId) {
    throw new AppError(422, `No open debt found for "${entities.customer || ''}".`, 'DEBT_NOT_FOUND');
  }
  if (['record_expense', 'record_debt_payment'].includes(intent) && !entities.totalAmount) {
    throw new AppError(422, 'Please enter the amount.', 'AMOUNT_REQUIRED');
  }
};

const naira = (n) => `₦${Math.round(Number(n) || 0).toLocaleString('en-NG')}`;

/** Regenerate the confirmation card text after an edit, in the merchant's language */
const describeAction = (intent, e, language) => {
  const lang = ['en', 'yo', 'ha', 'ig'].includes(language) ? language : 'en';
  let templates;
  if (intent === 'add_inventory' && Array.isArray(e.items) && e.items.length) {
    const n = e.items.length;
    const from = e.supplier || 'supplier';
    templates = {
      en: `Add ${n} item(s) from ${from} to inventory (Total: ${naira(e.totalAmount)})?`,
      yo: `Se ki n fi ọja ${n} lati ọdọ ${from} kun (Lapapọ: ${naira(e.totalAmount)})?`,
      ha: `A kara kaya ${n} daga ${from} (Jimilla: ${naira(e.totalAmount)})?`,
      ig: `Tinye ngwongwo ${n} sitere na ${from} (Ngụkọta: ${naira(e.totalAmount)})?`,
    };
  } else if (intent === 'add_inventory') {
    templates = {
      en: `Add ${e.quantity} ${e.unit || 'unit'}(s) of ${e.product} at ${naira(e.unitCost)} each (Total: ${naira(e.totalAmount)})?`,
      yo: `Se ki n se afikun ${e.quantity} ${e.unit || ''} ti ${e.product} ni ${naira(e.unitCost)} kọọkan (Lapapọ: ${naira(e.totalAmount)})?`,
      ha: `A kara ${e.quantity} ${e.unit || ''} na ${e.product} a kan ${naira(e.unitCost)} kowanne (Jimilla: ${naira(e.totalAmount)})?`,
      ig: `Tinye ${e.quantity} ${e.unit || ''} nke ${e.product} na ${naira(e.unitCost)} nke ọ bụla (Ngụkọta: ${naira(e.totalAmount)})?`,
    };
  } else if (intent === 'record_sale') {
    const credit = ['unpaid', 'partial'].includes(e.paymentStatus) && e.customer
      ? ` (${e.paymentStatus === 'partial' ? `paid ${naira(e.amountPaid)}, balance ${naira((e.totalAmount || 0) - (e.amountPaid || 0))}` : `credit: ${e.customer}`})`
      : '';
    templates = {
      en: `Record sale of ${e.quantity} ${e.product} for ${naira(e.totalAmount)}${credit}?`,
      yo: `Se ki n se akọsilẹ tita ${e.quantity} ti ${e.product} fun ${naira(e.totalAmount)}${credit}?`,
      ha: `A rubuta cinikin ${e.quantity} na ${e.product} a kan ${naira(e.totalAmount)}${credit}?`,
      ig: `Dee ire ahịa nke ${e.quantity} nke ${e.product} maka ${naira(e.totalAmount)}${credit}?`,
    };
  } else if (intent === 'record_expense') {
    templates = {
      en: `Record expense of ${naira(e.totalAmount)} for ${e.category || 'other'}?`,
      yo: `Se ki n kọ inawo ${naira(e.totalAmount)} fun ${e.category || 'other'}?`,
      ha: `A rubuta kudin da aka kashe ${naira(e.totalAmount)} na ${e.category || 'other'}?`,
      ig: `Dee mmefu nke ${naira(e.totalAmount)} maka ${e.category || 'other'}?`,
    };
  } else {
    templates = {
      en: `Record debt payment of ${naira(e.totalAmount)} from ${e.customer}?`,
      yo: `Se ki n kọ sisan gbese ${naira(e.totalAmount)} lati ọdọ ${e.customer}?`,
      ha: `A rubuta biyan bashi ${naira(e.totalAmount)} daga ${e.customer}?`,
      ig: `Dee ụgwọ ${naira(e.totalAmount)} nke ${e.customer} kwụrụ?`,
    };
  }
  return templates[lang];
};

/**
 * Apply the merchant's corrections to a proposed action.
 * body: { intent?: string, entities: { ...fields to change } }
 */
const editAIAction = async (actionId, businessId, userId, body = {}) => {
  const { intent: newIntent, entities: edits = {} } = body;
  if (typeof edits !== 'object' || Array.isArray(edits) || edits === null) throw bad('"entities" must be an object');
  if (newIntent !== undefined && !EDITABLE_INTENTS.includes(newIntent)) {
    throw bad(`"intent" must be one of ${EDITABLE_INTENTS.join(', ')}`);
  }
  if (newIntent === undefined && Object.keys(edits).length === 0) throw bad('Nothing to edit');

  const action = await AIAction.findOne({ _id: actionId, businessId });
  if (!action) throw new AppError(404, 'AI proposed action not found', 'ACTION_NOT_FOUND');
  if (action.status !== 'proposed') throw await notPending(actionId, businessId, 'edit');

  const before = action.toObject().parsedJSON;
  const intent = newIntent || before.intent;
  if (!EDITABLE_INTENTS.includes(intent)) {
    throw new AppError(422, `A "${intent}" action cannot be edited. Ask the question again instead.`, 'NOT_EDITABLE');
  }

  // Switching intent (e.g. the AI heard a sale as a purchase) starts from a clean slate
  const base = intent === before.intent ? before.entities || {} : {};
  const merged = applyEdits(intent, base, edits);
  const resolved = { intent, entities: merged };
  await resolveEntities(businessId, resolved);
  checkResolvable(intent, resolved.entities);

  const confirmationMessage = describeAction(intent, resolved.entities, action.language);

  // Optimistic lock: only apply if nobody confirmed/rejected/edited it since we read it
  const updated = await AIAction.findOneAndUpdate(
    { _id: action._id, businessId, status: 'proposed', updatedAt: action.updatedAt },
    {
      $set: {
        'parsedJSON.intent': intent,
        'parsedJSON.entities': resolved.entities,
        'parsedJSON.confirmationMessage': confirmationMessage,
      },
      $push: {
        editHistory: {
          editedBy: userId,
          before: { intent: before.intent, entities: before.entities },
          after: { intent, entities: resolved.entities },
        },
      },
    },
    { new: true, runValidators: true }
  );
  if (!updated) {
    throw new AppError(409, 'This action was changed at the same time. Reload it and try again.', 'ACTION_CONFLICT');
  }
  return updated;
};

module.exports = {
  editAIAction,
  describeAction,
};
