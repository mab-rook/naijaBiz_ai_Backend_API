const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });

const app = require('./app');
const { connectDB } = require('./config/db');
const User = require('./modules/auth/userModel');
const seedDatabase = require('./seed/seedData');
const { assertJwtConfig } = require('./modules/auth/tokenService');
const { warnIfOpenInProduction } = require('./config/cors');
const { startAlertScheduler, stopAlertScheduler } = require('./modules/alerts/alertScheduler');
const { initializeRateLimiterStore } = require('./common/middleware/rateLimiter');
const { runWithLease } = require('./common/utils/distributedLease');

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    assertJwtConfig();
    warnIfOpenInProduction();
    await connectDB();
    await initializeRateLimiterStore();

    // Seed the demo shop only into a brand-new database. The seed wipes every collection,
    // so it must never run once any merchant exists. AUTO_SEED=false turns it off.
    if (process.env.AUTO_SEED !== 'false') {
      const seedOutcome = await runWithLease(
        'initial-demo-seed',
        async () => {
          if (await User.exists()) return false;
          console.log('Empty database detected. Auto-populating Nigerian SME demo data...');
          await seedDatabase();
          return true;
        },
        { durationMs: 15 * 60 * 1000, renewIntervalMs: 60 * 1000 }
      );
      if (!seedOutcome.acquired) {
        console.log('Another API instance is handling initial demo seeding.');
      } else if (!seedOutcome.value) {
        console.log('Database already contains merchants; demo seeding skipped.');
      }
    }

    const server = app.listen(PORT, () => {
      console.log('=====================================================');
      console.log(`NaijaBiz AI backend running in ${process.env.NODE_ENV || 'development'} mode`);
      console.log(`Port: ${PORT}`);
      console.log(`API docs: http://localhost:${PORT}/api-docs`);
      console.log(`Health check: http://localhost:${PORT}/health`);
      console.log('=====================================================');
      startAlertScheduler();
    });

    const shutdown = async () => {
      console.log('Gracefully terminating server...');
      stopAlertScheduler();
      server.close(() => {
        console.log('HTTP server closed.');
        process.exit(0);
      });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
};

startServer();
