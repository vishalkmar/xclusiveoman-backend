const {
  pool
} = require('../db/pool.js');

const {
  newId
} = require('../utils/id.js');

const {
  listItineraryForPackage,
  resolveRatePerPax,
  maxGroupSizeFromVehicles,
  loadCatalogPools,
  findAddonsByIds,
  incrementSeatsBooked
} = require('../models/fdPackages.model.js');

const {
  listTravelersForRequest
} = require('../models/packageRequests.model.js');

const {
  findBookingBySource
} = require('../models/bookings.model.js');

const {
  tourPerPaxPrice
} = require('../utils/tourPricing.js');

const {
  roundMoney
} = require('../utils/currency.js');

const {
  getFdPrebookingSettings,
  resolvePrebookingPercentage,
  getFdPlatformFeeSettings,
  resolvePlatformFeePercentage,
  applyPlatformFee,
} = require('./prebooking.service.js');

const {
  SEAT_HOLD_MINUTES,
  SeatsUnavailableError
} = require('./seatHold.service.js');

// FD booking creation — the one real "create a bookings row" transaction in
// this codebase (Task 13). Extracted out of departures.controller.js#createBooking
// (self-service) so the new Admin Manual Booking flow
// (bookingsAdmin.controller.js) can create the exact same kind of row
// through the exact same atomic path, instead of a second, parallel booking
// engine — per Task 13's own "do not duplicate booking business logic" rule.
// Self-service behavior is unchanged: it calls this with no agreedTotalPrice/
// depositPaid override, which reproduces its old inline logic exactly.

// FD packages carry no per-package deposit/balance-due policy — every
// booking uses this fixed lead time (moved here verbatim from
// departures.controller.js, its only previous home).
const DEFAULT_BALANCE_DUE_DAYS_BEFORE = 30;

// Part-payment policy for FD departures (0077_booking_deposit_due.sql):
// inside this many days of departure the whole booking value is due up
// front; earlier than that, only the package's pre-booking percentage
// (prebooking.service.js — admin Payments → Package Controller) is due now and
// the rest is collected later. No pre-booking means the full amount up front.
const FD_FULL_PAYMENT_LEAD_DAYS = 15;

// The "pay this now to hold the seat" figure, fixed at booking time.
// `departureDateISO` is the fd_departure_dates.date value. `totalPrice` is
// pax × the per-person rate, so the deposit scales with group size.
// `prebookingPercentage` is null when the package has no pre-booking.
function computeFdDepositDue(departureDateISO, totalPrice, prebookingPercentage) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysUntilDeparture = Math.ceil((new Date(departureDateISO).getTime() - Date.now()) / msPerDay);
  if (daysUntilDeparture < FD_FULL_PAYMENT_LEAD_DAYS) return totalPrice;
  if (prebookingPercentage == null) return totalPrice;
  return Math.min(roundMoney((totalPrice * prebookingPercentage) / 100), totalPrice);
}

// depositPaid=0 → pending_payment (self-service's own default, and an admin
// manual booking recorded with no offline deposit yet); a partial deposit →
// balance_due (money owed remains); a deposit covering the full price →
// fully_paid. Mirrors paymentConfirmation.service.js#confirmPayment's own
// "newBalanceDue <= 0 ? fully_paid : balance_due" derivation, generalized to
// also cover the zero-deposit case confirmPayment never has to (it's only
// ever called with a real payment > 0).
function deriveStatusFromDeposit(depositPaid, totalPrice) {
  if (depositPaid <= 0) return 'pending_payment';
  return depositPaid >= totalPrice ? 'fully_paid' : 'balance_due';
}

