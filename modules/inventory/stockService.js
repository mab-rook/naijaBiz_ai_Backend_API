const Product = require('../products/productModel');
const StockMovement = require('./stockMovementModel');
const Alert = require('../alerts/alertModel');
const AppError = require('../../common/utils/AppError');
const withTransaction = require('../../common/utils/withTransaction');

const MOVEMENT_TYPES = ['purchase', 'sale', 'damaged', 'expired', 'adjustment'];
const OUTFLOW_TYPES = ['sale', 'damaged', 'expired'];

const calculateDaysOfStockRemaining = (currentStock, totalSold, periodDays = 14) => {
  if (currentStock <= 0) return 0;
  const dailyRate = totalSold / periodDays;
  if (dailyRate <= 0) return 999;
  return Math.round((currentStock / dailyRate) * 10) / 10;
};

/**
 * Record a stock movement and adjust product currentStock.
 * Purchases add stock; sales, damaged and expired remove it; adjustments use the sign given.
 * Stock can never go below zero: the update is conditional, so two concurrent sales cannot
 * both take the last unit.
 */
const recordStockMovement = async ({
  businessId,
  productId,
  type,
  quantity,
  unitCost,
  note = '',
  referenceId = null,
  session,
}) => {
  if (!session) {
    return withTransaction((transactionSession) =>
      recordStockMovement({
        businessId,
        productId,
        type,
        quantity,
        unitCost,
        note,
        referenceId,
        session: transactionSession,
      })
    );
  }

  if (!MOVEMENT_TYPES.includes(type)) {
    throw new AppError(400, `Movement type must be one of: ${MOVEMENT_TYPES.join(', ')}`, 'INVALID_MOVEMENT_TYPE');
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty === 0 || (type !== 'adjustment' && qty < 0)) {
    throw new AppError(400, 'Quantity must be a positive number (adjustments may be negative)', 'INVALID_QUANTITY');
  }

  let delta = qty;
  if (OUTFLOW_TYPES.includes(type)) delta = -Math.abs(qty);
  else if (type === 'purchase') delta = Math.abs(qty);

  const filter = { _id: productId, businessId };
  if (delta < 0) filter.currentStock = { $gte: -delta };
  const update = { $inc: { currentStock: delta } };
  if (type === 'purchase' && unitCost > 0) update.$set = { costPrice: unitCost }; // latest cost price

  const product = await Product.findOneAndUpdate(filter, update, { new: true, session });
  if (!product) {
    const existing = await Product.findOne({ _id: productId, businessId }).session(session);
    if (!existing) throw new AppError(404, 'Product not found in this business', 'PRODUCT_NOT_FOUND');
    throw new AppError(
      409,
      `Not enough stock: only ${existing.currentStock} ${existing.unit}(s) of ${existing.name} left.`,
      'INSUFFICIENT_STOCK'
    );
  }

  const [movement] = await StockMovement.create([{
    businessId,
    productId,
    type,
    quantity: delta,
    unitCost: unitCost || 0,
    note,
    referenceId,
    date: new Date(),
  }], { session });

  // Low stock check: one unread alert per product, plus an escalation when it hits zero
  if (product.currentStock <= product.minimumStock) {
    const isCritical = product.currentStock === 0;
    const existing = await Alert.findOne({
      businessId,
      type: 'low_stock',
      'metadata.productId': product._id,
      read: false,
      ...(isCritical ? { severity: 'critical' } : {}),
    }).session(session);
    if (!existing) await Alert.create([{
      businessId,
      type: 'low_stock',
      title: isCritical ? `Out of Stock: ${product.name}` : `Low Stock: ${product.name}`,
      message: `Only ${product.currentStock} ${product.unit}(s) of ${product.name} left. Minimum threshold is ${product.minimumStock}. Time to restock!`,
      messageLocalized: {
        yo: `O ku ${product.currentStock} ${product.unit} ti ${product.name}. O to akoko lati ra si!`,
        ha: `Sauran ${product.currentStock} ${product.unit} na ${product.name}. Lokaci ya yi da za a sake siyo!`,
        ig: `Naani ${product.currentStock} ${product.unit} nke ${product.name} fọdụrụ. Oge eruola iji zụtakwuo!`,
      },
      severity: isCritical ? 'critical' : 'warning',
      metadata: {
        productId: product._id,
        productName: product.name,
        currentStock: product.currentStock,
        minimumStock: product.minimumStock,
      },
    }], { session });
  }

  return { movement, product };
};

/**
 * Get comprehensive stock report, valuation and days remaining
 */
const getStockSummary = async (businessId) => {
  const products = await Product.find({ businessId }).sort({ name: 1 });

  let totalCostValue = 0;
  let totalSalesValue = 0;
  let lowStockCount = 0;
  let outOfStockCount = 0;

  const productDetails = await Promise.all(
    products.map(async (prod) => {
      const costVal = (prod.currentStock || 0) * (prod.costPrice || 0);
      const saleVal = (prod.currentStock || 0) * (prod.sellingPrice || 0);

      totalCostValue += costVal;
      totalSalesValue += saleVal;

      let status = 'in_stock';
      if (prod.currentStock === 0) {
        status = 'out_of_stock';
        outOfStockCount++;
      } else if (prod.currentStock <= prod.minimumStock) {
        status = 'low_stock';
        lowStockCount++;
      }

      // Calculate days of stock left based on past 14 days movements
      const daysOfStockLeft = await calculateDaysRemaining(businessId, prod._id, prod.currentStock);

      return {
        _id: prod._id,
        name: prod.name,
        category: prod.category,
        unit: prod.unit,
        sellingPrice: prod.sellingPrice,
        costPrice: prod.costPrice,
        currentStock: prod.currentStock,
        minimumStock: prod.minimumStock,
        stockValue: costVal,
        potentialRevenue: saleVal,
        status,
        daysOfStockLeft,
      };
    })
  );

  return {
    totalProducts: products.length,
    totalStockCostValue: totalCostValue,
    totalStockRetailValue: totalSalesValue,
    lowStockCount,
    outOfStockCount,
    products: productDetails,
  };
};

/**
 * Days of stock left = Current stock / average daily sales
 */
const calculateDaysRemaining = async (businessId, productId, currentStock) => {
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const movements = await StockMovement.find({
    businessId,
    productId,
    type: 'sale',
    date: { $gte: twoWeeksAgo },
  });

  const totalSold = movements.reduce((acc, m) => acc + Math.abs(m.quantity), 0);
  return calculateDaysOfStockRemaining(currentStock, totalSold);
};

module.exports = {
  recordStockMovement,
  getStockSummary,
  calculateDaysRemaining,
  calculateDaysOfStockRemaining,
};
