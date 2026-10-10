const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const {
  processVoiceInput,
  processReceiptInput,
  processTextInput,
  confirmAction,
  rejectAction,
  askMyBusiness,
  getAIActions,
  getAIAction,
  getAIActionMedia,
  editAction,
} = require('./aiController');
const { protect } = require('../auth/authMiddleware');
const { validateRequest, schemas } = require('../../common/middleware/requestValidation');
const { fileFilter, getUploadType, validateUploadedFile, cleanupRejectedUpload } = require('../../common/middleware/uploadValidation');

// Multer storage setup
const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const kind = file.fieldname === 'image' ? 'image' : 'audio';
    const type = getUploadType(kind, file.mimetype);
    cb(null, `${crypto.randomUUID()}${type ? type.extension : '.upload'}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5, parts: 6 },
  fileFilter: (req, file, callback) => {
    const kind = file.fieldname === 'image' ? 'image' : 'audio';
    return fileFilter(kind)(req, file, callback);
  },
});

router.use(protect);

// AI Input
router.post(
  '/voice',
  upload.single('audio'),
  validateRequest({ body: schemas.aiVoice }),
  validateUploadedFile('audio'),
  processVoiceInput,
  cleanupRejectedUpload
);
router.post(
  '/receipt',
  upload.single('image'),
  validateRequest({ body: schemas.aiReceipt }),
  validateUploadedFile('image'),
  processReceiptInput,
  cleanupRejectedUpload
);
router.post('/text', validateRequest({ body: schemas.aiText }), processTextInput);

// Confirm-then-commit action layer (Confirm / Edit / Cancel on the confirmation card)
router.get('/actions/:id', validateRequest({ params: schemas.aiActionId }), getAIAction);
router.get('/actions/:id/media', validateRequest({ params: schemas.aiActionId }), getAIActionMedia);
router.patch('/actions/:id', validateRequest({ params: schemas.aiActionId, body: schemas.aiEdit }), editAction);
router.post('/actions/:id/confirm', validateRequest({ params: schemas.aiActionId, body: schemas.empty }), confirmAction);
router.post('/actions/:id/reject', validateRequest({ params: schemas.aiActionId, body: schemas.empty }), rejectAction);

// Conversational Business Brain
router.post('/ask', validateRequest({ body: schemas.aiAsk }), askMyBusiness);

// AI Action Audit Trail
router.get('/actions', validateRequest({ query: schemas.aiActionsQuery }), getAIActions);

module.exports = router;
