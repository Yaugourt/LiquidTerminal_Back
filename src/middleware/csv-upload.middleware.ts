import multer from 'multer';
import path from 'path';
import { Request, Response, NextFunction } from 'express';
import { logDeduplicator } from '../utils/logDeduplicator';
import fs from 'fs';
import crypto from 'crypto';

// Configuration du stockage pour les CSV
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Créer le dossier s'il n'existe pas
    const uploadDir = 'uploads/csv-resources/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Générer un nom unique avec timestamp + hash
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const hash = crypto.createHash('md5').update(file.originalname + uniqueSuffix).digest('hex').substring(0, 8);
    const ext = path.extname(file.originalname);
    cb(null, `resources-${uniqueSuffix}-${hash}${ext}`);
  }
});

// Filtre pour les fichiers CSV
const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  logDeduplicator.info('fileFilter called', { 
    originalname: file.originalname,
    mimetype: file.mimetype,
    size: file.size
  });

  // 1. Vérifier le type MIME
  if (file.mimetype !== 'text/csv' && !file.mimetype.includes('csv')) {
    logDeduplicator.error('Invalid MIME type', { mimetype: file.mimetype });
    return cb(new Error('Seuls les fichiers CSV sont autorisés.'));
  }

  // 2. Vérifier l'extension
  const allowedExtensions = ['.csv'];
  const ext = path.extname(file.originalname).toLowerCase();
  
  if (!allowedExtensions.includes(ext)) {
    logDeduplicator.error('Invalid extension', { extension: ext });
    return cb(new Error('Format de fichier non supporté. Utilisez CSV.'));
  }

  // 3. Vérifier la taille du fichier (10MB max pour les CSV)
  if (file.size > 10 * 1024 * 1024) {
    logDeduplicator.error('File too large', { size: file.size });
    return cb(new Error('Le fichier est trop volumineux. Taille maximum: 10MB'));
  }

  // 4. Vérifier le nom du fichier (éviter les caractères dangereux)
  const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
  if (safeName !== file.originalname) {
    logDeduplicator.warn('Filename sanitized', { 
      original: file.originalname, 
      sanitized: safeName 
    });
  }

  logDeduplicator.info('fileFilter passed, calling cb(null, true)');
  cb(null, true);
};

// Configuration de multer pour CSV
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
    files: 1, // 1 fichier max
    fieldSize: 1024 * 1024 // 1MB max pour les champs texte
  }
});

// Middleware d'upload pour les CSV de ressources
export const uploadCsvResources = upload.single('csv');

// Middleware pour gérer les erreurs d'upload CSV
export const handleCsvUploadError = (error: Error, req: Request, res: Response, next: NextFunction) => {
  if (error instanceof multer.MulterError) {
    logDeduplicator.error('CSV upload error:', { error: error.message, field: error.field });
    
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'Le fichier est trop volumineux. Taille maximum: 10MB',
        code: 'FILE_TOO_LARGE'
      });
    }
    
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        error: 'Trop de fichiers. Maximum: 1 fichier',
        code: 'TOO_MANY_FILES'
      });
    }
    
    return res.status(400).json({
      success: false,
      error: 'Erreur lors de l\'upload du fichier CSV',
      code: 'UPLOAD_ERROR'
    });
  }
  
  if (error.message.includes('Format de fichier') || 
      error.message.includes('Seuls les fichiers CSV') ||
      error.message.includes('trop volumineux')) {
    return res.status(400).json({
      success: false,
      error: error.message,
      code: 'INVALID_FILE_TYPE'
    });
  }
  
  logDeduplicator.error('Unexpected CSV upload error:', { error: error.message });
  res.status(500).json({
    success: false,
    error: 'Erreur interne lors de l\'upload CSV',
    code: 'INTERNAL_UPLOAD_ERROR'
  });
};

// Middleware de validation post-upload pour CSV
export const validateCsvFile = async (req: Request, res: Response, next: NextFunction) => {
  logDeduplicator.info('validateCsvFile middleware called');
  
  if (!req.file) {
    logDeduplicator.error('No file provided in validateCsvFile');
    return res.status(400).json({
      success: false,
      error: 'Aucun fichier CSV fourni',
      code: 'NO_FILE_PROVIDED'
    });
  }

  logDeduplicator.info('File exists in validateCsvFile', { 
    filename: req.file.filename,
    path: req.file.path
  });

  try {
    // Vérifier que le fichier existe
    if (!fs.existsSync(req.file.path)) {
      logDeduplicator.error('File not found on disk', { path: req.file.path });
      return res.status(400).json({
        success: false,
        error: 'Fichier CSV introuvable',
        code: 'FILE_NOT_FOUND'
      });
    }

    // Vérifier la taille du fichier
    const stats = fs.statSync(req.file.path);
    if (stats.size === 0) {
      logDeduplicator.error('File is empty');
      // Supprimer le fichier vide
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        success: false,
        error: 'Le fichier CSV est vide',
        code: 'EMPTY_FILE'
      });
    }

    logDeduplicator.info('CSV file validation passed', { 
      filename: req.file.filename,
      size: req.file.size,
      originalName: req.file.originalname
    });
    
    logDeduplicator.info('validateCsvFile calling next()');
    next();
  } catch (error) {
    logDeduplicator.error('Error during CSV file validation', { error });
    
    // En cas d'erreur, supprimer le fichier par précaution
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la validation du fichier CSV',
      code: 'VALIDATION_ERROR'
    });
  }
};

// Fonction utilitaire pour obtenir le chemin du fichier
export const getCsvFilePath = (filename: string): string => {
  return `uploads/csv-resources/${filename}`;
};

// Fonction pour nettoyer les fichiers CSV temporaires
export const cleanupCsvFile = (filePath: string): void => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logDeduplicator.info('CSV file cleaned up', { filePath });
    }
  } catch (error) {
    logDeduplicator.error('Error cleaning up CSV file', { error, filePath });
  }
}; 