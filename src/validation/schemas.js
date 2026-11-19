const { z } = require("zod");

const { isValidTimeZone, zonedDateTimeToUtc } = require("../utils/timezone.js");

// User-supplied links (uploaded file URLs, logos, gallery photos) end up in
// href/src attributes in both portals, so only https:// links — or a path on
// this site ("/images/x.png", never "//other.host") — are accepted. That
// shuts out javascript:/data:/vbscript: URLs (stored XSS when an admin
// clicks the link) and plain-http mixed content.
function safeUrl(message = "Enter a valid https:// link") {
  return z
    .string()
    .trim()
    .max(2048)
    .refine((v) => /^https:\/\/[^\s/]+[^\s]*$/i.test(v) || /^\/(?!\/)[^\s]*$/.test(v), { message });
}

const registerSchema = z.object({
  agencyName: z.string().min(2).max(200),
  // 'mice_company' dropped from self-service Sign Up — the Agency Type
  // picker (Register.jsx) now only ever offers Travel Agent, so this
  // endpoint no longer accepts anything else. The agency_type DB enum still
  // has 'mice_company' (existing agencies, and it's still assignable
  // elsewhere e.g. admin-created agencies) — only the public registration
  // API stopped accepting it.
  agencyType: z.literal("travel_agent"),
  // Business proof (0114_agency_license_document_type.sql): which kind of
  // document it is, the document itself — a mandatory upload (POST
  // /auth/register/license-document) whose returned URL is sent here, not
  // the file (the document was already uploaded to Cloudinary in a separate
  // prior request) — and the number printed on it.
  licenseDocumentType: z.enum(["iata", "gst", "company_registration"], {
    errorMap: () => ({ message: "Choose the document type" }),
  }),
  licenseDocumentUrl: safeUrl(),
  licenseNumber: z.string().trim().min(1, "Enter the document number").max(100),
  // Optional company logo, uploaded the same way (POST /auth/register/logo).
  logoUrl: safeUrl().optional(),
  country: z.string().min(2).max(100),
  ownerFullName: z.string().min(2).max(200),
  email: z.string().email(),
  phone: z.string().min(1, "Phone is required").max(30),
});

module.exports.registerSchema = registerSchema;

const requestOtpSchema = z.object({
  email: z.string().email(),
  // Which login the request came from (LoginModal.jsx's restrictTo). When
  // set, requestLoginOtp refuses to send a code for an email that doesn't
  // belong to that portal — so an agent never receives an OTP from /admin.
  portal: z.enum(["admin", "agent"]).optional(),
});

module.exports.requestOtpSchema = requestOtpSchema;

const verifyOtpSchema = z.object({
  email: z.string().email(),
  otp: z.string().regex(/^\d{6}$/, "Enter the 6-digit code"),
});

module.exports.verifyOtpSchema = verifyOtpSchema;

const totpCodeSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code"),
});

module.exports.totpCodeSchema = totpCodeSchema;

const verifyMfaSchema = z.object({
  mfaToken: z.string().min(1),
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code"),
  // Which second factor the code came from. Defaults to the authenticator
  // app so older clients keep working unchanged.
  method: z.enum(["totp", "email"]).optional(),
});

module.exports.verifyMfaSchema = verifyMfaSchema;

const mfaTokenSchema = z.object({
  mfaToken: z.string().min(1),
});

module.exports.mfaTokenSchema = mfaTokenSchema;

const emailMfaEnrollSchema = z.object({
  email: z.string().trim().email("Enter a valid email address"),
});

module.exports.emailMfaEnrollSchema = emailMfaEnrollSchema;

const adminLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
});

module.exports.adminLoginSchema = adminLoginSchema;

// ── Agent password sign-in / reset / change (controllers/passwordAuth) ──────

// A password the agent chooses: 8–64 characters with a letter and a number
// (services/password.service.js's passwordPolicyError is the same rule).
// 64 is under bcrypt's 72-byte limit, so nothing is silently truncated.
const newPasswordSchema = z
  .string()
  .min(8, "Use at least 8 characters, including a letter and a number.")
  .max(64, "Use 64 characters or fewer.")
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), {
    message: "Use at least one letter and one number.",
  });

// Existing passwords are only compared, never judged — a generous max just
// stops a megabyte string reaching bcrypt.
const currentPasswordSchema = z.string().min(1, "Password is required").max(200);

const agentLoginSchema = z.object({
  email: z.string().email().max(254),
  password: currentPasswordSchema,
});

module.exports.agentLoginSchema = agentLoginSchema;

const forgotPasswordSchema = z.object({
  email: z.string().email().max(254),
});

module.exports.forgotPasswordSchema = forgotPasswordSchema;

const resetPasswordSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/i, "This reset link is invalid."),
  password: newPasswordSchema,
});

module.exports.resetPasswordSchema = resetPasswordSchema;

// `currentPassword` is required only when the account already has a
// password; the endpoint decides (an account with none "creates" one).
const changePasswordSchema = z.object({
  currentPassword: currentPasswordSchema.optional(),
  newPassword: newPasswordSchema,
});

module.exports.changePasswordSchema = changePasswordSchema;

const patchAgencyMeSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  country: z.string().min(2).max(100).optional(),
  logoAssetUrl: safeUrl().optional(),
  currencyPreference: z.string().max(10).optional(),
});

module.exports.patchAgencyMeSchema = patchAgencyMeSchema;

const createSubUserSchema = z.object({
  fullName: z.string().min(2).max(200),
  email: z.string().email(),
  phone: z.string().max(30).optional(),
  permissions: z.record(z.boolean()).optional(),
});

module.exports.createSubUserSchema = createSubUserSchema;

const patchAdminAgencySchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "suspended"]).optional(),
  creditLimit: z.number().nonnegative().optional(),
  rmUserId: z.string().uuid().nullable().optional(),
});

module.exports.patchAdminAgencySchema = patchAdminAgencySchema;

const rmPermissionsSchema = z
  .object({
    approvedAgents: z.boolean().optional(),
    quotesPricing: z.boolean().optional(),
    supportTickets: z.boolean().optional(),
    bookingsDocs: z.boolean().optional(),
  })
  .partial();

module.exports.rmPermissionsSchema = rmPermissionsSchema;

const createRelationshipManagerSchema = z.object({
  fullName: z.string().min(2).max(200),
  email: z.string().email(),
  phone: z.string().max(30).optional(),
  whatsappNumber: z.string().max(30).optional(),
  permissions: rmPermissionsSchema.optional(),
});

module.exports.createRelationshipManagerSchema =
  createRelationshipManagerSchema;

const patchRelationshipManagerSchema = z.object({
  fullName: z.string().min(2).max(200).optional(),
  phone: z.string().max(30).optional(),
  whatsappNumber: z.string().max(30).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  permissions: rmPermissionsSchema.optional(),
});

module.exports.patchRelationshipManagerSchema = patchRelationshipManagerSchema;

const lmPermissionsSchema = z
  .object({
    catalog: z.boolean().optional(),
    quotesPricing: z.boolean().optional(),
    bookingsDocs: z.boolean().optional(),
    fdOperations: z.boolean().optional(),
  })
  .partial();

module.exports.lmPermissionsSchema = lmPermissionsSchema;

const createSalesManagerSchema = z.object({
  fullName: z.string().min(2).max(200),
  email: z.string().email(),
  phone: z.string().max(30).optional(),
  whatsappNumber: z.string().max(30).optional(),
  permissions: lmPermissionsSchema.optional(),
});

module.exports.createSalesManagerSchema = createSalesManagerSchema;

const patchSalesManagerSchema = z.object({
  fullName: z.string().min(2).max(200).optional(),
  phone: z.string().max(30).optional(),
  whatsappNumber: z.string().max(30).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  permissions: lmPermissionsSchema.optional(),
});

