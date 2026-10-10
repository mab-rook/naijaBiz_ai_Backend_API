const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Please provide customer name'],
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

customerSchema.index({ businessId: 1, name: 1 });

module.exports = mongoose.model('Customer', customerSchema);

