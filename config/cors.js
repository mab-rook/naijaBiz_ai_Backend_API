/**
 * CORS: browsers may only call the API from the origins listed in CORS_ORIGINS
 * (comma-separated, e.g. "https://naijabiz.vercel.app,http://localhost:3000").
 * Requests without an Origin header (mobile apps, curl, the ML service) are not affected by CORS.
 * If CORS_ORIGINS is empty, every origin is allowed (fine for local development only).
 */
const getAllowedOrigins = () =>
  (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    const allowed = getAllowedOrigins();
    if (!origin || allowed.length === 0 || allowed.includes(origin)) {
      return callback(null, true);
    }
    // No CORS headers -> the browser blocks the response
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining'],
  maxAge: 600,
};

const warnIfOpenInProduction = () => {
  if (process.env.NODE_ENV === 'production' && getAllowedOrigins().length === 0) {
    console.warn('[cors] CORS_ORIGINS is not set: any website can call this API from a browser. Set it to the frontend URL.');
  }
};

module.exports = { corsOptions, warnIfOpenInProduction };
