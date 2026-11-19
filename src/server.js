const http = require('node:http');

const {
  createApp
} = require('./app.js');

const {
  initSockets
} = require('./sockets/index.js');

const {
  startMarketingScheduler
} = require('./jobs/marketingScheduler.job.js');

const {
  startBalanceDueReminderScheduler
} = require('./jobs/balanceDueReminder.job.js');

const {
  startFxRateScheduler
} = require('./jobs/fxRate.job.js');

const {
  startSeatHoldReleaseScheduler
} = require('./jobs/seatHoldRelease.job.js');

const {
  env
} = require('./config/env.js');

const app = createApp();
const httpServer = http.createServer(app);

// Slow-client protection: a client must send its headers within 20s and its
// whole request within 2 minutes (long enough for a 10MB upload on a slow
// connection), so trickled "slowloris" requests can't hold sockets open.
httpServer.headersTimeout = 20 * 1000;
httpServer.requestTimeout = 2 * 60 * 1000;
httpServer.keepAliveTimeout = 5 * 1000;

initSockets(httpServer);
// Marketing Center Task 6 — polls for due scheduled campaigns once a
// minute (jobs/marketingScheduler.job.js); safe to start unconditionally,
// it's a no-op tick when nothing is due.
startMarketingScheduler();
// Balance Due Reminder — daily (jobs/balanceDueReminder.job.js); same
// safe-to-start-unconditionally reasoning as the marketing scheduler above,
// a no-op tick when nothing currently qualifies.
startBalanceDueReminderScheduler();
// FX rate — nightly at midnight (jobs/fxRate.job.js); the only FX API call,
// checkout reads the saved rate (services/fx.service.js).
startFxRateScheduler();
// Seat holds — every 30s (jobs/seatHoldRelease.job.js); gives an unpaid
// booking's seats back once its checkout has been pending past 2 minutes.
startSeatHoldReleaseScheduler();

httpServer.listen(env.port, () => {
  console.log(`Xclusive Oman API listening on http://localhost:${env.port} (${env.nodeEnv})`);
});
