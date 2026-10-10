const AIAction = require('./aiActionModel');
const Product = require('../products/productModel');
const Sale = require('../sales/saleModel');
const Purchase = require('../purchases/purchaseModel');
const Expense = require('../expenses/expenseModel');
const Customer = require('../debts/customerModel');
const Debt = require('../debts/debtModel');
const { recordStockMovement } = require('../inventory/stockService');
const { recordDebtPayment } = require('../debts/debtService');
const { escapeRegex } = require('../../common/utils/regex');
const AppError = require('../../common/utils/AppError');
const withTransaction = require('../../common/utils/withTransaction');

const notPending = async (actionId, businessId, verb) => {
  const existing = await AIAction.findOne({ _id: actionId, businessId }).select('status');
  if (!existing) return new AppError(404, 'AI proposed action not found', 'ACTION_NOT_FOUND');
  return new AppError(409, `Cannot ${verb} action with status: ${existing.status}`, 'ACTION_NOT_PENDING');
};

/**
 * Writes the business records for a claimed action. Returns the execution result.
 */
const executeAction = async (aiAction, businessId, session) => {
  const { intent, entities } = aiAction.parsedJSON;
  let executionResult = {};

  switch (intent) {
    case 'add_inventory': {
      // 1. If multiple items (from receipt) or single item
      const itemsToProcess = entities.items && entities.items.length > 0
        ? entities.items
        : [
            {
              productName: entities.product,
              productId: entities.productId,
              quantity: entities.quantity,
              unit: entities.unit || 'bag',
              unitCost: entities.unitCost || 0,
              subtotal: entities.totalAmount || (entities.quantity * (entities.unitCost || 0)),
            },
          ];

      const purchaseItems = [];
      let totalPurchaseCost = 0;

      for (const rawItem of itemsToProcess) {
        // Receipt items may name the product as `productName` (local parser) or `product` (ML schema)
        const item = { ...(rawItem.toObject ? rawItem.toObject() : rawItem) };
        item.productName = item.productName || item.product;
        if (!item.productName && !item.productId) {
          throw new AppError(422, 'Each inventory item needs a product name', 'ITEM_PRODUCT_REQUIRED');
        }
        let product;
        if (item.productId) {
          product = await Product.findOne({ _id: item.productId, businessId }).session(session);
        }
        if (!product && item.productName) {
          // Find by name or create new product
          product = await Product.findOne({
            businessId,
            name: new RegExp(`^${escapeRegex(item.productName)}$`, 'i'),
          }).session(session);
        }
        if (!product) {
          [product] = await Product.create([{
            businessId,
            name: item.productName,
            category: 'General',
            unit: item.unit || 'piece',
            costPrice: item.unitCost || 0,
            sellingPrice: Math.round((item.unitCost || 0) * 1.15), // 15% default markup
            currentStock: 0,
            minimumStock: 5,
          }], { session });
        }

        const subtotal = item.subtotal || item.quantity * item.unitCost;
        totalPurchaseCost += subtotal;

        purchaseItems.push({
          productId: product._id,
          productName: product.name,
          quantity: item.quantity,
          unit: item.unit,
          unitCost: item.unitCost,
          subtotal,
        });

        // Record stock movement (inflow)
        await recordStockMovement({
          businessId,
          productId: product._id,
          type: 'purchase',
          quantity: item.quantity,
          unitCost: item.unitCost,
          note: `AI Inflow via ${aiAction.inputType}`,
          session,
        });
      }

      // Record Purchase
      const [purchase] = await Purchase.create([{
        businessId,
        supplier: entities.supplier || 'Wholesale Supplier',
        items: purchaseItems,
        total: totalPurchaseCost,
        source: aiAction.inputType,
        receiptImageUrl: aiAction.inputType === 'receipt' && aiAction.media ? aiAction.rawInput : '',
      }], { session });

      executionResult = {
        type: 'purchase',
        purchaseId: purchase._id,
        itemsCount: purchaseItems.length,
        total: totalPurchaseCost,
      };
      break;
    }

    case 'record_sale': {
      let product;
      if (entities.productId) {
        product = await Product.findOne({ _id: entities.productId, businessId }).session(session);
      }
      if (!product && entities.product) {
        product = await Product.findOne({
          businessId,
          name: new RegExp(escapeRegex(entities.product), 'i'),
        }).session(session);
      }
      if (!product) {
        throw new AppError(422, `Product "${entities.product}" not found in inventory.`, 'PRODUCT_NOT_FOUND');
      }

      const quantity = entities.quantity || 1;
      // entities.unitCost is the cost price; the selling price comes from the stated total or the catalogue
      const unitPrice = entities.totalAmount != null ? entities.totalAmount / quantity : product.sellingPrice;
      const total = entities.totalAmount != null ? entities.totalAmount : quantity * unitPrice;
      const requestedStatus = entities.paymentStatus || 'paid';
      const amountPaid = entities.amountPaid != null
        ? entities.amountPaid
        : requestedStatus === 'unpaid'
          ? 0
          : requestedStatus === 'partial'
            ? null
            : total;
      if (amountPaid == null || amountPaid < 0 || amountPaid > total) {
        throw new AppError(422, 'Enter a valid amount paid for this sale.', 'INVALID_AMOUNT');
      }
      if (
        (requestedStatus === 'unpaid' && amountPaid !== 0) ||
        (requestedStatus === 'partial' && (amountPaid <= 0 || amountPaid >= total)) ||
        (requestedStatus === 'paid' && amountPaid < total)
      ) {
        throw new AppError(422, 'Payment status does not match the amount paid.', 'PAYMENT_STATUS_MISMATCH');
      }
      const paymentStatus = amountPaid === 0 ? 'unpaid' : amountPaid < total ? 'partial' : 'paid';
      if (paymentStatus !== 'paid' && !entities.customer && !entities.customerId) {
        throw new AppError(422, "A credit sale needs the customer's name. Edit the action and add the customer.", 'CUSTOMER_REQUIRED');
      }

      // Check customer if on credit
      let customer = null;
      if (entities.customer) {
        customer = await Customer.findOne({
          businessId,
          name: new RegExp(escapeRegex(entities.customer), 'i'),
        }).session(session);
        if (!customer) {
          [customer] = await Customer.create([{
            businessId,
            name: entities.customer,
            phone: '',
          }], { session });
        }
      }

      // Deduct stock first: if there isn't enough, nothing else is written (409 INSUFFICIENT_STOCK)
      const { movement } = await recordStockMovement({
        businessId,
        productId: product._id,
        type: 'sale',
        quantity,
        unitCost: product.costPrice,
        note: `AI Sale recorded`,
        session,
      });

      // Record Sale
      const [sale] = await Sale.create([{
        businessId,
        customerId: customer ? customer._id : null,
        items: [
          {
            productId: product._id,
            productName: product.name,
            quantity,
            unit: product.unit,
            unitPrice,
            costPrice: product.costPrice,
            subtotal: total,
          },
        ],
        total,
        amountPaid,
        paymentStatus,
        source: aiAction.inputType,
      }], { session });
      movement.referenceId = sale._id;
      await movement.save({ session });

      // Record the unpaid balance for unpaid or part-paid sales.
      let debt = null;
      if (total > amountPaid && customer) {
        [debt] = await Debt.create([{
          businessId,
          customerId: customer._id,
          saleId: sale._id,
          amount: total - amountPaid,
          amountPaid: 0,
          status: 'unpaid',
          notes: `Credit sale for ${quantity} ${product.unit}(s) of ${product.name}`,
        }], { session });
      }

      executionResult = {
        type: 'sale',
        saleId: sale._id,
        total,
        paymentStatus: sale.paymentStatus,
        debtId: debt ? debt._id : null,
      };
      break;
    }

    case 'record_expense': {
      const [expense] = await Expense.create([{
        businessId,
        category: entities.category || 'other',
        amount: entities.totalAmount || 0,
        note: entities.note || 'AI voice expense',
        source: aiAction.inputType,
      }], { session });

      executionResult = {
        type: 'expense',
        expenseId: expense._id,
        amount: expense.amount,
        category: expense.category,
      };
      break;
    }

    case 'record_debt_payment': {
      // The AI usually only knows the customer ("Emeka paid me 5,000"), so fall back to
      // that customer's oldest open debt when no debtId was resolved at proposal time
      let debtId = entities.debtId;
      if (!debtId && (entities.customerId || entities.customer)) {
        const customer = entities.customerId
          ? await Customer.findOne({ _id: entities.customerId, businessId }).session(session)
          : await Customer.findOne({ businessId, name: new RegExp(escapeRegex(entities.customer), 'i') }).session(session);
        const openDebt = customer
          ? await Debt.findOne({ businessId, customerId: customer._id, status: { $ne: 'paid' } })
            .sort({ createdDate: 1 })
            .session(session)
          : null;
        debtId = openDebt ? openDebt._id : null;
      }
      if (!debtId) {
        throw new AppError(422, 'Could not find an open debt for this repayment. Specify the customer or debt.', 'DEBT_NOT_FOUND');
      }
      const updatedDebt = await recordDebtPayment(
        businessId,
        debtId,
        entities.totalAmount,
        entities.note,
        session
      );

      executionResult = {
        type: 'debt_payment',
        debtId: updatedDebt._id,
        amountPaid: entities.totalAmount,
        remainingBalance: updatedDebt.balanceRemaining,
      };
      break;
    }

    default:
      executionResult = {
        message: 'Query or informational action acknowledged; no database state modified.',
      };
      break;
  }

  return executionResult;
};

