const Purchase = require('./purchaseModel');
const Product = require('../products/productModel');
const { recordStockMovement } = require('../inventory/stockService');
const { escapeRegex } = require('../../common/utils/regex');
const AppError = require('../../common/utils/AppError');
const { requireArray, requirePositiveNumber, requireNonNegativeNumber, optionalString } = require('../../common/utils/validators');
const withTransaction = require('../../common/utils/withTransaction');

/**
 * Record a purchase (add inventory manually)
 */
const recordPurchase = async (req, res, next) => {
  try {
    const { supplier, items, total, source, receiptImageUrl } = req.body;

    requireArray(items, 'Purchase items');

    const purchase = await withTransaction(async (session) => {
      let calculatedTotal = 0;
      const purchaseItems = [];

      for (const [i, item] of items.entries()) {
        const qty = requirePositiveNumber(item.quantity, `Item ${i + 1}: quantity`);
        const uc = item.unitCost !== undefined ? requireNonNegativeNumber(item.unitCost, `Item ${i + 1}: unitCost`) : undefined;
        const pName = optionalString(item.productName, `Item ${i + 1}: productName`, { maxLength: 200 });

        let product;
        if (item.productId) {
          product = await Product.findOne({ _id: item.productId, businessId: req.businessId }).session(session);
        }
        if (!product && pName) {
          product = await Product.findOne({
            businessId: req.businessId,
            name: new RegExp(`^${escapeRegex(pName)}$`, 'i'),
          }).session(session);
        }
        if (!product) {
          [product] = await Product.create([{
            businessId: req.businessId,
            name: pName || 'New Product',
            category: item.category || 'General',
            unit: item.unit || 'piece',
            costPrice: uc || 0,
            sellingPrice: Math.round((uc || 0) * 1.15),
            currentStock: 0,
            minimumStock: 5,
          }], { session });
        }

        const unitCost = uc !== undefined ? uc : product.costPrice;
        const subtotal = qty * unitCost;
        calculatedTotal += subtotal;

        purchaseItems.push({
          productId: product._id,
          productName: product.name,
          quantity: qty,
          unit: item.unit || product.unit,
          unitCost,
          subtotal,
        });

        await recordStockMovement({
          businessId: req.businessId,
          productId: product._id,
          type: 'purchase',
          quantity: qty,
          unitCost,
          note: `Manual stock purchase from ${supplier || 'supplier'}`,
          session,
        });
      }

      const finalTotal = total !== undefined ? requireNonNegativeNumber(total, 'total') : calculatedTotal;
      if (Math.abs(finalTotal - calculatedTotal) > 0.01) {
        throw new AppError(400, 'total must equal the sum of the purchase item subtotals', 'TOTAL_MISMATCH');
      }
      const [createdPurchase] = await Purchase.create([{
        businessId: req.businessId,
        supplier: supplier || 'General Supplier',
        items: purchaseItems,
        total: finalTotal,
        source: source || 'manual',
        receiptImageUrl: receiptImageUrl || '',
      }], { session });
      return createdPurchase;
    });

    res.status(201).json({
      success: true,
      message: 'Purchase and inventory replenishment recorded successfully',
      data: purchase,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get all purchases
 */
const getPurchases = async (req, res, next) => {
  try {
    const purchases = await Purchase.find({ businessId: req.businessId })
      .sort({ date: -1 })
      .limit(100);

    res.json({
      success: true,
      count: purchases.length,
      data: purchases,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  recordPurchase,
  getPurchases,
};
