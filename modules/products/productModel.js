const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Please provide product name'],
      trim: true,
      index: true,
    },
    category: {
      type: String,
      required: true,
      trim: true,
      default: 'General',
    },
    unit: {
      type: String,
      required: [true, 'Please specify product unit (e.g., bag, carton, bottle, crate, piece)'],
      trim: true,
      default: 'piece',
    },
    sellingPrice: {
      type: Number,
      required: [true, 'Please provide selling price in Naira'],
      min: 0,
    },
    costPrice: {
      type: Number,
      required: [true, 'Please provide cost price in Naira'],
      min: 0,
    },
    currentStock: {
      type: Number,
      default: 0,
      min: 0,
    },
    minimumStock: {
      type: Number,
      default: 5,
      min: 0,
    },
    imageUrl: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

productSchema.index({ businessId: 1, name: 1 });

module.exports = mongoose.model('Product', productSchema);

