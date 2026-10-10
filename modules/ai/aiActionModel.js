const mongoose = require('mongoose');

const aiActionSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    inputType: {
      type: String,
      enum: ['voice', 'receipt', 'text'],
      required: true,
    },
    rawInput: {
      type: String, // original text or private backend media URL
      required: true,
    },
    media: {
      provider: { type: String, enum: ['local', 'cloudinary'] },
      fileName: { type: String },
      publicId: { type: String },
      resourceType: { type: String, enum: ['image', 'video'] },
      format: { type: String },
      mimeType: { type: String },
      bytes: { type: Number, min: 0 },
      // Set when the file is removed by the retention job; the action stays in the audit trail
      deletedAt: { type: Date },
    },
    language: {
      type: String,
      enum: ['en', 'yo', 'ha', 'ig'],
      default: 'en',
    },
    transcript: {
      type: String,
      default: '',
    },
    parsedJSON: {
      intent: {
        type: String,
        enum: [
          'add_inventory',
          'record_sale',
          'record_expense',
          'query',
          'record_debt_payment',
          'affordability_check',
          'other',
        ],
        required: true,
      },
      entities: {
        product: { type: String, default: null },
        productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
        quantity: { type: Number, default: null },
        unit: { type: String, default: 'piece' },
        totalAmount: { type: Number, default: null },
        amountPaid: { type: Number, default: null },
        unitCost: { type: Number, default: null },
        customer: { type: String, default: null },
        customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
        debtId: { type: mongoose.Schema.Types.ObjectId, ref: 'Debt', default: null },
        category: { type: String, default: null },
        supplier: { type: String, default: null },
        paymentStatus: { type: String, enum: ['paid', 'partial', 'unpaid'], default: 'paid' },
        note: { type: String, default: '' },
        items: [
          {
            product: String,
            productName: String,
            productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
            quantity: Number,
            unit: String,
            unitCost: Number,
            subtotal: Number,
          },
        ],
      },
      confirmationMessage: {
        type: String,
        required: true,
      },
      suggestedAction: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
      },
    },
    confidence: {
      type: Number,
      min: 0,
      max: 1,
      default: 0.95,
    },
    // Which parser produced this proposal: the ML service, or the local rule-based fallback
    engine: {
      type: String,
      enum: ['ml', 'local'],
      default: 'local',
    },
    status: {
      type: String,
      // 'executing' is a short-lived lock while a confirm is being written (prevents double confirms)
      enum: ['proposed', 'executing', 'confirmed', 'rejected'],
      default: 'proposed',
      index: true,
    },
    // Merchant corrections made on the confirmation card ("Edit") before confirming
    editHistory: [
      {
        editedAt: { type: Date, default: Date.now },
        editedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        before: { type: mongoose.Schema.Types.Mixed },
        after: { type: mongoose.Schema.Types.Mixed },
      },
    ],
    executedAt: {
      type: Date,
      default: null,
    },
    executionResult: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

aiActionSchema.index({ businessId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('AIAction', aiActionSchema);
