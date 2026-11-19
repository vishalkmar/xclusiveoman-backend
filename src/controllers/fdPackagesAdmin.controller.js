const {
  listAllFdPackagesForAdmin,
  findFdPackageById,
  createFdPackage,
  updateFdPackage,
  deleteFdPackage,
  archiveFdPackage,
  getFdPackageDeleteImpact,
  listItineraryForPackage,
  replaceItinerary,
  clearItineraryVehicles,
  composeItinerary,
  resolveRatePerPax,
  loadCatalogPools,
  listDepartureDates,
  addDepartureDate,
  removeDepartureDate,
  listAddons,
  addAddon,
  removeAddon
} = require('../models/fdPackages.model.js');

const {
  activitiesModel,
  toursModel,
  transfersModel,
  flightsModel,
  mealsModel
} = require('../models/catalog.model.js');
const { listDepartureLocations } = require('../models/locations.model.js');
const { syncRowFeeRate, refreshFeeRatesSafe } = require('../services/fdPackageFeeRate.service.js');
const { getFdPlatformFeeSettings } = require('../services/prebooking.service.js');

const {
  parseDurationDays
} = require('../utils/meals.js');

const {
  BASELINE_PAX,
  tourPerPaxPrice,
  chosenVehicleRow,
  hasVehiclePricing
} = require('../utils/tourPricing.js');

const {
  toSnakeCaseColumns
} = require('../validation/schemas.js');

const {
  uploadBuffer
} = require('../services/cloudinary.service.js');

// Postgres NUMERIC columns come back from `pg` as strings (to avoid silent
// float precision loss), not JS numbers. Left unconverted, those strings flow
// straight into the admin form on GET and then get POSTed/PATCHed back
// unchanged, tripping the `z.number()` checks in fdPackageSchema with
// "Expected number, received string". Convert here so every response the
// admin UI reads back already has real numbers (null stays null instead of
// becoming 0, since these columns have no DB default).
function toNumOrNull(v) {
  return v === null || v === undefined ? null : Number(v);
}

// Mirrors the admin UI's own pre-Publish gate (FdPackageEditor.jsx's
// findCarouselImagesError) — enforced here too so a package can never be
// published with a thin gallery via a direct API call that skips the UI.
// Only blocks the transition *into* (or staying) 'published'; a package
// still being drafted/autosaved can hold any number of images, same as the
// day-by-day itinerary, which has no equivalent server-side check either.
const MIN_CAROUSEL_IMAGES = 4;

function carouselImagesError(images, status) {
  if (status === 'published' && (images || []).length < MIN_CAROUSEL_IMAGES) {
    return `Add at least ${MIN_CAROUSEL_IMAGES} carousel images before publishing.`;
  }
  return null;
}

// Same "only checked at the moment of publishing" gate as carouselImagesError
// above — a package can sit in draft with no hero image while the admin is
// still building it out (heroImageUrl is nullable in fdPackageSchema for
// exactly that reason), but needs one before it goes live.
function heroImageError(heroImageUrl, status) {
  if (status === 'published' && !heroImageUrl) {
    return 'Add a hero image before publishing.';
  }
  return null;
}

// Same "only checked at the moment of publishing" gate as carouselImagesError
// above, for the Flights section (0064_fd_package_flights.sql) — flying
// solely on flightsEnabled being true (mid-edit, before either flight is
// picked yet) would reject the debounced autosave PATCH that fires the
// instant the toggle is flipped on, well before the admin has had a chance
// to actually pick a flight.
function flightsSelectionError(flightsEnabled, onwardFlightId, returnFlightId, status) {
  if (status === 'published' && flightsEnabled && (!onwardFlightId || !returnFlightId)) {
    return 'Select both an Onward and a Return flight before publishing, or turn off the Flights section.';
  }
  return null;
}

// A Readymade package has no departure dates or seats to validate; what it
// needs instead, to go live, is somewhere to depart from: "All cities" ticked,
// or at least one chosen city. (Fixed Departure packages keep their own
// rules unchanged.) Like the other publish gates, only checked at the moment
// of publishing so a draft can be saved mid-edit.
function readymadeCitiesError(type, allCities, cities, status) {
  if (status === 'published' && type === 'readymade' && !allCities && (cities || []).length === 0) {
    return 'Select "All cities" or at least one departure city before publishing.';
  }
  return null;
}

