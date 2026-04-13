import multer from 'multer';
import path from 'path';
import { Request, Response, NextFunction } from 'express';
import { logDeduplicator } from '../utils/logDeduplicator';
import fs from 'fs';
import crypto from 'crypto';

// Configuration du stockage pour logo
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/publicgoods/logos/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const hash = crypto.createHash('md5').update(file.originalname + uniqueSuffix).digest('hex').substring(0, 8);
    const ext = path.extname(file.originalname);
    cb(null, `publicgood-logo-${uniqueSuffix}-${hash}${ext}`);
  }
});

// Configuration du stockage pour banner
const bannerStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/publicgoods/banners/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const hash = crypto.createHash('md5').update(file.originalname + uniqueSuffix).digest('hex').substring(0, 8);
    const ext = path.extname(file.originalname);
    cb(null, `publicgood-banner-${uniqueSuffix}-${hash}${ext}`);
  }
});

// Configuration du stockage pour screenshots
const screenshotStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/publicgoods/screenshots/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const hash = crypto.createHash('md5').update(file.originalname + uniqueSuffix).digest('hex').substring(0, 8);
    const ext = path.extname(file.originalname);
    cb(null, `publicgood-screenshot-${uniqueSuffix}-${hash}${ext}`);
  }
});

// Filtre pour les types de fichiers autorisés
const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  // 1. Vérifier le type MIME
  if (!file.mimetype.startsWith('image/')) {
    return cb(new Error('Only images are allowed'));
  }

  // 2. Vérifier l'extension
  const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();
  
  if (!allowedExtensions.includes(ext)) {
    return cb(new Error('Unsupported image format. Use JPG, PNG, GIF or WebP'));
  }

  // 3. Vérifier les types MIME spécifiques
  const allowedMimeTypes = [
    'image/jpeg',
    'image/jpg', 
    'image/png',
    'image/gif',
    'image/webp'
  ];
  
  if (!allowedMimeTypes.includes(file.mimetype)) {
    return cb(new Error('Invalid MIME type'));
  }

  // 4. Vérification taille par type de fichier
  const fieldName = file.fieldname;
  const maxSizes = {
    logo: 2 * 1024 * 1024,      // 2MB
    banner: 5 * 1024 * 1024,    // 5MB
    screenshots: 2 * 1024 * 1024 // 2MB par screenshot
  };

  if (fieldName in maxSizes && file.size > (maxSizes as any)[fieldName]) {
    return cb(new Error(`File ${fieldName} is too large. Max: ${(maxSizes as any)[fieldName] / (1024 * 1024)}MB`));
  }

  cb(null, true);
};

// Configuration de multer avec storage dynamique
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const destinations: Record<string, string> = {
        logo: 'uploads/publicgoods/logos/',
        banner: 'uploads/publicgoods/banners/',
        screenshots: 'uploads/publicgoods/screenshots/'
      };
      cb(null, destinations[file.fieldname] || 'uploads/publicgoods/');
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const hash = crypto.createHash('md5').update(file.originalname + uniqueSuffix).digest('hex').substring(0, 8);
      const ext = path.extname(file.originalname);
      const prefix = `publicgood-${file.fieldname}`;
      cb(null, `${prefix}-${uniqueSuffix}-${hash}${ext}`);
    }
  }),
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max (pour banner)
    files: 7 // 1 logo + 1 banner + 5 screenshots
  }
});

// Middleware d'upload pour les public goods
export const uploadPublicGoodFiles = upload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'banner', maxCount: 1 },
  { name: 'screenshots', maxCount: 5 }
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

