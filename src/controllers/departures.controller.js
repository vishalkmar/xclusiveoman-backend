const {
  getItineraryBranding
} = require('../services/itineraryBranding.service.js');

const {
  SEAT_HOLD_MINUTES
} = require('../services/seatHold.service.js');

const {
  env
} = require('../config/env.js');

const {
  listFdPackages,
  findFdPackageById,
  listItineraryForPackage,
  composeItinerary,
  resolveRatePerPax,
  rateVariesWithGroupSize,
  buildGroupPricing,
  buildReadymadePaxPricing,
  maxGroupSizeFromVehicles,
  resolveFlightDetails,
  resolvePrimaryHotelId,
  loadCatalogPools,
  listDepartureDates,
  findDepartureDateById,
  addDepartureDate,
  listAddons,
  listPackageReviewStats
} = require('../models/fdPackages.model.js');

const {
  BASELINE_PAX,
  toPublicVehiclePrices
} = require('../utils/tourPricing.js');

const {
  findAgencyById
} = require('../models/agencies.model.js');

const {
  siteTermsModel
} = require('../models/siteTerms.model.js');

const {
  buildWhatsAppLink
} = require('../utils/whatsapp.js');

const {
  getIo
} = require('../sockets/index.js');

const {
  createFdBooking
} = require('../services/booking.service.js');

const {
  signFdItineraryPdfToken
} = require('../services/auth.service.js');

const {
  getFdPrebookingSettings,
  resolvePrebookingPercentage,
  getFdPlatformFeeSettings,
  resolvePlatformFeePercentage,
  applyPlatformFee,
} = require('../services/prebooking.service.js');

// ratePerPax is fdPackage.rate_per_pax (an admin override) when set, else the
// sum of the package's day-by-day itinerary (see resolveRatePerPax) — the
// same price for every agency (agency tier was removed entirely — it no
// longer exists anywhere in this app, not just as a pricing input).
// `hotel` is the resolved primary hotel's own catalog row
// (resolvePrimaryHotelId + a pools.hotel lookup — see both call sites below),
// not fdPackage.hotel_city/hotel_name off the now-legacy hotel_id join,
// which stays null forever for a package whose hotel was placed on the
// itinerary instead (the only way FdPackageEditor.jsx sets a hotel today).
function toPublicPackage(fdPackage, ratePerPax, hotel, reviewStats = {}) {
  return {
    id: fdPackage.id,
    title: fdPackage.title,
    // The package's Category (FdPackageEditor's Category picker,
    // 0117_fd_package_category.sql) — it replaces the old free-text "theme",
    // which this response no longer carries. null until a category is set;
    // there is deliberately no fallback to the legacy theme.
    category: fdPackage.category ?? null,
    // Package kind (0120) and — Readymade only — its departure cities.
    type: fdPackage.type || 'fd_package',
    allCities: !!fdPackage.all_cities,
    departureCities: Array.isArray(fdPackage.departure_cities) ? fdPackage.departure_cities : [],
    duration: fdPackage.duration,
    heroImageUrl: fdPackage.hero_image_url,
    images: fdPackage.images || [],
    // fd_packages has no dedicated destination column — the resolved
    // primary hotel's city is the closest real-data stand-in.
    destination: hotel?.city || null,
    hotelName: hotel?.name || null,
    // Star rating shown on the listing card's "N Star Hotel" info row
    // (Departures.jsx's DepartureCard) — the resolved primary hotel's own
    // category, same resolution as hotelName/destination just above.
    hotelCategory: hotel?.category ?? null,
    shortDescription: fdPackage.short_description,
    suitableAgeMin: fdPackage.suitable_age_min,
    rating: reviewStats.rating ?? null,
    reviewCount: reviewStats.reviewCount ?? 0,
    isFeatured: !!fdPackage.is_featured,
    isBestseller: !!fdPackage.is_bestseller,
    ratePerPax,
    // Client-facing Inclusions/Exclusions, admin-authored in FdPackageEditor.jsx
    // (see 0050_fd_packages_inclusions_exclusions.sql) — read-only here,
    // shown on the departure detail page (DepartureDetail.jsx).
    inclusions: fdPackage.inclusions || '',
    exclusions: fdPackage.exclusions || '',
  };
}