module.exports.patchSalesManagerSchema = patchSalesManagerSchema;

// --- Custom-role employees ---
// Employees & Roles' unified "Add" button (Employees.jsx) added a third
// option beyond the RM/LM schemas above — "Other", a free-text role typed
// by the admin (product decision: saved straight into users.role, no
// Access Features, no /team login routing yet — see
// customRoleEmployees.controller.js#create's own comment). This is exactly
// the kind of "any staff role, including super_admin" free-for-all the
// comment above says was already tried and removed once — RESERVED_ROLES
// keeps this from reopening that hole: every role name this app's own
// requireRole(...) gates already check for is off-limits here, so this can
// only ever mint a label with no built-in privileges, never impersonate an
// existing one by typing its name.
const RESERVED_ROLES = new Set([
  "agency_owner",
  "agency_staff",
  "ops_admin",
  "super_admin",
  "sales_marketing",
  "support",
  "finance",
  "relationship_manager",
  "sales_manager",
]);

const patchGenericEmployeeSchema = z.object({
  fullName: z.string().min(2).max(200).optional(),
  phone: z.string().max(30).optional(),
  whatsappNumber: z.string().max(30).optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

module.exports.patchGenericEmployeeSchema = patchGenericEmployeeSchema;

const createCustomRoleEmployeeSchema = z.object({
  fullName: z.string().min(2).max(200),
  email: z.string().email(),
  phone: z.string().max(30).optional(),
  whatsappNumber: z.string().max(30).optional(),
  role: z
    .string()
    .min(2)
    .max(60)
    .transform((s) => s.trim().toLowerCase().replace(/\s+/g, "_"))
    .refine(
      (r) => /^[a-z][a-z0-9_]*$/.test(r),
      "Role can only contain letters, numbers, and spaces"
    )
    .refine(
      (r) => !RESERVED_ROLES.has(r),
      "That role name is already used by a built-in role"
    ),
});

module.exports.createCustomRoleEmployeeSchema = createCustomRoleEmployeeSchema;

const hotelSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  city: z.string().min(2).max(100).optional(),
  state: z.string().min(2).max(100).optional(),
  address: z.string().min(1).max(500).optional(),
  email: z.string().email("Enter a valid email address").optional(),
  // Star category — dropdown limited to 3/4/5 stars, reuses the existing
  // `category` column rather than adding a duplicate field.
  category: z
    .number()
    .int()
    .refine((v) => [3, 4, 5].includes(v), {
      message: "Star category must be 3, 4, or 5",
    })
    .optional(),
  images: z.array(safeUrl()).max(50).optional(),
  description: z.string().optional(),
  // 0070_hotels_status.sql — set explicitly by HotelEditor.jsx/MiceCatalog.jsx's
  // MiceHotelForm on every full Save (status: 'published'), and by
  // HotelEditor.jsx's draft autosave (status: 'draft', only on the create
  // that first materializes the row — the debounced PATCHes after that never
  // resend status, so they can't flip an already-published hotel back to
  // draft mid-edit).
  status: z.enum(["draft", "published"]).optional(),
  // Occupancy-tiered pricing (0061_hotel_occupancy_pricing.sql) — admin
  // checks which of single/double/triple this hotel offers and prices each
  // one independently, replacing the old single flat pricePerNight field in
  // this form. All three optional at the zod level (not a `.refine()`
  // "at least one required" — that would return a ZodEffects, and
  // catalog.routes.js calls `schema.partial()` on this exact schema object
  // for PATCH, which only exists on a plain ZodObject); "at least one
  // occupancy price set" is instead enforced in the Hotel Editor UI itself
  // (HotelEditor.jsx) before it ever submits. pricePerNight itself is no
  // longer collected here — it's derived server-side (toColumns pipeline,
  // catalog.routes.js) so MICE costing, which still reads it, keeps working
  // unchanged.
  singlePrice: z
    .number()
    .positive("Price must be a positive number")
    .optional(),
  doublePrice: z
    .number()
    .positive("Price must be a positive number")
    .optional(),
  triplePrice: z
    .number()
    .positive("Price must be a positive number")
    .optional(),
  boardBasisOptions: z.array(z.string()).optional(),
  miceBallroomCapacity: z.number().int().nonnegative().optional(),
  miceBreakoutRooms: z.number().int().nonnegative().optional(),
  isMiceEnabled: z.boolean().optional(),
});

module.exports.hotelSchema = hotelSchema;

// name/city/description/duration/images/category/price all used to be
// required unconditionally, same problem hotelSchema had (see its own
// comment above) — 0072_tours_activities_transfers_status.sql moves
// "must be complete" to a publish-time gate instead (requireCatalogPublishFields,
// catalog.routes.js), each field still validating its own format when present.
// pickupTime — "HH:MM" (same <input type="time"> + regex convention as
// flightSchema.departureTime below) — is mandatory-on-publish for Tours and
// Activities but optional for Transfers (0078_pickup_time.sql); kept
// optional at this schema level for all three so drafts stay lenient, same
// as every other publish-only-required field here. The mandatory/optional
// split itself lives in catalog.routes.js's per-entity publish-fields gate.
const pickupTimeField = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Pickup time must be a valid HH:MM time")
  .optional();

const tourVehiclePriceSchema = z.object({
  key: z.string().max(100).optional(),
  // Which Vehicles-tab entry this row prices (0122). label/minPax/maxPax are
  // re-stamped from that vehicle server-side.
  vehicleId: z.string().uuid().optional(),
  label: z.string().trim().min(1).max(100),
  minPax: z.number().int().positive(),
  maxPax: z.number().int().positive(),
  price: z.number().positive("Vehicle price must be a positive number"),
});

const vehicleSchema = z.object({
  name: z.string().trim().min(1, "Vehicle name is required").max(100),
  minPax: z.number().int().positive("Minimum passengers must be at least 1"),
  maxPax: z.number().int().positive("Maximum passengers must be at least 1"),
  // Total for the vehicle filled to capacity (0123); a tour that prices this
  // vehicle starts from it.
  price: z.number().positive("Price must be a positive number").optional(),
});

module.exports.vehicleSchema = vehicleSchema;

const tourSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  city: z.string().min(2).max(100).optional(),
  description: z.string().optional(),
  duration: z.string().max(50).optional(),
  images: z.array(safeUrl()).max(50).optional(),
  category: z.string().max(100).optional(),
  platformFeeMode: z.enum(['global', 'none', 'custom']).optional(),
  platformFeePercentage: z.number().min(0).max(100).nullable().optional(),
  // Old single per-person price — no longer entered from the admin editor
  // (vehicle prices below replaced it) but still accepted so older clients
  // and tours created before 0089 keep working.
  price: z.number().positive("Price must be a positive number").optional(),
  // 0089_tour_vehicle_pricing.sql — TOTAL price for the whole group in each
  // vehicle (see src/utils/tourPricing.js for the pax ranges); retained for
  // older clients while vehiclePrices supports editable rows.
  priceSedan: z
    .number()
    .positive("Sedan price must be a positive number")
    .optional(),
  priceLandCruiser: z
    .number()
    .positive("Land Cruiser price must be a positive number")
    .optional(),
  priceBus20: z
    .number()
    .positive("20 Seater Bus price must be a positive number")
    .optional(),
  priceBus35: z
    .number()
    .positive("35 Seater Bus price must be a positive number")
    .optional(),
  priceBus50: z
    .number()
    .positive("50 Seater Bus price must be a positive number")
    .optional(),
  vehiclePrices: z.array(tourVehiclePriceSchema).optional(),
  groupSuitability: z.string().optional(),
  suitableAgeMin: z.number().int().nonnegative().optional(),
  pickupTime: pickupTimeField,
  isBestseller: z.boolean().optional(),
  isMiceEnabled: z.boolean().optional(),
  // 0072_tours_activities_transfers_status.sql — same status story as
  // hotelSchema's own `status` field above.
  status: z.enum(["draft", "published"]).optional(),
});

