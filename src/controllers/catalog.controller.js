const {
  hotelsModel,
  toursModel,
  vehiclesModel,
  activitiesModel,
  transfersModel,
  experiencesModel,
  mealsModel,
  inclusionsModel,
  exclusionsModel,
  visaModel,
  flightsModel,
  omanOverviewsModel,
  dealsModel,
} = require("../models/catalog.model.js");

const { uploadBuffer, deleteAsset } = require("../services/cloudinary.service.js");

const MODELS = {
  hotels: hotelsModel,
  tours: toursModel,
  vehicles: vehiclesModel,
  activities: activitiesModel,
  transfers: transfersModel,
  experiences: experiencesModel,
  meals: mealsModel,
  inclusions: inclusionsModel,
  exclusions: exclusionsModel,
  // Plural key ('visas', not 'visa') purely so catalogHandlersFor's
  // singular response key still comes out right ("visa") — Visa itself is a
  // singleton row, the route/response shape otherwise matches every other
  // list-style catalog entity.
  visas: visaModel,
  flights: flightsModel,
  "oman-overviews": omanOverviewsModel,
  deals: dealsModel,
};

// Naive `entity.slice(0, -1)` mis-singularizes "activities" -> "activitie"
// (dropping a trailing 's' doesn't undo an "-ies" plural). Every other
// entity name here happens to be a plain "-s" plural, so this is the one
// case that needs a real exception rather than the generic rule — found via
// Task 21 regression testing: ActivityEditor.jsx's `{ activity }` and
// MiceCatalog.jsx's MiceActivityForm `{ activity }` destructure both
// silently got `undefined` because the response key was actually
// "activitie", breaking load-for-edit and post-create list updates.
function singularize(entity) {
  if (entity === "activities") return "activity";
  return entity.slice(0, -1);
}

// Catalog reads are open to agents too (GET routes need any login —
// catalog.routes.js), but agents only ever see what's published, and never
// internal supplier details. Staff (no agency) see everything, drafts
// included, for the admin editors.
const AGENT_HIDDEN_FIELDS = ['email']; // hotels.email — the hotel/supplier contact

function isStaffUser(req) {
  return Boolean(req.user) && !req.user.agency_id;
}

function forAgent(row) {
  if (!row || typeof row !== 'object') return row;
  const copy = { ...row };
  for (const field of AGENT_HIDDEN_FIELDS) delete copy[field];
  return copy;
}

function catalogHandlersFor(entity) {
  const model = MODELS[entity];

  return {
    // ?page=/?pageSize= (opt-in — see createCrudModel#list's own comment)
    // currently only exercised by the admin Hotels tab (ProductCatalog.jsx),
    // but available to every entity here since they all share this one
    // handler. Every other caller — the agent-facing catalog browse for all
    // ten entities, admin's own Tours/Activities/Transfers/etc. tabs — still
    // calls this with neither param and gets back the plain
    // `{ [entity]: rows }` shape unchanged.
    async list(req, res, next) {
      try {
        const {
          city,
          category,
          durationRange,
          type,
          vehicleClass,
          bestseller,
          priceMin,
          priceMax,
          search,
          mice,
          mealType,
          isLiquor,
          isFlightOnward,
          status,
          dateFrom,
          dateTo,
        } = req.query;
        const isMiceEnabled = mice === undefined ? undefined : mice === "true";
        const isFlightOnwardBool =
          isFlightOnward === undefined ? undefined : isFlightOnward === "true";

        const paginate =
          req.query.page !== undefined || req.query.pageSize !== undefined;
        const page = paginate
          ? Math.max(1, parseInt(req.query.page, 10) || 1)
          : undefined;
        const pageSize = paginate
          ? Math.max(1, Math.min(100, parseInt(req.query.pageSize, 10) || 10))
          : undefined;

        const result = await model.list({
          city,
          category,
          durationRange,
          type,
          vehicleClass,
          isBestseller:
            bestseller === undefined ? undefined : bestseller === "true",
          priceMin: priceMin === undefined ? undefined : Number(priceMin),
          priceMax: priceMax === undefined ? undefined : Number(priceMax),
          search,
          isMiceEnabled,
          mealType,
          isLiquor: isLiquor === undefined ? undefined : isLiquor === "true",
          isFlightOnward: isFlightOnwardBool,
          // Agents can't ask for drafts: the model applies this only to
          // tables that have a status column (hotels/tours/activities/transfers).
          status: isStaffUser(req) ? status : 'published',
          dateFrom,
          dateTo,
          page,
          pageSize,
        });

        if (paginate) {
          const { rows, total } = result;
          res.json({
            [entity]: isStaffUser(req) ? rows : rows.map(forAgent),
            pagination: {
              total,
              page,
              pageSize,
              totalPages: Math.max(1, Math.ceil(total / pageSize)),
            },
          });
        } else {
          res.json({ [entity]: isStaffUser(req) ? result : result.map(forAgent) });
        }
      } catch (err) {
        next(err);
      }
    },

    async get(req, res, next) {
      try {
        const row = await model.findById(req.params.id);
        if (!row) return res.status(404).json({ error: "not_found" });
        if (!isStaffUser(req)) {
          // A draft is invisible to agents, by id as well as in lists.
          if (row.status && row.status !== "published") return res.status(404).json({ error: "not_found" });
          return res.json({ [singularize(entity)]: forAgent(row) });
        }
        res.json({ [singularize(entity)]: row });
      } catch (err) {
        next(err);
      }
    },

    async create(req, res, next) {
      try {
        const row = await model.create(req.body);
        res.status(201).json({ [singularize(entity)]: row });
      } catch (err) {
        next(err);
      }
    },

    async update(req, res, next) {
      try {
        const row = await model.update(req.params.id, req.body);
        if (!row) return res.status(404).json({ error: "not_found" });
        res.json({ [singularize(entity)]: row });
      } catch (err) {
        next(err);
      }
    },

    async remove(req, res, next) {
      try {
        await model.remove(req.params.id);
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  };
}

module.exports.catalogHandlersFor = catalogHandlersFor;

function uploadImagesHandlerFor(entity) {
  const idField = `${singularize(entity)}Id`;

  return async function uploadImages(req, res, next) {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({
          error: "missing_files",
          message: "Upload at least one image",
        });
      }

      const folderId = req.body[idField] || "new";
      const uploaded = await Promise.all(
        req.files.map((file) =>
          uploadBuffer(file.buffer, {
            folderParts: [entity, folderId, "images"],
          })
        )
      );

      res.status(201).json({ images: uploaded.map((u) => u.secure_url) });
    } catch (err) {
      next(err);
    }
  };
}

