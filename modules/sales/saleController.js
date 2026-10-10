const Sale = require('./saleModel');
const Product = require('../products/productModel');
const Customer = require('../debts/customerModel');
const Debt = require('../debts/debtModel');
const { recordStockMovement } = require('../inventory/stockService');
const AppError = require('../../common/utils/AppError');
const { escapeRegex } = require('../../common/utils/regex');
const withTransaction = require('../../common/utils/withTransaction');

/**
 * Record a sale
 */
const recordSale = async (req, res, next) => {
  try {
    const { items, customerName, customerPhone, total, amountPaid, paymentStatus, notes } = req.body;

    if (!Array.isArray(items) || !items.length) {
      throw new AppError(400, 'Sale items are required', 'ITEMS_REQUIRED');
    }

    // 1. Validate every line and check stock BEFORE writing anything, so a shortage on one
    //    item doesn't leave earlier items already deducted
    let calculatedTotal = 0;
    const saleItems = [];
    const neededByProduct = new Map();

    for (const item of items) {
      const quantity = Number(item.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new AppError(400, 'Each item needs a positive quantity', 'INVALID_QUANTITY');
      }
      const product = await Product.findOne({ _id: item.productId, businessId: req.businessId });
      if (!product) {
        throw new AppError(404, `Product ${item.productId} not found`, 'PRODUCT_NOT_FOUND');
      }

      const key = String(product._id);
      neededByProduct.set(key, { product, quantity: (neededByProduct.get(key)?.quantity || 0) + quantity });

      const unitPrice = item.unitPrice !== undefined ? Number(item.unitPrice) : product.sellingPrice;
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new AppError(400, 'unitPrice must be a non-negative number', 'INVALID_PRICE');
      }
      const subtotal = quantity * unitPrice;
      calculatedTotal += subtotal;

      saleItems.push({
        productId: product._id,
        productName: product.name,
        quantity,
        unit: product.unit,
        unitPrice,
        costPrice: product.costPrice,
        subtotal,
      });
    }

    for (const { product, quantity } of neededByProduct.values()) {
      if (product.currentStock < quantity) {
        throw new AppError(
          409,
          `Not enough stock: only ${product.currentStock} ${product.unit}(s) of ${product.name} left.`,
          'INSUFFICIENT_STOCK'
        );
      }
    }

    // 2. Work out payment; any unpaid balance needs a named customer for the debt ledger
    const finalTotal = total !== undefined ? Number(total) : calculatedTotal;
    if (Math.abs(finalTotal - calculatedTotal) > 0.01) {
      throw new AppError(400, 'total must equal the sum of the sale item subtotals', 'TOTAL_MISMATCH');
    }
    if (paymentStatus === 'partial' && amountPaid === undefined) {
      throw new AppError(400, 'amountPaid is required for a part-paid sale', 'INVALID_AMOUNT');
    }
    const finalAmountPaid =
      amountPaid !== undefined ? Number(amountPaid) : paymentStatus === 'unpaid' ? 0 : finalTotal;
    if (!Number.isFinite(finalTotal) || finalTotal < 0 || !Number.isFinite(finalAmountPaid) || finalAmountPaid < 0) {
      throw new AppError(400, 'total and amountPaid must be non-negative numbers', 'INVALID_AMOUNT');
    }
    if (finalAmountPaid > finalTotal) {
      throw new AppError(400, 'amountPaid cannot be more than the sale total', 'INVALID_AMOUNT');
    }
    if (
      (paymentStatus === 'unpaid' && finalAmountPaid !== 0) ||
      (paymentStatus === 'paid' && finalAmountPaid < finalTotal) ||
      (paymentStatus === 'partial' && (finalAmountPaid <= 0 || finalAmountPaid >= finalTotal))
    ) {
      throw new AppError(400, 'paymentStatus does not match amountPaid', 'PAYMENT_STATUS_MISMATCH');
    }
    const finalStatus = finalAmountPaid >= finalTotal ? 'paid' : finalAmountPaid > 0 ? 'partial' : 'unpaid';
    if (finalStatus !== 'paid' && !customerName) {
      throw new AppError(400, "A credit or part-paid sale needs the customer's name (customerName).", 'CUSTOMER_REQUIRED');
    }

    const result = await withTransaction(async (session) => {
      let customer = null;
      if (customerName) {
        customer = await Customer.findOne({
          businessId: req.businessId,
          name: new RegExp(`^${escapeRegex(customerName.trim())}$`, 'i'),
        }).session(session);
        if (!customer) {
          [customer] = await Customer.create([{
            businessId: req.businessId,
            name: customerName.trim(),
            phone: customerPhone || '',
          }], { session });
        }
      }

      // Conditional stock updates also protect against concurrent sales.
      for (const line of saleItems) {
        await recordStockMovement({
          businessId: req.businessId,
          productId: line.productId,
          type: 'sale',
          quantity: line.quantity,
          unitCost: line.costPrice,
          note: `Manual sale of ${line.quantity} ${line.unit}`,
          session,
        });
      }

      const [sale] = await Sale.create([{
        businessId: req.businessId,
        customerId: customer ? customer._id : null,
        items: saleItems,
        total: finalTotal,
        amountPaid: finalAmountPaid,
        paymentStatus: finalStatus,
        notes: notes || '',
        source: 'manual',
      }], { session });

      let debt = null;
      const unpaidBalance = finalTotal - finalAmountPaid;
      if (unpaidBalance > 0 && customer) {
        [debt] = await Debt.create([{
          businessId: req.businessId,
          customerId: customer._id,
          saleId: sale._id,
          amount: unpaidBalance,
          amountPaid: 0,
          status: 'unpaid',
          notes: `Unpaid balance from sale #${sale._id}`,
        }], { session });
      }

      return { sale, debt };
    });

    res.status(201).json({
      success: true,
      message: 'Sale recorded successfully',
      data: { sale: result.sale, debtCreated: result.debt },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get all sales
 */
const getSales = async (req, res, next) => {
  try {
    const { startDate, endDate, paymentStatus } = req.query;
    const filter = { businessId: req.businessId };

    if (paymentStatus) filter.paymentStatus = paymentStatus;
    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(startDate);
      if (endDate) filter.date.$lte = new Date(endDate);
    }

    const sales = await Sale.find(filter)
      .populate('customerId', 'name phone')
      .sort({ date: -1 })
      .limit(100);

    res.json({
      success: true,
      count: sales.length,
      data: sales,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  recordSale,
  getSales,
};
