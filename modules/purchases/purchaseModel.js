const mongoose = require('mongoose');

const purchaseItemSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  productName: {
    type: String,
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
    min: 1,
  },
  unit: {
    type: String,
    default: 'piece',
  },
  unitCost: {
    type: Number,
    required: true,
    min: 0,
  },
  subtotal: {
    type: Number,
    required: true,
    min: 0,
  },
});

const purchaseSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    date: {
      type: Date,
      default: Date.now,
      index: true,
    },
    supplier: {
      type: String,
      default: 'General Supplier',
      trim: true,
    },
    items: [purchaseItemSchema],
    total: {
      type: Number,
      required: true,
      min: 0,
    },
    source: {
      type: String,
      enum: ['manual', 'voice', 'text', 'receipt'],
      default: 'manual',
    },
    receiptImageUrl: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

purchaseSchema.index({ businessId: 1, date: -1 });

module.exports = mongoose.model('Purchase', purchaseSchema);

