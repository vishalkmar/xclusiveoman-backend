const {
  listDepartureLocations,
  createDepartureLocation,
  deleteDepartureLocation
} = require('../models/locations.model.js');

async function list(req, res, next) {
  try {
    const locations = await listDepartureLocations();
    res.json({ locations });
  } catch (err) {
    next(err);
  }
}

module.exports.list = list;

async function create(req, res, next) {
  try {
    const location = await createDepartureLocation(req.body.name);
    res.status(201).json({ location });
  } catch (err) {
    next(err);
  }
}

module.exports.create = create;

async function remove(req, res, next) {
  try {
    await deleteDepartureLocation(req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports.remove = remove;
