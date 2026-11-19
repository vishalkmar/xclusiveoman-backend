const { getRate } = require('../services/fx.service.js');
async function getInrRate(req, res, next) { try { res.json({ baseCurrency: 'OMR', targetCurrency: 'INR', rate: await getRate('INR') }); } catch (err) { next(err); } }
module.exports = { getInrRate };
