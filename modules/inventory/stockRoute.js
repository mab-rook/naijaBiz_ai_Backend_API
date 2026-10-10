const express = require('express');
const router = express.Router();
const { getStock, addStockMovement, getStockMovements } = require('./stockController');
const { protect } = require('../auth/authMiddleware');
const { validateRequest, schemas } = require('../../common/middleware/requestValidation');

router.use(protect);

router.get('/', getStock);
router.post('/movements', validateRequest({ body: schemas.movementCreate }), addStockMovement);
router.get('/movements', validateRequest({ query: schemas.movementQuery }), getStockMovements);

module.exports = router;
