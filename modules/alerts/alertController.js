const Alert = require('./alertModel');
const { generateProactiveAlerts } = require('./alertService');
const AppError = require('../../common/utils/AppError');

/**
 * Get proactive alerts feed
 */
const getAlerts = async (req, res, next) => {
  try {
    const { unreadOnly } = req.query;
    const filter = { businessId: req.businessId };

    if (unreadOnly === 'true') {
      filter.read = false;
    }

    const alerts = await Alert.find(filter).sort({ createdAt: -1 });

    res.json({
      success: true,
      count: alerts.length,
      unreadCount: alerts.filter((a) => !a.read).length,
      data: alerts,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Mark alert as read
 */
const markAlertAsRead = async (req, res, next) => {
  try {
    const alert = await Alert.findOneAndUpdate(
      { _id: req.params.id, businessId: req.businessId },
      { read: true },
      { new: true }
    );

    if (!alert) {
      throw new AppError(404, 'Alert not found', 'ALERT_NOT_FOUND');
    }

    res.json({
      success: true,
      message: 'Alert marked as read',
      data: alert,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Trigger proactive alert generation scan
 */
const triggerAlertScan = async (req, res, next) => {
  try {
    const alerts = await generateProactiveAlerts(req.businessId);

    res.json({
      success: true,
      message: `Alert scan complete. Generated ${alerts.length} new alert(s).`,
      newAlertsCount: alerts.length,
      data: alerts,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAlerts,
  markAlertAsRead,
  triggerAlertScan,
};
