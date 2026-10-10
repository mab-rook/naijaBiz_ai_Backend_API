const mongoose = require('mongoose');

const businessSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please provide business name'],
      trim: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    category: {
      type: String,
      default: 'Provisions & Foodstuff',
      trim: true,
    },
    currency: {
      type: String,
      default: 'NGN',
    },
    location: {
      type: String,
      default: 'Lagos, Nigeria',
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Business', businessSchema);

