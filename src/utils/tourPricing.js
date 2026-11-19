// Tour vehicle pricing (0089_tour_vehicle_pricing.sql). The price entered for a
// vehicle is the TOTAL for that vehicle filled to capacity, so a vehicle's
// per-person price is price / maxPax (a Sedan entered as 30 for 3 people is 10
// a head). Which vehicle applies depends on how many people are travelling, and
// a group pays that per-person price for each traveller. Mirrored on the
// frontend by src/shared/tourPricing.js — keep the two in step.
//
// Groups above 50 aren't handled yet — they fall into the 50 Seater Bus tier.
const TOUR_VEHICLE_TIERS = [
  { key: "sedan", column: "price_sedan", label: "Sedan", minPax: 1, maxPax: 3 },
  {
    key: "landCruiser",
    column: "price_land_cruiser",
    label: "Land Cruiser",
    minPax: 4,
    maxPax: 6,
  },
  {
    key: "bus20",
    column: "price_bus_20",
    label: "20 Seater Bus",
    minPax: 7,
    maxPax: 20,
  },
  {
    key: "bus35",
    column: "price_bus_35",
    label: "35 Seater Bus",
    minPax: 21,
    maxPax: 35,
  },
  {
    key: "bus50",
    column: "price_bus_50",
    label: "50 Seater Bus",
    minPax: 36,
    maxPax: 50,
  },
];

// Group size the advertised per-person package rate is quoted for, before
// the agent has picked a headcount — same "2 adults" baseline hotel pricing
// already uses (fdPackages.model.js#resolveHotelPerPaxRate).
const BASELINE_PAX = 2;

function hasVehiclePricing(tour) {
  if (!tour) return false;
  if (Array.isArray(tour.vehicle_prices)) return true;
  return vehiclePricesForTour(tour).some((tier) => Number(tier.price) > 0);
}

function vehiclePricesForTour(tour) {
  if (!tour) return [];
  if (Array.isArray(tour.vehicle_prices)) return tour.vehicle_prices;
  return TOUR_VEHICLE_TIERS.map((tier) => ({
    key: tier.key,
    label: tier.label,
    minPax: tier.minPax,
    maxPax: tier.maxPax,
    price: tour[tier.column],
  }));
}

// The vehicle for `pax` people. Ranges can overlap (a 4-seat Sedan and a 7-seat
// van both cover 3 people), so among the vehicles that cover the group the
// snuggest fit - the smallest capacity - is used. When no vehicle's range covers the group (a
// gap left by an unpriced vehicle, e.g. Sedan 1-3 and 20 Seater 7-20 with no
// Land Cruiser), the next vehicle up is used — the one with the closest
// minimum above the group size. null only when the group is bigger than every
// vehicle.
function tierForPax(pax, tiers = TOUR_VEHICLE_TIERS) {
  const n = Math.max(1, Number(pax) || 1);
  const covering = tiers.filter((tier) => n >= tier.minPax && n <= tier.maxPax);
  if (covering.length > 0) {
    return covering.reduce((best, tier) =>
      Number(tier.maxPax) < Number(best.maxPax) ? tier : best
    );
  }
  return (
    tiers
      .filter((tier) => tier.minPax > n)
      .sort((a, b) => a.minPax - b.minPax)[0] || null
  );
}

// Per-person price of a vehicle: its entered total shared across its capacity.
function vehiclePerPersonPrice(tier) {
  const maxPax = Number(tier?.maxPax) || 0;
  return maxPax > 0 ? Number(tier.price || 0) / maxPax : 0;
}

// Total price of the tour for a group of `pax`. Tours without vehicle prices
// fall back to their old single `price`, which FD packages always treated as
// per person (`legacy: 'perPax'`) and custom-package / MICE quotes treated as
// one flat price (`legacy: 'flat'`).
function tourGroupPrice(tour, pax, { legacy = "perPax" } = {}) {
  if (!tour) return 0;
  const n = Math.max(1, Number(pax) || 1);
  if (hasVehiclePricing(tour)) {
    const pricedRows = vehiclePricesForTour(tour).filter(
      (tier) => Number(tier.price) > 0
    );
    const tier = tierForPax(n, pricedRows);
    return tier ? vehiclePerPersonPrice(tier) * n : 0;
  }
  const price = Number(tour.price || 0);
  return legacy === "flat" ? price : price * n;
}

// The tour's priced vehicle row with this key (an FD itinerary tour picks one),
// or null when there isn't one - no key, a key that's no longer on the tour,
// or a tour without vehicle pricing.
function chosenVehicleRow(tour, vehicleKey) {
  if (!vehicleKey || !hasVehiclePricing(tour)) return null;
  return (
    vehiclePricesForTour(tour).find(
      (tier) => String(tier.key) === String(vehicleKey) && Number(tier.price) > 0
    ) || null
  );
}

// Per-person price of a tour placed in an FD itinerary. With a chosen vehicle
// it's that vehicle's price / max passengers, the same for any group size;
// otherwise it falls back to the group-size based price.
function tourItemPerPaxPrice(tour, vehicleKey, pax) {
  const chosen = chosenVehicleRow(tour, vehicleKey);
  return chosen ? vehiclePerPersonPrice(chosen) : tourPerPaxPrice(tour, pax);
}

function tourPerPaxPrice(tour, pax) {
  const n = Math.max(1, Number(pax) || 1);
  return tourGroupPrice(tour, n) / n;
}

// [{ key, label, minPax, maxPax, price }] for API responses, or null for a
// tour that still only has the old per-person price.
function toPublicVehiclePrices(tour) {
  if (!hasVehiclePricing(tour)) return null;
  return vehiclePricesForTour(tour)
    .filter((tier) => Number(tier.price) > 0)
    .map((tier, index) => ({
      key: tier.key || `${tier.minPax}-${tier.maxPax}-${index}`,
      label: tier.label,
      minPax: Number(tier.minPax),
      maxPax: Number(tier.maxPax),
      price: Number(tier.price),
      // price / maxPax — what each traveller in this vehicle pays.
      perPersonPrice: vehiclePerPersonPrice(tier),
    }));
}

module.exports = {
  TOUR_VEHICLE_TIERS,
  BASELINE_PAX,
  hasVehiclePricing,
  vehiclePerPersonPrice,
  chosenVehicleRow,
  tourItemPerPaxPrice,
  tierForPax,
  tourGroupPrice,
  tourPerPaxPrice,
  toPublicVehiclePrices,
};
