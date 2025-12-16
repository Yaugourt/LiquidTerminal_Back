import multer from 'multer';
import path from 'path';
import { Request, Response, NextFunction } from 'express';
import { logDeduplicator } from '../utils/logDeduplicator';
import { storageService } from '../core/storage.service';

/**
 * Middleware d'upload vers Cloudflare R2
 * Utilise memory storage de multer puis upload vers R2
 */

// Configuration memory storage (stockage temporaire en RAM)
const memoryStorage = multer.memoryStorage();

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

  // 3. Vérifier les types MIME spécifiques (plus strict)
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

  // 4. Vérifier le nom du fichier (éviter les caractères dangereux)
  const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
  if (safeName !== file.originalname) {
    logDeduplicator.warn('Filename sanitized', { 
      original: file.originalname, 
      sanitized: safeName 
    });
  }

  cb(null, true);
};

// Configuration de multer avec memory storage
const upload = multer({
  storage: memoryStorage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max
    files: 1, // 1 fichier max par défaut
    fieldSize: 1024 * 1024 // 1MB max pour les champs texte
  }
});

// Middleware d'upload pour les logos de projets
export const uploadProjectLogoR2 = upload.single('logo');

// Middleware d'upload pour les logos et banners de projets
export const uploadProjectFilesR2 = upload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'banner', maxCount: 1 }
]);

/**
 * Scanne un fichier pour détecter les contenus malveillants
 */
const scanUploadedFile = async (buffer: Buffer, originalName: string): Promise<boolean> => {
  try {
    // 1. Vérifier la signature du fichier (magic bytes)
    const signatures = {
      jpeg: [0xFF, 0xD8, 0xFF],
      png: [0x89, 0x50, 0x4E, 0x47],
      gif: [0x47, 0x49, 0x46],
      webp: [0x52, 0x49, 0x46, 0x46]
    };

    const ext = path.extname(originalName).toLowerCase();
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
      logDeduplicator.warn('Invalid file signature detected', { originalName, ext });
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
          originalName, 
          pattern: pattern.source 
        });
        return false;
      }
    }

    return true;
  } catch (error) {
    logDeduplicator.error('Error scanning uploaded file', { error, originalName });
    return false;
  }
};

/**
 * Middleware pour valider et uploader vers R2
 */
export const validateAndUploadToR2 = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
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

    // Valider tous les fichiers
    for (const file of files) {
      const isValid = await scanUploadedFile(file.buffer, file.originalname);
      
      if (!isValid) {
        logDeduplicator.warn('Malicious file detected', { 
          filename: file.originalname
        });
        
        return res.status(400).json({
          success: false,
          error: 'Fichier non sécurisé détecté',
          code: 'MALICIOUS_FILE'
        });
      }
    }

    // Upload vers R2
    const uploadedFiles: any = {};

    for (const file of files) {
      const folder = (file.fieldname === 'banner') ? 'projects/banners' : 'projects/logos';
      const { key, url } = await storageService.uploadFile(
        file.buffer,
        folder,
        file.originalname,
        file.mimetype
      );

      uploadedFiles[file.fieldname] = { key, url, originalName: file.originalname };
    }

    // Attacher les URLs à la requête pour utilisation dans les routes
    (req as any).uploadedFiles = uploadedFiles;

    logDeduplicator.info('Files uploaded to R2 successfully', { 
      fileCount: files.length,
      files: Object.keys(uploadedFiles)
    });

    next();
  } catch (error) {
    logDeduplicator.error('Error during R2 upload', { error });
    
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'upload vers le stockage cloud',
      code: 'R2_UPLOAD_ERROR'
    });
  }
};

/**
 * Middleware pour gérer les erreurs d'upload
 */
export const handleUploadErrorR2 = (error: Error, req: Request, res: Response, next: NextFunction) => {
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
        error: 'Trop de fichiers.',
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

/**
 * Helper pour extraire les URLs uploadées
 */
export const getUploadedUrls = (req: Request): { logo?: string; banner?: string } => {
  const uploadedFiles = (req as any).uploadedFiles || {};
  
  return {
    logo: uploadedFiles.logo?.url,
    banner: uploadedFiles.banner?.url
  };
};

/**
 * Helper pour extraire les clés R2 uploadées (pour suppression ultérieure)
 */
export const getUploadedKeys = (req: Request): { logo?: string; banner?: string } => {
  const uploadedFiles = (req as any).uploadedFiles || {};
  
  return {
    logo: uploadedFiles.logo?.key,
    banner: uploadedFiles.banner?.key
  };
};

