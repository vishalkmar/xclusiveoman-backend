const { getAdminDashboardStats } = require("../models/adminDashboard.model.js");

async function getStats(req, res, next) {
  try {
    res.json(await getAdminDashboardStats());
  } catch (err) {
    next(err);
  }
}

module.exports.getStats = getStats;
