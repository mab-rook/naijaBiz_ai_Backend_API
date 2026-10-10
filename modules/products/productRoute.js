const express = require('express');
const router = express.Router();
const {
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
} = require('./productController');
const { protect } = require('../auth/authMiddleware');
const { validateRequest, schemas } = require('../../common/middleware/requestValidation');

router.use(protect);

router.route('/')
  .get(validateRequest({ query: schemas.productListQuery }), getProducts)
  .post(validateRequest({ body: schemas.productCreate }), createProduct);

router.route('/:id')
  .get(validateRequest({ params: schemas.productId }), getProductById)
  .put(validateRequest({ params: schemas.productId, body: schemas.productUpdate }), updateProduct)
  .delete(validateRequest({ params: schemas.productId }), deleteProduct);

module.exports = router;
