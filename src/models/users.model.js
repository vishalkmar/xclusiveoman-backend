const {
  pool
} = require('../db/pool.js');

const {
  newId
} = require('../utils/id.js');

async function createUser(
  client,
  { agencyId, role, fullName, email, phone, whatsappNumber, permissions, passwordHash }
) {
  const id = newId();
  await client.query(
    `INSERT INTO users (id, agency_id, role, full_name, email, phone, whatsapp_number, permissions, password_hash, password_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, JSON_OBJECT()), ?, ${passwordHash ? 'now()' : 'NULL'})`,
    [
      id,
      agencyId || null,
      role,
      fullName,
      email.toLowerCase(),
      phone || null,
      whatsappNumber || null,
      permissions ? JSON.stringify(permissions) : null,
      passwordHash || null,
    ]
  );
  const { rows } = await client.query('SELECT * FROM users WHERE id = ?', [id]);
  return rows[0];
}

module.exports.createUser = createUser;

async function findUserByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email = ?', [
    email.toLowerCase(),
  ]);
  return rows[0] || null;
}

module.exports.findUserByEmail = findUserByEmail;

async function findUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
  return rows[0] || null;
}

module.exports.findUserById = findUserById;

async function listStaff() {
  const { rows } = await pool.query(
    `SELECT * FROM users WHERE agency_id IS NULL ORDER BY created_at DESC`
  );
  return rows;
}

module.exports.listStaff = listStaff;

async function listStaffByRole(role) {
  const { rows } = await pool.query(
    `SELECT * FROM users WHERE agency_id IS NULL AND role = ? ORDER BY created_at DESC`,
    [role]
  );
  return rows;
}

module.exports.listStaffByRole = listStaffByRole;

async function listAgencyUsers(agencyId) {
  const { rows } = await pool.query(
    `SELECT * FROM users WHERE agency_id = ? ORDER BY created_at DESC`,
    [agencyId]
  );
  return rows;
}

module.exports.listAgencyUsers = listAgencyUsers;

async function listAgencyOwnerEmails(agencyIds) {
  if (agencyIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT id, agency_id, full_name, email, phone FROM users
     WHERE agency_id IN (?) AND role = 'agency_owner' AND status = 'active'`,
    [agencyIds]
  );
  return rows;
}

module.exports.listAgencyOwnerEmails = listAgencyOwnerEmails;

async function updateUser(id, fields) {
  const setClauses = [];
  const values = [];

  const columnMap = {
    role: 'role',
    status: 'status',
    fullName: 'full_name',
    phone: 'phone',
    whatsappNumber: 'whatsapp_number',
  };

  for (const [key, column] of Object.entries(columnMap)) {
    if (fields[key] !== undefined) {
      setClauses.push(`${column} = ?`);
      values.push(fields[key]);
    }
  }

  if (fields.permissions !== undefined) {
    setClauses.push(`permissions = ?`);
    values.push(JSON.stringify(fields.permissions));
  }

  if (setClauses.length === 0) {
    return findUserById(id);
  }

  setClauses.push('updated_at = now()');
  values.push(id);

  await pool.query(
    `UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`,
    values
  );
  const { rows } = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
  return rows[0] || null;
}

module.exports.updateUser = updateUser;

function toPublicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    agencyId: user.agency_id,
    role: user.role,
    fullName: user.full_name,
    email: user.email,
    phone: user.phone,
    whatsappNumber: user.whatsapp_number,
    status: user.status,
    permissions: user.permissions,
    // Whether a password is set (never the hash itself) — the Profile's
    // "Change password" page shows "Create password" when it isn't.
    hasPassword: Boolean(user.password_hash),
    // Account audit timestamps (0003_users.sql; updated_at bumped by
    // updateUser) — surfaced for the admin Employees table's Created /
    // Updated columns. Additive: every other toPublicUser consumer just
    // gains two ISO strings it can ignore.
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  };
}

module.exports.toPublicUser = toPublicUser;

// ── Password sign-in (0117_agent_password_login.sql) ────────────────────────

// Sets a new password and signs the user out everywhere: token_version is
// bumped so every access/refresh token issued before this stops working
// (middleware/auth.js, POST /auth/refresh), and the wrong-password counter
// and lock are cleared. Returns the updated row.
async function setUserPassword(userId, passwordHash) {
  await pool.query(
    `UPDATE users
     SET password_hash = ?, password_changed_at = now(), token_version = token_version + 1,
         password_failed_attempts = 0, password_locked_until = NULL, updated_at = now()
     WHERE id = ?`,
    [passwordHash, userId]
  );
  const { rows } = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
  return rows[0] || null;
}

module.exports.setUserPassword = setUserPassword;

// Seconds left on a password lockout (0 when not locked). Decided in SQL so
// it uses the database clock, the same one that wrote password_locked_until.
async function getPasswordLockSeconds(userId) {
  const { rows } = await pool.query(
    `SELECT GREATEST(TIMESTAMPDIFF(SECOND, now(), password_locked_until), 0) AS seconds
     FROM users WHERE id = ?`,
    [userId]
  );
  return Number(rows[0]?.seconds || 0);
}

module.exports.getPasswordLockSeconds = getPasswordLockSeconds;

// One wrong password. At `maxAttempts` in a row the account's password
// sign-in locks for `lockMinutes`; a failure after a lock has expired starts
// the count again at 1. (MySQL evaluates the assignments left to right, so
// the second one sees the already-incremented counter.)
async function recordFailedPasswordAttempt(userId, { maxAttempts, lockMinutes }) {
  await pool.query(
    `UPDATE users SET
       password_failed_attempts = IF(password_locked_until IS NOT NULL AND password_locked_until <= now(), 1, password_failed_attempts + 1),
       password_locked_until = IF(password_failed_attempts >= ?, now() + INTERVAL ? MINUTE,
                                  IF(password_locked_until IS NOT NULL AND password_locked_until <= now(), NULL, password_locked_until))
     WHERE id = ?`,
    [maxAttempts, lockMinutes, userId]
  );
}

module.exports.recordFailedPasswordAttempt = recordFailedPasswordAttempt;

async function clearPasswordFailures(userId) {
  await pool.query(
    'UPDATE users SET password_failed_attempts = 0, password_locked_until = NULL WHERE id = ? AND (password_failed_attempts > 0 OR password_locked_until IS NOT NULL)',
    [userId]
  );
}

module.exports.clearPasswordFailures = clearPasswordFailures;