module.exports.uploadImagesHandlerFor = uploadImagesHandlerFor;

async function uploadOmanOverviewPdf(req, res, next) {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: "missing_file", message: "Upload a PDF document" });
    }
    if (req.file.mimetype !== "application/pdf") {
      return res.status(400).json({
        error: "invalid_file_type",
        message: "Only PDF files are allowed",
      });
    }
    const uploaded = await uploadBuffer(req.file.buffer, {
      folderParts: ["oman-overviews", "pdfs"],
      resourceType: "raw",
    });
    res.status(201).json({ url: uploaded.secure_url });
  } catch (err) {
    next(err);
  }
}

module.exports.uploadOmanOverviewPdf = uploadOmanOverviewPdf;

async function uploadOmanOverviewCoverImage(req, res, next) {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: "missing_file", message: "Upload a cover image" });
    }
    if (!req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({
        error: "invalid_file_type",
        message: "Only image files are allowed",
      });
    }
    const uploaded = await uploadBuffer(req.file.buffer, {
      folderParts: ["oman-overviews", "cover-images"],
    });
    res.status(201).json({ url: uploaded.secure_url });
  } catch (err) {
    next(err);
  }
}

module.exports.uploadOmanOverviewCoverImage = uploadOmanOverviewCoverImage;

// Agent "Deals For You" banner is an 8:3 frame (recommended 1920×720) —
// anything below this looks blurry once stretched across a desktop screen.
// Mirrors DEAL_IMAGE in the admin portal's Deals.jsx, which checks the same
// limit before uploading; this is the server-side backstop.
const DEAL_IMAGE_MIN_WIDTH = 1600;
const DEAL_IMAGE_MIN_HEIGHT = 600;

async function uploadDealImage(req, res, next) {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: "missing_file", message: "Upload a photo" });
    }
    if (!req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({
        error: "invalid_file_type",
        message: "Only image files are allowed",
      });
    }
    const uploaded = await uploadBuffer(req.file.buffer, {
      folderParts: ["deals", "images"],
    });
    // Cloudinary reports the stored image's real pixel size, so there's no
    // need to decode the buffer here; an undersized upload is removed again
    // rather than left orphaned in the deals folder.
    if (uploaded.width < DEAL_IMAGE_MIN_WIDTH || uploaded.height < DEAL_IMAGE_MIN_HEIGHT) {
      await deleteAsset(uploaded.public_id).catch(() => {});
      return res.status(400).json({
        error: "image_too_small",
        message: `Photo is ${uploaded.width} × ${uploaded.height} px — use at least ${DEAL_IMAGE_MIN_WIDTH} × ${DEAL_IMAGE_MIN_HEIGHT} px (ideally 1920 × 720).`,
      });
    }
    res.status(201).json({ url: uploaded.secure_url });
  } catch (err) {
    next(err);
  }
}

module.exports.uploadDealImage = uploadDealImage;
