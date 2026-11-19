const {
  pool
} = require('../db/pool.js');

const {
  newId
} = require('../utils/id.js');

const {
  hotelsModel,
  toursModel,
  transfersModel,
  activitiesModel,
  mealsModel,
  visaModel,
  flightsModel
} = require('./catalog.model.js');

const {
  roomsForAdults
} = require('../utils/occupancy.js');

const {
  parseDurationDays
} = require('../utils/meals.js');

const {
  BASELINE_PAX,
  hasVehiclePricing,
  tourPerPaxPrice,
  tourItemPerPaxPrice,
  chosenVehicleRow,
  toPublicVehiclePrices,
  tierForPax,
} = require('../utils/tourPricing.js');

const FD_COLUMNS = [
  'title', 'theme', 'category', 'duration', 'hero_image_url', 'short_description',
  'suitable_age_min', 'is_featured', 'is_bestseller', 'status',
  // Package kind + Readymade departure cities (0120_fd_package_readymade.sql).
  'type', 'all_cities', 'departure_cities',
  'images', 'hotel_id', 'rate_per_pax',
  'platform_fee_mode', 'platform_fee_percentage',
  // Meals (lunch/dinner) are opt-in fd_addons rows now, not columns here —
  // see 0075_fd_meal_addons.sql.
  // Task 5 — "included or not" (0062_fd_addons_transfer_visa.sql).
  'visa_enabled',
  // Flights section (0064_fd_package_flights.sql) — at most one Onward +
  // one Return flight included directly, mutually exclusive in the editor
  // with offering flights as a fd_addons checkbox add-on instead.
  'flights_enabled', 'onward_flight_id', 'return_flight_id',
  // Client-facing Inclusions/Exclusions — see
  // 0050_fd_packages_inclusions_exclusions.sql.
  'inclusions', 'exclusions',
];

// `images` (0011_fd_package_images.sql) is a JSON column under MySQL —
// mysql2 auto-parses it on read but needs an explicit JSON.stringify on
// write, same as catalog.model.js's own createCrudModel handles for its
// tables' images/board_basis_options columns. `inclusions`/`exclusions`
// (0050_fd_packages_inclusions_exclusions.sql) are plain TEXT, not JSON —
// no serialization needed there.
function serializeValue(v) {
  if (Array.isArray(v) || (v !== null && typeof v === 'object' && !(v instanceof Date))) {
    return JSON.stringify(v);
  }
  return v;
}

