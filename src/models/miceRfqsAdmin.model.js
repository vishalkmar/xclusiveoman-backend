const {
  pool
} = require('../db/pool.js');

const {
  replaceItinerary
} = require('./miceRfqs.model.js');

// Admin-side queries only (listing with joins/pagination/search, lead-manager
// assignment) — mirrors packageRequestsAdmin.model.js. Detail sub-lists
// (hotels/tours/transfers/activities) are reused as-is from
// models/miceRfqs.model.js by the controller, not duplicated here.

const JOINS = `
  FROM mice_rfqs mr
  JOIN agencies a ON a.id = mr.agency_id
  JOIN users u ON u.id = mr.created_by_user_id
  LEFT JOIN users lm ON lm.id = mr.lead_manager_user_id
  LEFT JOIN users pub ON pub.id = mr.published_by_user_id
`;

const SELECT_COLUMNS = `
  mr.*,
  a.name AS agency_name,
  u.full_name AS agent_full_name,
  u.email AS agent_email,
  lm.full_name AS lead_manager_full_name,
  lm.email AS lead_manager_email,
  pub.full_name AS published_by_full_name
`;

// leadManagerUserId/agencyIds — see packageRequestsAdmin.model.js's
// identical comment on its own buildFilters; same Team Portal LM/RM scoping,
// mirrored here for MICE RFQs.
// `agencyId` / `assignedTo` / `submittedFrom|To` are the admin list's own
// client filters (MICE Requests page) — distinct from the server-set
// leadManagerUserId/agencyIds scoping above, and ANDed with it.
function buildFilters({ status, search, eventFrom, eventTo, submittedFrom, submittedTo, agencyId, assignedTo, leadManagerUserId, agencyIds }) {
  const clauses = [];
  const values = [];

  if (status) {
    clauses.push(`mr.status = ?`);
    values.push(status);
  }
  if (agencyId) {
    clauses.push(`mr.agency_id = ?`);
    values.push(agencyId);
  }
  if (assignedTo === 'unassigned') {
    clauses.push(`mr.lead_manager_user_id IS NULL`);
  } else if (assignedTo) {
    clauses.push(`mr.lead_manager_user_id = ?`);
    values.push(assignedTo);
  }
  if (submittedFrom) {
    clauses.push(`mr.created_at >= ?`);
    values.push(submittedFrom);
  }
  if (submittedTo) {
    clauses.push(`mr.created_at < (? + INTERVAL 1 DAY)`);
    values.push(submittedTo);
  }
  if (leadManagerUserId) {
    clauses.push(`mr.lead_manager_user_id = ?`);
    values.push(leadManagerUserId);
  }
  if (agencyIds) {
    clauses.push(`mr.agency_id IN (?)`);
    values.push(agencyIds);
  }
  if (eventFrom) {
    clauses.push(`mr.event_date_from >= ?`);
    values.push(eventFrom);
  }
  if (eventTo) {
    clauses.push(`mr.event_date_from < (? + INTERVAL 1 DAY)`);
    values.push(eventTo);
  }
  if (search) {
    clauses.push(`(LOWER(mr.id) LIKE LOWER(?) OR LOWER(u.full_name) LIKE LOWER(?) OR LOWER(a.name) LIKE LOWER(?) OR LOWER(mr.destination) LIKE LOWER(?))`);
    values.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

async function listMiceRfqsForAdmin(
  { page, pageSize, ...filters } = {}
) {
  const { where, values } = buildFilters(filters);

  const { rows: countRows } = await pool.query(`SELECT COUNT(*) AS count ${JOINS} ${where}`, values);
  const total = Number(countRows[0].count);

  const limit = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const currentPage = Math.max(1, Number(page) || 1);
  const offset = (currentPage - 1) * limit;

  const { rows } = await pool.query(
    `SELECT ${SELECT_COLUMNS} ${JOINS} ${where}
     ORDER BY mr.created_at DESC
     LIMIT ? OFFSET ?`,
    [...values, limit, offset]
  );

  return { rows, total, page: currentPage, pageSize: limit };
}

module.exports.listMiceRfqsForAdmin = listMiceRfqsForAdmin;

// Every matching row (no pagination), just the columns the statistics need —
// services/requestStats.service.js aggregates them.
async function listMiceRfqsForStats(filters = {}) {
  const { where, values } = buildFilters(filters);
  const { rows } = await pool.query(
    `SELECT mr.id, mr.status, mr.created_at, mr.updated_at, mr.published_at, mr.sell_price,
            mr.lead_manager_user_id, lm.full_name AS lead_manager_full_name,
            mr.agency_id, a.name AS agency_name, mr.destination, mr.group_size, mr.event_date_from
     ${JOINS} ${where}`,
    values
  );
  return rows;
}

module.exports.listMiceRfqsForStats = listMiceRfqsForStats;

async function findMiceRfqForAdmin(id) {
  const { rows } = await pool.query(`SELECT ${SELECT_COLUMNS} ${JOINS} WHERE mr.id = ?`, [id]);
  return rows[0] || null;
}

module.exports.findMiceRfqForAdmin = findMiceRfqForAdmin;

async function updateMiceRfqLeadManager(id, leadManagerUserId) {
  await pool.query(
    `UPDATE mice_rfqs SET lead_manager_user_id = ?, updated_at = now() WHERE id = ?`,
    [leadManagerUserId, id]
  );
  const { rows } = await pool.query(`SELECT * FROM mice_rfqs WHERE id = ?`, [id]);
  return rows[0] || null;
}

module.exports.updateMiceRfqLeadManager = updateMiceRfqLeadManager;

async function updateMiceRfqCosting(
  id,
  { costBreakdown, landingCost, markupRule, sellPrice, internalNotes, status }
) {
  await pool.query(
    `UPDATE mice_rfqs
     SET cost_breakdown = ?, net_cost_total = ?, markup_rule = ?, sell_price = ?, internal_notes = ?,
         status = ?, updated_at = now()
     WHERE id = ?`,
    [JSON.stringify(costBreakdown ?? null), landingCost, JSON.stringify(markupRule ?? null), sellPrice, internalNotes, status, id]
  );
  const { rows } = await pool.query(`SELECT * FROM mice_rfqs WHERE id = ?`, [id]);
  return rows[0] || null;
}

module.exports.updateMiceRfqCosting = updateMiceRfqCosting;

async function updateMiceRfqItinerary(id, days) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await replaceItinerary(client, id, days);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports.updateMiceRfqItinerary = updateMiceRfqItinerary;

async function publishMiceRfq(id, publishedByUserId) {
  await pool.query(
    `UPDATE mice_rfqs
     SET status = 'published', published_at = now(), published_by_user_id = ?, updated_at = now()
     WHERE id = ?`,
    [publishedByUserId, id]
  );
  const { rows } = await pool.query(`SELECT * FROM mice_rfqs WHERE id = ?`, [id]);
  return rows[0] || null;
}

module.exports.publishMiceRfq = publishMiceRfq;
