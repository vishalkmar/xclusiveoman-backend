const { pool } = require("../db/pool.js");

const { newId } = require("../utils/id.js");

/**
 * Hotels/tours/activities/transfers/experiences (doc §11.2) are structurally
 * similar flat tables, so CRUD is generated once per table from a fixed,
 * trusted column list rather than duplicated five times.
 */

// Several of these generic per-table column lists include JSON columns under
// MySQL (hotels' board_basis_options/images, tours'/activities'/transfers'
// images — see migrations 0005/0011/0029). mysql2 auto-parses JSON columns
// to JS values on read, but a write needs an explicit JSON.stringify or the
// driver may instead try to expand a raw JS array as an IN (?)-style param
// list. Rather than hardcoding which of this factory's column lists are
// JSON, any array/plain-object value handed to create()/update() is
// stringified here — every other value (string/number/boolean/null/Date)
// passes through unchanged.
function serializeValue(v) {
  if (
    Array.isArray(v) ||
    (v !== null && typeof v === "object" && !(v instanceof Date))
  ) {
    return JSON.stringify(v);
  }
  return v;
}

function createCrudModel(table, columns) {
  return {
    // `filters.page`/`filters.pageSize` are opt-in (Product Catalog's Hotels
    // table, following FdPackagesTab's same pagination) — when neither is
    // passed this returns the plain rows array exactly as before (every
    // other caller: packageRequestsAdmin.controller.js's mealsModel.list()/
    // visaModel.list(), the agent-facing GET /<entity> catalog.routes.js
    // route for every entity that doesn't opt in). Only when either is
    // present does it run a COUNT(*) alongside a LIMIT/OFFSET query and
    // return `{ rows, total, page, pageSize }` instead — real SQL-level
    // pagination, not a fetch-everything-then-slice-in-JS shortcut, since
    // this is a real table query (unlike the JS-side search/pagination on
    // admin.controller.js#getAgencies etc., which already had to load
    // everything anyway to join in owner/RM data first).
    async list(filters = {}) {
      const clauses = [];
      const values = [];
      const hasPriceMin = Number.isFinite(filters.priceMin);
      const hasPriceMax = Number.isFinite(filters.priceMax);
      const priceBounds = (column) => {
        const conditions = [];
        const params = [];
        if (hasPriceMin) {
          conditions.push(`${column} >= ?`);
          params.push(filters.priceMin);
        }
        if (hasPriceMax) {
          conditions.push(`${column} <= ?`);
          params.push(filters.priceMax);
        }
        return { sql: conditions.join(" AND "), params };
      };

      if (filters.city) {
        clauses.push(`city = ?`);
        values.push(filters.city);
      }
      if (filters.category && columns.includes("category")) {
        clauses.push(`category = ?`);
        values.push(filters.category);
      }
      if (filters.durationRange && columns.includes("duration")) {
        const durationNumber =
          "CAST(REGEXP_SUBSTR(duration, '[0-9]+') AS UNSIGNED)";
        const durationRanges = {
          lt2: { sql: `${durationNumber} < ?`, params: [2] },
          "2-4": { sql: `${durationNumber} BETWEEN ? AND ?`, params: [2, 4] },
          "5-7": { sql: `${durationNumber} BETWEEN ? AND ?`, params: [5, 7] },
          "8-10": { sql: `${durationNumber} BETWEEN ? AND ?`, params: [8, 10] },
          gt10: { sql: `${durationNumber} > ?`, params: [10] },
        };
        const durationFilter = durationRanges[filters.durationRange];
        if (durationFilter) {
          clauses.push(`(${durationFilter.sql})`);
          values.push(...durationFilter.params);
        }
      }
      if (filters.type && columns.includes("type")) {
        clauses.push(`type = ?`);
        values.push(filters.type);
      }
      if (filters.vehicleClass && columns.includes("vehicle_class")) {
        clauses.push(`vehicle_class = ?`);
        values.push(filters.vehicleClass);
      }
      if (
        typeof filters.isBestseller === "boolean" &&
        columns.includes("is_bestseller")
      ) {
        clauses.push(`is_bestseller = ?`);
        values.push(filters.isBestseller);
      }
      if (hasPriceMin || hasPriceMax) {
        if (columns.includes("vehicle_prices")) {
          const jsonBounds = priceBounds("vehicle_price.price");
          const jsonMatch = `EXISTS (
            SELECT 1
            FROM JSON_TABLE(vehicle_prices, '$[*]' COLUMNS (price DECIMAL(12,2) PATH '$.price')) AS vehicle_price
            WHERE ${jsonBounds.sql}
          )`;
          const legacyColumns = [
            "price_sedan",
            "price_land_cruiser",
            "price_bus_20",
            "price_bus_35",
            "price_bus_50",
            "price",
          ].filter((column) => columns.includes(column));
          const legacyParams = [];
          const legacyMatches = legacyColumns.map((column) => {
            const bounds = priceBounds(column);
            legacyParams.push(...bounds.params);
            return `(${bounds.sql})`;
          });
          clauses.push(
            `((vehicle_prices IS NOT NULL AND ${jsonMatch}) OR (vehicle_prices IS NULL AND (${legacyMatches.join(
              " OR "
            )})))`
          );
          values.push(...jsonBounds.params, ...legacyParams);
        } else {
          const priceColumn = [
            "price_per_night",
            "price_per_pax",
            "price_per_day",
            "price",
          ].find((column) => columns.includes(column));
          if (priceColumn) {
            const bounds = priceBounds(priceColumn);
            clauses.push(`(${bounds.sql})`);
            values.push(...bounds.params);
          }
        }
      }
      if (filters.search) {
        clauses.push(`LOWER(name) LIKE LOWER(?)`);
        values.push(`%${filters.search}%`);
      }
      if (filters.dateFrom) {
        clauses.push(`created_at >= ?`);
        values.push(`${filters.dateFrom} 00:00:00`);
      }
      if (filters.dateTo) {
        clauses.push(`created_at < DATE_ADD(?, INTERVAL 1 DAY)`);
        values.push(filters.dateTo);
      }
      if (
        filters.isMiceEnabled !== undefined &&
        columns.includes("is_mice_enabled")
      ) {
        clauses.push(`is_mice_enabled = ?`);
        values.push(filters.isMiceEnabled);
      }
      if (filters.mealType && columns.includes("meal_type")) {
        clauses.push(`meal_type = ?`);
        values.push(filters.mealType);
      }
      if (
        typeof filters.isLiquor === "boolean" &&
        columns.includes("is_liquor")
      ) {
        clauses.push(`is_liquor = ?`);
        values.push(filters.isLiquor);
      }
      if (
        filters.isFlightOnward !== undefined &&
        columns.includes("is_flight_onward")
      ) {
        clauses.push(`is_flight_onward = ?`);
        values.push(filters.isFlightOnward);
      }
      // Opt-in — only passed by the itinerary-building hotel pickers
      // (FdPackageEditor.jsx, PackageBuilder.jsx, MiceBuilder.jsx), so a
      // draft hotel can't be added to a package before it's ready. The admin
      // management lists (ProductCatalog.jsx, MiceCatalog.jsx) omit this and
      // keep seeing every hotel regardless of status.
      if (filters.status && columns.includes("status")) {
        clauses.push(`status = ?`);
        values.push(filters.status);
      }

      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

      if (filters.page === undefined && filters.pageSize === undefined) {
        const { rows } = await pool.query(
          `SELECT * FROM ${table} ${where} ORDER BY created_at DESC`,
          values
        );
        return rows;
      }

      const page = Math.max(1, filters.page || 1);
      const pageSize = Math.max(1, Math.min(100, filters.pageSize || 10));
      const offset = (page - 1) * pageSize;

      const [{ rows: countRows }, { rows }] = await Promise.all([
        pool.query(`SELECT COUNT(*) AS count FROM ${table} ${where}`, values),
        pool.query(
          `SELECT * FROM ${table} ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          [...values, pageSize, offset]
        ),
      ]);

      return { rows, total: countRows[0].count, page, pageSize };
    },

    async findById(id) {
      const { rows } = await pool.query(`SELECT * FROM ${table} WHERE id = ?`, [
        id,
      ]);
      return rows[0] || null;
    },

    async create(fields) {
      const cols = columns.filter((c) => fields[c] !== undefined);
      const values = cols.map((c) => serializeValue(fields[c]));
      const id = newId();
      const placeholders = cols.map(() => "?").join(", ");
      await pool.query(
        `INSERT INTO ${table} (id, ${cols.join(
          ", "
        )}) VALUES (?, ${placeholders})`,
        [id, ...values]
      );
      const { rows } = await pool.query(`SELECT * FROM ${table} WHERE id = ?`, [
        id,
      ]);
      return rows[0];
    },

    async update(id, fields) {
      const cols = columns.filter((c) => fields[c] !== undefined);
      if (cols.length === 0) return this.findById(id);

      const setClauses = cols.map((c) => `${c} = ?`);
      const values = cols.map((c) => serializeValue(fields[c]));
      values.push(id);

      await pool.query(
        `UPDATE ${table} SET ${setClauses.join(
          ", "
        )}, updated_at = now() WHERE id = ?`,
        values
      );
      const { rows } = await pool.query(`SELECT * FROM ${table} WHERE id = ?`, [
        id,
      ]);
      return rows[0] || null;
    },

    async remove(id) {
      await pool.query(`DELETE FROM ${table} WHERE id = ?`, [id]);
    },
  };
}

const hotelsModel = createCrudModel("hotels", [
  "name",
  "city",
  "state",
  "address",
  "email",
  "category",
  "board_basis_options",
  "mice_ballroom_capacity",
  "mice_breakout_rooms",
  "images",
  "description",
  // price_per_night is no longer admin-entered directly (HotelEditor.jsx now
  // collects single_price/double_price/triple_price instead) but stays a
  // writable column here — catalog.routes.js's deriveHotelPricePerNight
  // middleware computes it from those three before this model ever sees the
  // request, so it's still populated for MICE quote costing, unchanged.
  "price_per_night",
  "single_price",
  "double_price",
  "triple_price",
  "is_mice_enabled",
  // 0070_hotels_status.sql — draft/published; only hotels/list's `status`
  // filter (below) reads it, gating the itinerary-building pickers.
  "status",
]);

module.exports.hotelsModel = hotelsModel;

const toursModel = createCrudModel("tours", [
  "name",
  "city",
  "description",
  "duration",
  "images",
  "category",
  "price",
  // 0089_tour_vehicle_pricing.sql — total price per vehicle, by group size.
  "price_sedan",
  "price_land_cruiser",
  "price_bus_20",
  "price_bus_35",
  "price_bus_50",
  "vehicle_prices",
  "group_suitability",
  "rating",
  "review_count",
  "suitable_age_min",
  "is_bestseller",
  "is_mice_enabled",
  // 0078_pickup_time.sql — mandatory on publish (see catalog.routes.js's
  // requireTourPublishFields).
  "pickup_time",
  // 0072_tours_activities_transfers_status.sql — draft/published.
  "status",
]);

module.exports.toursModel = toursModel;

// Vehicles master list (0122_vehicles.sql). A tour's vehicle_prices rows carry
// the vehicle's id plus a snapshot of its name and passenger range, so every
// price calculation keeps working off the row alone. Editing a vehicle here
// re-stamps those snapshots on the tours that use it, and a vehicle still
// priced on a tour can't be deleted.
const vehiclesModel = createCrudModel("vehicles", ["name", "min_pax", "max_pax", "price"]);

async function toursUsingVehicle(vehicleId) {
  const { rows } = await pool.query(
    "SELECT id, name, vehicle_prices FROM tours WHERE vehicle_prices IS NOT NULL"
  );
  return rows.filter(
    (t) =>
      Array.isArray(t.vehicle_prices) &&
      t.vehicle_prices.some((row) => row && row.vehicleId === vehicleId)
  );
}

vehiclesModel.toursUsing = toursUsingVehicle;

const baseVehicleUpdate = vehiclesModel.update.bind(vehiclesModel);
vehiclesModel.update = async function updateVehicle(id, fields) {
  const updated = await baseVehicleUpdate(id, fields);
  if (!updated) return updated;
  for (const tour of await toursUsingVehicle(id)) {
    const rows = tour.vehicle_prices.map((row) =>
      row && row.vehicleId === id
        ? { ...row, label: updated.name, minPax: updated.min_pax, maxPax: updated.max_pax }
        : row
    );
    await pool.query("UPDATE tours SET vehicle_prices = ? WHERE id = ?", [
      JSON.stringify(rows),
      tour.id,
    ]);
  }
  return updated;
};

vehiclesModel.remove = async function removeVehicle(id) {
  const tours = await toursUsingVehicle(id);
  if (tours.length > 0) {
    const names = tours.slice(0, 3).map((t) => t.name).join(", ");
    throw Object.assign(
      new Error(
        `This vehicle is priced on ${tours.length} tour${tours.length === 1 ? "" : "s"} (${names}${tours.length > 3 ? ", ..." : ""}). Remove it from those tours first.`
      ),
      { status: 409, publicCode: "vehicle_in_use" }
    );
  }
  await pool.query("DELETE FROM vehicles WHERE id = ?", [id]);
};

module.exports.vehiclesModel = vehiclesModel;

const activitiesModel = createCrudModel("activities", [
  "name",
  "city",
  "description",
  "duration",
  "images",
  "price_per_pax",
  "rating",
  "review_count",
  "suitable_age_min",
  "is_bestseller",
  "is_mice_enabled",
  // 0078_pickup_time.sql — mandatory on publish (see catalog.routes.js's
  // requireActivityPublishFields).
  "pickup_time",
  "status",
]);

module.exports.activitiesModel = activitiesModel;

const transfersModel = createCrudModel("transfers", [
  "name",
  "type",
  "vehicle_class",
  "city",
  "description",
  "price",
  "images",
  "is_mice_enabled",
  // 0078_pickup_time.sql — optional, unlike tours/activities above.
  "pickup_time",
  "status",
]);

module.exports.transfersModel = transfersModel;

const experiencesModel = createCrudModel("experiences", [
  "name",
  "description",
  "images",
  "suitable_group_size_min",
  "suitable_group_size_max",
]);

module.exports.experiencesModel = experiencesModel;

const mealsModel = createCrudModel("meals", [
  "name",
  "city",
  "description",
  "meal_type",
  "price_per_person",
  "price_per_day",
  "category",
  "is_liquor",
  "liquor_brand",
  "liquor_price_quarter",
  "liquor_price_half",
  "liquor_price_full",
  "liquor_price_per_ml",
  "liquor_ml",
]);

// Meals can be used as opt-in FD add-ons. The FK is intentionally restrictive,
// so remove the package add-on rows first. Booking add-ons are snapshots of the
// booked price; remove only that package-option link and keep the booking,
// traveller, payment, and financial records intact.
mealsModel.remove = async function removeMeal(id) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM booking_addons
       WHERE fd_addon_id IN (
         SELECT id FROM fd_addons WHERE meal_id = ?
       )`,
      [id],
    );
    await client.query("DELETE FROM fd_addons WHERE meal_id = ?", [id]);
    await client.query("DELETE FROM meals WHERE id = ?", [id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

module.exports.mealsModel = mealsModel;
const inclusionsModel = createCrudModel("inclusions", ["name"]);
module.exports.inclusionsModel = inclusionsModel;
const exclusionsModel = createCrudModel("exclusions", ["name"]);
module.exports.exclusionsModel = exclusionsModel;
const visaModel = createCrudModel("visa", ["price_per_person"]);
module.exports.visaModel = visaModel;

const flightsModel = createCrudModel("flights", [
  "name",
  "source",
  "destination",
  "departure_date",
  "departure_time",
  "is_flight_onward",
  "price",
]);

module.exports.flightsModel = flightsModel;

const omanOverviewsModel = createCrudModel("oman_overviews", [
  "name",
  "description",
  "pdf_url",
  "cover_image_url",
]);

module.exports.omanOverviewsModel = omanOverviewsModel;
const dealsModel = createCrudModel("deals", ["title", "duration", "image_url"]);
module.exports.dealsModel = dealsModel;