module.exports.tourSchema = tourSchema;

const activitySchema = z.object({
  name: z.string().min(2).max(200).optional(),
  city: z.string().min(2).max(100).optional(),
  description: z.string().optional(),
  duration: z.string().max(50).optional(),
  images: z.array(safeUrl()).max(50).optional(),
  pricePerPax: z.number().nonnegative().optional(),
  suitableAgeMin: z.number().int().nonnegative().optional(),
  pickupTime: pickupTimeField,
  isBestseller: z.boolean().optional(),
  isMiceEnabled: z.boolean().optional(),
  status: z.enum(["draft", "published"]).optional(),
});

module.exports.activitySchema = activitySchema;

const transferSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  type: z
    .enum(["airport", "intercity", "point_to_point", "group_coach"])
    .optional(),
  vehicleClass: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
  description: z.string().optional(),
  // Feeds the Quote Details "Landing Cost Breakdown" auto-calculation —
  // optional (unlike hotel/tour price) since existing transfers predate it.
  price: z.number().nonnegative().optional(),
  // Optional like activities' images (0029_transfer_images.sql) — unlike
  // hotel/tour images, not required, since existing transfers predate it.
  images: z.array(safeUrl()).max(50).optional(),
  // Unlike Tours/Activities, never required-on-publish for Transfers — see
  // pickupTimeField's own comment above.
  pickupTime: pickupTimeField,
  isMiceEnabled: z.boolean().optional(),
  status: z.enum(["draft", "published"]).optional(),
});

module.exports.transferSchema = transferSchema;

const experienceSchema = z.object({
  name: z.string().min(2).max(200),
  description: z.string().optional(),
  images: z.array(safeUrl()).max(50).optional(),
  suitableGroupSizeMin: z.number().int().nonnegative().optional(),
  suitableGroupSizeMax: z.number().int().nonnegative().optional(),
});

module.exports.experienceSchema = experienceSchema;

const mealSchema = z.object({
  name: z.string().min(2).max(200),
  city: z.string().max(100).optional(),
  description: z.string().optional(),
  mealType: z.enum(["lunch", "dinner"]),
  category: z.string().min(1).max(100),
  pricePerPerson: z.number().nonnegative().optional(),
  pricePerDay: z.number().nonnegative(),
  isLiquor: z.boolean().optional(),
  liquorBrand: z.string().max(255).nullable().optional(),
  liquorPriceQuarter: z.number().positive().nullable().optional(),
  liquorPriceHalf: z.number().positive().nullable().optional(),
  liquorPriceFull: z.number().positive().nullable().optional(),
  liquorPricePerMl: z.number().positive().nullable().optional(),
  liquorMl: z.number().int().positive().nullable().optional(),
});

module.exports.mealSchema = mealSchema;

const nameOnlyCatalogSchema = z.object({
  name: z.string().min(1).max(300),
});

module.exports.nameOnlyCatalogSchema = nameOnlyCatalogSchema;

const visaSchema = z.object({
  pricePerPerson: z.number().nonnegative(),
});

module.exports.visaSchema = visaSchema;

const siteTermsSchema = z.object({
  bodyHtml: z.string().min(1, "Terms & Conditions content is required"),
});

module.exports.siteTermsSchema = siteTermsSchema;

const flightSchema = z.object({
  name: z.string().min(1, "Flight name is required").max(200),
  source: z.string().min(1, "Source is required").max(200),
  destination: z.string().min(1, "Destination is required").max(200),
  departureDate: z.string().min(1, "Departure date is required"),
  // 0066_flights_departure_time.sql — "HH:MM" from <input type="time">,
  // same required-alongside-the-date posture as departureDate above.
  departureTime: z
    .string()
    .regex(
      /^([01]\d|2[0-3]):[0-5]\d$/,
      "Departure time must be a valid HH:MM time"
    ),
  isFlightOnward: z.boolean(),
  // 0065_flights_price.sql — optional, same as transfers.price, so this can
  // still be added without a price and priced in later.
  price: z.number().nonnegative("Price must be a positive number").optional(),
});

module.exports.flightSchema = flightSchema;

// Content Hub "Oman Overview" tab (see 0081_oman_overviews.sql) — a plain
// growable list, same posture as flightSchema above (every field required
// up front, no draft state). `description` needs to be a real written piece
// alongside the uploaded PDF, not a one-line blurb, but not an unbounded
// wall of text either — this strips HTML tags/entities then counts words,
// mirrored client-side (admin/lib/omanOverviewForm.js) for the same live
// word-count feedback rather than only finding out on submit.
const OMAN_OVERVIEW_MIN_WORDS = 10;
const OMAN_OVERVIEW_MAX_WORDS = 500;
function countWords(html) {
  const text = String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-zA-Z0-9#]+;/g, " ")
    .trim();
  return text ? text.split(/\s+/).length : 0;
}

const omanOverviewSchema = z.object({
  name: z.string().min(2, "Name is required").max(200),
  description: z
    .string()
    .max(50000)
    .refine(
      (v) => {
        const words = countWords(v);
        return (
          words >= OMAN_OVERVIEW_MIN_WORDS && words <= OMAN_OVERVIEW_MAX_WORDS
        );
      },
      {
        message: `Description must be between ${OMAN_OVERVIEW_MIN_WORDS} and ${OMAN_OVERVIEW_MAX_WORDS} words`,
      }
    ),
  // Uploaded separately first (POST /admin/oman-overviews/pdf), same
  // "upload returns a URL, the create/update call just carries it" flow
  // every catalog image upload already uses.
  pdfUrl: safeUrl("Upload a PDF document"),
  // cover_image_url (0083_oman_overview_cover_image.sql) — shown on the
  // agent-facing card in place of the plain PDF-icon placeholder. Same
  // "upload first, the create/update call just carries the URL" flow as
  // pdfUrl above, its own POST /admin/oman-overviews/cover-image endpoint.
  coverImageUrl: safeUrl("Upload a cover image"),
});

module.exports.omanOverviewSchema = omanOverviewSchema;

const dealSchema = z.object({
  title: z.string().min(1, "Title is required").max(200),
  // "4N | 5D" style duration badge overlaid on the photo — optional, a deal
  // photo can stand alone without one.
  duration: z.string().max(50).optional(),
  // Uploaded separately first (POST /admin/deals/image), same "upload
  // returns a URL, the create/update call just carries it" flow every
  // catalog image upload already uses.
  imageUrl: safeUrl("Upload a photo"),
});

module.exports.dealSchema = dealSchema;

