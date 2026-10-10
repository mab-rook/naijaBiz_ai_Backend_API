const AIAction = require('./aiActionModel');
const aiService = require('./aiService');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { confirmAIAction, rejectAIAction } = require('./actionExecutorService');
const { editAIAction } = require('./aiEditService');
const mediaStorage = require('./mediaStorageService');
const AppError = require('../../common/utils/AppError');

const LANGUAGES = ['en', 'yo', 'ha', 'ig'];

const resolveLanguage = (req) => {
  const requested = req.body && req.body.language;
  if (LANGUAGES.includes(requested)) return requested;
  return (req.user && req.user.preferredLanguage) || 'en';
};

/**
 * Store a proposed action (confirm-then-commit) and send it back for the confirmation card
 */
const createProposal = async ({ req, inputType, rawInput, transcript, parsed, media }) => {
  const actionId = new mongoose.Types.ObjectId();
  const mediaUrl = media ? `/api/ai/actions/${actionId}/media` : null;
  let proposedAction;
  try {
    proposedAction = await AIAction.create({
      _id: actionId,
      businessId: req.businessId,
      inputType,
      rawInput: mediaUrl || rawInput,
      media: media || undefined,
      language: parsed.language,
      transcript,
      parsedJSON: {
        intent: parsed.intent,
        entities: parsed.entities,
        confirmationMessage: parsed.confirmationMessage,
        suggestedAction: parsed.suggestedAction,
      },
      confidence: parsed.confidence,
      engine: parsed.engine,
      status: 'proposed',
    });
  } catch (error) {
    if (media) {
      try {
        await mediaStorage.deleteUpload(media);
      } catch (cleanupError) {
        console.error('[ai] Could not remove uploaded media after proposal creation failed:', cleanupError);
      }
    }
    throw error;
  }

  return {
    id: proposedAction._id,
    intent: parsed.intent,
    language: parsed.language,
    transcript,
    entities: proposedAction.parsedJSON.entities,
    confidence: proposedAction.confidence,
    lowConfidence: parsed.lowConfidence,
    engine: parsed.engine,
    confirmationMessage: parsed.confirmationMessage,
    suggestedAction: parsed.suggestedAction,
    status: proposedAction.status,
    mediaUrl,
  };
};

/**
 * Handle voice command: audio file (transcribed by the ML service) and/or a client-side transcript
 */
