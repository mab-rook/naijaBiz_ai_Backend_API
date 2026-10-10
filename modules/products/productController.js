const Product = require('./productModel');
const { recordStockMovement } = require('../inventory/stockService');
const AppError = require('../../common/utils/AppError');
const withTransaction = require('../../common/utils/withTransaction');

// Fields a client may change on a product. Stock is never edited directly: it only moves through
// stock movements (purchase, sale, damaged, expired, adjustment) so history always adds up.
const UPDATABLE_FIELDS = ['name', 'category', 'unit', 'sellingPrice', 'costPrice', 'minimumStock', 'imageUrl'];

const getProducts = async (req, res, next) => {
  try {
    const { category, lowStock } = req.query;
    const query = { businessId: req.businessId };

    if (category) query.category = category;
    if (lowStock === 'true') {
      query.$expr = { $lte: ['$currentStock', '$minimumStock'] };
    }

    const products = await Product.find(query).sort({ name: 1 });
    res.json({
      success: true,
      count: products.length,
      data: products,
    });
  } catch (error) {
    next(error);
  }
};

const getProductById = async (req, res, next) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!product) {
      throw new AppError(404, 'Product not found', 'PRODUCT_NOT_FOUND');
    }
    res.json({ success: true, data: product });
  } catch (error) {
    next(error);
  }
};

const createProduct = async (req, res, next) => {
  try {
    const { name, category, unit, sellingPrice, costPrice, currentStock, minimumStock, imageUrl } = req.body;

    const openingStock = Number(currentStock) || 0;
    if (openingStock < 0) throw new AppError(400, 'Opening stock cannot be negative', 'INVALID_STOCK');
    const product = await withTransaction(async (session) => {
      const [createdProduct] = await Product.create([{
        businessId: req.businessId,
        name,
        category: category || 'General',
        unit: unit || 'piece',
        sellingPrice,
        costPrice,
        currentStock: 0,
        minimumStock: minimumStock ?? 5,
        imageUrl: imageUrl || '',
      }], { session });

      // Opening stock is recorded as an adjustment movement, so current stock = sum of movements.
      if (openingStock > 0) {
        const { product: stocked } = await recordStockMovement({
          businessId: req.businessId,
          productId: createdProduct._id,
          type: 'adjustment',
          quantity: openingStock,
          unitCost: createdProduct.costPrice,
          note: 'Opening stock',
          session,
        });
        return stocked;
      }
      return createdProduct;
    });

    res.status(201).json({ success: true, data: product });
  } catch (error) {
    next(error);
  }
};

const updateProduct = async (req, res, next) => {
  try {
    if ('currentStock' in req.body) {
      throw new AppError(
        400,
        'Stock cannot be edited directly. Record a stock movement (POST /api/stock/movements, type "adjustment", "damaged" or "expired").',
        'STOCK_NOT_EDITABLE'
      );
    }
    const unknown = Object.keys(req.body).filter((k) => !UPDATABLE_FIELDS.includes(k));
    if (unknown.length) {
      throw new AppError(400, `Cannot update: ${unknown.join(', ')}. Updatable fields: ${UPDATABLE_FIELDS.join(', ')}`, 'INVALID_FIELDS');
    }

    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      { $set: req.body },
      { new: true, runValidators: true }
    );

    if (!product) {
      throw new AppError(404, 'Product not found', 'PRODUCT_NOT_FOUND');
    }

    res.json({ success: true, data: product });
  } catch (error) {
    next(error);
  }
};

const deleteProduct = async (req, res, next) => {
  try {
    const product = await Product.findOneAndDelete({
      _id: req.params.id,
      businessId: req.businessId,
    });

    if (!product) {
      throw new AppError(404, 'Product not found', 'PRODUCT_NOT_FOUND');
    }

    res.json({ success: true, message: 'Product deleted successfully' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
};