// camelCase request bodies -> snake_case DB columns for the catalog CRUD models.
const CATALOG_KEY_MAP = {
  boardBasisOptions: "board_basis_options",
  miceBallroomCapacity: "mice_ballroom_capacity",
  miceBreakoutRooms: "mice_breakout_rooms",
  isMiceEnabled: "is_mice_enabled",
  groupSuitability: "group_suitability",
  suitableAgeMin: "suitable_age_min",
  isBestseller: "is_bestseller",
  pricePerPax: "price_per_pax",
  pricePerNight: "price_per_night",
  singlePrice: "single_price",
  doublePrice: "double_price",
  triplePrice: "triple_price",
  vehicleClass: "vehicle_class",
  suitableGroupSizeMin: "suitable_group_size_min",
  suitableGroupSizeMax: "suitable_group_size_max",
  mealType: "meal_type",
  pricePerPerson: "price_per_person",
  pricePerDay: "price_per_day",
  isLiquor: "is_liquor",
  liquorBrand: "liquor_brand",
  liquorPriceQuarter: "liquor_price_quarter",
  liquorPriceHalf: "liquor_price_half",
  liquorPriceFull: "liquor_price_full",
  liquorPricePerMl: "liquor_price_per_ml",
  liquorMl: "liquor_ml",
  liquorCategory: "liquor_category",
  departureDate: "departure_date",
  departureTime: "departure_time",
  pdfUrl: "pdf_url",
  coverImageUrl: "cover_image_url",
  imageUrl: "image_url",
  isFlightOnward: "is_flight_onward",
  pickupTime: "pickup_time",
  // Tour vehicle pricing (0089_tour_vehicle_pricing.sql).
  priceSedan: "price_sedan",
  priceLandCruiser: "price_land_cruiser",
  priceBus20: "price_bus_20",
  priceBus35: "price_bus_35",
  priceBus50: "price_bus_50",
  vehiclePrices: "vehicle_prices",
  minPax: "min_pax",
  maxPax: "max_pax",
  // FD packages (fdPackageSchema) — these were missing, which silently dropped
  // them from every create/update since FD_COLUMNS looks up the snake_case key.
  heroImageUrl: "hero_image_url",
  hotelId: "hotel_id",
  shortDescription: "short_description",
  isFeatured: "is_featured",
  ratePerPax: "rate_per_pax",
  visaEnabled: "visa_enabled",
  flightsEnabled: "flights_enabled",
  onwardFlightId: "onward_flight_id",
  returnFlightId: "return_flight_id",
  flightId: "flight_id",
  // Readymade packages (0120_fd_package_readymade.sql).
  allCities: "all_cities",
  departureCities: "departure_cities",
};

function toSnakeCaseColumns(body) {
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    out[CATALOG_KEY_MAP[key] || key] = value;
  }
  return out;
}

module.exports.toSnakeCaseColumns = toSnakeCaseColumns;

const fdPackageSchema = z.object({
  // Drafts are created immediately when the editor opens, so the admin can
  // fill the package name later. Publish-time validation requires a name.
  title: z.string().max(200),
  // Legacy field retained only for old records/clients; it is no longer
  // validated or used. Package classification is handled by category.
  theme: z.any().optional(),
  category: z.string().max(100).optional(),
  // Package kind (0120_fd_package_readymade.sql): a dated Fixed Departure
  // package, or a Readymade one (no dates/seats — offered from all cities or
  // a chosen list of departure cities).
  type: z.enum(["fd_package", "readymade"]).optional(),
  allCities: z.boolean().optional(),
  departureCities: z.array(z.string().trim().min(1).max(100)).max(200).optional(),
  duration: z.string().max(50).optional(),
  heroImageUrl: safeUrl().or(z.literal("")).nullable().optional(),
  images: z.array(safeUrl()).max(50).optional(),
  hotelId: z.string().uuid().nullable().optional(),
  shortDescription: z.string().optional(),
  suitableAgeMin: z.number().int().nonnegative().optional(),
  isFeatured: z.boolean().optional(),
  isBestseller: z.boolean().optional(),
  status: z.enum(["draft", "published", "closed"]).optional(),
  // Admin override of the itinerary-computed net rate — null clears the
  // override and falls back to the itinerary total again.
  ratePerPax: z.number().nonnegative().nullable().optional(),
  // Meals (lunch/dinner) are opt-in fd_addons rows now (0075) — added via
  // POST /admin/fd-packages/:id/addons with a `mealId` (see fdAddonSchema),
  // not fields on the package.
  // Task 5 — Visa is a simple "included or not" checkbox (no catalog
  // picker, there's only ever one Visa product — see 0062_fd_addons_transfer_visa.sql).
  // Priced at booking time from the visa catalog's price_per_person, same
  // deferred-until-real-pax-is-known posture as meals above.
  visaEnabled: z.boolean().optional(),
  // Flights section (0064_fd_package_flights.sql) — flightsEnabled true
  // means this package includes exactly one Onward + one Return flight
  // directly (onwardFlightId/returnFlightId); false means neither is set and
  // those same flights are instead offered as fd_addons checkbox add-ons
  // (see fdAddonSchema's flightId). Enforcing "not both at once" is the
  // editor's job (FdPackageEditor.jsx), not this schema's.
  flightsEnabled: z.boolean().optional(),
  onwardFlightId: z.string().uuid().nullable().optional(),
  returnFlightId: z.string().uuid().nullable().optional(),
  // Client-facing Inclusions/Exclusions — same shape/behavior as Custom FIT
  // quotes (packageRequestCostingSchema above): one point per line, edited
  // in FdPackageEditor.jsx via the catalog dropdown + editable list
  // (admin/components/InclusionExclusionList.jsx).
  inclusions: z.string().max(5000).optional(),
  exclusions: z.string().max(5000).optional(),
});

module.exports.fdPackageSchema = fdPackageSchema;

const fdDepartureDateSchema = z.object({
  date: z.string(), // ISO date
  seatsTotal: z.number().int().positive("Seats must be at least 1"), // was nonnegative() — a 0-seat departure date can never be booked, mirrors the FdPackageEditor's own client-side check
  location: z.string().min(1, "Location is required").max(100), // e.g. "Mumbai" — picked from GET /departure-locations, or freshly typed (see departureLocationSchema)
});

module.exports.fdDepartureDateSchema = fdDepartureDateSchema;

const departureLocationSchema = z.object({
  name: z.string().trim().min(1, "Location name is required").max(100),
});

module.exports.departureLocationSchema = departureLocationSchema;

const fdAddonSchema = z
  .object({
    activityId: z.string().uuid().optional(),
    tourId: z.string().uuid().optional(),
    transferId: z.string().uuid().optional(),
    // Flights section (0064_fd_package_flights.sql) — only ever posted for a
    // package that has flightsEnabled false (the editor hides this option
    // entirely otherwise); nothing enforces that here, same as the rest of
    // the "not both at once" split living in FdPackageEditor.jsx.
    flightId: z.string().uuid().optional(),
    // Meals as opt-in add-ons (0075) — the mealId is a meals-catalog row
    // (one per meal_type); price is resolved server-side from
    // price_per_day × the package's Duration (fdPackagesAdmin.controller.js).
    mealId: z.string().uuid().optional(),
  })
  .refine(
    (v) =>
      [v.activityId, v.tourId, v.transferId, v.flightId, v.mealId].filter(
        Boolean
      ).length === 1,
    {
      message:
        "Provide exactly one of activityId, tourId, transferId, flightId, or mealId",
    }
  );

module.exports.fdAddonSchema = fdAddonSchema;

// Reused by both the agent self-service booking schema (below) and the
// Admin Manual Booking flow (Task 13, manualBookingSchema further down) —
// same traveler shape either way: name required, everything else optional
// (passport/DOB are collected later via the separate Documents & Visa flow,
// Screen 23, not at booking time).
const bookingTravelerSchema = z.object({
  name: z.string().min(1),
  passportNo: z.string().optional(),
  dob: z.string().optional(),
  roomShareGroup: z.string().optional(),
});

// An agent booking needs at least this many adults (children don't count
// towards it). Checked here and again on the booking screen.
const MIN_BOOKING_ADULTS = 2;

