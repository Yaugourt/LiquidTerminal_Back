import multer from 'multer';
import path from 'path';
import { Request, Response, NextFunction } from 'express';
import { logDeduplicator } from '../utils/logDeduplicator';
import { storageService } from '../core/storage.service';

/**
 * Middleware d'upload pour Public Goods vers Cloudflare R2
 * Support: logo (1), banner (1), screenshots (jusqu'à 5)
 */

// Configuration memory storage
const memoryStorage = multer.memoryStorage();

// Filtre pour les types de fichiers autorisés
const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (!file.mimetype.startsWith('image/')) {
    return cb(new Error('Seules les images sont autorisées.'));
  }

  const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();
  
  if (!allowedExtensions.includes(ext)) {
    return cb(new Error('Format d\'image non supporté. Utilisez JPG, PNG, GIF ou WebP.'));
  }

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
  storage: memoryStorage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max par fichier
    files: 7, // Max: 1 logo + 1 banner + 5 screenshots
    fieldSize: 2 * 1024 * 1024
  }
});

// Middleware d'upload pour les fichiers Public Goods
export const uploadPublicGoodFilesR2 = upload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'banner', maxCount: 1 },
  { name: 'screenshots', maxCount: 5 }
]);

/**
 * Scanne un fichier pour détecter les contenus malveillants
 */
const scanUploadedFile = async (buffer: Buffer, originalName: string): Promise<boolean> => {
  try {
    // Vérifier la signature du fichier (magic bytes)
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

    // Vérifier qu'il n'y a pas de code exécutable caché
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
export const validateAndUploadPublicGoodToR2 = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    if (!req.files || typeof req.files !== 'object' || Array.isArray(req.files)) {
      return next();
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    const uploadedFiles: any = {};

    // Valider tous les fichiers
    for (const [fieldname, fileArray] of Object.entries(files)) {
      for (const file of fileArray) {
        const isValid = await scanUploadedFile(file.buffer, file.originalname);
        
        if (!isValid) {
          logDeduplicator.warn('Malicious file detected', { 
            fieldname,
            filename: file.originalname
          });
          
          return res.status(400).json({
            success: false,
            error: 'Fichier non sécurisé détecté',
            code: 'MALICIOUS_FILE'
          });
        }
      }
    }

    // Upload vers R2
    for (const [fieldname, fileArray] of Object.entries(files)) {
      if (fieldname === 'screenshots') {
        // Uploader tous les screenshots
        uploadedFiles.screenshots = [];
        for (const file of fileArray) {
          const { key, url } = await storageService.uploadFile(
            file.buffer,
            'publicgoods/screenshots',
            file.originalname,
            file.mimetype
          );
          uploadedFiles.screenshots.push({ key, url });
        }
      } else {
        // Logo ou banner (un seul fichier)
        const file = fileArray[0];
        const folder = fieldname === 'logo' 
          ? 'publicgoods/logos' 
          : 'publicgoods/banners';
        
        const { key, url } = await storageService.uploadFile(
          file.buffer,
          folder,
          file.originalname,
          file.mimetype
        );
        
        uploadedFiles[fieldname] = { key, url };
      }
    }

    // Attacher les URLs à la requête
    (req as any).uploadedFiles = uploadedFiles;

    logDeduplicator.info('Public Good files uploaded to R2 successfully', { 
      logo: !!uploadedFiles.logo,
      banner: !!uploadedFiles.banner,
      screenshotsCount: uploadedFiles.screenshots?.length || 0
    });

    next();
  } catch (error) {
    logDeduplicator.error('Error during Public Good R2 upload', { error });
    
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
export const handlePublicGoodUploadErrorR2 = (error: Error, req: Request, res: Response, next: NextFunction) => {
  if (error instanceof multer.MulterError) {
    logDeduplicator.error('Upload error:', { error: error.message, field: error.field });
    
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'Un fichier est trop volumineux. Taille maximum: 10MB',
        code: 'FILE_TOO_LARGE'
      });
    }
    
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        error: 'Trop de fichiers. Maximum: 1 logo, 1 banner, 5 screenshots',
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
export const getPublicGoodUploadedUrls = (req: Request): { 
  logo?: string; 
  banner?: string; 
  screenshots?: string[] 
} => {
  const uploadedFiles = (req as any).uploadedFiles || {};
  
  return {
    logo: uploadedFiles.logo?.url,
    banner: uploadedFiles.banner?.url,
    screenshots: uploadedFiles.screenshots?.map((s: any) => s.url)
  };
};

/**
 * Helper pour extraire les clés R2 uploadées (pour suppression ultérieure)
 */
export const getPublicGoodUploadedKeys = (req: Request): {
  logo?: string;
  banner?: string;
  screenshots?: string[]
} => {
  const uploadedFiles = (req as any).uploadedFiles || {};
  
  return {
    logo: uploadedFiles.logo?.key,
    banner: uploadedFiles.banner?.key,
    screenshots: uploadedFiles.screenshots?.map((s: any) => s.key)
  };
};

