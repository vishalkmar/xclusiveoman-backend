const cron = require('node-cron');

const {
  loadSavedRate,
  refreshSavedRate
} = require('../services/fx.service.js');

// FX rate — nightly cron, same node-cron as the other jobs here. The only
// place the FX API is called: saves the day's OMR -> gateway-currency rate
// (services/fx.service.js#refreshSavedRate), which checkout then reads with
// no API call of its own. A failed run leaves the previous saved rate in
// place; the next night (or the next restart, see below) tries again.
let running = false;

async function runFxRateRefresh() {
  if (running) return;
  running = true;
  try {
    const saved = await refreshSavedRate();
    if (saved) console.log(`[fxRate] Saved 1 ${saved.baseCurrency} = ${saved.rate} ${saved.targetCurrency} (provider time ${saved.providerUpdatedAt})`);
  } catch (err) {
    console.error('[fxRate] Failed to refresh saved rate:', err.message);
  } finally {
    running = false;
  }
}

module.exports.runFxRateRefresh = runFxRateRefresh;

// 00:00 server time, nightly. Also refreshes once at startup when there is
// no saved rate yet or it is over a day old, so a fresh deploy can take
// payments before its first midnight.
function startFxRateScheduler() {
  cron.schedule('0 0 * * *', () => {
    runFxRateRefresh().catch((err) => console.error('[fxRate] Unexpected error', err));
  });

  loadSavedRate()
    .then((saved) => {
      const stale = !saved || Date.now() - Date.parse(saved.fetchedAt) > 24 * 60 * 60 * 1000;
      if (stale) return runFxRateRefresh();
      return undefined;
    })
    .catch((err) => console.error('[fxRate] Unexpected error', err));
}

module.exports.startFxRateScheduler = startFxRateScheduler;
