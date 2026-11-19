const { Router } = require('express');
const { getInrRate } = require('../controllers/fx.controller.js');
const router = Router();
router.get('/fx-rate', getInrRate);
module.exports = router;