function hotelLocationNights(itinerary, duration, hotels = []) {
  const totalDays = Number.parseInt(String(duration || '').match(/\d+/)?.[0] || '', 10) || (itinerary?.days?.length || 0);
  const nights = Math.max(totalDays - 1, 0);
  const hotelById = new Map(hotels.map((hotel) => [hotel.id, hotel]));
  const counts = new Map();
  const items = Array.isArray(itinerary?.items) ? itinerary.items : itinerary || [];
  for (const item of items.filter((entry) => entry.item_type === 'hotel' && Number(entry.day_number) <= nights)) {
    const hotel = hotelById.get(item.item_id);
    const location = hotel?.location || hotel?.city;
    if (location) counts.set(location, (counts.get(location) || 0) + 1);
  }
  return [...counts].map(([location, count]) => ({ location, nights: count }));
}

async function listDepartures(req, res, next) {
  try {
    const [packages, pools, platformFeeSettings, reviewStats] = await Promise.all([
      listFdPackages({
        destination: req.query.destination,
        theme: req.query.theme,
        category: req.query.category,
        // Both kinds by default; ?type=fd_package|readymade narrows it.
        type: req.query.type,
        featured: req.query.featured,
        bestseller: req.query.bestseller,
      }),
      loadCatalogPools(),
      getFdPlatformFeeSettings(),
      listPackageReviewStats(),
    ]);

    const withDates = await Promise.all(
      packages.map(async (p) => {
        const [dates, itinerary] = await Promise.all([listDepartureDates(p.id), listItineraryForPackage(p.id)]);
        const hotelId = resolvePrimaryHotelId(p, itinerary.items);
        const hotel = hotelId ? pools.hotel.find((h) => h.id === hotelId) : null;
        return {
          ...toPublicPackage(p, applyPlatformFee(resolveRatePerPax(p, itinerary.items, pools), resolvePlatformFeePercentage(p, platformFeeSettings)), hotel, reviewStats[p.id]),
          hotelLocations: hotelLocationNights(itinerary, p.duration, pools.hotel),
          // ratePerPax above is quoted for BASELINE_PAX travellers when the
          // package has vehicle-priced tours (0089) — the card says so.
          rateVariesWithGroupSize: rateVariesWithGroupSize(p, itinerary.items, pools),
          rateBaselinePax: BASELINE_PAX,
          // Same null-unless-directly-included resolution the single-departure
          // GET already uses (resolveFlightDetails, see its own doc comment) —
          // added here too so the listing (Departures.jsx's DepartureCard) can
          // show an onward/return summary on the card itself when a package
          // has flights, without a second per-card request.
          flights: resolveFlightDetails(p, pools),
          nextDepartures: dates.map((d) => ({
            id: d.id,
            date: d.date,
            seatsLeft: d.seats_total - d.seats_booked,
            // Total capacity alongside seatsLeft — DepartureCard's seats-left
            // progress bar needs both ends of the ratio, not just what's
            // remaining.
            seatsTotal: d.seats_total,
            location: d.location,
          })),
        };
      })
    );

    res.json({ departures: withDates });
  } catch (err) {
    next(err);
  }
}

module.exports.listDepartures = listDepartures;

