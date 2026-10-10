const mongoose = require('mongoose');

const saleItemSchema = new mongoose.Schema({
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
  unitPrice: {
    type: Number,
    required: true,
    min: 0,
  },
  costPrice: {
    type: Number,
    default: 0,
  },
  subtotal: {
    type: Number,
    required: true,
    min: 0,
  },
});

const saleSchema = new mongoose.Schema(
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
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
    },
    items: [saleItemSchema],
    total: {
      type: Number,
      required: true,
      min: 0,
    },
    amountPaid: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    paymentStatus: {
      type: String,
      enum: ['paid', 'partial', 'unpaid'],
      default: 'paid',
    },
    notes: {
      type: String,
      default: '',
    },
    source: {
      type: String,
      enum: ['manual', 'voice', 'text', 'receipt'],
      default: 'manual',
    },
  },
  {
    timestamps: true,
  }
);

saleSchema.index({ businessId: 1, date: -1 });

module.exports = mongoose.model('Sale', saleSchema);