async function listFdPackages({ status, destination, theme, category, featured, bestseller, type } = {}) {
  const clauses = [];
  const values = [];

  // Both kinds by default (the agent Packages tab shows FD and Readymade
  // together); ?type=fd_package or ?type=readymade narrows it.
  if (type === 'fd_package' || type === 'readymade') {
    clauses.push('fd_packages.type = ?');
    values.push(type);
  }

  if (status) {
    clauses.push(`fd_packages.status = ?`);
    values.push(status);
  } else {
    clauses.push(`fd_packages.status = 'published'`); // default agent-facing view
  }
  if (theme) {
    clauses.push(`fd_packages.theme = ?`);
    values.push(theme);
  }
  if (category) {
    clauses.push(`fd_packages.category = ?`);
    values.push(category);
  }
  if (featured === 'true') clauses.push('fd_packages.is_featured = true');
  if (bestseller === 'true') clauses.push('fd_packages.is_bestseller = true');
  if (destination) {
    // fd_packages has no dedicated "destination" column — the closest real
    // signal is the linked hotel's city, so match that alongside the title.
    clauses.push(`(LOWER(fd_packages.title) LIKE LOWER(?) OR LOWER(hotels.city) LIKE LOWER(?))`);
    values.push(`%${destination}%`, `%${destination}%`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT fd_packages.*, hotels.city AS hotel_city, hotels.name AS hotel_name
     FROM fd_packages
     LEFT JOIN hotels ON hotels.id = fd_packages.hotel_id
     ${where}
     ORDER BY fd_packages.created_at DESC`,
    values
  );
  return rows;
}

module.exports.listFdPackages = listFdPackages;

async function listPackageReviewStats() {
  const { rows } = await pool.query(
    `SELECT fd_package_id AS package_id, ROUND(AVG(rating), 1) AS rating, COUNT(*) AS review_count
       FROM reviews WHERE status = 'published' GROUP BY fd_package_id`
  );
  return Object.fromEntries(rows.map((row) => [row.package_id, { rating: Number(row.rating), reviewCount: Number(row.review_count) }]));
}

module.exports.listPackageReviewStats = listPackageReviewStats;

async function listAllFdPackagesForAdmin({ status, type, priceMin, priceMax, dateFrom, dateTo } = {}) {
  const clauses = [];
  const values = [];
  if (type === 'fd_package' || type === 'readymade') {
    clauses.push(`fd_packages.type = ?`);
    values.push(type);
  }
  if (status) {
    clauses.push(`fd_packages.status = ?`);
    values.push(status);
  } else {
    // Archived = "deleted, bookings kept" (0116) — hidden unless asked for.
    clauses.push(`fd_packages.status <> 'archived'`);
  }
  if (Number.isFinite(priceMin)) {
    // Price filters are in OMR and must match the OMR amount shown in the
    // admin catalogue. INR is only a presentation conversion in the UI.
    clauses.push(`COALESCE(fd_packages.rate_with_fee, fd_packages.rate_per_pax) >= ?`);
    values.push(priceMin);
  }
  if (Number.isFinite(priceMax)) {
    clauses.push(`COALESCE(fd_packages.rate_with_fee, fd_packages.rate_per_pax) <= ?`);
    values.push(priceMax);
  }
  if (dateFrom) {
    clauses.push(`fd_packages.created_at >= ?`);
    values.push(`${dateFrom} 00:00:00`);
  }
  if (dateTo) {
    clauses.push(`fd_packages.created_at < DATE_ADD(?, INTERVAL 1 DAY)`);
    values.push(dateTo);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(`
    SELECT fd_packages.*,
      hotels.name AS hotel_name,
      COALESCE(seat_agg.seats_total, 0) AS seats_total,
      COALESCE(seat_agg.seats_booked, 0) AS seats_booked,
      seat_agg.first_date,
      seat_agg.last_date
    FROM fd_packages
    LEFT JOIN hotels ON hotels.id = fd_packages.hotel_id
    LEFT JOIN LATERAL (
      SELECT SUM(seats_total) AS seats_total, SUM(seats_booked) AS seats_booked,
        MIN(date) AS first_date, MAX(date) AS last_date
      FROM fd_departure_dates
      WHERE fd_departure_dates.fd_package_id = fd_packages.id
    ) seat_agg ON true
    ${where}
    ORDER BY fd_packages.created_at DESC
  `, values);
  return rows;
}

module.exports.listAllFdPackagesForAdmin = listAllFdPackagesForAdmin;

async function findFdPackageById(id) {
  const { rows } = await pool.query(
    `SELECT fd_packages.*, hotels.name AS hotel_name
     FROM fd_packages
     LEFT JOIN hotels ON hotels.id = fd_packages.hotel_id
     WHERE fd_packages.id = ?`,
    [id]
  );
  return rows[0] || null;
}

module.exports.findFdPackageById = findFdPackageById;

async function createFdPackage(fields) {
  const cols = FD_COLUMNS.filter((c) => fields[c] !== undefined);
  const values = cols.map((c) => serializeValue(fields[c]));
  const id = newId();
  const placeholders = cols.map(() => '?').join(', ');
  await pool.query(
    `INSERT INTO fd_packages (id, ${cols.join(', ')}) VALUES (?, ${placeholders})`,
    [id, ...values]
  );
  const { rows } = await pool.query('SELECT * FROM fd_packages WHERE id = ?', [id]);
  return rows[0];
}

module.exports.createFdPackage = createFdPackage;

// What deleting a package would affect — shown in the admin delete dialog
// before the admin picks "delete everything" or "delete package only".
async function getFdPackageDeleteImpact(id) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS booking_count,
            COALESCE(SUM(b.deposit_paid > 0), 0) AS paid_booking_count,
            COALESCE(SUM(b.deposit_paid), 0) AS total_paid,
            COALESCE(SUM(b.pax), 0) AS traveller_count
     FROM bookings b
     WHERE b.source_type = 'fd_package' AND b.source_id = ?`,
    [id]
  );
  const r = rows[0];
  return {
    bookingCount: Number(r.booking_count),
    paidBookingCount: Number(r.paid_booking_count),
    totalPaid: Number(r.total_paid),
    travellerCount: Number(r.traveller_count),
  };
}

module.exports.getFdPackageDeleteImpact = getFdPackageDeleteImpact;

// Rows hanging off a package's departure dates that have no ON DELETE
// CASCADE — FD Operations' per-departure records. Cleared before the
// package (and so its departure dates) is deleted.
const DEPARTURE_CHILD_TABLES = [
  'fd_departure_driver_dispatches',
  'fd_departure_operations',
  'fd_departure_supplier_logs',
  'fd_departure_tour_updates',
];

// Permanently deletes a package. With `withBookings`, every booking made
// for it goes too, with their payments, transactions and reviews
// (travellers, traveller documents, add-ons and vouchers cascade from the
// booking). All in one transaction: it either all goes or nothing does.
// Callers must not use this without withBookings when bookings exist
// (archiveFdPackage is the keep-the-bookings path).
async function deleteFdPackage(id, { withBookings = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: bookings } = await client.query(
      `SELECT id FROM bookings WHERE source_type = 'fd_package' AND source_id = ? FOR UPDATE`,
      [id]
    );
    const bookingIds = bookings.map((booking) => booking.id);
    if (bookingIds.length && !withBookings) {
      throw Object.assign(new Error('This package still has bookings.'), { status: 409, publicCode: 'has_bookings' });
    }

    if (bookingIds.length) {
      const { rows: payments } = await client.query('SELECT id FROM payments WHERE booking_id IN (?)', [bookingIds]);
      const paymentIds = payments.map((p) => p.id);
      await client.query('DELETE FROM transactions WHERE booking_id IN (?)', [bookingIds]);
      if (paymentIds.length) await client.query('DELETE FROM transactions WHERE payment_id IN (?)', [paymentIds]);
      await client.query('DELETE FROM payments WHERE booking_id IN (?)', [bookingIds]);
      await client.query('DELETE FROM reviews WHERE booking_id IN (?)', [bookingIds]);
      await client.query('DELETE FROM bookings WHERE id IN (?)', [bookingIds]);
    }

    const { rows: dates } = await client.query('SELECT id FROM fd_departure_dates WHERE fd_package_id = ?', [id]);
    const dateIds = dates.map((d) => d.id);
    if (dateIds.length) {
      for (const table of DEPARTURE_CHILD_TABLES) {
        await client.query(`DELETE FROM ${table} WHERE fd_departure_date_id IN (?)`, [dateIds]);
      }
    }

    await client.query('DELETE FROM reviews WHERE fd_package_id = ?', [id]);
    // fd_departure_dates, fd_addons and the itinerary cascade from here.
    await client.query('DELETE FROM fd_packages WHERE id = ?', [id]);
    await client.query('COMMIT');
    return { deletedBookings: bookingIds.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports.deleteFdPackage = deleteFdPackage;

// "Delete package only, keep its bookings": the package is archived
// (0116_fd_package_archive.sql) — gone from the admin list and from agents,
// unbookable — but its row, departure dates and add-ons stay, so every kept
// booking still shows its package, dates, add-ons and payments.
async function archiveFdPackage(id) {
  await pool.query(
    `UPDATE fd_packages
     SET status = 'archived', archived_at = now(), is_featured = false, is_bestseller = false, updated_at = now()
     WHERE id = ?`,
    [id]
  );
}

module.exports.archiveFdPackage = archiveFdPackage;

async function updateFdPackage(id, fields) {
  const cols = FD_COLUMNS.filter((c) => fields[c] !== undefined);
  if (cols.length === 0) return findFdPackageById(id);

  const setClauses = cols.map((c) => `${c} = ?`);
  const values = cols.map((c) => serializeValue(fields[c]));
  values.push(id);

  await pool.query(
    `UPDATE fd_packages SET ${setClauses.join(', ')}, updated_at = now() WHERE id = ?`,
    values
  );
  const { rows } = await pool.query('SELECT * FROM fd_packages WHERE id = ?', [id]);
  const updated = rows[0] || null;
  if (updated && cols.includes('duration')) {
    await repriceMealAddons(id, updated.duration);
  }
  return updated;
}

module.exports.updateFdPackage = updateFdPackage;

async function listItineraryForPackage(fdPackageId) {
  const [{ rows: days }, { rows: items }] = await Promise.all([
    pool.query('SELECT * FROM fd_itinerary_days WHERE fd_package_id = ? ORDER BY day_number', [fdPackageId]),
    pool.query(
      'SELECT * FROM fd_itinerary_items WHERE fd_package_id = ? ORDER BY day_number, position',
      [fdPackageId]
    ),
  ]);
  return { days, items };
}

module.exports.listItineraryForPackage = listItineraryForPackage;

async function replaceItinerary(fdPackageId, days) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM fd_itinerary_days WHERE fd_package_id = ?', [fdPackageId]);
    await client.query('DELETE FROM fd_itinerary_items WHERE fd_package_id = ?', [fdPackageId]);

    for (const day of days || []) {
      // Leisure days (0105) keep only their hotel and a remark; the day's
      // regular notes and any tours/transfers/activities don't apply.
      const leisure = Boolean(day.leisure);
      const remark = leisure ? (day.leisureRemark || '').trim() || null : null;
      const dayItems = leisure ? (day.items || []).filter((it) => it.type === 'hotel') : day.items || [];
      await client.query(
        'INSERT INTO fd_itinerary_days (id, fd_package_id, day_number, notes, is_leisure, leisure_remark) VALUES (?, ?, ?, ?, ?, ?)',
        [newId(), fdPackageId, day.dayNumber, leisure ? null : day.notes || null, leisure, remark]
      );
      for (const [position, item] of dayItems.entries()) {
        await client.query(
          `INSERT INTO fd_itinerary_items (id, fd_package_id, day_number, item_type, item_id, position, note, adults, vehicle_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [newId(), fdPackageId, day.dayNumber, item.type, item.id, position, item.note || null, item.adults || null, item.type === 'tour' ? item.vehicleKey || null : null]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return listItineraryForPackage(fdPackageId);
}

module.exports.replaceItinerary = replaceItinerary;

// Forgets every itinerary tour's chosen vehicle (a package that became Readymade).
async function clearItineraryVehicles(fdPackageId) {
  await pool.query('UPDATE fd_itinerary_items SET vehicle_key = NULL WHERE fd_package_id = ?', [fdPackageId]);
}

module.exports.clearItineraryVehicles = clearItineraryVehicles;

async function loadCatalogPools() {
  const [hotels, tours, transfers, activities, meals, visa, flights] = await Promise.all([
    hotelsModel.list(),
    toursModel.list(),
    transfersModel.list(),
    activitiesModel.list(),
    mealsModel.list(),
    visaModel.list(),
    flightsModel.list(),
  ]);
  // `flight` (0064/0065_fd_package_flights*.sql) is read by resolveRatePerPax
  // below to price a package's onward_flight_id/return_flight_id when
  // flights_enabled — never by composeItinerary/computeNetRatePerPax, since
  // a flight is never placed as a day-by-day itinerary item.
  return { hotel: hotels, tour: tours, transfer: transfers, activity: activities, meal: meals, visa, flight: flights };
}

module.exports.loadCatalogPools = loadCatalogPools;

// Pricing is no longer a manually-entered tiered rate (Gold/Silver/Bronze) —
// it's the sum of what's actually placed in the day-by-day itinerary, so the
// number always matches what the itinerary shows. Each item contributes its
// catalog price once per occurrence: a hotel placed on 3 separate days (the
// single-select-per-day hotel section) counts as 3 nights, matching how a
// real stay would be priced.
// Tours aren't in this map any more — they're priced per vehicle by group
// size (0089_tour_vehicle_pricing.sql), see computeNetRatePerPax below.
const ITEM_PRICE_FIELD = { transfer: 'price', activity: 'price_per_pax' };

// Hotel occupancy-tiered pricing (0061_hotel_occupancy_pricing.sql, Task 1/6)
// — a hotel's displayed per-pax nightly rate uses its single-occupancy price
// first, falling back to double (÷2) and then triple (÷3). Deliberately
// headcount-independent: an FD package's
// own admin-set rate can't depend on a real group size, since that's only
// known once an agent actually books (agent/pages/DepartureDetail.jsx's
// Traveler Details step) — admin no longer enters an adults count at all
// (fd_itinerary_items.adults stays in the DB for old rows, just unused by
// this formula going forward). Returns null when the hotel has no price on
// any of the three tiers, so callers can tell "free" apart from "not priced".
const HOTEL_RATE_FALLBACK_ORDER = [
  { field: 'single_price', capacity: 1 },
  { field: 'double_price', capacity: 2 },
  { field: 'triple_price', capacity: 3 },
];

function resolveHotelPerPaxRate(hotel) {
  if (!hotel) return null;
  for (const { field, capacity } of HOTEL_RATE_FALLBACK_ORDER) {
    if (hotel[field] != null) return Number(hotel[field]) / capacity;
  }
  return null;
}

module.exports.resolveHotelPerPaxRate = resolveHotelPerPaxRate;

// `pax` only matters for tours: a tour's vehicle price is a total for the
// whole group, so its per-person share is that total ÷ pax (e.g. an OMR 50
// Land Cruiser for 5 people adds OMR 10 each). Readers that don't know the
// group size yet (listings, the admin catalog) use BASELINE_PAX; the booking
// itself passes the real headcount.
function computeNetRatePerPax(items, pools, pax = BASELINE_PAX) {
  return (items || []).reduce((total, it) => {
    if (it.item_type === 'tour') {
      const tour = (pools.tour || []).find((t) => t.id === it.item_id);
      return tour ? total + tourItemPerPaxPrice(tour, it.vehicle_key, pax) : total;
    }
    if (it.item_type === 'hotel') {
      const hotel = (pools.hotel || []).find((h) => h.id === it.item_id);
      const perPax = resolveHotelPerPaxRate(hotel);
      return perPax != null ? total + perPax : total;
    }
    const field = ITEM_PRICE_FIELD[it.item_type];
    const ref = field && (pools[it.item_type] || []).find((p) => p.id === it.item_id);
    if (!ref) return total;
    return total + (Number(ref[field]) || 0);
  }, 0);
}

module.exports.computeNetRatePerPax = computeNetRatePerPax;

// The effective net rate: fdPackage.rate_per_pax when the admin has set an
// override, else the itinerary total plus any included visa (Task 5 — a
// checkbox-only inclusion priced off the visa catalog's flat per-person
// rate). Shared by every reader (admin catalog, agent listing/detail,
// booking) so they never disagree about which price applies.
// Flights (0064/0065_fd_package_flights*.sql) only ever contribute here when
// flights_enabled — the direct-inclusion pick, not the add-on checkbox path.
// A flight added as a fd_addons row instead is deliberately *not* folded in
// here: add-ons are an opt-in a-la-carte charge the agent applies at booking
// time (see booking.service.js), never part of the package's own advertised
// net rate, same as Activities/Tours/Transfers/Meals offered as add-ons
// already aren't. Only Onward/Return picked directly here behave like Visa
// above — an always-included cost baked into the rate.
function resolveFlightsPerPax(fdPackage, pools) {
  if (!fdPackage.flights_enabled) return 0;
  const flights = pools.flight || [];
  const onward = flights.find((f) => f.id === fdPackage.onward_flight_id);
  const ret = flights.find((f) => f.id === fdPackage.return_flight_id);
  return Number(onward?.price || 0) + Number(ret?.price || 0);
}

function resolveFlightDetails(fdPackage, pools) {
  if (!fdPackage.flights_enabled) return null;
  const flights = pools.flight || [];
  const onward = flights.find((f) => f.id === fdPackage.onward_flight_id);
  const ret = flights.find((f) => f.id === fdPackage.return_flight_id);
  if (!onward || !ret) return null;
  const toPublicFlight = (f) => ({
    name: f.name,
    source: f.source,
    destination: f.destination,
    departureDate: f.departure_date,
    // 0066_flights_departure_time.sql — admin-entered "HH:MM:SS" (or null for
    // a flight that predates this column); the frontend formats it for display.
    departureTime: f.departure_time,
  });
  return { onward: toPublicFlight(onward), return: toPublicFlight(ret) };
}

module.exports.resolveFlightDetails = resolveFlightDetails;

function resolvePrimaryHotelId(fdPackage, items) {
  const firstHotelItem = (items || []).find((it) => it.item_type === 'hotel');
  return firstHotelItem?.item_id || fdPackage.hotel_id || null;
}

module.exports.resolvePrimaryHotelId = resolvePrimaryHotelId;

// Readymade packages never fix a vehicle on their tours — the vehicle is
// picked from the group size (Sedan for 1-3, Land Cruiser for 4-6, ...), so
// the price follows the headcount. putItinerary already drops vehicleKey for
// them; this also ignores any key left over from before (e.g. a package
// switched from FD to readymade).
function pricingItems(fdPackage, items) {
  if (fdPackage?.type !== 'readymade') return items;
  return (items || []).map((it) => (it.vehicle_key ? { ...it, vehicle_key: null } : it));
}

// Admin's manual per-person rate (rate_per_pax). Readymade packages have no
// manual pricing — their rate always comes from the itinerary and the
// vehicle picked for the group size — so any stored override is ignored.
function hasManualRate(fdPackage) {
  return fdPackage.type !== 'readymade' && fdPackage.rate_per_pax != null;
}

module.exports.hasManualRate = hasManualRate;

function resolveRatePerPax(fdPackage, items, pools, pax = BASELINE_PAX) {
  if (hasManualRate(fdPackage)) return Number(fdPackage.rate_per_pax);
  items = pricingItems(fdPackage, items);
  // Meals are opt-in fd_addons now (0075) — priced onto a booking's total at
  // booking time, never part of the package's advertised net rate.
  const visaPerPax = fdPackage.visa_enabled ? Number(pools.visa?.[0]?.price_per_person || 0) : 0;
  const flightsPerPax = resolveFlightsPerPax(fdPackage, pools);
  return computeNetRatePerPax(items, pools, pax) + visaPerPax + flightsPerPax;
}

module.exports.resolveRatePerPax = resolveRatePerPax;

// Whether this package's per-person rate changes with group size — true when
// the rate is itinerary-driven (no admin override) and at least one
// itinerary tour has vehicle prices. Lets the agent UI say "rate shown for 2
// travellers" and recompute it for the real headcount.
function rateVariesWithGroupSize(fdPackage, items, pools) {
  if (hasManualRate(fdPackage)) return false;
  items = pricingItems(fdPackage, items);
  // A tour with a vehicle chosen in the itinerary has a fixed per-person
  // price, so only the tours still priced by group size make the rate vary.
  return (items || []).some((it) => {
    if (it.item_type !== 'tour') return false;
    const tour = (pools.tour || []).find((t) => t.id === it.item_id);
    return hasVehiclePricing(tour) && !chosenVehicleRow(tour, it.vehicle_key);
  });
}

module.exports.rateVariesWithGroupSize = rateVariesWithGroupSize;

// Everything the agent UI needs to price this package for any headcount
// itself (and to show which vehicle each tour will use): the per-person rate
// with itinerary tours taken out, plus each itinerary tour's vehicle price
// table. rate(pax) = ratePerPaxExcludingTours + Σ occurrences × tour total(pax) ÷ pax.
// With an admin rate override the rate is fixed, so tours are listed for
// information only and ratePerPaxExcludingTours is simply that fixed rate.
// The most people one booking can have, as far as the itinerary's tour
// vehicles go: the LARGEST max-passengers among the vehicles chosen for its
// tours. null when no tour has a vehicle, i.e. nothing limits the group beyond
// the seats left.
//
// Readymade packages place tours without choosing a vehicle, so each tour
// counts as its largest vehicle (the max of its vehicles' max passengers);
// the cap is then the largest of those.
function maxGroupSizeFromVehicles(items, pools, { readymade = false } = {}) {
  let cap = null;
  for (const it of items || []) {
    if (it.item_type !== 'tour') continue;
    const tour = (pools.tour || []).find((t) => t.id === it.item_id);
    if (!tour) continue;
    let max;
    if (readymade) {
      const rows = hasVehiclePricing(tour)
        ? toPublicVehiclePrices(tour).map((r) => Number(r.maxPax)).filter((n) => Number.isFinite(n) && n > 0)
        : [];
      if (rows.length === 0) continue;
      max = Math.max(...rows);
    } else {
      const chosen = chosenVehicleRow(tour, it.vehicle_key);
      if (!chosen) continue;
      max = Number(chosen.maxPax);
    }
    if (Number.isFinite(max) && max > 0) cap = cap == null ? max : Math.max(cap, max);
  }
  return cap;
}

module.exports.maxGroupSizeFromVehicles = maxGroupSizeFromVehicles;

function buildGroupPricing(fdPackage, items, pools) {
  const fixedRate = hasManualRate(fdPackage);
  items = pricingItems(fdPackage, items);
  const byTour = new Map();
  for (const it of items || []) {
    if (it.item_type !== 'tour') continue;
    const tour = (pools.tour || []).find((t) => t.id === it.item_id);
    if (!tour) continue;
    // Chosen vehicle = fixed per-person price, already inside the base rate.
    if (chosenVehicleRow(tour, it.vehicle_key)) continue;
    if (!byTour.has(tour.id)) {
      byTour.set(tour.id, {
        id: tour.id,
        name: tour.name,
        occurrences: 0,
        dayNumbers: [],
        vehiclePrices: toPublicVehiclePrices(tour),
        // Old single per-person price, only for tours without vehicle prices.
        pricePerPax: hasVehiclePricing(tour) ? null : Number(tour.price || 0),
        tour,
      });
    }
    const entry = byTour.get(tour.id);
    entry.occurrences += 1;
    entry.dayNumbers.push(it.day_number);
  }
  const entries = [...byTour.values()];
  const baselineRate = resolveRatePerPax(fdPackage, items, pools);
  const toursAtBaseline = fixedRate
    ? 0
    : entries.reduce((sum, e) => sum + e.occurrences * tourPerPaxPrice(e.tour, BASELINE_PAX), 0);
  return {
    baselinePax: BASELINE_PAX,
    // Admin override set — the rate never changes, tours included or not.
    fixedRate,
    rateVaries: rateVariesWithGroupSize(fdPackage, items, pools),
    ratePerPaxExcludingTours: baselineRate - toursAtBaseline,
    itineraryTours: entries.map(({ tour, ...rest }) => rest),
  };
}

module.exports.buildGroupPricing = buildGroupPricing;

// Readymade only: the per-person rate (before platform fee) and the vehicle
// each itinerary tour gets, for every headcount from 1 to maxPax — so the
// agent's booking panel shows exactly what booking.service.js will charge
// for the group they've entered. null for FD packages or when the rate
// doesn't depend on group size (admin rate override, no vehicle-priced tours).
function buildReadymadePaxPricing(fdPackage, items, pools, maxPax) {
  if (fdPackage.type !== 'readymade' || !rateVariesWithGroupSize(fdPackage, items, pools)) return null;
  const tours = pricingItems(fdPackage, items)
    .filter((it) => it.item_type === 'tour')
    .map((it) => (pools.tour || []).find((t) => t.id === it.item_id))
    .filter((tour, i, all) => tour && hasVehiclePricing(tour) && all.indexOf(tour) === i);
  const upTo = Math.max(1, Number(maxPax) || 50);
  const rows = [];
  for (let pax = 1; pax <= upTo; pax += 1) {
    rows.push({
      pax,
      ratePerPax: resolveRatePerPax(fdPackage, items, pools, pax),
      vehicles: tours.map((tour) => {
        const tier = tierForPax(pax, toPublicVehiclePrices(tour));
        return { tourId: tour.id, tourName: tour.name, label: tier?.label || null };
      }),
    });
  }
  return rows;
}

module.exports.buildReadymadePaxPricing = buildReadymadePaxPricing;

// The vehicle chosen for an itinerary tour, for display: its name, group size
// and per-person price. Empty when none was chosen (or it's gone from the tour).
function tourVehicleFields(tour, vehicleKey) {
  const chosen = chosenVehicleRow(tour, vehicleKey);
  if (!chosen) return {};
  return {
    vehicleKey: String(chosen.key),
    vehicleLabel: chosen.label,
    vehicleMinPax: Number(chosen.minPax),
    vehicleMaxPax: Number(chosen.maxPax),
    vehiclePricePerPax: Number(chosen.price) / Number(chosen.maxPax),
  };
}

function composeItinerary(days, items, pools) {
  const byDay = new Map();
  for (const d of days) {
    byDay.set(d.day_number, {
      dayNumber: d.day_number,
      notes: d.notes || '',
      leisure: Boolean(d.is_leisure),
      leisureRemark: d.is_leisure ? d.leisure_remark || '' : '',
      items: [],
    });
  }
  for (const it of items) {
    if (!byDay.has(it.day_number)) {
      byDay.set(it.day_number, { dayNumber: it.day_number, notes: '', leisure: false, leisureRemark: '', items: [] });
    }
    const pool = pools[it.item_type] || [];
    const ref = pool.find((p) => p.id === it.item_id);
    byDay.get(it.day_number).items.push({
      type: it.item_type,
      id: it.item_id,
      name: ref?.name || null,
      city: ref?.city ?? null,
      images: ref?.images ?? undefined,
      // Include the catalog information needed by the agent's itinerary
      // cards and detail popup. Catalog rows store pickup_time in snake_case;
      // expose it in the API's existing camelCase shape.
      ...(it.item_type !== 'hotel'
        ? {
            description: ref?.description ?? null,
            duration: ref?.duration ?? null,
            pickupTime: ref?.pickup_time ?? null,
          }
        : {}),
      note: it.note || '',
      ...(it.item_type === 'tour' ? tourVehicleFields(ref, it.vehicle_key) : {}),
      // Occupancy — hotel items only (undefined for everything else, same as
      // a never-set hotel item). `rooms` is the derived room count
      // (computeNetRatePerPax's pricing driver) so consumers don't need to
      // re-derive ceil(adults / 2) themselves just to display it.
      ...(it.item_type === 'hotel' ? { adults: it.adults ?? null, rooms: roomsForAdults(it.adults) } : {}),
    });
  }
  return [...byDay.values()].sort((a, b) => a.dayNumber - b.dayNumber);
}

module.exports.composeItinerary = composeItinerary;

async function listDepartureDates(fdPackageId) {
  const { rows } = await pool.query(
    'SELECT * FROM fd_departure_dates WHERE fd_package_id = ? ORDER BY date',
    [fdPackageId]
  );
  return rows;
}

module.exports.listDepartureDates = listDepartureDates;

async function findDepartureDateById(id) {
  const { rows } = await pool.query('SELECT * FROM fd_departure_dates WHERE id = ?', [id]);
  return rows[0] || null;
}

module.exports.findDepartureDateById = findDepartureDateById;

async function addDepartureDate(fdPackageId, { date, seatsTotal, location }) {
  const id = newId();
  await pool.query(
    'INSERT INTO fd_departure_dates (id, fd_package_id, date, seats_total, location) VALUES (?, ?, ?, ?, ?)',
    [id, fdPackageId, date, seatsTotal, location]
  );
  const { rows } = await pool.query('SELECT * FROM fd_departure_dates WHERE id = ?', [id]);
  return rows[0];
}

module.exports.addDepartureDate = addDepartureDate;

async function removeDepartureDate(id) {
  await pool.query('DELETE FROM fd_departure_dates WHERE id = ?', [id]);
}

module.exports.removeDepartureDate = removeDepartureDate;

async function incrementSeatsBooked(client, departureDateId, pax) {
  const { rowCount } = await client.query(
    `UPDATE fd_departure_dates
     SET seats_booked = seats_booked + ?
     WHERE id = ? AND seats_total - seats_booked >= ?`,
    [pax, departureDateId, pax]
  );
  if (!rowCount) return null; // not enough seats (caller should treat as sold out)
  const { rows } = await client.query('SELECT * FROM fd_departure_dates WHERE id = ?', [departureDateId]);
  return rows[0] || null;
}

module.exports.incrementSeatsBooked = incrementSeatsBooked;

async function listAddons(fdPackageId) {
  const { rows } = await pool.query(
    `SELECT fd_addons.*, activities.name AS activity_name, tours.name AS tour_name,
       transfers.name AS transfer_name, flights.name AS flight_name,
       meals.name AS meal_name, meals.meal_type AS meal_type
     FROM fd_addons
     LEFT JOIN activities ON activities.id = fd_addons.activity_id
     LEFT JOIN tours ON tours.id = fd_addons.tour_id
     LEFT JOIN transfers ON transfers.id = fd_addons.transfer_id
     LEFT JOIN flights ON flights.id = fd_addons.flight_id
     LEFT JOIN meals ON meals.id = fd_addons.meal_id
     WHERE fd_package_id = ?`,
    [fdPackageId]
  );
  return rows;
}

module.exports.listAddons = listAddons;

async function findAddonsByIds(fdPackageId, addonIds) {
  if (!addonIds || addonIds.length === 0) return [];
  const { rows } = await pool.query(
    'SELECT * FROM fd_addons WHERE fd_package_id = ? AND id IN (?)',
    [fdPackageId, addonIds]
  );
  return rows;
}

module.exports.findAddonsByIds = findAddonsByIds;

async function addAddon(
  fdPackageId,
  { activityId, tourId, transferId, flightId, mealId, pricePerPax }
) {
  const id = newId();
  await pool.query(
    `INSERT INTO fd_addons (id, fd_package_id, activity_id, tour_id, transfer_id, flight_id, meal_id, price_per_pax)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, fdPackageId, activityId || null, tourId || null, transferId || null, flightId || null, mealId || null, pricePerPax]
  );
  const { rows } = await pool.query('SELECT * FROM fd_addons WHERE id = ?', [id]);
  return rows[0];
}

module.exports.addAddon = addAddon;

// Meal add-on prices are price_per_day x the package's Duration, so a later
// Duration change has to reprice them (activities/tours/transfers/flights
// don't depend on Duration and keep their add-time snapshot). Called from
// updateFdPackage whenever `duration` is in the update.
//
// Postgres' `UPDATE ... FROM` (correlated multi-table UPDATE) has no direct
// MySQL equivalent — MySQL instead joins the target table in the UPDATE
// statement itself (`UPDATE a JOIN m ON ... SET a.col = ...`).
async function repriceMealAddons(fdPackageId, duration) {
  await pool.query(
    `UPDATE fd_addons a
     JOIN meals m ON m.id = a.meal_id
     SET a.price_per_pax = COALESCE(m.price_per_day, 0) * ?
     WHERE a.fd_package_id = ? AND a.meal_id IS NOT NULL`,
    [parseDurationDays(duration) || 0, fdPackageId]
  );
}

async function removeAddon(id) {
  await pool.query('DELETE FROM fd_addons WHERE id = ?', [id]);
}

module.exports.removeAddon = removeAddon;

// Admin Payments → Package Controller: each package's pre-booking override
// (0108_fd_prebooking_settings.sql).
const PREBOOKING_SELECT = `SELECT fd_packages.id, fd_packages.title, fd_packages.status, fd_packages.hero_image_url,
       fd_packages.images, fd_packages.prebooking_mode, fd_packages.prebooking_percentage,
       fd_packages.platform_fee_mode, fd_packages.platform_fee_percentage,
       COALESCE(fd_packages.prebooking_updated_at, fd_packages.updated_at) AS prebooking_updated_at,
       users.full_name AS prebooking_updated_by_name,
       (SELECT MIN(d.date) FROM fd_departure_dates d
         WHERE d.fd_package_id = fd_packages.id AND d.date >= CURDATE()) AS next_departure_date
     FROM fd_packages
     LEFT JOIN users ON users.id = fd_packages.prebooking_updated_by_user_id`;

async function listFdPackagePrebooking() {
  const { rows } = await pool.query(
    `${PREBOOKING_SELECT} WHERE fd_packages.status <> 'archived' ORDER BY fd_packages.created_at DESC`
  );
  return rows;
}

module.exports.listFdPackagePrebooking = listFdPackagePrebooking;

// `ids` is one package id or several (bulk update from the list).
async function updateFdPackagePrebooking(ids, { mode, percentage }, updatedByUserId) {
  const idList = Array.isArray(ids) ? ids : [ids];
  if (idList.length === 0) return [];
  const placeholders = idList.map(() => '?').join(', ');
  await pool.query(
    `UPDATE fd_packages
     SET prebooking_mode = ?, prebooking_percentage = ?,
       prebooking_updated_at = now(), prebooking_updated_by_user_id = ?
     WHERE id IN (${placeholders})`,
    [mode, mode === 'custom' ? percentage : null, updatedByUserId || null, ...idList]
  );
  const { rows } = await pool.query(`${PREBOOKING_SELECT} WHERE fd_packages.id IN (${placeholders})`, idList);
  return rows;
}

module.exports.updateFdPackagePrebooking = updateFdPackagePrebooking;

async function updateFdPackagePlatformFee(ids, { mode, percentage }, updatedByUserId) {
  const idList = Array.isArray(ids) ? ids : [ids];
  if (idList.length === 0) return [];
  const placeholders = idList.map(() => '?').join(', ');
  await pool.query(
    `UPDATE fd_packages
     SET platform_fee_mode = ?, platform_fee_percentage = ?, updated_at = now()
     WHERE id IN (${placeholders})`,
    [mode, mode === 'custom' ? percentage : null, ...idList]
  );
  const { rows } = await pool.query(`${PREBOOKING_SELECT} WHERE fd_packages.id IN (${placeholders})`, idList);
  return rows;
}

module.exports.updateFdPackagePlatformFee = updateFdPackagePlatformFee;