// Builds the full agent-facing departure detail object — shared by the
// normal authenticated GET below and getDepartureDataForPdf (the print page's
// own data fetch, used to build the PDF), so the on-screen page and the
// downloaded PDF are always built from the exact same query/compose path
// rather than two independently-maintained copies drifting apart. Mirrors
// packageRequests.controller.js's toPublicPackageRequest, reused the same
// way by its own downloadItineraryPdf/getItineraryDataForPdf pair.
async function buildDepartureDetail(fdPackage) {
  const [itinerary, dates, addons, pools, prebookingSettings, platformFeeSettings] = await Promise.all([
    listItineraryForPackage(fdPackage.id),
    listDepartureDates(fdPackage.id),
    listAddons(fdPackage.id),
    loadCatalogPools(),
    getFdPrebookingSettings(),
    getFdPlatformFeeSettings(),
  ]);

  // pools.hotel already holds every hotel's full row (loadCatalogPools) —
  // resolving here off the itinerary's own hotel item instead of a second
  // hotelsModel.findById(fdPackage.hotel_id) call both fixes the
  // legacy-hotel_id bug (see resolvePrimaryHotelId) and avoids a redundant
  // DB round trip.
  const hotelId = resolvePrimaryHotelId(fdPackage, itinerary.items);
  const hotel = hotelId ? pools.hotel.find((h) => h.id === hotelId) : null;
  const feePercentage = resolvePlatformFeePercentage(fdPackage, platformFeeSettings);
  const maxGroupSize = maxGroupSizeFromVehicles(itinerary.items, pools, { readymade: fdPackage.type === 'readymade' });
  const paxPricing = buildReadymadePaxPricing(fdPackage, itinerary.items, pools, maxGroupSize);

  return {
    ...toPublicPackage(fdPackage, applyPlatformFee(resolveRatePerPax(fdPackage, itinerary.items, pools), feePercentage), hotel),
    // Readymade only (null otherwise): per-person rate incl. platform fee and
    // the auto-picked vehicle per tour for each headcount 1..maxGroupSize —
    // DepartureDetail.jsx reads the row for the agent's pax. Same
    // resolveRatePerPax(pax) + applyPlatformFee booking.service.js charges.
    paxPricing: paxPricing
      ? paxPricing.map((row) => ({ ...row, ratePerPax: applyPlatformFee(row.ratePerPax, feePercentage) }))
      : null,
    // Tour vehicle pricing (0089) — lets DepartureDetail.jsx recompute the
    // per-person rate for the headcount the agent picks and show which
    // vehicle each tour uses. See fdPackages.model.js#buildGroupPricing.
    groupPricing: buildGroupPricing(fdPackage, itinerary.items, pools),
    // Most people one booking can have: the smallest capacity among the
    // vehicles chosen for the itinerary's tours (null = no vehicle limit). The
    // booking screen also caps the group at the seats left.
    maxGroupSize,
    // % of the total due at booking to hold seats (admin Payments → Package
    // Controller); null = no pre-booking, the full amount is due. Lets
    // DepartureDetail.jsx preview what booking.service.js will charge.
    prebookingPercentage: resolvePrebookingPercentage(fdPackage, prebookingSettings),
    itinerary: composeItinerary(itinerary.days, itinerary.items, pools),
    // Meals (lunch/dinner) are opt-in fd_addons rows now (0075) — they come
    // back in `addons` below with type 'meal', not as a separate section.
    // null unless flights are included directly on the package — the
    // "Flight Details" collapsible section (DepartureDetail.jsx) only
    // renders when this comes back non-null.
    flights: resolveFlightDetails(fdPackage, pools),
    departureDates: dates.map((d) => ({
      id: d.id,
      date: d.date,
      seatsLeft: d.seats_total - d.seats_booked,
      seatsTotal: d.seats_total,
      location: d.location,
    })),
    // `type` tells the agent-facing UI (DepartureDetail.jsx) which category
    // heading an add-on belongs under (Activities/Tours/Transfers/Flights/
    // Meals) — derived from whichever of the 5 mutually exclusive *_id
    // columns is set (fd_addons_exactly_one_item CHECK guarantees exactly
    // one). `name` falls back through all 5 joined name columns (listAddons);
    // a meal add-on has no per-row name, so it's labelled by meal type.
    addons: addons.map((a) => ({
      ...(a.meal_id
        ? (() => {
            const meal = pools.meal.find((m) => m.id === a.meal_id);
            return {
              description: meal?.description ?? null,
              category: meal?.category ?? null,
              mealType: meal?.meal_type ?? null,
              isLiquor: Boolean(meal?.is_liquor),
              liquorBrand: meal?.liquor_brand ?? null,
              liquorPriceQuarter: meal?.liquor_price_quarter ?? null,
              liquorPriceHalf: meal?.liquor_price_half ?? null,
              liquorPriceFull: meal?.liquor_price_full ?? null,
              liquorPricePerMl: meal?.liquor_price_per_ml ?? null,
              liquorMl: meal?.liquor_ml ?? null,
              pricePerDay: Number(meal?.price_per_day || 0),
            };
          })()
        : {}),
      id: a.id,
      type: a.activity_id
        ? 'activity'
        : a.tour_id
          ? 'tour'
          : a.transfer_id
            ? 'transfer'
            : a.flight_id
              ? 'flight'
              : 'meal',
      // The catalog row's own id (not `id` above, which is the fd_addons
      // join-row id) — lets the agent-facing "View Details" combobox
      // (DepartureDetail.jsx) fetch the full catalog record straight off
      // the existing generic GET /:entity/:id detail route
      // (catalog.routes.js) using this + `type`.
      catalogId: a.activity_id || a.tour_id || a.transfer_id || a.flight_id || a.meal_id,
      name:
        a.activity_name ||
        a.tour_name ||
        a.transfer_name ||
        a.flight_name ||
        a.meal_name || (a.meal_type ? a.meal_type[0].toUpperCase() + a.meal_type.slice(1) : null),
      pricePerPax: Number(a.price_per_pax),
      // Tour add-ons are priced per vehicle by group size (0089): the agent
      // UI prices them from this table for the chosen headcount (and the
      // booking re-prices them server-side); pricePerPax above is then only
      // the 2-traveller snapshot. null for a tour still on a per-person price.
      vehiclePrices: a.tour_id ? toPublicVehiclePrices(pools.tour.find((t) => t.id === a.tour_id)) : null,
    })),
    // Richer hotel detail for the "Hotel Information" section — the
    // listing/toPublicPackage only carries hotelName for the card.
    hotel: hotel
      ? {
          id: hotel.id,
          name: hotel.name,
          city: hotel.city,
          state: hotel.state,
          category: hotel.category,
          boardBasisOptions: hotel.board_basis_options || [],
          description: hotel.description,
          images: hotel.images || [],
        }
      : null,
  };
}

