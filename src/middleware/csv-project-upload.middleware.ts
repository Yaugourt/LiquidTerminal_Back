import multer from 'multer';
import path from 'path';
import { Request, Response, NextFunction } from 'express';
import { logDeduplicator } from '../utils/logDeduplicator';
import fs from 'fs';
import crypto from 'crypto';

// Configuration du stockage pour les CSV de projets
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/csv-projects/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const hash = crypto.createHash('md5').update(file.originalname + uniqueSuffix).digest('hex').substring(0, 8);
    const ext = path.extname(file.originalname);
    cb(null, `projects-${uniqueSuffix}-${hash}${ext}`);
  }
});

// Filtre pour les fichiers CSV
const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (file.mimetype !== 'text/csv' && !file.originalname.toLowerCase().endsWith('.csv')) {
    logDeduplicator.warn('Invalid file type for CSV upload', {
      originalname: file.originalname,
      mimetype: file.mimetype
    });
    return cb(new Error('Seuls les fichiers CSV sont autorisés'));
  }
  cb(null, true);
};

// Configuration de multer pour CSV de projets
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
    files: 1,
    fieldSize: 1024 * 1024
  }
});

// Middleware d'upload pour les CSV de projets
export const uploadCsvProjects = upload.single('csv');

// Middleware pour gérer les erreurs d'upload CSV
export const handleCsvProjectUploadError = (error: Error, req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof multer.MulterError) {
    logDeduplicator.error('Multer error during CSV project upload', { error: error.message });
    
    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        return res.status(400).json({
          success: false,
          error: 'Le fichier est trop volumineux (maximum 10MB)',
          code: 'FILE_TOO_LARGE'
        });
      case 'LIMIT_FILE_COUNT':
        return res.status(400).json({
          success: false,
          error: 'Trop de fichiers (maximum 1)',
          code: 'TOO_MANY_FILES'
        });
      case 'LIMIT_UNEXPECTED_FILE':
        return res.status(400).json({
          success: false,
          error: 'Champ de fichier inattendu',
          code: 'UNEXPECTED_FILE_FIELD'
        });
      default:
        return res.status(400).json({
          success: false,
          error: 'Erreur lors de l\'upload du fichier',
          code: 'UPLOAD_ERROR'
        });
    }
  }

  if (error.message === 'Seuls les fichiers CSV sont autorisés') {
    return res.status(400).json({
      success: false,
      error: error.message,
      code: 'INVALID_FILE_TYPE'
    });
  }

  logDeduplicator.error('Unexpected error during CSV project upload', { error: error.message });
  return res.status(500).json({
    success: false,
    error: 'Erreur interne du serveur',
    code: 'INTERNAL_SERVER_ERROR'
  });
};

// Middleware pour valider le fichier CSV
export const validateCsvProjectFile = (req: Request, res: Response, next: NextFunction) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: 'Aucun fichier fourni',
      code: 'NO_FILE_PROVIDED'
    });
  }

  const allowedExtensions = ['.csv'];
  const fileExtension = path.extname(req.file.originalname).toLowerCase();
  
  if (!allowedExtensions.includes(fileExtension)) {
    return res.status(400).json({
      success: false,
      error: 'Extension de fichier non autorisée. Seuls les fichiers .csv sont acceptés',
      code: 'INVALID_FILE_EXTENSION'
    });
  }

  logDeduplicator.info('CSV project file validation passed', {
    filename: req.file.filename,
    originalname: req.file.originalname,
    size: req.file.size
  });

  next();
};

// Utilitaire pour obtenir le chemin du fichier CSV
export const getCsvProjectFilePath = (filename: string): string => {
  return path.join('uploads/csv-projects/', filename);
};

// Utilitaire pour nettoyer le fichier CSV après traitement
export const cleanupCsvProjectFile = (filePath: string): void => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logDeduplicator.info('CSV project file cleaned up', { filePath });
    }
  } catch (error) {
    logDeduplicator.error('Error cleaning up CSV project file', { filePath, error });
  }
};