const processVoiceInput = async (req, res, next) => {
  try {
    let lang = resolveLanguage(req);
    let transcript = req.body.transcript;

    if (!transcript && req.file) {
      const asr = await aiService.transcribeAudio(req.file, lang);
      if (asr) {
        transcript = asr.transcript;
        lang = asr.language;
      }
    }

    if (!transcript) {
      if (req.file) {
        try {
          await fs.promises.unlink(req.file.path);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      return res.status(422).json({
        success: false,
        message: req.file
          ? 'Could not transcribe the voice note right now. Please try again or type the command.'
          : 'Send an "audio" file or a "transcript" field.',
      });
    }

    const parsed = await aiService.interpretCommand(req.businessId, transcript, lang);
    const media = req.file ? await mediaStorage.storeUpload(req.file, req.businessId) : null;
    const data = await createProposal({
      req,
      inputType: 'voice',
      rawInput: transcript,
      transcript,
      parsed,
      media,
    });

    res.status(200).json({
      success: true,
      message: 'Voice input parsed. Awaiting merchant confirmation.',
      actionId: data.id,
      data,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Handle receipt / invoice photo upload
 */
const processReceiptInput = async (req, res, next) => {
  try {
    const { receiptData, receiptImageUrl } = req.body;
    const lang = resolveLanguage(req);
    const imagePath = req.file ? req.file.path : receiptImageUrl || 'receipt_invoice_sample.jpg';

    const parsed = await aiService.parseReceipt(req.businessId, {
      file: req.file,
      language: lang,
      receiptData: receiptData || imagePath,
    });
    const media = req.file ? await mediaStorage.storeUpload(req.file, req.businessId) : null;
    const data = await createProposal({
      req,
      inputType: 'receipt',
      rawInput: 'Supplier invoice photo',
      transcript: parsed.transcript || 'Supplier invoice photo',
      parsed,
      media,
    });

    res.status(200).json({
      success: true,
      message: 'Receipt parsed successfully. Awaiting merchant confirmation.',
      actionId: data.id,
      data,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Handle text chat command
 */
const processTextInput = async (req, res, next) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ success: false, message: 'Text input is required' });
    }

    const parsed = await aiService.interpretCommand(req.businessId, text, resolveLanguage(req));
    const data = await createProposal({ req, inputType: 'text', rawInput: text, transcript: text, parsed });

    res.status(200).json({
      success: true,
      message: 'Text command parsed. Awaiting merchant confirmation.',
      actionId: data.id,
      data,
    });
  } catch (error) {
    next(error);
  }
};

/** Shape an action for the confirmation card */
const toCard = (action) => ({
  id: action._id,
  intent: action.parsedJSON.intent,
  language: action.language,
  transcript: action.transcript,
  entities: action.parsedJSON.entities,
  confidence: action.confidence,
  engine: action.engine,
  confirmationMessage: action.parsedJSON.confirmationMessage,
  status: action.status,
  edited: action.editHistory.length > 0,
  mediaUrl: action.media ? `/api/ai/actions/${action._id}/media` : null,
});

const getAIActionMedia = async (req, res, next) => {
  try {
    const action = await AIAction.findOne({ _id: req.params.id, businessId: req.businessId }).select('media');
    if (!action || !action.media || !action.media.provider) {
      throw new AppError(404, 'AI action media not found', 'MEDIA_NOT_FOUND');
    }
    if (action.media.deletedAt) {
      throw new AppError(410, 'This file was deleted after the media retention period.', 'MEDIA_EXPIRED');
    }

    res.set({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': action.media.mimeType,
      'Content-Disposition': 'inline',
    });

    if (action.media.provider === 'local') {
      const uploadDir = path.resolve(__dirname, '../../uploads');
      const filePath = path.resolve(uploadDir, action.media.fileName);
      if (path.dirname(filePath) !== uploadDir) {
        throw new AppError(500, 'Invalid local media path', 'MEDIA_PATH_INVALID');
      }
      try {
        await fs.promises.access(filePath, fs.constants.R_OK);
      } catch (error) {
        if (error.code === 'ENOENT') throw new AppError(404, 'AI action media not found', 'MEDIA_NOT_FOUND');
        throw error;
      }
      return res.sendFile(filePath);
    }

    let upstream;
    try {
      upstream = await fetch(mediaStorage.getCloudinaryDeliveryUrl(action.media));
    } catch (error) {
      if (error.name === 'AppError') throw error;
      throw new AppError(502, 'Private media could not be retrieved from storage', 'MEDIA_STORAGE_ERROR');
    }
    if (!upstream.ok || !upstream.body) {
      throw new AppError(502, 'Private media could not be retrieved from storage', 'MEDIA_STORAGE_ERROR');
    }
    if (upstream.headers.get('content-length')) {
      res.set('Content-Length', upstream.headers.get('content-length'));
    }
    const { Readable } = require('stream');
    const { pipeline } = require('stream/promises');
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    next(error);
  }
};

/**
 * Get one AI action (e.g. to reload the confirmation card)
 */
const getAIAction = async (req, res, next) => {
  try {
    const action = await AIAction.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!action) throw new AppError(404, 'AI proposed action not found', 'ACTION_NOT_FOUND');
    res.json({ success: true, data: { ...toCard(action), editHistory: action.editHistory } });
  } catch (error) {
    next(error);
  }
};

/**
 * "Edit" on the confirmation card: merchant corrects the proposal before confirming
 */
const editAction = async (req, res, next) => {
  try {
    const updated = await editAIAction(req.params.id, req.businessId, req.user._id, req.body);
    res.json({
      success: true,
      message: 'AI action updated. Awaiting merchant confirmation.',
      data: { ...toCard(updated), lowConfidence: false },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Confirm and commit proposed AI action
 */
const confirmAction = async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await confirmAIAction(id, req.businessId);

    res.status(200).json({
      success: true,
      message: 'AI action confirmed and written to database.',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Reject and cancel proposed AI action
 */
const rejectAction = async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await rejectAIAction(id, req.businessId);

    res.status(200).json({
      success: true,
      message: 'AI action rejected. No changes made to business records.',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * "Ask My Business" natural language query endpoint
 */
const askMyBusiness = async (req, res, next) => {
  try {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ success: false, message: 'Query is required' });
    }

    const response = await aiService.askMyBusiness(req.businessId, query, resolveLanguage(req));

    res.status(200).json({
      success: true,
      data: response,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get AI action audit trail
 */
const getAIActions = async (req, res, next) => {
  try {
    const { status, inputType } = req.query;
    const filter = { businessId: req.businessId };

    if (status) filter.status = status;
    if (inputType) filter.inputType = inputType;

    const actions = await AIAction.find(filter).sort({ createdAt: -1 }).limit(50);

    res.json({
      success: true,
      count: actions.length,
      data: actions,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
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
};