const createBookingSchema = z.object({
  departureDateId: z.string().uuid().optional(),
  departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid departure date").optional(),
  pax: z.number().int().positive(),
  adults: z
    .number({ required_error: `At least ${MIN_BOOKING_ADULTS} adults are required` })
    .int()
    .min(MIN_BOOKING_ADULTS, `At least ${MIN_BOOKING_ADULTS} adults are required per booking`),
  children: z.number().int().nonnegative().optional().default(0),
  addonIds: z.array(z.string().uuid()).optional(),
  // Which itinerary days a selected Lunch/Dinner add-on applies to
  // (0080_booking_addon_days.sql) — keyed by the fd_addons id already present
  // in addonIds above, valued with the itinerary day numbers checked in
  // DepartureDetail.jsx's day-picker. Only meaningful for meal-type addons;
  // ignored server-side for every other type. Never trusted as-is —
  // booking.service.js#createFdBooking re-validates every day number against
  // the package's real itinerary before pricing or persisting anything.
  addonDayNumbers: z.record(z.array(z.number().int().positive())).optional(),
  travelers: z.array(bookingTravelerSchema).optional(),
}).refine((b) => b.pax === b.adults + b.children, {
  message: "Travellers must add up: adults + children should equal the total pax",
  path: ["pax"],
});

module.exports.createBookingSchema = createBookingSchema;

const manualBookingSchema = z.object({
  agencyId: z.string().uuid(),
  fdPackageId: z.string().uuid(),
  departureDateId: z.string().uuid(),
  pax: z.number().int().positive(),
  travelers: z.array(bookingTravelerSchema).optional(),
  addonIds: z.array(z.string().uuid()).optional(),
  agreedTotalPrice: z.number().positive(),
  // Offline deposit the admin is recording (money already collected by
  // phone/bank transfer before this screen exists) — never a real
  // Cashfree/NEFT payment record (Task 13 explicitly excludes both), just
  // the amount used to derive the booking's initial status.
  depositPaid: z.number().nonnegative().optional().default(0),
  // Purely descriptive of how that offline deposit was actually collected —
  // not wired to the Cashfree/NEFT/credit-terms pipelines (none of those
  // are admin-initiable here); captured in the booking's audit log entry.
  paymentMethod: z.enum(["cashfree", "neft", "credit_terms"]).optional(),
});

module.exports.manualBookingSchema = manualBookingSchema;

// --- Client Documents & Visa Processing (Task 14 — Screen 23, DOC-3) ---

// documentRefs identify which already-uploaded documents to attach — either
// a traveler's passport_scan/passport_photo/visa_copy (travelerId required)
// or the booking-level voucher (no travelerId). The controller re-verifies
// each ref actually has an uploaded file before attaching anything — this
// schema only shapes the request, it can't know what's actually on file.
const documentRefSchema = z
  .object({
    type: z.enum(["passport_scan", "passport_photo", "visa_copy", "voucher"]),
    travelerId: z.string().uuid().optional(),
  })
  .refine((v) => v.type === "voucher" || !!v.travelerId, {
    message: "travelerId is required for traveler-level documents",
    path: ["travelerId"],
  });

const emailToSupplierSchema = z.object({
  to: z.string().email("Enter a valid supplier email address"),
  message: z.string().max(2000).optional(),
  documentRefs: z
    .array(documentRefSchema)
    .min(1, "Select at least one document to send"),
});

module.exports.emailToSupplierSchema = emailToSupplierSchema;

const sendAgencyEmailSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(20000),
});
module.exports.sendAgencyEmailSchema = sendAgencyEmailSchema;

const createTicketSchema = z.object({
  subject: z.string().min(1, "Subject is required").max(200),
  description: z
    .string()
    .max(5000)
    .refine((v) => v.replace(/<[^>]*>/g, "").trim().length > 0, {
      message: "Description is required",
    }),
});

module.exports.createTicketSchema = createTicketSchema;

const ticketMessageSchema = z.object({
  message: z.string().min(1, "Message is required").max(5000),
});

module.exports.ticketMessageSchema = ticketMessageSchema;

