const mongoose = require('mongoose');

let memoryServer = null;

const connectDB = async () => {
  if (mongoose.connection.readyState === 1) {
    return;
  }

  if (process.env.NODE_ENV === 'test') {
    const { MongoMemoryReplSet } = require('mongodb-memory-server');
    memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(memoryServer.getUri());
    console.log('MongoDB connected via isolated in-memory replica set for tests.');
    return;
  }

  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/naijabiz_db';

  try {
    if (uri) {
      console.log('Connecting to MongoDB...');
      await mongoose.connect(uri);
      console.log('MongoDB connected successfully via URI.');
    } else {
      console.log('No MONGODB_URI provided. Initializing in-memory MongoDB for local/demo environment...');
      const { MongoMemoryReplSet } = require('mongodb-memory-server');
      memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
      const memoryUri = memoryServer.getUri();
      console.log(`In-memory MongoDB started at: ${memoryUri}`);
      await mongoose.connect(memoryUri);
      console.log('MongoDB connected successfully via in-memory replica set.');
    }
  } catch (err) {
    console.error('Failed to connect to primary MongoDB URI:', err.message);
    if (process.env.NODE_ENV === 'production') {
      // Never fall back to a throwaway in-memory database in production: data would be lost
      console.error('Fatal: MongoDB is unreachable in production. Check MONGODB_URI.');
      process.exit(1);
    }
    try {
      console.log('Attempting fallback to in-memory MongoDB replica set...');
      const { MongoMemoryReplSet } = require('mongodb-memory-server');
      memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
      const memoryUri = memoryServer.getUri();
      await mongoose.connect(memoryUri);
      console.log('MongoDB fallback connected via in-memory replica set.');
    } catch (fallbackErr) {
      console.error('Fatal: Could not initialize any MongoDB connection:', fallbackErr.message);
      process.exit(1);
    }
  }
};

const disconnectDB = async () => {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop();
  }
};

// True when running on the throwaway in-memory database (dev/test fallback): data is not saved
const isUsingInMemoryDatabase = () => memoryServer !== null;

module.exports = { connectDB, disconnectDB, isUsingInMemoryDatabase };
