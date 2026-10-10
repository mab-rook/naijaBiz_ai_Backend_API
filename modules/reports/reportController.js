const reportService = require('./reportService');

// Every report handler has the same shape: run the service with the query string, return its data
const handle = (fn) => async (req, res, next) => {
  try {
    res.json({ success: true, data: await fn(req.businessId, req.query) });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getProfitAndLoss: handle(reportService.getProfitAndLoss),
  getCashFlow: handle(reportService.getCashFlow),
  getTopProducts: handle(reportService.getTopProducts),
  getSalesRate: handle(reportService.getSalesRate),
  getDailySales: handle(reportService.getDailySales),
};
