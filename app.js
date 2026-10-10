const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const mongoose = require('mongoose');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./docs/swagger.json');
const errorHandler = require('./common/middleware/errorHandler');
const { isUsingInMemoryDatabase } = require('./config/db');
const { corsOptions } = require('./config/cors');

const apiRoutes = require('./routes');

const app = express();

// Behind a hosting proxy (Render, Railway, Heroku...) set TRUST_PROXY=1 so req.ip is the real client IP
// (needed for per-IP rate limiting)
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
}

// Global Middlewares
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// Interactive Swagger / OpenAPI Documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Health check for the hosting platform: 200 only when the database is connected
app.get('/health', (req, res) => {
  const dbConnected = mongoose.connection.readyState === 1;
  const inMemory = isUsingInMemoryDatabase();
  res.status(dbConnected ? 200 : 503).json({
    status: dbConnected ? 'ok' : 'degraded',
    database: dbConnected ? 'connected' : 'disconnected',
    // 'in-memory' means MONGODB_URI could not be reached and data will be lost on restart
    databaseType: inMemory ? 'in-memory' : 'mongodb',
    ...(inMemory ? { warning: 'Running on a temporary in-memory database: data is not saved. Check MONGODB_URI.' } : {}),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// Root Healthcheck & Welcome
app.get('/', (req, res) => {
  res.json({
    project: 'NaijaBiz AI API',
    version: '1.0.0',
    tagline: 'Run your business by simply talking to it.',
    status: 'online',
    documentation: '/api-docs',
    endpoints: {
      auth: '/api/auth',
      dashboard: '/api/dashboard',
      products: '/api/products',
      stock: '/api/stock',
      sales: '/api/sales',
      expenses: '/api/expenses',
      debts: '/api/debts',
      alerts: '/api/alerts',
      aiInput: {
        voice: 'POST /api/ai/voice',
        receipt: 'POST /api/ai/receipt',
        text: 'POST /api/ai/text',
        ask: 'POST /api/ai/ask',
        confirm: 'POST /api/ai/actions/:id/confirm',
        reject: 'POST /api/ai/actions/:id/reject',
      },
    },
  });
});

// API Routes
app.use('/api', apiRoutes);

// Catch-all 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// Error handling middleware
app.use(errorHandler);

module.exports = app;
