// Transactions service Express app (owner: [TEAMMATE 1]).
try { require('dotenv').config({ quiet: true }); } catch { /* dotenv is optional */ }
const { createApp, createLogger } = require('pb-common');
const { createTransactionRoutes } = require('./routes/transactions');

const logger = createLogger('transactions');

module.exports = createApp({
  service: 'transactions',
  logger,
  mount: (app) => app.use('/api/transactions', createTransactionRoutes(logger))
});
