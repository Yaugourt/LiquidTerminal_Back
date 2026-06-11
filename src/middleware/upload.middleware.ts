import multer from 'multer';
import path from 'path';
import { Request, Response, NextFunction } from 'express';
import { logDeduplicator } from '../utils/logDeduplicator';
import fs from 'fs';
import crypto from 'crypto';

// Configuration du stockage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/logos/');
  },
  filename: (req, file, cb) => {
    // Générer un nom unique avec timestamp + hash pour éviter les collisions
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const hash = crypto.createHash('md5').update(file.originalname + uniqueSuffix).digest('hex').substring(0, 8);
    const ext = path.extname(file.originalname);
    cb(null, `project-logo-${uniqueSuffix}-${hash}${ext}`);
  }
});

// Filtre pour les types de fichiers autorisés
const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  // 1. Vérifier le type MIME
  if (!file.mimetype.startsWith('image/')) {
    return cb(new Error('Seules les images sont autorisées.'));
  }

  // 2. Vérifier l'extension
  const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();
  
  if (!allowedExtensions.includes(ext)) {
    return cb(new Error('Format d\'image non supporté. Utilisez JPG, PNG, GIF ou WebP.'));
  }

  // 3. Vérifier la taille du fichier (double vérification)
  if (file.size > 5 * 1024 * 1024) {
    return cb(new Error('Le fichier est trop volumineux. Taille maximum: 5MB'));
  }

  // 4. Vérifier le nom du fichier (éviter les caractères dangereux)
  const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
  if (safeName !== file.originalname) {
    logDeduplicator.warn('Filename sanitized', { 
      original: file.originalname, 
      sanitized: safeName 
    });
  }

  // 5. Vérifier les types MIME spécifiques (plus strict)
  const allowedMimeTypes = [
    'image/jpeg',
    'image/jpg', 
    'image/png',
    'image/gif',
    'image/webp'
  ];
  
  if (!allowedMimeTypes.includes(file.mimetype)) {
    return cb(new Error('Type MIME non autorisé.'));
  }

  cb(null, true);
};

// Configuration de multer
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max
    files: 1, // 1 fichier max
    fieldSize: 1024 * 1024 // 1MB max pour les champs texte
  }
});

// Middleware d'upload pour les logos de projets
export const uploadProjectLogo = upload.single('logo');

// Middleware d'upload pour les logos et banners de projets
export const uploadProjectFiles = upload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'banner', maxCount: 1 }
]);

// Fonction pour scanner un fichier uploadé
const scanUploadedFile = async (filePath: string): Promise<boolean> => {
  try {
    // 1. Vérifier la signature du fichier (magic bytes)
    const buffer = fs.readFileSync(filePath);
    const signatures = {
      jpeg: [0xFF, 0xD8, 0xFF],
      png: [0x89, 0x50, 0x4E, 0x47],
      gif: [0x47, 0x49, 0x46],
      webp: [0x52, 0x49, 0x46, 0x46]
    };

    const ext = path.extname(filePath).toLowerCase();
    let isValid = false;

    switch (ext) {
      case '.jpg':
      case '.jpeg':
        isValid = signatures.jpeg.every((byte, index) => buffer[index] === byte);
        break;
      case '.png':
        isValid = signatures.png.every((byte, index) => buffer[index] === byte);
        break;
      case '.gif':
        isValid = signatures.gif.every((byte, index) => buffer[index] === byte);
        break;
      case '.webp':
        isValid = signatures.webp.every((byte, index) => buffer[index] === byte);
        break;
    }

    if (!isValid) {
      logDeduplicator.warn('Invalid file signature detected', { filePath, ext });
      return false;
    }

    // 2. Vérifier qu'il n'y a pas de code exécutable caché
    const suspiciousPatterns = [
      /<\?php/i,
      /<script/i,
      /javascript:/i,
      /vbscript:/i,
      /onload=/i,
      /onerror=/i
    ];

    const fileContent = buffer.toString('utf8', 0, Math.min(buffer.length, 10000));
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(fileContent)) {
        logDeduplicator.warn('Suspicious content detected in uploaded file', { 
          filePath, 
          pattern: pattern.source 
        });
        return false;
      }
    }

    return true;
  } catch (error) {
    logDeduplicator.error('Error scanning uploaded file', { error: error instanceof Error ? error.message : String(error), filePath });
    return false;
  }
};