// Cities only mean something on a Readymade package: an FD package never
// carries them (its departures name their own location), and a Readymade
// package's chosen cities must be real entries of the departure-locations
// master list. De-duplicated; "All cities" wins over a list. Mutates body.
async function normalizeCityFields(body, finalType) {
  if (finalType !== 'readymade') {
    if (body.allCities !== undefined) body.allCities = false;
    if (body.departureCities !== undefined || body.type !== undefined) body.departureCities = [];
    return null;
  }
  if (body.allCities === true) {
    body.departureCities = [];
    return null;
  }
  if (body.departureCities !== undefined) {
    const unique = [...new Set(body.departureCities.map((c) => c.trim()).filter(Boolean))];
    const known = new Set((await listDepartureLocations()).map((l) => l.name));
    const unknown = unique.filter((c) => !known.has(c));
    if (unknown.length > 0) {
      return `Unknown departure city: ${unknown.join(', ')}. Pick cities from the list.`;
    }
    body.departureCities = unique;
  }
  return null;
}

// departure_cities is a JSON column — normally already parsed by mysql2.
function citiesFromRow(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function packageDetailsError(title, category, status) {
  if (status !== 'published') return null;
  if (!String(title || '').trim()) return 'Enter a package name before publishing.';
  if (!String(category || '').trim()) return 'Select a category before publishing.';
  return null;
}

// fd_packages.hotel_id/hotel_name are a pre-day-by-day-itinerary leftover
// (0013_fd_package_hotel.sql) — the day-by-day itinerary builder
// (ItineraryManager, FdPackageEditor.jsx) never writes to that column, it
// only ever places hotel items on individual days (fd_itinerary_items), so
// hotel_id is null on every package that's ever gone through this editor and
// the old join-on-hotel_id approach always resolved hotelName to null. This
// derives it from the itinerary instead — the earliest day that has a hotel
// placed on it, resolved against the already-loaded hotel pool — which is
// what a listing actually wants to show ("the" hotel this package uses).
function deriveHotelName(items, pools) {
  const hotelItem = [...items].sort((a, b) => a.day_number - b.day_number).find((it) => it.item_type === 'hotel');
  if (!hotelItem) return null;
  return pools.hotel?.find((h) => h.id === hotelItem.item_id)?.name || null;
}

// `ratePerPax` is the already-resolved rate (see resolveRatePerPax —
// fdPackage.rate_per_pax when the admin set an override, else the itinerary
// total). Callers that haven't loaded the itinerary/catalog pools
// (create/update, which have no itinerary yet) simply omit it, so a package
// with no override and no itinerary yet reports ratePerPax: null. `hotelName`
// works the same way — omitted (falls back to the always-null legacy
// hotel_id join) by callers with no itinerary loaded yet; list()/get() below
// pass deriveHotelName's result explicitly.
// `rateOverride` is the raw column, unresolved — the editor needs this
// (rather than the resolved ratePerPax) to tell whether the admin has set a
// manual price at all, since it computes the itinerary-driven default live
// on its own instead of trusting a value that might just be the fallback.
function toPublicPackage(fdPackage, ratePerPax, hotelName) {
  return {
    id: fdPackage.id,
    title: fdPackage.title,
    theme: fdPackage.theme,
    category: fdPackage.category,
    // Package kind (0120): 'fd_package' | 'readymade', and — Readymade only —
    // where it departs from.
    type: fdPackage.type || 'fd_package',
    allCities: !!fdPackage.all_cities,
    departureCities: citiesFromRow(fdPackage.departure_cities),
    platformFeeMode: fdPackage.platform_fee_mode || 'global',
    platformFeePercentage: fdPackage.platform_fee_percentage == null ? null : Number(fdPackage.platform_fee_percentage),
    duration: fdPackage.duration,
    heroImageUrl: fdPackage.hero_image_url,
    images: fdPackage.images || [],
    hotelId: fdPackage.hotel_id,
    hotelName: hotelName !== undefined ? hotelName : (fdPackage.hotel_name ?? null),
    shortDescription: fdPackage.short_description,
    suitableAgeMin: fdPackage.suitable_age_min,
    rating: toNumOrNull(fdPackage.rating),
    reviewCount: fdPackage.review_count,
    isFeatured: !!fdPackage.is_featured,
    isBestseller: !!fdPackage.is_bestseller,
    status: fdPackage.status,
    ratePerPax: ratePerPax ?? null,
    rateOverride: fdPackage.type === 'readymade' ? null : toNumOrNull(fdPackage.rate_per_pax),
    // Meals (lunch/dinner) are opt-in fd_addons rows now (0075) — they come
    // back in `addons` on get(), not as fields here.
    // Task 5 — "included or not" checkbox (0062_fd_addons_transfer_visa.sql).
    visaEnabled: !!fdPackage.visa_enabled,
    // Flights section (0064_fd_package_flights.sql) — ids only; the editor
    // resolves names/source/destination/date against its own /flights fetch
    // (same "parent already has the full catalog loaded" convention
    // AddonsManager uses for activities/tours/transfers), rather than this
    // response embedding a joined name the way hotelName above does.
    flightsEnabled: !!fdPackage.flights_enabled,
    onwardFlightId: fdPackage.onward_flight_id ?? null,
    returnFlightId: fdPackage.return_flight_id ?? null,
    // Client-facing Inclusions/Exclusions — see
    // 0050_fd_packages_inclusions_exclusions.sql.
    inclusions: fdPackage.inclusions || '',
    exclusions: fdPackage.exclusions || '',
    createdAt: fdPackage.created_at,
    // fd_packages.updated_at (0006_fd_packages.sql) — bumped to now() on every
    // updateFdPackage. Surfaced for the Product Catalog table's "Updated"
    // column; present on both list() (SELECT fd_packages.*) and get().
    updatedAt: fdPackage.updated_at,
    // Only present on the admin list() row (listAllFdPackagesForAdmin's seat
    // rollup) — undefined here on the single-package get(), which loads the
    // full departureDates array separately instead.
    seatsTotal: toNumOrNull(fdPackage.seats_total),
    seatsBooked: toNumOrNull(fdPackage.seats_booked),
    firstDepartureDate: fdPackage.first_date ?? null,
    lastDepartureDate: fdPackage.last_date ?? null,
    // The per-person rate with the platform fee applied (0121), and the fee
    // percentage that was added: what the admin screens show as the price.
    // ratePerPax above stays the net rate before any fee.
    ratePerPaxWithFee: toNumOrNull(fdPackage.rate_with_fee),
    platformFeeApplied: toNumOrNull(fdPackage.platform_fee_applied),
  };
}

async function list(req, res, next) {
  try {
    res.set('Cache-Control', 'no-store');
    const { search, status, type, priceMin, priceMax, dateFrom, dateTo } = req.query;
    const parsedPriceMin = priceMin === undefined ? undefined : Number(priceMin);
    const parsedPriceMax = priceMax === undefined ? undefined : Number(priceMax);
    const [rows, pools, feeSettings] = await Promise.all([
      listAllFdPackagesForAdmin({ status, type, priceMin: parsedPriceMin, priceMax: parsedPriceMax, dateFrom, dateTo }),
      loadCatalogPools(),
      getFdPlatformFeeSettings(),
    ]);
    let fdPackages = await Promise.all(
      rows.map(async (row) => {
        const { items } = await listItineraryForPackage(row.id);
        // Recompute and persist if a catalog price or the fee setting moved.
        await syncRowFeeRate(row, items, pools, feeSettings);
        return toPublicPackage(row, resolveRatePerPax(row, items, pools), deriveHotelName(items, pools));
      })
    );

    if (search) {
      const needle = search.trim().toLowerCase();
      fdPackages = fdPackages.filter((p) =>
        [p.title, p.theme, p.hotelName].some((v) => v && v.toLowerCase().includes(needle))
      );
    }

    const paginate = req.query.page !== undefined || req.query.pageSize !== undefined;
    if (!paginate) {
      return res.json({ fdPackages });
    }
    const total = fdPackages.length;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(req.query.pageSize, 10) || 10));
    const start = (page - 1) * pageSize;
    fdPackages = fdPackages.slice(start, start + pageSize);

    res.json({ fdPackages, pagination: { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) } });
  } catch (err) {
    next(err);
  }
}