// Chat Logs workflow edits — values mirror migration 0104's ENUMs.
const updateTicketWorkflowSchema = z
  .object({
    status: z.enum(["new", "open", "waiting_admin", "waiting_user", "resolved", "closed"]).optional(),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    category: z.enum(["booking", "payment", "cancellation", "account", "technical", "general", "other"]).optional(),
    assignedToUserId: z.string().max(36).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Nothing to update" });

module.exports.updateTicketWorkflowSchema = updateTicketWorkflowSchema;

const submitReviewSchema = z.object({
  rating: z
    .number()
    .int()
    .min(1, "Rating must be between 1 and 5")
    .max(5, "Rating must be between 1 and 5"),
  reviewText: z.string().max(2000).optional(),
});

module.exports.submitReviewSchema = submitReviewSchema;

const requestRefundSchema = z.object({
  reason: z.string().max(500).optional(),
});

module.exports.requestRefundSchema = requestRefundSchema;

const updateReviewStatusSchema = z.object({
  status: z.enum(["published", "hidden"]),
});

module.exports.updateReviewStatusSchema = updateReviewStatusSchema;

const adminCreateReviewSchema = z.object({
  fdPackageId: z.string().uuid("Choose a published package"),
  rating: z.number().int().min(1, "Choose a rating from 1 to 5").max(5, "Choose a rating from 1 to 5"),
  reviewText: z.string().trim().min(1, "Review text is required").max(5000, "Review text is too long"),
});

module.exports.adminCreateReviewSchema = adminCreateReviewSchema;

// --- Custom FIT Package Builder (doc §6.2 / §9.3 / FIT-1..FIT-7) ---

// Passport is required for adult travelers only — isChild (backed by
// package_request_travelers.is_child) is what the PackageBuilder's
// Traveller Details step uses to decide whether to even show the field.
const packageRequestTravelerSchema = z
  .object({
    name: z.string().min(1),
    passportNo: z.string().optional(),
    dob: z.string().optional(),
    roomShareGroup: z.string().optional(),
    isChild: z.boolean().optional().default(false),
  })
  .refine((v) => v.isChild || !!v.passportNo?.trim(), {
    message: "Passport number is required for adult travelers",
    path: ["passportNo"],
  });

const itineraryDaySchema = z.object({
  dayNumber: z.number().int().positive(),
  notes: z.string().max(2000).optional().default(""),
  items: z
    .array(
      z.object({
        type: z.enum(["hotel", "tour", "transfer", "activity"]),
        id: z.string().uuid(),
        // Per-item annotation (e.g. "9am pickup"), separate from the day's
        // own `notes` above.
        note: z.string().max(500).optional().default(""),
        // Hotel occupancy — two different shapes, only one used per builder
        // (both only meaningful for type: 'hotel'):
        // `adults` — FD Packages only (fd_itinerary_items.adults /
        // computeNetRatePerPax): a direct headcount typed per hotel-day.
        // `occupancy` — Custom FIT only (package_request_itinerary_items.
        // occupancy / roomsForOccupancy): Single/Double/Triple, since
        // headcount is already known from Trip Details (pax_adults).
        // MICE RFQ itineraries ignore both.
        adults: z.number().int().positive().optional(),
        occupancy: z.enum(["single", "double", "triple"]).optional(),
        // FD packages only (0124) - which of a tour's priced vehicles this
        // itinerary tour uses. Ignored for every other item type.
        vehicleKey: z.string().max(100).optional(),
      })
    )
    .optional()
    .default([]),
});

module.exports.itineraryDaySchema = itineraryDaySchema;
const itinerarySchema = z.array(itineraryDaySchema).optional().default([]);
module.exports.itinerarySchema = itinerarySchema;

// FD packages only (0105_fd_itinerary_leisure.sql) — a day can be marked a
// Leisure day: hotel only (optional), plus an optional remark for agents.
// Custom FIT / MICE keep using itinerarySchema above unchanged.
const fdItineraryDaySchema = itineraryDaySchema
  .extend({
    leisure: z.boolean().optional().default(false),
    leisureRemark: z.string().max(1000).optional().default(""),
  })
  .refine((day) => !day.leisure || day.items.every((it) => it.type === "hotel"), {
    message: "A leisure day can only have a hotel — remove its tours, transfers and activities",
    path: ["items"],
  });

const fdItinerarySchema = z.array(fdItineraryDaySchema).optional().default([]);
module.exports.fdItinerarySchema = fdItinerarySchema;

const createPackageRequestSchema = z
  .object({
    destination: z.string().min(2, "Destination is required").max(200),
    dateFrom: z.string().min(1, "Travel start date is required"),
    dateTo: z.string().min(1, "Travel end date is required"),
    paxAdults: z.number().int().positive("At least one adult is required"),
    paxChildren: z.number().int().nonnegative().optional().default(0),
    hotelIds: z.array(z.string().uuid()).min(1, "Select a hotel"),
    tourIds: z.array(z.string().uuid()).optional().default([]),
    transferIds: z.array(z.string().uuid()).optional().default([]),
    activityIds: z.array(z.string().uuid()).optional().default([]),
    travelers: z
      .array(packageRequestTravelerSchema)
      .min(1, "Add at least one traveller"),
    itinerary: itinerarySchema,
    // Optional lunch/dinner add-on — same shape as FD packages
    // (fdPackageSchema below): a headcount and a day count per meal type,
    // never a specific catalog entry (see computeMealsCost/resolveMealsSummary,
    // src/utils/meals.js). All three null clears that meal type.
    lunchMealId: z.string().uuid().nullable().optional(),
    lunchPeople: z.number().int().nonnegative().nullable().optional(),
    lunchDays: z.number().int().nonnegative().nullable().optional(),
    dinnerMealId: z.string().uuid().nullable().optional(),
    dinnerPeople: z.number().int().nonnegative().nullable().optional(),
    dinnerDays: z.number().int().nonnegative().nullable().optional(),
    // Optional Visa add-on — a checkbox plus an adults-only headcount, no
    // catalog entry to pick (there's only ever the one Visa row, resolved by
    // meal_type-style singleton — see visaModel/visa table). visaPeople is
    // independent of visaEnabled (mirrors lunchMealId/lunchPeople) so
    // toggling off doesn't need to also null this out for visaEnabled to
    // stay the single source of truth for "is Visa included".
    visaEnabled: z.boolean().optional().default(false),
    visaPeople: z.number().int().nonnegative().nullable().optional(),
  })
  // Plain string comparisons — dateFrom/dateTo are always "YYYY-MM-DD" (no
  // time/timezone component) coming from the FE's <input type="date">, so
  // lexicographic order already matches chronological order without the
  // Date-parsing timezone pitfalls that come with mixing UTC- and
  // local-parsed dates.
  .refine((v) => v.dateFrom <= v.dateTo, {
    message: "End date cannot be earlier than the start date.",
    path: ["dateTo"],
  })
  .refine((v) => v.dateFrom >= new Date().toISOString().slice(0, 10), {
    message: "Start date cannot be in the past.",
    path: ["dateFrom"],
  });

module.exports.createPackageRequestSchema = createPackageRequestSchema;

// Agent Quote lifecycle — Draft Quotes (item 1). Deliberately lenient: a
// half-built package (no destination yet, no hotel picked, a traveler row
// with just a name typed) must save without tripping createPackageRequestSchema's
// strict rules above — those still gate the final POST .../submit.
const draftPackageRequestTravelerSchema = z.object({
  name: z.string().max(200).optional().default(""),
  passportNo: z.string().optional(),
  dob: z.string().optional(),
  roomShareGroup: z.string().optional(),
  isChild: z.boolean().optional().default(false),
});

const draftPackageRequestSchema = z.object({
  destination: z.string().max(200).optional().default(""),
  dateFrom: z.string().optional().nullable(),
  dateTo: z.string().optional().nullable(),
  paxAdults: z.number().int().positive().optional().default(1),
  paxChildren: z.number().int().nonnegative().optional().default(0),
  hotelIds: z.array(z.string().uuid()).optional().default([]),
  tourIds: z.array(z.string().uuid()).optional().default([]),
  transferIds: z.array(z.string().uuid()).optional().default([]),
  activityIds: z.array(z.string().uuid()).optional().default([]),
  travelers: z.array(draftPackageRequestTravelerSchema).optional().default([]),
  itinerary: itinerarySchema,
  lunchMealId: z.string().uuid().nullable().optional(),
  lunchPeople: z.number().int().nonnegative().nullable().optional(),
  lunchDays: z.number().int().nonnegative().nullable().optional(),
  dinnerMealId: z.string().uuid().nullable().optional(),
  dinnerPeople: z.number().int().nonnegative().nullable().optional(),
  dinnerDays: z.number().int().nonnegative().nullable().optional(),
  visaEnabled: z.boolean().optional().default(false),
  visaPeople: z.number().int().nonnegative().nullable().optional(),
});

module.exports.draftPackageRequestSchema = draftPackageRequestSchema;

const respondPackageRequestSchema = z
  .object({
    action: z.enum(["accept", "revision", "decline"]),
    comments: z.string().max(2000).optional(),
  })
  .refine((v) => v.action !== "revision" || !!v.comments?.trim(), {
    message: "Add a comment describing what needs to change",
    path: ["comments"],
  });

module.exports.respondPackageRequestSchema = respondPackageRequestSchema;

const assignPackageRequestLeadManagerSchema = z.object({
  leadManagerUserId: z.string().uuid().nullable(),
});

module.exports.assignPackageRequestLeadManagerSchema =
  assignPackageRequestLeadManagerSchema;

const packageRequestCostingSchema = z.object({
  hotelCost: z.number().nonnegative().nullable(),
  tourCost: z.number().nonnegative().nullable(),
  transferCost: z.number().nonnegative().nullable(),
  extraCost: z.number().nonnegative().nullable(),
  // Visa add-on (see 0052_package_request_visa.sql) — auto total is
  // visaPeople × the catalog's one price_per_person row, same override
  // convention as every other *Cost field here.
  visaCost: z.number().nonnegative().nullable(),
  markupType: z.enum(["percentage", "fixed"]),
  markupValue: z.number().nonnegative(),
  internalNotes: z.string().max(5000).optional().default(""),
  // Inclusions/Exclusions (see 0048_package_request_inclusions_exclusions.sql)
  // — admin-authored free text set alongside costing, shown read-only on the
  // agent's own quote view once published (packageRequests.controller.js).
  // Unlike internalNotes, these are client-facing, not admin-only.
  inclusions: z.string().max(5000).optional().default(""),
  exclusions: z.string().max(5000).optional().default(""),
});

module.exports.packageRequestCostingSchema = packageRequestCostingSchema;

const createMiceRfqSchema = z
  .object({
    destination: z.string().min(2, "Destination is required").max(200),
    groupSize: z.number().int().positive("Group size is required"),
    eventDateFrom: z.string().min(1, "Event start date is required"),
    eventDateTo: z.string().min(1, "Event end date is required"),
    hallCapacityNeeded: z.number().int().positive().optional(),
    seatingStyle: z.string().max(100).optional(),
    avNeeds: z.string().max(1000).optional(),
    otherRequirements: z.string().max(2000).optional(),
    // MICE-2/MICE-7: "up to 3 hotels", server-enforced.
    hotelIds: z
      .array(z.string().uuid())
      .min(1, "Select at least one hotel")
      .max(3, "Select up to 3 hotels"),
    tourIds: z.array(z.string().uuid()).optional().default([]),
    transferIds: z.array(z.string().uuid()).optional().default([]),
    activityIds: z.array(z.string().uuid()).optional().default([]),
    // Day-wise Itinerary Planner — same shape/rules as package_requests'
    // itinerary (itineraryDaySchema above); `items` here just arrange
    // whichever of hotelIds/tourIds/transferIds/activityIds above were
    // already selected, resolved by the controller the same way.
    itinerary: itinerarySchema,
  })
  .refine((v) => new Date(v.eventDateFrom) <= new Date(v.eventDateTo), {
    message: "Event end date must be on or after the start date",
    path: ["eventDateTo"],
  });

module.exports.createMiceRfqSchema = createMiceRfqSchema;

const draftMiceRfqSchema = z.object({
  destination: z.string().max(200).optional().default(""),
  groupSize: z.number().int().positive().optional().nullable(),
  eventDateFrom: z.string().optional().nullable(),
  eventDateTo: z.string().optional().nullable(),
  hallCapacityNeeded: z.number().int().positive().optional().nullable(),
  seatingStyle: z.string().max(100).optional(),
  avNeeds: z.string().max(1000).optional(),
  otherRequirements: z.string().max(2000).optional(),
  hotelIds: z
    .array(z.string().uuid())
    .max(3, "Select up to 3 hotels")
    .optional()
    .default([]),
  tourIds: z.array(z.string().uuid()).optional().default([]),
  transferIds: z.array(z.string().uuid()).optional().default([]),
  activityIds: z.array(z.string().uuid()).optional().default([]),
  itinerary: itinerarySchema,
});

module.exports.draftMiceRfqSchema = draftMiceRfqSchema;

const respondMiceRfqSchema = z
  .object({
    action: z.enum(["accept", "revision", "decline"]),
    comments: z.string().max(2000).optional(),
  })
  .refine((v) => v.action !== "revision" || !!v.comments?.trim(), {
    message: "Add a comment describing what needs to change",
    path: ["comments"],
  });

module.exports.respondMiceRfqSchema = respondMiceRfqSchema;

const assignMiceRfqLeadManagerSchema = z.object({
  leadManagerUserId: z.string().uuid().nullable(),
});

module.exports.assignMiceRfqLeadManagerSchema = assignMiceRfqLeadManagerSchema;

const miceRfqCostingSchema = z.object({
  hotelCost: z.number().nonnegative().nullable(),
  toursActivitiesCost: z.number().nonnegative().nullable(),
  transferCost: z.number().nonnegative().nullable(),
  venueCost: z.number().nonnegative().nullable(),
  miscellaneousCost: z.number().nonnegative().nullable(),
  markupType: z.enum(["percentage", "fixed"]),
  markupValue: z.number().nonnegative(),
  internalNotes: z.string().max(5000).optional().default(""),
});

module.exports.miceRfqCostingSchema = miceRfqCostingSchema;

// --- Marketing Center (Task 5 — Send Test / Send Campaign) ---

const MARKETING_CHANNELS = ["email", "whatsapp"];
const MARKETING_PROVIDERS = [
  "mailchimp",
  "zoho",
  "built_in",
  "whatsapp_business_api",
];
const MARKETING_AUDIENCE_TYPES = ["all", "country", "inactive_30d"];
// Only 'built_in' has a real send path today (no Mailchimp/Zoho/WhatsApp
// Business API integration exists — see marketing.controller.js); the
// schema still accepts every enum value so an unconfigured provider gets a
// clear, specific "not configured" error from the controller rather than a
// generic validation failure that reads like a frontend bug.
const CHANNEL_PROVIDERS = {
  email: ["mailchimp", "zoho", "built_in"],
  whatsapp: ["whatsapp_business_api"],
};

// Shared by both schemas below: provider must actually belong to the
// selected channel (mirrors the frontend's Task 2 Channel section, which
// never lets these mismatch through its own UI — this is the server-side
// backstop), and Email needs a non-blank Subject the same way Task 4's
// Message card requires one before Send Campaign is enabled client-side.
function withMarketingCrossFieldRules(schema) {
  return schema
    .refine((v) => CHANNEL_PROVIDERS[v.channel]?.includes(v.provider), {
      message: "This provider is not available for the selected channel",
      path: ["provider"],
    })
    .refine((v) => v.channel !== "email" || !!v.subject?.trim(), {
      message: "Subject is required for email campaigns",
      path: ["subject"],
    });
}

const sendMarketingTestSchema = withMarketingCrossFieldRules(
  z.object({
    channel: z.enum(MARKETING_CHANNELS),
    provider: z.enum(MARKETING_PROVIDERS),
    subject: z.string().max(150).optional(),
    body: z.string().min(1, "Message body is required").max(20000),
    recipientEmail: z.string().email(),
  })
);

module.exports.sendMarketingTestSchema = sendMarketingTestSchema;

const createMarketingCampaignSchema = withMarketingCrossFieldRules(
  z
    .object({
      name: z.string().min(2, "Campaign name is required").max(200),
      channel: z.enum(MARKETING_CHANNELS),
      provider: z.enum(MARKETING_PROVIDERS),
      audienceType: z.enum(MARKETING_AUDIENCE_TYPES),
      audienceValue: z.string().max(100).optional(),
      subject: z.string().max(150).optional(),
      body: z.string().min(1, "Message body is required").max(20000),
      replyToAccountManager: z.boolean().optional().default(false),
    })
    .refine((v) => v.audienceType !== "country" || !!v.audienceValue?.trim(), {
      message: "Select a country",
      path: ["audienceValue"],
    })
);

module.exports.createMarketingCampaignSchema = createMarketingCampaignSchema;

const scheduleMarketingCampaignSchema = withMarketingCrossFieldRules(
  z
    .object({
      name: z.string().min(2, "Campaign name is required").max(200),
      channel: z.enum(MARKETING_CHANNELS),
      provider: z.enum(MARKETING_PROVIDERS),
      audienceType: z.enum(MARKETING_AUDIENCE_TYPES),
      audienceValue: z.string().max(100).optional(),
      subject: z.string().max(150).optional(),
      body: z.string().min(1, "Message body is required").max(20000),
      replyToAccountManager: z.boolean().optional().default(false),
      scheduledDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date"),
      scheduledTime: z.string().regex(/^\d{2}:\d{2}$/, "Enter a valid time"),
      scheduledTimezone: z.string().min(1, "Select a timezone"),
    })
    .refine((v) => v.audienceType !== "country" || !!v.audienceValue?.trim(), {
      message: "Select a country",
      path: ["audienceValue"],
    })
    .refine((v) => isValidTimeZone(v.scheduledTimezone), {
      message: "Unrecognised timezone",
      path: ["scheduledTimezone"],
    })
    .refine(
      (v) => {
        if (!isValidTimeZone(v.scheduledTimezone)) return true; // already reported by the refine above
        const at = zonedDateTimeToUtc(
          v.scheduledDate,
          v.scheduledTime,
          v.scheduledTimezone
        );
        return !!at && at.getTime() > Date.now();
      },
      {
        message: "Scheduled time must be in the future",
        path: ["scheduledDate"],
      }
    )
);

module.exports.scheduleMarketingCampaignSchema =
  scheduleMarketingCampaignSchema;

// --- FD Operations Tracker (Task 12 — Screen 19) ---

// Every stage the generic advance-stage endpoint can set. 'driver_sent' is
// deliberately excluded — it's only ever set automatically as a side effect
// of a real driver dispatch (marketing.controller.js-style single source of
// truth; see fdOperations.model.js#advanceStage's own comment), never via
// this endpoint directly.
const FD_OPERATIONS_STAGES = [
  "docs_collected",
  "supplier_coordination",
  "visa_processing",
  "trip_live",
  "completed",
];

const advanceFdOperationsStageSchema = z.object({
  stage: z.enum(FD_OPERATIONS_STAGES),
});

module.exports.advanceFdOperationsStageSchema = advanceFdOperationsStageSchema;

const fdOperationsSupplierLogSchema = z.object({
  supplierName: z.string().min(1, "Supplier name is required").max(200),
  item: z.string().min(1, "Item is required").max(300),
  status: z.enum(["pending", "confirmed"]).optional().default("pending"),
});

module.exports.fdOperationsSupplierLogSchema = fdOperationsSupplierLogSchema;

const fdOperationsDriverDetailsSchema = z.object({
  driverName: z.string().min(1, "Driver name is required").max(150),
  vehicle: z.string().min(1, "Vehicle is required").max(150),
  pickupDetails: z.string().min(1, "Pickup time/point is required").max(500),
});

module.exports.fdOperationsDriverDetailsSchema =
  fdOperationsDriverDetailsSchema;

const fdOperationsTourUpdateSchema = z.object({
  updateType: z.enum(["itinerary_change", "delay", "general_notice"]),
  message: z.string().min(1, "Message is required").max(2000),
});

module.exports.fdOperationsTourUpdateSchema = fdOperationsTourUpdateSchema;

// Admin Content & CMS Management (Task 21 — Item 34, CMS-1/CMS-2). Matches
// cms_pages (0058_cms.sql) exactly — no SEO/author/tag/ordering/scheduling
// fields, per the doc's own ERD not defining any. `slug` gets a light
// URL-safe format check (lowercase/digits/hyphens) — not itself documented,
// but "slug" has an established, unambiguous technical meaning and this
// merely enforces that shape rather than inventing a new field.
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const cmsPageSchema = z.object({
  title: z.string().min(1, "Title is required").max(300),
  section: z.string().min(1, "Section is required").max(150),
  slug: z
    .string()
    .min(1, "Slug is required")
    .max(200)
    .regex(SLUG_PATTERN, "Use lowercase letters, numbers, and hyphens only"),
  bodyHtml: z.string().max(200000).optional(),
  status: z.enum(["draft", "published"]).optional().default("draft"),
});

module.exports.cmsPageSchema = cmsPageSchema;

// "depositAmount" -> "Deposit amount"
function humanizeField(field) {
  const spaced = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Zod's default messages ("Expected number, received string", "Required")
// are accurate but read like internal type-checker output. Reword the common
// ones into plain language a non-dev admin user can act on — no mention of
// JS types like "string"/"undefined".
function humanizeIssueMessage(msg) {
  const typeMismatch = msg.match(/^Expected (\w+), received (\w+)$/);
  if (typeMismatch) {
    const [, expected, received] = typeMismatch;
    if (received === "undefined") return "is required";
    const article = /^[aeiou]/i.test(expected) ? "an" : "a";
    return `must be ${article} valid ${expected}`;
  }
  if (msg === "Required") return "is required";
  if (/^Invalid /.test(msg))
    return msg.replace(/^Invalid (\w+)$/, "is not a valid $1");
  return msg;
}

function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.flatten();
      const fieldMessages = Object.entries(details.fieldErrors).map(
        ([field, messages]) =>
          `${humanizeField(field)} ${humanizeIssueMessage(messages[0])}`
      );
      const message =
        [...details.formErrors, ...fieldMessages].join("; ") ||
        "Invalid request";

      return res.status(400).json({
        error: "validation_error",
        message,
        details,
      });
    }
    req.body = result.data;
    next();
  };
}