// Middleware pour gérer les erreurs d'upload
export const handleUploadError = (error: Error, req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof multer.MulterError) {
    logDeduplicator.error('Upload error:', { error: error.message, field: error.field });
    
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'Le fichier est trop volumineux. Taille maximum: 5MB',
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
      error: 'Erreur lors de l\'upload du fichier',
      code: 'UPLOAD_ERROR'
    });
  }
  
  if (error.message.includes('Format d\'image') || 
      error.message.includes('Seules les images') ||
      error.message.includes('Type MIME') ||
      error.message.includes('trop volumineux')) {
    return res.status(400).json({
      success: false,
      error: error.message,
      code: 'INVALID_FILE_TYPE'
    });
  }
  
  logDeduplicator.error('Unexpected upload error:', { error: error.message });
  res.status(500).json({
    success: false,
    error: 'Erreur interne lors de l\'upload',
    code: 'INTERNAL_UPLOAD_ERROR'
  });
};

// Middleware de sécurité post-upload
export const validateUploadedFile = async (req: Request, res: Response, next: NextFunction) => {
  // Gérer les uploads simples (req.file) et multiples (req.files)
  const files: Express.Multer.File[] = [];
  
  if (req.file) {
    files.push(req.file);
  } else if (req.files) {
    if (Array.isArray(req.files)) {
      files.push(...req.files);
    } else {
      // req.files est un objet avec des clés (logo, banner, etc.)
      Object.values(req.files).forEach(fileArray => {
        if (Array.isArray(fileArray)) {
          files.push(...fileArray);
        }
      });
    }
  }

  if (files.length === 0) {
    return next();
  }

  try {
    // Valider tous les fichiers
    for (const file of files) {
      const isValid = await scanUploadedFile(file.path);
      
      if (!isValid) {
        // Supprimer le fichier dangereux
        fs.unlinkSync(file.path);
        
        logDeduplicator.warn('Malicious file detected and removed', { 
          filename: file.filename,
          originalName: file.originalname
        });
        
        return res.status(400).json({
          success: false,
          error: 'Fichier non sécurisé détecté',
          code: 'MALICIOUS_FILE'
        });
      }
    }

    logDeduplicator.info('File security scan passed', { 
      fileCount: files.length,
      files: files.map(f => ({ filename: f.filename, size: f.size }))
    });
    
    next();
  } catch (error) {
    logDeduplicator.error('Error during file security scan', { error: error instanceof Error ? error.message : String(error) });
    
    // En cas d'erreur, supprimer tous les fichiers par précaution
    files.forEach(file => {
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
    });
    
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la vérification de sécurité',
      code: 'SECURITY_SCAN_ERROR'
    });
  }
};

// Fonction utilitaire pour générer l'URL du fichier
export const getFileUrl = (filename: string): string => {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3002';
  return `${baseUrl}/uploads/logos/${filename}`;
};

// Fonction helper pour traiter les fichiers uploadés
export const processUploadedFiles = (req: Request): { logo?: string; banner?: string } => {
  const result: { logo?: string; banner?: string } = {};
  
  if (req.file) {
    // Upload simple (logo seulement)
    result.logo = getFileUrl(req.file.filename);
  } else if (req.files && !Array.isArray(req.files)) {
    // Upload multiple avec champs nommés
    if (req.files.logo && req.files.logo[0]) {
      result.logo = getFileUrl(req.files.logo[0].filename);
    }
    if (req.files.banner && req.files.banner[0]) {
      result.banner = getFileUrl(req.files.banner[0].filename);
    }
  }
  
  return result;
};

// Fonction pour nettoyer les anciens fichiers
export const cleanupOldFiles = async (maxAge: number = 24 * 60 * 60 * 1000) => {
  try {
    const uploadDir = 'uploads/logos/';
    if (!fs.existsSync(uploadDir)) return;

    const files = fs.readdirSync(uploadDir);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(uploadDir, file);
      const stats = fs.statSync(filePath);
      
      if (now - stats.mtime.getTime() > maxAge) {
        fs.unlinkSync(filePath);
        logDeduplicator.info('Cleaned up old file', { filename: file });
      }
    }
  } catch (error) {
    logDeduplicator.error('Error cleaning up old files', { error: error instanceof Error ? error.message : String(error) });
  }
};

// Fonction pour supprimer un fichier uploadé
export const deleteUploadedFile = (logoUrl: string): boolean => {
  try {
    // Extraire le nom du fichier depuis l'URL
    const urlParts = logoUrl.split('/');
    const filename = urlParts[urlParts.length - 1];
    
    // Vérifier que c'est bien un fichier de notre dossier uploads
    if (!filename || !filename.includes('project-logo-')) {
      logDeduplicator.warn('Attempted to delete file with invalid filename', { logoUrl, filename });
      return false;
    }
    
    const filePath = path.join('uploads/logos/', filename);
    
    // Vérifier si le fichier existe
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logDeduplicator.info('Deleted uploaded file', { filename, filePath });
      return true;
    } else {
      logDeduplicator.warn('File not found for deletion', { filename, filePath });
      return false;
    }
  } catch (error) {
    logDeduplicator.error('Error deleting uploaded file', { error: error instanceof Error ? error.message : String(error), logoUrl });
    return false;
  }
}; 