// Middleware de sécurité post-upload
export const validateUploadedPublicGoodFiles = async (req: Request, res: Response, next: NextFunction) => {
  const files: Express.Multer.File[] = [];
  
  if (req.files && !Array.isArray(req.files)) {
    // req.files est un objet avec des clés (logo, banner, screenshots)
    Object.values(req.files).forEach(fileArray => {
      if (Array.isArray(fileArray)) {
        files.push(...fileArray);
      }
    });
  }

  if (files.length === 0) {
    return next();
  }

  try {
    // Valider tous les fichiers
    for (const file of files) {
      const isValid = await scanUploadedFile(file.path);
      
      if (!isValid) {
        // Supprimer tous les fichiers uploadés
        files.forEach(f => {
          if (fs.existsSync(f.path)) {
            fs.unlinkSync(f.path);
          }
        });
        
        logDeduplicator.warn('Malicious file detected and removed', { 
          filename: file.filename,
          originalName: file.originalname
        });
        
        return res.status(400).json({
          success: false,
          error: 'Malicious file detected',
          code: 'MALICIOUS_FILE'
        });
      }
    }

    logDeduplicator.info('Files security scan passed', { 
      fileCount: files.length,
      files: files.map(f => ({ filename: f.filename, size: f.size, fieldname: f.fieldname }))
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
      error: 'Error during security scan',
      code: 'SECURITY_SCAN_ERROR'
    });
  }
};

// Middleware pour gérer les erreurs d'upload
export const handlePublicGoodUploadError = (error: Error, req: Request, res: Response, next: NextFunction) => {
  if (error instanceof multer.MulterError) {
    logDeduplicator.error('Upload error:', { error: error.message, field: error.field });
    
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'File too large. Max: logo 2MB, banner 5MB, screenshots 2MB each',
        code: 'FILE_TOO_LARGE'
      });
    }
    
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        error: 'Too many files. Max: 1 logo, 1 banner, 5 screenshots',
        code: 'TOO_MANY_FILES'
      });
    }
    
    return res.status(400).json({
      success: false,
      error: 'Upload error',
      code: 'UPLOAD_ERROR'
    });
  }
  
  if (error.message.includes('Only images') || 
      error.message.includes('Unsupported') ||
      error.message.includes('Invalid MIME') ||
      error.message.includes('too large')) {
    return res.status(400).json({
      success: false,
      error: error.message,
      code: 'INVALID_FILE_TYPE'
    });
  }
  
  logDeduplicator.error('Unexpected upload error:', { error: error.message });
  res.status(500).json({
    success: false,
    error: 'Internal upload error',
    code: 'INTERNAL_UPLOAD_ERROR'
  });
};

// Fonction helper pour traiter les fichiers uploadés
export const processUploadedPublicGoodFiles = (req: Request): { 
  logo?: string; 
  banner?: string;
  screenshots?: string[];
} => {
  const result: { logo?: string; banner?: string; screenshots?: string[] } = {};
  const baseUrl = process.env.BASE_URL || 'http://localhost:3002';
  
  if (req.files && !Array.isArray(req.files)) {
    if (req.files.logo && req.files.logo[0]) {
      result.logo = `${baseUrl}/uploads/publicgoods/logos/${req.files.logo[0].filename}`;
    }
    if (req.files.banner && req.files.banner[0]) {
      result.banner = `${baseUrl}/uploads/publicgoods/banners/${req.files.banner[0].filename}`;
    }
    if (req.files.screenshots && req.files.screenshots.length > 0) {
      result.screenshots = req.files.screenshots.map(
        file => `${baseUrl}/uploads/publicgoods/screenshots/${file.filename}`
      );
    }
  }
  
  return result;
};

// Fonction pour supprimer un fichier uploadé
export const deleteUploadedPublicGoodFile = (fileUrl: string): boolean => {
  try {
    // Extraire le nom du fichier et le type depuis l'URL
    const urlParts = fileUrl.split('/');
    const filename = urlParts[urlParts.length - 1];
    const type = urlParts[urlParts.length - 2]; // logos, banners, ou screenshots
    
    // Vérifier que c'est bien un fichier de notre dossier uploads
    if (!filename || !filename.includes('publicgood-')) {
      logDeduplicator.warn('Attempted to delete file with invalid filename', { fileUrl, filename });
      return false;
    }
    
    const validTypes = ['logos', 'banners', 'screenshots'];
    if (!validTypes.includes(type)) {
      logDeduplicator.warn('Invalid file type for deletion', { fileUrl, type });
      return false;
    }
    
    const filePath = path.join('uploads/publicgoods/', type, filename);
    
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
    logDeduplicator.error('Error deleting uploaded file', { error: error instanceof Error ? error.message : String(error), fileUrl });
    return false;
  }
};