async function createFdBooking(
  {
    fdPackage,
    departureDate,
    isReadymade = fdPackage?.type === 'readymade',
    agencyId,
    createdByUserId,
    createdVia,
    pax,
    addonIds = [],
    addonDayNumbers = {},
    travelers = [],
    agreedTotalPrice,
    depositPaid = 0,
  }
) {
  const client = await pool.connect();
  try {
    const [addons, itinerary, pools] = await Promise.all([
      findAddonsByIds(fdPackage.id, addonIds),
      listItineraryForPackage(fdPackage.id),
      loadCatalogPools(),
    ]);

    // Lunch/Dinner add-ons can be limited to specific itinerary days
    // (0080_booking_addon_days.sql) instead of always covering the whole
    // package — never trust the client's day numbers: re-validated here
    // against this package's real fd_itinerary_days, and priced per selected
    // day (meal.price_per_day × count) instead of the fd_addons row's
    // full-duration snapshot. Any addon with no day numbers submitted (every
    // non-meal type, or a meal added with none picked) keeps the existing
    // whole-package snapshot behavior unchanged.
    // A self-service group has to fit the vehicles chosen for the package's
    // tours (DepartureDetail caps the headcount the same way).
    if (createdVia === 'self_service') {
      const cap = maxGroupSizeFromVehicles(itinerary.items, pools, { readymade: isReadymade });
      if (cap != null && pax > cap) {
        throw Object.assign(
          new Error(`This package's tour vehicles carry at most ${cap} people, so a booking can't have more than ${cap} travellers.`),
          { status: 400, publicCode: 'group_too_large' }
        );
      }
    }

    const validDayNumbers = new Set(itinerary.days.map((d) => d.day_number));
    function priceAndDaysFor(addon) {
      // Tour add-ons are priced per vehicle by group size
      // (0089_tour_vehicle_pricing.sql), so their fd_addons snapshot can't
      // be used — the live tour row decides, for this booking's real pax.
      if (addon.tour_id) {
        const tour = pools.tour.find((t) => t.id === addon.tour_id);
        return { pricePerPax: tour ? tourPerPaxPrice(tour, pax) : Number(addon.price_per_pax), days: [] };
      }
      const days = addon.meal_id ? addonDayNumbers[addon.id] || [] : [];
      if (days.length === 0) return { pricePerPax: Number(addon.price_per_pax), days: [] };
      if (!days.every((d) => validDayNumbers.has(d))) {
        throw Object.assign(new Error('Selected day is not part of this package\'s itinerary'), { status: 400 });
      }
      const meal = pools.meal.find((m) => m.id === addon.meal_id);
      return { pricePerPax: Number(meal?.price_per_day || 0) * days.length, days };
    }
    const addonPricing = new Map(addons.map((a) => [a.id, priceAndDaysFor(a)]));

    // ratePerPax (resolveRatePerPax) folds in any included visa (Task 5 — a
    // checkbox inclusion priced off the visa catalog, a real per-pax figure
    // with nothing left to resolve here). Meals are opt-in fd_addons rows
    // now (0075), so they ride the addonsPerPax sum below like every other
    // add-on. This only ever multiplies by the one thing that can't be known
    // before now: real pax.
    // Real pax is also what picks each tour's vehicle price (itinerary tours
    // inside ratePerPax, tour add-ons in addonPricing above). Rounded to the
    // baisa since a vehicle total ÷ pax can be fractional.
    const baseRatePerPax = resolveRatePerPax(fdPackage, itinerary.items, pools, pax);
    const platformFeeSettings = await getFdPlatformFeeSettings();
    const ratePerPax = applyPlatformFee(
      baseRatePerPax,
      resolvePlatformFeePercentage(fdPackage, platformFeeSettings)
    );
    const addonsPerPax = addons.reduce((sum, a) => sum + addonPricing.get(a.id).pricePerPax, 0);
    const computedTotalPrice = roundMoney((ratePerPax + addonsPerPax) * pax);
    const totalPrice = agreedTotalPrice != null ? agreedTotalPrice : computedTotalPrice;

    const balanceDue = Math.max(0, totalPrice - depositPaid);
    const balanceDueDate = departureDate
      ? new Date(
          new Date(departureDate.date).getTime() - DEFAULT_BALANCE_DUE_DAYS_BEFORE * 24 * 60 * 60 * 1000
        )
      : null;
    // How much of `totalPrice` must be paid now for this booking to be
    // held: the full amount within 15 days of departure, otherwise the
    // pre-booking deposit. An admin manual booking may already carry an offline
    // depositPaid — this stays the gross policy figure regardless; "still
    // due now" is deposit_due - deposit_paid, computed where it's shown.
    const prebookingPercentage = resolvePrebookingPercentage(fdPackage, await getFdPrebookingSettings());
    const depositDue = departureDate
      ? computeFdDepositDue(departureDate.date, totalPrice, prebookingPercentage)
      : totalPrice;

    await client.query('BEGIN');

    // Single atomic UPDATE ... WHERE seats_total - seats_booked >= pax —
    // the only seat check anywhere in this codebase, race-safe by
    // construction (no separate read-then-write window): when two agents
    // book the last seats at once, exactly one gets them. A null result
    // means sold out, and the booking is refused outright — no waitlisted
    // row is created (they'd pile up and skew the booking data), the whole
    // transaction rolls back and the caller gets a 409.
    if (!isReadymade) {
      const seatsResult = await incrementSeatsBooked(client, departureDate.id, pax);
      if (!seatsResult) throw new SeatsUnavailableError();
    }
    const status = deriveStatusFromDeposit(depositPaid, totalPrice);

    // Seat hold (seatHold.service.js): an unpaid self-service booking only
    // holds its seats for SEAT_HOLD_MINUTES unless a payment starts (the
    // "Pay" click restarts the timer) — otherwise a booking the agent never
    // pays for would keep its seats forever. Admin manual bookings are paid
    // offline, so theirs never lapses.
    const holdExpires = createdVia === 'self_service' && depositPaid <= 0;
    const bookingId = newId();
    await client.query(
      `INSERT INTO bookings
        (id, source_type, source_id, fd_departure_date_id, agency_id, created_by_user_id,
         pax, total_price, deposit_paid, balance_due, balance_due_date, deposit_due, status, created_via,
         seats_held, seat_hold_expires_at)
       VALUES (?, 'fd_package', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, IF(?, now() + INTERVAL ? MINUTE, NULL))`,
      [
        bookingId, fdPackage.id, departureDate?.id || null, agencyId, createdByUserId,
        pax, totalPrice, depositPaid, balanceDue, balanceDueDate, depositDue, status, createdVia,
        isReadymade ? 0 : 1, isReadymade ? false : holdExpires, SEAT_HOLD_MINUTES,
      ]
    );
    const { rows: bookingRows } = await client.query('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    const booking = bookingRows[0];

    for (const traveler of travelers) {
      await client.query(
        `INSERT INTO booking_travelers (id, booking_id, name, passport_no, dob, room_share_group)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [newId(), booking.id, traveler.name, traveler.passportNo || null, traveler.dob || null, traveler.roomShareGroup || null]
      );
    }

    for (const addon of addons) {
      const { pricePerPax, days } = addonPricing.get(addon.id);
      await client.query(
        `INSERT INTO booking_addons (id, booking_id, fd_addon_id, price_per_pax, day_numbers) VALUES (?, ?, ?, ?, ?)`,
        [newId(), booking.id, addon.id, pricePerPax, JSON.stringify(days ?? [])]
      );
    }

    await client.query('COMMIT');

    return { booking };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports.createFdBooking = createFdBooking;

async function createBookingFromPackageRequest(packageRequest) {
  // Idempotent by construction, not just by the caller's own guard: a
  // package_request can only ever transition published -> accepted once
  // (respondToPackageRequest's own WHERE status='published' clause makes a
  // second respond() call fail with 'not_published' before this is ever
  // reached again), but this checks for real regardless — "already created?
  // don't create it again" — rather than trusting that invariant alone.
  const existing = await findBookingBySource('package_request', packageRequest.id);
  if (existing) {
    return { booking: existing, created: false };
  }

  const client = await pool.connect();
  try {
    const travelers = await listTravelersForRequest(packageRequest.id);
    const pax = Math.max(1, (packageRequest.pax_adults || 0) + (packageRequest.pax_children || 0));
    const totalPrice = Number(packageRequest.sell_price) || 0;
    const depositPaid = 0; // no deposit captured at accept time — same as FD self-service's own default
    const balanceDue = Math.max(0, totalPrice - depositPaid);
    const balanceDueDate = new Date(
      new Date(packageRequest.date_from).getTime() - DEFAULT_BALANCE_DUE_DAYS_BEFORE * 24 * 60 * 60 * 1000
    );
    const status = deriveStatusFromDeposit(depositPaid, totalPrice);

    await client.query('BEGIN');

    // FIT quotes keep the "full amount due now" behaviour — the 15-day
    // part-payment policy (computeFdDepositDue) is an FD-departure rule
    // only, so deposit_due mirrors total_price here.
    const bookingId = newId();
    await client.query(
      `INSERT INTO bookings
        (id, source_type, source_id, agency_id, created_by_user_id,
         pax, total_price, deposit_paid, balance_due, balance_due_date, deposit_due, status, created_via)
       VALUES (?, 'package_request', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'self_service')`,
      [
        bookingId, packageRequest.id, packageRequest.agency_id, packageRequest.created_by_user_id,
        pax, totalPrice, depositPaid, balanceDue, balanceDueDate, totalPrice, status,
      ]
    );
    const { rows: bookingRows } = await client.query('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    const booking = bookingRows[0];

    for (const traveler of travelers) {
      await client.query(
        `INSERT INTO booking_travelers (id, booking_id, name, passport_no, dob, room_share_group)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [newId(), booking.id, traveler.name, traveler.passport_no || null, traveler.dob || null, traveler.room_share_group || null]
      );
    }

    await client.query('COMMIT');
    return { booking, created: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports.createBookingFromPackageRequest = createBookingFromPackageRequest;
