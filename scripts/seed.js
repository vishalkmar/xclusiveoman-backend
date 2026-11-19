require('dotenv/config');

const {
  pool
} = require('../src/db/pool.js');

const {
  env
} = require('../src/config/env.js');

const {
  newId
} = require('../src/utils/id.js');

// Set per-environment via SEED_ADMIN_EMAIL in .env (src/config/env.js) —
// dev points at a real inbox so OTP emails during local testing are actually
// receivable; prod should be set to whichever inbox will run the seed there.
const DEFAULT_EMAIL = env.seedAdminEmail;
const DEFAULT_FULL_NAME = 'Super Admin';
const CASHFREE_TEST_EMAIL = env.cashfree.testLoginEmail;
const CASHFREE_TEST_FULL_NAME = 'Cashfree Sandbox Test User';

async function seedCashfreeTestAccount() {
  if (!env.cashfree.apiBaseUrl.includes('sandbox')) {
    console.log('Cashfree is not configured for sandbox — skipping Cashfree test account.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let { rows } = await client.query(
      'SELECT id, agency_id FROM users WHERE email = ? LIMIT 1',
      [CASHFREE_TEST_EMAIL],
    );
    let agencyId = rows[0]?.agency_id;

    if (!agencyId) {
      const agencyRows = await client.query(
        `SELECT id FROM agencies WHERE name = ? LIMIT 1`,
        ['Cashfree Sandbox Test Agency'],
      );
      agencyId = agencyRows.rows[0]?.id;
    }

    if (!agencyId) {
      agencyId = newId();
      await client.query(
        `INSERT INTO agencies (id, name, type, country, status, currency_preference)
         VALUES (?, ?, 'travel_agent', 'Oman', 'approved', 'OMR')`,
        [agencyId, 'Cashfree Sandbox Test Agency'],
      );
    } else {
      await client.query(
        `UPDATE agencies SET status = 'approved' WHERE id = ?`,
        [agencyId],
      );
    }

    if (rows[0]) {
      await client.query(
        `UPDATE users
         SET agency_id = ?, role = 'agency_owner', full_name = ?, status = 'active'
         WHERE id = ?`,
        [agencyId, CASHFREE_TEST_FULL_NAME, rows[0].id],
      );
    } else {
      await client.query(
        `INSERT INTO users
         (id, agency_id, role, full_name, email, permissions, status, password_hash)
         VALUES (?, ?, 'agency_owner', ?, ?, JSON_OBJECT(), 'active', '')`,
        [newId(), agencyId, CASHFREE_TEST_FULL_NAME, CASHFREE_TEST_EMAIL],
      );
    }

    await client.query('COMMIT');
    console.log(`Seeded Cashfree sandbox test account (${CASHFREE_TEST_EMAIL}).`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  await seedCashfreeTestAccount();

  if (!DEFAULT_EMAIL) {
    console.log('No seed email configured for this environment — set SEED_ADMIN_EMAIL in .env.');
    await pool.end();
    return;
  }

  const { rows } = await pool.query('SELECT id FROM users WHERE email = ?', [DEFAULT_EMAIL]);

  if (rows[0]) {
    console.log(`Seed super admin already exists (${DEFAULT_EMAIL}) — skipping.`);
    await pool.end();
    return;
  }

  await pool.query(
    `INSERT INTO users (id, agency_id, role, full_name, email, status)
     VALUES (?, NULL, 'super_admin', ?, ?, 'active')`,
    [newId(), DEFAULT_FULL_NAME, DEFAULT_EMAIL]
  );

  console.log('Seeded default super admin:');
  console.log(`  email: ${DEFAULT_EMAIL}`);
  console.log('Run `npm run seed-admin-passwords` next to give this account an initial password, then sign in at /admin/login.');

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