async function getDeparture(req, res, next) {
  try {
    const fdPackage = await findFdPackageById(req.params.id);
    if (!fdPackage || fdPackage.status !== 'published') {
      return res.status(404).json({ error: 'not_found' });
    }

    res.json({ departure: await buildDepartureDetail(fdPackage) });
  } catch (err) {
    next(err);
  }
}

module.exports.getDeparture = getDeparture;

async function getDepartureDataForPdf(req, res, next) {
  try {
    const { id } = req.params;
    if (req.fdPdfClaims.departureId !== id) {
      return res.status(403).json({ error: 'forbidden', message: 'This token is not valid for this itinerary' });
    }

    const fdPackage = await findFdPackageById(id);
    if (!fdPackage || fdPackage.status !== 'published') {
      return res.status(404).json({ error: 'not_found' });
    }

    const [departure, branding] = await Promise.all([
      buildDepartureDetail(fdPackage),
      getItineraryBranding(req.fdPdfClaims.sub), // the downloading agent's logo / name / registration
    ]);
    res.json({ departure, branding });
  } catch (err) {
    next(err);
  }
}

module.exports.getDepartureDataForPdf = getDepartureDataForPdf;

// "Download Itinerary": issues the short-lived FD pdfToken the agent's own
// browser uses to load DepartureItineraryPrint.jsx (in a hidden iframe) and
// build the PDF itself (agent/lib/itineraryPdf.js on the frontend) — the
// server renders no PDFs.
async function getDepartureItineraryPrintToken(req, res, next) {
  try {
    const { id } = req.params;
    const fdPackage = await findFdPackageById(id);
    if (!fdPackage || fdPackage.status !== 'published') {
      return res.status(404).json({ error: 'not_found' });
    }
    res.json({ pdfToken: signFdItineraryPdfToken({ userId: req.user.id, departureId: id }) });
  } catch (err) {
    next(err);
  }
}

