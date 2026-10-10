const mongoose = require('mongoose');
const AppError = require('./AppError');

const isUnsupportedTransactionError = (error) =>
  error.code === 20 ||
  error.codeName === 'IllegalOperation' ||
  /Transaction numbers are only allowed|does not support transactions/i.test(error.message || '');

const withTransaction = async (operation) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await operation(session);
    });
    return result;
  } catch (error) {
    if (isUnsupportedTransactionError(error)) {
      throw new AppError(
        503,
        'This operation requires MongoDB replica set transaction support',
        'TRANSACTIONS_UNAVAILABLE'
      );
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

module.exports = withTransaction;