/**
 * Confirm-then-commit: atomically claim a proposed action, write it, and mark it confirmed.
 * All business writes and the confirmed action state commit in one MongoDB transaction.
 * If writing fails, the transaction rolls back and the action returns to 'proposed'.
 */
const confirmAIAction = async (actionId, businessId) => {
  const aiAction = await AIAction.findOneAndUpdate(
    { _id: actionId, businessId, status: 'proposed' },
    { $set: { status: 'executing' } },
    { new: true }
  );
  if (!aiAction) {
    throw await notPending(actionId, businessId, 'confirm');
  }

  let executionResult;
  try {
    executionResult = await withTransaction(async (session) => {
      const actionInTransaction = await AIAction.findOne({
        _id: aiAction._id,
        businessId,
        status: 'executing',
      }).session(session);
      if (!actionInTransaction) {
        throw new AppError(409, 'AI action is no longer being executed', 'ACTION_NOT_PENDING');
      }

      const result = await executeAction(actionInTransaction, businessId, session);
      actionInTransaction.status = 'confirmed';
      actionInTransaction.executedAt = new Date();
      actionInTransaction.executionResult = result;
      await actionInTransaction.save({ session });
      return result;
    });
  } catch (err) {
    await AIAction.updateOne({ _id: aiAction._id, status: 'executing' }, { $set: { status: 'proposed' } });
    throw err;
  }

  const confirmedAction = await AIAction.findOne({
    _id: aiAction._id,
    businessId,
    status: 'confirmed',
  });
  if (!confirmedAction) {
    throw new AppError(500, 'Confirmed AI action could not be reloaded', 'ACTION_CONFIRMATION_ERROR');
  }

  return {
    aiAction: confirmedAction,
    executionResult,
  };
};

/**
 * Rejects and cancels an AI proposed action without mutating business data
 */
const rejectAIAction = async (actionId, businessId) => {
  const aiAction = await AIAction.findOneAndUpdate(
    { _id: actionId, businessId, status: 'proposed' },
    { $set: { status: 'rejected' } },
    { new: true }
  );
  if (!aiAction) {
    throw await notPending(actionId, businessId, 'reject');
  }
  return aiAction;
};

module.exports = {
  notPending,
  confirmAIAction,
  rejectAIAction,
};