module.exports.getDepartureItineraryPrintToken = getDepartureItineraryPrintToken;

async function createBooking(req, res, next) {
  try {
    const fdPackage = await findFdPackageById(req.params.id);
    if (!fdPackage || fdPackage.status !== 'published') {
      return res.status(404).json({ error: 'not_found' });
    }

    const isReadymade = fdPackage.type === 'readymade';
    let departureDate = req.body.departureDateId
      ? await findDepartureDateById(req.body.departureDateId)
      : null;
    if (isReadymade && !departureDate && req.body.departureDate) {
      const requested = new Date(`${req.body.departureDate}T00:00:00`);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (Number.isNaN(requested.getTime()) || requested < today) {
        return res.status(400).json({ error: 'invalid_departure_date' });
      }
      departureDate = await addDepartureDate(fdPackage.id, {
        date: req.body.departureDate,
        seatsTotal: 0,
        location: 'Readymade',
      });
    }
    if (!departureDate || departureDate.fd_package_id !== fdPackage.id) {
      return res.status(400).json({ error: 'invalid_departure_date' });
    }

    const agency = await findAgencyById(req.user.agency_id);
    const { pax, addonIds = [], addonDayNumbers = {}, travelers = [] } = req.body;

    const { booking } = await createFdBooking({
      fdPackage,
      departureDate,
      isReadymade,
      agencyId: agency.id,
      createdByUserId: req.user.id,
      createdVia: 'self_service',
      pax,
      addonIds,
      addonDayNumbers,
      travelers,
    });

    getIo()?.to(`agency:${agency.id}`).emit('booking:status_changed', {
      bookingId: booking.id,
      status: booking.status,
    });

    const depositDue = Number(booking.deposit_due);
    const amountDueNow = Math.max(0, depositDue - Number(booking.deposit_paid));
    res.status(201).json({
      booking: {
        id: booking.id,
        status: booking.status,
        pax: booking.pax,
        totalPrice: Number(booking.total_price),
        balanceDue: Number(booking.balance_due),
        balanceDueDate: booking.balance_due_date,
        // Part-payment (0077): what must be paid now to hold the seat (full
        // price inside 15 days of departure, otherwise the flat deposit),
        // and the still-outstanding remainder collected later.
        depositDue,
        amountDueNow,
        // How long an unpaid booking keeps its seats (seatHold.service.js) —
        // shown on the booking screen so the text always matches the backend.
        seatHoldMinutes: SEAT_HOLD_MINUTES,
        remainingBalance: Math.max(0, Number(booking.balance_due) - amountDueNow),
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports.createBooking = createBooking;

async function enquireNow(req, res, next) {
  try {
    const fdPackage = await findFdPackageById(req.params.id);
    if (!fdPackage) return res.status(404).json({ error: 'not_found' });

    const { date, pax } = req.query;
    const message = `Hi, I'd like to enquire about ${fdPackage.title}${date ? `, ${date}` : ''}${
      pax ? `, ${pax} pax` : ''
    }`;

    res.json({ whatsappLink: buildWhatsAppLink(env.whatsappSalesNumber, message) });
  } catch (err) {
    next(err);
  }
}

module.exports.enquireNow = enquireNow;
