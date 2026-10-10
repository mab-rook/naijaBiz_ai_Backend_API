const StockMovement = require('./stockMovementModel');
const { getStockSummary, recordStockMovement } = require('./stockService');
const AppError = require('../../common/utils/AppError');
const { requireObjectId, requirePositiveNumber, requireNonNegativeNumber, optionalString } = require('../../common/utils/validators');

/**
 * Get current stock levels and inventory health
 */
const getStock = async (req, res, next) => {
  try {
    const summary = await getStockSummary(req.businessId);
    res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Record a manual stock movement (purchase, damaged, expired, adjustment)
 */
const addStockMovement = async (req, res, next) => {
  try {
    const { productId, type, quantity, unitCost, note } = req.body;

    requireObjectId(productId, 'Product ID');
    const parsedQuantity = requirePositiveNumber(quantity, 'Quantity');
    const parsedUnitCost = unitCost !== undefined ? requireNonNegativeNumber(unitCost, 'Unit cost') : 0;
    const validNote = optionalString(note, 'Note');

    const result = await recordStockMovement({
      businessId: req.businessId,
      productId,
      type,
      quantity: parsedQuantity,
      unitCost: parsedUnitCost,
      note: validNote,
    });

    res.status(201).json({
      success: true,
      message: 'Stock movement recorded successfully',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get movement history
 */
const getStockMovements = async (req, res, next) => {
  try {
    const { productId, type } = req.query;
    const filter = { businessId: req.businessId };

    if (productId) filter.productId = productId;
    if (type) filter.type = type;

    const movements = await StockMovement.find(filter)
      .populate('productId', 'name unit')
      .sort({ date: -1 })
      .limit(100);

    res.json({
      success: true,
      count: movements.length,
      data: movements,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getStock,
  addStockMovement,
  getStockMovements,
};
