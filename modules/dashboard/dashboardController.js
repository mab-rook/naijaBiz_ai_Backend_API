const { getDashboardMetrics } = require('./financialService');
const Alert = require('../alerts/alertModel');

/**
 * Get aggregated business dashboard totals and alerts
 */
const getDashboard = async (req, res, next) => {
  try {
    const { timeRange } = req.query;
    const metrics = await getDashboardMetrics(req.businessId, timeRange || '30d');

    // Fetch latest active alerts for dashboard widget
    const alerts = await Alert.find({ businessId: req.businessId, read: false })
      .sort({ createdAt: -1 })
      .limit(5);

    res.json({
      success: true,
      data: {
        ...metrics,
        recentAlerts: alerts,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getDashboard,
};

