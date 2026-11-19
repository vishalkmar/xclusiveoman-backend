require('dotenv/config');

const { pool } = require('../src/db/pool.js');
const { newId } = require('../src/utils/id.js');

const DEMO_AGENCY = 'Seed Reviews Demo Agency';
const REVIEWS = [
  ['A beautifully organised journey from start to finish. The itinerary was clear, the hotels were comfortable, and every transfer arrived on time. Our guests especially loved how smoothly the entire trip came together.', 5],
  ['Excellent package with a thoughtful balance of sightseeing and free time. The team was responsive throughout, and the experience felt effortless for both our agency and our travellers.', 5],
  ['A polished, well-planned Oman experience. The selection of activities was outstanding, the schedule was easy to follow, and the service delivered far beyond expectations.', 5],
  ['Our travellers returned delighted. The package offered great value, beautiful locations, and dependable support at every stage. We would confidently recommend it to other agencies.', 5],
  ['An exceptional itinerary with memorable experiences in every destination. Everything was handled professionally, from the first confirmation to the final departure.', 5],
];

async function seedReviews() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: packages } = await client.query(
      `SELECT id, title AS name
       FROM fd_packages
       WHERE status = 'published'
       ORDER BY created_at, id`
    );
    if (!packages.length) {
      console.log('No active FD packages found; no reviews seeded.');
      await client.query('ROLLBACK');
      return;
    }
    console.log(`Found ${packages.length} published FD package${packages.length === 1 ? '' : 's'}.`);

    let { rows: agencies } = await client.query('SELECT id FROM agencies WHERE name = ? LIMIT 1', [DEMO_AGENCY]);
    let agencyId = agencies[0]?.id;
    if (!agencyId) {
      agencyId = newId();
      await client.query(
        `INSERT INTO agencies (id, name, type, country, status, currency_preference)
         VALUES (?, ?, 'travel_agent', 'Oman', 'approved', 'OMR')`,
        [agencyId, DEMO_AGENCY]
      );
    }

    const email = 'seed-reviews@xclusiveoman.local';
    let { rows: users } = await client.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
    let userId = users[0]?.id;
    if (!userId) {
      userId = newId();
      await client.query(
        `INSERT IGNORE INTO users (id, agency_id, role, full_name, email, status, password_hash)
         VALUES (?, ?, 'agency_owner', 'Xclusive Oman Guest Reviewer', ?, 'active', '')`,
        [userId, agencyId, email]
      );
      ({ rows: users } = await client.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]));
      userId = users[0].id;
    }

    let packagesWithReviews = 0;
    let reviewsCreated = 0;

    for (let i = 0; i < packages.length; i += 1) {
      const pkg = packages[i];
      const { rows: existing } = await client.query(
        `SELECT r.id FROM reviews r
         JOIN bookings b ON b.id = r.booking_id
         WHERE r.fd_package_id = ? AND b.created_by_user_id = ? AND r.status = 'published'
         ORDER BY r.submitted_at, r.id`,
        [pkg.id, userId]
      );
      for (let reviewIndex = existing.length; reviewIndex < 3; reviewIndex += 1) {
        const bookingId = newId();
        await client.query(
          `INSERT INTO bookings
            (id, source_type, source_id, agency_id, created_by_user_id, pax, total_price, deposit_paid, balance_due, status, created_via)
           VALUES (?, 'fd_package', ?, ?, ?, 2, 0, 0, 0, 'completed', 'manual_admin')`,
          [bookingId, pkg.id, agencyId, userId]
        );

        const [text, rating] = REVIEWS[(i * 3 + reviewIndex) % REVIEWS.length];
        await client.query(
          `INSERT INTO reviews (id, booking_id, fd_package_id, agency_id, rating, review_text, status)
           VALUES (?, ?, ?, ?, ?, ?, 'published')`,
          [newId(), bookingId, pkg.id, agencyId, rating, text]
        );
        reviewsCreated += 1;
        console.log(`Seeded review ${reviewIndex + 1}/3 for package: ${pkg.name || pkg.id}`);
      }
      packagesWithReviews += 1;
    }

    await client.query('COMMIT');
    console.log(
      `Reviews filled for ${packagesWithReviews}/${packages.length} published package${packages.length === 1 ? '' : 's'}; ${reviewsCreated} new review${reviewsCreated === 1 ? '' : 's'} created.`
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

seedReviews()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end().finally(() => process.exit(1));
  });
