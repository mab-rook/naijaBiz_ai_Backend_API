const Alert = require('./alertModel');
const Business = require('../auth/businessModel');
const User = require('../auth/userModel');
const mlService = require('../ai/mlService');
const { getSalesRate, getDailySales, getProfitAndLoss, getCashFlow } = require('../reports/reportService');

/**
 * Business insights (recommendations) stored as alerts of type 'insight'.
 * Source: the ML service's POST /insights when it is
 * available, otherwise the backend's own rules (currently: weekend demand).
 * Each insight has a stable `key`; the same key is not stored again within 7 days.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const REPEAT_AFTER_MS = 7 * DAY_MS;
const MAX_INSIGHTS_PER_RUN = 5;
const SEVERITIES = ['info', 'warning', 'critical'];
const LANGUAGES = ['yo', 'ha', 'ig'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday'];

const naira = (n) => `₦${Math.round(n).toLocaleString('en-NG')}`;

/** Data the ML service (or local rules) base insights on */
const buildInsightContext = async (businessId) => {
  const [salesRate, dailySales, profitLoss, cashFlow] = await Promise.all([
    getSalesRate(businessId, {}),
    getDailySales(businessId, { days: 28 }),
    getProfitAndLoss(businessId, {}),
    getCashFlow(businessId, { interval: 'week' }),
  ]);
  return { currency: 'NGN', salesRate, dailySales, profitLoss, cashFlow };
};

/**
 * Local rule: Friday/Saturday average revenue at least 1.5x the Monday-Thursday average,
 * with at least 3 weeks of data. Names the product with the biggest weekend lift.
 */
const weekendDemandInsight = (context) => {
  const { series, byWeekday } = context.dailySales;
  if (series.filter((d) => d.revenue > 0).length < 14) return null;

  const avgOf = (names) => {
    const rows = byWeekday.filter((d) => names.includes(d.dayOfWeek) && d.days > 0);
    return rows.length ? rows.reduce((sum, d) => sum + d.avgRevenue, 0) / rows.length : 0;
  };
  const weekend = avgOf(['Friday', 'Saturday']);
  const weekday = avgOf(WEEKDAYS);
  if (weekday <= 0 || weekend < weekday * 1.5) return null;

  const ratio = Math.round((weekend / weekday) * 10) / 10;
  const fastest = [...context.salesRate.products].sort((a, b) => b.avgDailyUnits - a.avgDailyUnits)[0];
  const product = fastest && fastest.avgDailyUnits > 0 ? fastest.name : 'your best sellers';

  return {
    key: 'weekend_demand',
    type: 'weekend_demand',
    title: `Weekend demand: Fridays and Saturdays sell ${ratio}x more`,
    message: `Your Friday and Saturday sales average ${naira(weekend)} a day, about ${ratio}x a normal weekday (${naira(weekday)}). Restock ${product} by Thursday so you don't run out at the weekend.`,
    messageLocalized: {
      yo: `Tita rẹ ni Ọjọ Ẹti ati Satide pọ to ${ratio} ilọpo ti ọjọ miiran. Ra ${product} si ki Ọjọbọ to pari.`,
      ha: `Cinikinka a ranar Juma'a da Asabar ya ninka na sauran kwanaki sau ${ratio}. Ka siyo ${product} kafin Alhamis.`,
      ig: `Ahịa gị na Fraịde na Satọdee karịrị ụbọchị ndị ọzọ ugboro ${ratio}. Zụtakwuo ${product} tupu Tọzdee.`,
    },
    severity: 'info',
    data: { weekendAvgRevenue: Math.round(weekend), weekdayAvgRevenue: Math.round(weekday), ratio, product },
  };
};

/** Never trust ML output as-is: keep only well-formed insights */
const sanitizeInsight = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const key = typeof raw.key === 'string' ? raw.key.trim().slice(0, 100) : '';
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 200) : '';
  const message = typeof raw.message === 'string' ? raw.message.trim().slice(0, 1000) : '';
  if (!key || !title || !message) return null;

  const messageLocalized = {};
  for (const lang of LANGUAGES) {
    const text = raw.messageLocalized && raw.messageLocalized[lang];
    if (typeof text === 'string') messageLocalized[lang] = text.slice(0, 1000);
  }
  return {
    key,
    type: typeof raw.type === 'string' ? raw.type.slice(0, 50) : 'general',
    title,
    message,
    messageLocalized,
    severity: SEVERITIES.includes(raw.severity) ? raw.severity : 'info',
    data: raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : {},
  };
};

const getOwnerLanguage = async (businessId) => {
  const business = await Business.findById(businessId).select('owner');
  const owner = business && (await User.findById(business.owner).select('preferredLanguage'));
  return (owner && owner.preferredLanguage) || 'en';
};

/** Ask the ML service first; fall back to local rules. Returns { engine, insights } */
const computeInsights = async (businessId) => {
  const context = await buildInsightContext(businessId);

  if (mlService.isEnabled()) {
    try {
      const language = await getOwnerLanguage(businessId);
      const result = await mlService.insights({ businessId: String(businessId), language, context });
      const list = Array.isArray(result && result.insights) ? result.insights : [];
      return { engine: 'ml', insights: list.map(sanitizeInsight).filter(Boolean).slice(0, MAX_INSIGHTS_PER_RUN) };
    } catch (err) {
      console.warn(`[insights] ML insights failed, using local rules: ${err.message}`);
    }
  }

  return { engine: 'local', insights: [weekendDemandInsight(context)].filter(Boolean) };
};

/** Compute insights and store new ones as alerts. Returns the alerts created. */
const generateInsights = async (businessId) => {
  const { engine, insights } = await computeInsights(businessId);
  const created = [];
  for (const insight of insights) {
    const recent = await Alert.findOne({
      businessId,
      type: 'insight',
      'metadata.insightKey': insight.key,
      createdAt: { $gte: new Date(Date.now() - REPEAT_AFTER_MS) },
    });
    if (recent) continue;

    created.push(
      await Alert.create({
        businessId,
        type: 'insight',
        title: insight.title,
        message: insight.message,
        messageLocalized: insight.messageLocalized,
        severity: insight.severity,
        metadata: { ...insight.data, insightKey: insight.key, insightType: insight.type, engine },
      })
    );
  }
  return created;
};

module.exports = {
  generateInsights,
  computeInsights,
  weekendDemandInsight,
  sanitizeInsight,
};