module.exports.validateBody = validateBody;

// ---- Visa System (0125_visa_system.sql) ----------------------------------

const visaTypeSchema = z.object({
  name: z.string().trim().min(1, "Visa type name is required").max(150),
  description: z.string().trim().max(2000).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

module.exports.visaTypeSchema = visaTypeSchema;
module.exports.visaTypeUpdateSchema = visaTypeSchema.partial();

// Visa package (0129_visa_packages.sql) — every field required. Day counts
// are a preset (10/30/90 …) or a custom whole number of days.
const visaDays = (label) =>
  z
    .number({ invalid_type_error: `${label} is required`, required_error: `${label} is required` })
    .int(`${label} must be a whole number of days`)
    .min(1, `${label} must be at least 1 day`)
    .max(3650, `${label} can't be more than 3650 days`);

const visaPackageSchema = z.object({
  durationDays: visaDays('Duration'),
  entryType: z.string().trim().min(1, 'Entry type is required').max(60),
  validForDays: visaDays('Valid for'),
  maxStayDays: visaDays('Maximum stay'),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  priceMode: z.enum(['global', 'custom']).optional(),
  priceMethod: z.enum(['global', 'custom']).optional(),
  customPrice: z.number().positive('Custom price must be more than 0').max(100000).nullable().optional(),
});

module.exports.visaPackageSchema = visaPackageSchema;

const visaCategorySchema = z.object({
  visaTypeId: z.string().uuid("Choose a visa type"),
  name: z.string().trim().min(1, "Category name is required").max(150),
  description: z.string().trim().max(2000).optional(),
  // No price here — per-person pricing is set only from Payments → Package
  // Controller → Visa (visaPriceSchema); a price sent here is stripped.
  processingTime: z.string().trim().max(100).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

module.exports.visaCategorySchema = visaCategorySchema;
module.exports.visaCategoryUpdateSchema = visaCategorySchema.partial();

// The single visa price: OMR per person, 3 decimals like every other price
// in the app; null clears it.
module.exports.visaPriceSchema = z.object({
  defaultPrice: z.number().positive("Price must be more than 0").max(100000).nullable().optional(),
  pricePerPerson: z.number().positive("Price must be more than 0").max(100000).nullable().optional(),
});

const VISA_MAX_MEMBERS = 20;

module.exports.visaApplicationCreateSchema = z.object({
  visaPackageId: z.string().uuid("Choose a visa"),
  members: z
    .number()
    .int()
    .min(1, "Add at least one member")
    .max(VISA_MAX_MEMBERS, `At most ${VISA_MAX_MEMBERS} members per application`),
});

module.exports.visaApplicantNamesSchema = z.object({
  applicants: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        fullName: z
          .string()
          .trim()
          .min(2, "Enter the full name as on the passport")
          .max(200)
          .regex(/^[\p{L}][\p{L} .'-]*$/u, "Names can only contain letters, spaces, . ' and -"),
      })
    )
    .min(1, "Add at least one member")
    .max(VISA_MAX_MEMBERS, `At most ${VISA_MAX_MEMBERS} members per application`),
});

const passportDate = z
  .string()
  .regex(/^(\d{4}-\d{2}-\d{2})?$/, "Use the format YYYY-MM-DD")
  .optional();
const passportText = (max = 120) => z.string().trim().max(max).optional();

module.exports.visaPassportDetailsSchema = z.object({
  details: z.object({
    documentType: passportText(5),
    issuingCountry: passportText(60),
    passportNumber: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{5,12}$/, "Passport number should be 5–12 letters/digits"),
    surname: z.string().trim().min(1, "Surname is required").max(120),
    givenNames: passportText(160),
    nationality: z.string().trim().min(1, "Nationality is required").max(60),
    sex: z.enum(["M", "F", "X"], { errorMap: () => ({ message: "Choose M, F or X" }) }),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth is required"),
    placeOfBirth: passportText(),
    placeOfIssue: passportText(),
    dateOfIssue: passportDate,
    dateOfExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date of expiry is required"),
    fatherName: passportText(),
    motherName: passportText(),
    spouseName: passportText(),
    address: passportText(400),
    fileNumber: passportText(40),
    oldPassportNumber: passportText(20),
  }),
  // Also overwrite the traveller's name with the passport's (when the agent
  // typed it differently on the names page).
  useNameFromPassport: z.boolean().optional(),
});