module.exports.list = list;

async function get(req, res, next) {
  try {
    const fdPackage = await findFdPackageById(req.params.id);
    if (!fdPackage) return res.status(404).json({ error: 'not_found' });

    const [itinerary, dates, addons, pools, feeSettings] = await Promise.all([
      listItineraryForPackage(fdPackage.id),
      listDepartureDates(fdPackage.id),
      listAddons(fdPackage.id),
      loadCatalogPools(),
      getFdPlatformFeeSettings(),
    ]);
    await syncRowFeeRate(fdPackage, itinerary.items, pools, feeSettings);

    res.json({
      fdPackage: {
        ...toPublicPackage(fdPackage, resolveRatePerPax(fdPackage, itinerary.items, pools), deriveHotelName(itinerary.items, pools)),
        itinerary: composeItinerary(itinerary.days, itinerary.items, pools),
        departureDates: dates.map((d) => ({
          id: d.id,
          date: d.date,
          seatsTotal: d.seats_total,
          seatsBooked: d.seats_booked,
          location: d.location,
        })),
        addons: addons.map((a) => ({
          id: a.id,
          activityId: a.activity_id,
          tourId: a.tour_id,
          transferId: a.transfer_id,
          flightId: a.flight_id,
          mealId: a.meal_id,
          // Meal add-ons have no per-row name of their own — label by meal
          // type (there's one lunch + one dinner catalog entry).
          name:
            a.activity_name ||
            a.tour_name ||
            a.transfer_name ||
            a.flight_name ||
            a.meal_name || (a.meal_type ? a.meal_type[0].toUpperCase() + a.meal_type.slice(1) : null),
          pricePerPax: Number(a.price_per_pax),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports.get = get;

async function create(req, res, next) {
  try {
    const createBody = { ...req.body };
    const cityMessage = await normalizeCityFields(createBody, createBody.type || 'fd_package');
    if (cityMessage) return res.status(400).json({ error: 'validation_error', message: cityMessage });
    const message =
      packageDetailsError(req.body.title, req.body.category, req.body.status) ||
      carouselImagesError(req.body.images, req.body.status) ||
      heroImageError(req.body.heroImageUrl, req.body.status) ||
      flightsSelectionError(req.body.flightsEnabled, req.body.onwardFlightId, req.body.returnFlightId, req.body.status) ||
      readymadeCitiesError(createBody.type, createBody.allCities, createBody.departureCities, req.body.status);
    if (message) {
      return res.status(400).json({ error: 'validation_error', message });
    }
    const body = createBody;
    let fdPackage = await createFdPackage(toSnakeCaseColumns(body));
    await refreshFeeRatesSafe([fdPackage.id]);
    fdPackage = (await findFdPackageById(fdPackage.id)) || fdPackage;
    res.status(201).json({ fdPackage: toPublicPackage(fdPackage) });
  } catch (err) {
    next(err);
  }
}

module.exports.create = create;

// Publishing needs every itinerary tour that has priced vehicles to have one
// chosen (the package is priced with it). Only checked when the request is
// the publish action itself, so older packages stay editable until someone
// publishes them again.
async function itineraryTourVehicleError(fdPackageId) {
  const [{ items }, pools] = await Promise.all([listItineraryForPackage(fdPackageId), loadCatalogPools()]);
  for (const it of items) {
    if (it.item_type !== 'tour') continue;
    const tour = (pools.tour || []).find((t) => t.id === it.item_id);
    if (tour && hasVehiclePricing(tour) && !chosenVehicleRow(tour, it.vehicle_key)) {
      return `Choose a vehicle for the tour "${tour.name}" (Day ${it.day_number}) before publishing.`;
    }
  }
  return null;
}

async function update(req, res, next) {
  try {
    const existing = await findFdPackageById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    // An archived package was deleted (its bookings kept) — it's read-only,
    // and archiving is one-way so it can't be quietly re-published.
    if (existing.status === 'archived' || req.body.status === 'archived') {
      return res.status(409).json({ error: 'archived', message: 'This package has been deleted and can no longer be edited.' });
    }

    // Changing the package type is only allowed while it's a draft (the
    // editor's two tabs), so a live package never changes kind under agents'
    // feet — and a package can't become Readymade while it still carries
    // dated departures or bookings, which Readymade packages don't have.
    if (req.body.type !== undefined && req.body.type !== (existing.type || 'fd_package')) {
      if (existing.status !== 'draft') {
        return res.status(409).json({ error: 'type_locked', message: 'Only a draft package can change type.' });
      }
      if (req.body.type === 'readymade') {
        const [dates, impact] = await Promise.all([listDepartureDates(existing.id), getFdPackageDeleteImpact(existing.id)]);
        if (dates.length > 0 || impact.bookingCount > 0) {
          return res.status(409).json({
            error: 'type_locked',
            message: "Remove this package's departure dates before making it a Readymade package.",
          });
        }
      }
    }

    // PATCH bodies are partial — a `status: 'published'` PATCH sent without
    // `images` (or vice versa) still needs checking against whichever of the
    // two the request isn't touching, so fall back to what's already saved.
    const finalStatus = req.body.status !== undefined ? req.body.status : existing.status;
    const finalImages = req.body.images !== undefined ? req.body.images : existing.images;
    const finalHeroImageUrl = req.body.heroImageUrl !== undefined ? req.body.heroImageUrl : existing.hero_image_url;
    const finalFlightsEnabled = req.body.flightsEnabled !== undefined ? req.body.flightsEnabled : existing.flights_enabled;
    const finalOnwardFlightId = req.body.onwardFlightId !== undefined ? req.body.onwardFlightId : existing.onward_flight_id;
    const finalReturnFlightId = req.body.returnFlightId !== undefined ? req.body.returnFlightId : existing.return_flight_id;
    const finalTitle = req.body.title !== undefined ? req.body.title : existing.title;
    const finalCategory = req.body.category !== undefined ? req.body.category : existing.category;
    const finalType = req.body.type !== undefined ? req.body.type : existing.type || 'fd_package';
    const body = { ...req.body };
    const cityMessage = await normalizeCityFields(body, finalType);
    if (cityMessage) return res.status(400).json({ error: 'validation_error', message: cityMessage });
    const finalAllCities = body.allCities !== undefined ? body.allCities : !!existing.all_cities;
    const finalCities = body.departureCities !== undefined ? body.departureCities : citiesFromRow(existing.departure_cities);
    const message =
      packageDetailsError(finalTitle, finalCategory, finalStatus) ||
      carouselImagesError(finalImages, finalStatus) ||
      heroImageError(finalHeroImageUrl, finalStatus) ||
      flightsSelectionError(finalFlightsEnabled, finalOnwardFlightId, finalReturnFlightId, finalStatus) ||
      readymadeCitiesError(finalType, finalAllCities, finalCities, finalStatus);
    if (message) {
      return res.status(400).json({ error: 'validation_error', message });
    }
    if (req.body.status === 'published' && finalType !== 'readymade') {
      const vehicleMessage = await itineraryTourVehicleError(existing.id);
      if (vehicleMessage) return res.status(400).json({ error: 'validation_error', message: vehicleMessage });
    }

    let fdPackage = await updateFdPackage(req.params.id, toSnakeCaseColumns(body));
    // A package that just became Readymade prices its tours without a vehicle.
    if (finalType === 'readymade' && (existing.type || 'fd_package') !== 'readymade') {
      await clearItineraryVehicles(req.params.id);
    }
    if (!fdPackage) return res.status(404).json({ error: 'not_found' });
    await refreshFeeRatesSafe([fdPackage.id]);
    fdPackage = (await findFdPackageById(fdPackage.id)) || fdPackage;
    res.json({ fdPackage: toPublicPackage(fdPackage) });
  } catch (err) {
    next(err);
  }
}

module.exports.update = update;

// GET /admin/fd-packages/:id/delete-impact — what deleting would affect,
// for the delete dialog's explanation of the two options.
async function deleteImpact(req, res, next) {
  try {
    const existing = await findFdPackageById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    res.json({ impact: await getFdPackageDeleteImpact(req.params.id) });
  } catch (err) {
    next(err);
  }
}

module.exports.deleteImpact = deleteImpact;

// DELETE /admin/fd-packages/:id?mode=all|package_only
//   - no bookings:          the package is deleted outright (mode not needed);
//   - mode=all:             the package AND every booking made for it, with
//                           their payments, transactions, reviews and
//                           travellers — permanent;
//   - mode=package_only:    the package is archived (deleteFdPackage's
//                           sibling archiveFdPackage) — gone from the admin
//                           list and from agents, its bookings kept intact;
//   - bookings, no mode:    409 has_bookings, so nothing is ever removed
//                           without the admin choosing which way.
// `deleteBookings=true` is the older spelling of mode=all.
async function remove(req, res, next) {
  try {
    const existing = await findFdPackageById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    const mode = req.query.mode || (req.query.deleteBookings === 'true' ? 'all' : undefined);
    if (mode !== undefined && mode !== 'all' && mode !== 'package_only') {
      return res.status(400).json({ error: 'invalid_mode', message: 'mode must be "all" or "package_only".' });
    }

    const { bookingCount } = await getFdPackageDeleteImpact(req.params.id);
    if (bookingCount === 0) {
      await deleteFdPackage(req.params.id);
      return res.json({ result: 'deleted', deletedBookings: 0 });
    }
    if (mode === 'all') {
      const { deletedBookings } = await deleteFdPackage(req.params.id, { withBookings: true });
      return res.json({ result: 'deleted', deletedBookings });
    }
    if (mode === 'package_only') {
      await archiveFdPackage(req.params.id);
      return res.json({ result: 'archived', keptBookings: bookingCount });
    }
    return res.status(409).json({
      error: 'has_bookings',
      message: `This package has ${bookingCount} booking${bookingCount === 1 ? '' : 's'}. Choose whether to delete them too or keep them.`,
      bookingCount,
    });
  } catch (err) {
    next(err);
  }
}

module.exports.remove = remove;

async function uploadHeroImage(req, res, next) {
  try {
    const { id } = req.params;
    const existing = await findFdPackageById(id);
    if (!existing) return res.status(404).json({ error: 'not_found' });

    if (!req.file) {
      return res.status(400).json({ error: 'missing_file', message: 'Upload a hero image' });
    }

    const uploaded = await uploadBuffer(req.file.buffer, {
      folderParts: ['fd-packages', id, 'hero-image'],
    });

    const fdPackage = await updateFdPackage(id, { hero_image_url: uploaded.secure_url });
    res.status(201).json({ fdPackage: toPublicPackage(fdPackage) });
  } catch (err) {
    next(err);
  }
}

module.exports.uploadHeroImage = uploadHeroImage;

async function uploadImages(req, res, next) {
  try {
    const { id } = req.params;
    const existing = await findFdPackageById(id);
    if (!existing) return res.status(404).json({ error: 'not_found' });

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'missing_files', message: 'Upload at least one image' });
    }

    const uploaded = await Promise.all(
      req.files.map((file) => uploadBuffer(file.buffer, { folderParts: ['fd-packages', id, 'images'] }))
    );
    const images = [...(existing.images || []), ...uploaded.map((u) => u.secure_url)];

    const fdPackage = await updateFdPackage(id, { images });
    res.status(201).json({ fdPackage: toPublicPackage(fdPackage) });
  } catch (err) {
    next(err);
  }
}

module.exports.uploadImages = uploadImages;

async function deleteImage(req, res, next) {
  try {
    const { id } = req.params;
    const url = req.body?.url ?? decodeURIComponent(req.params.url);
    const existing = await findFdPackageById(id);
    if (!existing) return res.status(404).json({ error: 'not_found' });

    const images = (existing.images || []).filter((u) => u !== url);
    const fdPackage = await updateFdPackage(id, { images });
    res.json({ fdPackage: toPublicPackage(fdPackage) });
  } catch (err) {
    next(err);
  }
}

module.exports.deleteImage = deleteImage;

async function putItinerary(req, res, next) {
  try {
    // Readymade packages place tours without a vehicle (priced by group size,
    // as before); only FD packages pick one.
    const target = await findFdPackageById(req.params.id);
    if (target && target.type === 'readymade') {
      for (const d of req.body.days || []) for (const it of d.items || []) delete it.vehicleKey;
    }
    // A tour's chosen vehicle must be one of that tour's own priced vehicles.
    const tourItems = (req.body.days || []).flatMap((d) => (d.items || []).filter((it) => it.type === 'tour' && it.vehicleKey));
    if (tourItems.length > 0) {
      const pool = (await loadCatalogPools()).tour || [];
      const bad = tourItems.find((it) => !chosenVehicleRow(pool.find((t) => t.id === it.id), it.vehicleKey));
      if (bad) {
        const tour = pool.find((t) => t.id === bad.id);
        return res.status(400).json({
          error: 'validation_error',
          message: `The vehicle chosen for "${tour?.name || 'a tour'}" isn't one of its priced vehicles. Pick it again.`,
        });
      }
    }
    const [{ days, items }, pools] = await Promise.all([
      replaceItinerary(req.params.id, req.body.days),
      loadCatalogPools(),
    ]);
    // The itinerary drives the net rate, so refresh the stored price.
    await refreshFeeRatesSafe([req.params.id]);
    // The editor computes the itinerary-driven net rate live on its own
    // (mirrors computeNetRatePerPax) as items are added/removed, so this
    // response doesn't need to carry a price at all.
    res.json({ itinerary: composeItinerary(days, items, pools) });
  } catch (err) {
    next(err);
  }
}

module.exports.putItinerary = putItinerary;

async function postDepartureDate(req, res, next) {
  try {
    const existing = await findFdPackageById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    // Readymade packages have no dated departures or seat inventory.
    if (existing.type === 'readymade') {
      return res.status(409).json({ error: 'readymade_no_dates', message: 'A Readymade package has no departure dates.' });
    }
    const date = await addDepartureDate(req.params.id, req.body);
    res.status(201).json({ departureDate: date });
  } catch (err) {
    next(err);
  }
}

module.exports.postDepartureDate = postDepartureDate;

async function deleteDepartureDate(req, res, next) {
  try {
    await removeDepartureDate(req.params.dateId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports.deleteDepartureDate = deleteDepartureDate;

// Task 5 — admin picks a real catalog item by checkbox; its price is read
// straight off that catalog entry here (never admin-typed) so it can never
// drift from what the Product Catalog actually charges elsewhere. Flights
// (0064_fd_package_flights.sql, priced via 0065_flights_price.sql) follow the
// same rule now that they have a price column — still go through the same
// "does this id actually exist" check as everything else either way.
async function resolveAddonPriceAndName({ activityId, tourId, transferId, flightId, mealId, durationDays }) {
  if (activityId) {
    const row = await activitiesModel.findById(activityId);
    if (!row) return null;
    return { pricePerPax: Number(row.price_per_pax || 0), name: row.name };
  }
  if (tourId) {
    const row = await toursModel.findById(tourId);
    if (!row) return null;
    // Tours are priced per vehicle by group size (0089) — this snapshot is
    // just the per-person share for BASELINE_PAX travellers; bookings
    // re-price tour add-ons from the tour itself for the real headcount
    // (booking.service.js#createFdBooking).
    return { pricePerPax: tourPerPaxPrice(row, BASELINE_PAX), name: row.name };
  }
  if (transferId) {
    const row = await transfersModel.findById(transferId);
    if (!row) return null;
    return { pricePerPax: Number(row.price || 0), name: row.name };
  }
  if (mealId) {
    const row = await mealsModel.findById(mealId);
    if (!row) return null;
    // price_per_day × the package's Duration in days (0075) — repriced by
    // updateFdPackage if the Duration later changes.
    return {
      pricePerPax: Number(row.price_per_day || 0) * (durationDays || 0),
      name: row.meal_type ? row.meal_type[0].toUpperCase() + row.meal_type.slice(1) : row.name,
    };
  }
  const row = await flightsModel.findById(flightId);
  if (!row) return null;
  return { pricePerPax: Number(row.price || 0), name: row.name };
}

async function postAddon(req, res, next) {
  try {
    const { activityId, tourId, transferId, flightId, mealId } = req.body;
    let durationDays = null;
    if (mealId) {
      const fdPackage = await findFdPackageById(req.params.id);
      if (!fdPackage) return res.status(404).json({ error: 'not_found' });
      durationDays = parseDurationDays(fdPackage.duration);
    }
    const resolved = await resolveAddonPriceAndName({ activityId, tourId, transferId, flightId, mealId, durationDays });
    if (!resolved) {
      return res.status(400).json({ error: 'invalid_item', message: 'That catalog item no longer exists.' });
    }

    const addon = await addAddon(req.params.id, {
      activityId,
      tourId,
      transferId,
      flightId,
      mealId,
      pricePerPax: resolved.pricePerPax,
    });
    // Mirrors the get() addons mapping above — postAddon previously returned
    // the raw snake_case DB row, so a freshly-added addon showed a blank
    // price in the UI until the page was reloaded via get().
    res.status(201).json({
      addon: {
        id: addon.id,
        activityId: addon.activity_id,
        tourId: addon.tour_id,
        transferId: addon.transfer_id,
        flightId: addon.flight_id,
        mealId: addon.meal_id,
        name: resolved.name,
        pricePerPax: resolved.pricePerPax,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports.postAddon = postAddon;

async function deleteAddon(req, res, next) {
  try {
    await removeAddon(req.params.addonId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports.deleteAddon = deleteAddon;
