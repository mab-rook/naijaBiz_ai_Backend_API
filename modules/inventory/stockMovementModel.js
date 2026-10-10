const mongoose = require('mongoose');

const stockMovementSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['purchase', 'sale', 'damaged', 'expired', 'adjustment'],
      required: true,
    },
    quantity: {
      type: Number,
      required: true, // positive for inflow (purchase), negative for outflow (sale, damaged, expired)
    },
    unitCost: {
      type: Number,
      required: true,
      min: 0,
    },
    date: {
      type: Date,
      default: Date.now,
      index: true,
    },
    note: {
      type: String,
      default: '',
    },
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      // References Sale or Purchase if applicable
    },
  },
  {
    timestamps: true,
  }
);

stockMovementSchema.index({ businessId: 1, productId: 1, date: -1 });

module.exports = mongoose.model('StockMovement', stockMovementSchema);

