// Escape user/AI-supplied text so it can be used safely inside new RegExp(...)
const escapeRegex = (text = '') => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = { escapeRegex };
