import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logDeduplicator } from '../utils/logDeduplicator';
import path from 'path';
import crypto from 'crypto';

/**
 * Service de gestion du stockage avec Cloudflare R2
 * Compatible S3 API
 */
export class StorageService {
  private static instance: StorageService;
  private s3Client?: S3Client;
  private bucketName: string;
  private publicUrl: string;

  private constructor() {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    this.bucketName = process.env.R2_BUCKET_NAME || 'liquidterminal';
    this.publicUrl = process.env.R2_PUBLIC_URL || '';

    if (!accountId || !accessKeyId || !secretAccessKey) {
      logDeduplicator.warn('R2 credentials not configured, storage service disabled');

      // En production, les credentials R2 sont obligatoires
      if (process.env.NODE_ENV === 'production') {
        throw new Error('R2 credentials are required in production');
      }

      // En dev / test, on désactive simplement le client R2
      this.s3Client = undefined;
      return;
    }

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey
      }
    });

    logDeduplicator.info('Storage service initialized', {
      bucket: this.bucketName,
      hasPublicUrl: !!this.publicUrl
    });
  }

  public static getInstance(): StorageService {
    if (!StorageService.instance) {
      StorageService.instance = new StorageService();
    }
    return StorageService.instance;
  }

  /**
   * Génère une clé unique pour un fichier
   * @param folder Dossier dans le bucket (ex: 'publicgoods/logos')
   * @param originalName Nom original du fichier
   * @returns Clé unique pour le stockage
   */
  private generateKey(folder: string, originalName: string): string {
    const timestamp = Date.now();
    const randomString = crypto.randomBytes(4).toString('hex');
    const ext = path.extname(originalName);
    const baseName = path.basename(originalName, ext).toLowerCase().replace(/[^a-z0-9]/g, '-');
    
    return `${folder}/${baseName}-${timestamp}-${randomString}${ext}`;
  }

  /**
   * Upload un fichier vers R2
   * @param file Buffer du fichier
   * @param folder Dossier de destination
   * @param originalName Nom original du fichier
   * @param mimetype Type MIME du fichier
   * @returns URL publique du fichier
   */
  async uploadFile(
    file: Buffer,
    folder: string,
    originalName: string,
    mimetype: string
  ): Promise<{ key: string; url: string }> {
    try {
      if (!this.s3Client) {
        throw new Error('Storage service is not configured (R2 disabled for this environment)');
      }
      const key = this.generateKey(folder, originalName);

      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: file,
        ContentType: mimetype,
        CacheControl: 'public, max-age=31536000, immutable' // 1 an de cache
      });

      await this.s3Client.send(command);

      const url = this.publicUrl 
        ? `${this.publicUrl}/${key}`
        : `https://${this.bucketName}.public.r2.dev/${key}`;

      logDeduplicator.info('File uploaded to R2', { 
        key, 
        size: file.length,
        mimetype 
      });

      return { key, url };
    } catch (error) {
      logDeduplicator.error('Error uploading file to R2', { 
        error,
        folder,
        originalName 
      });
      throw new Error('Failed to upload file to storage');
    }
  }

  /**
   * Upload plusieurs fichiers vers R2
   * @param files Array de fichiers à uploader
   * @param folder Dossier de destination
   * @returns Array d'URLs publiques
   */
  async uploadFiles(
    files: Array<{ buffer: Buffer; originalname: string; mimetype: string }>,
    folder: string
  ): Promise<Array<{ key: string; url: string; originalName: string }>> {
    try {
      const uploads = await Promise.all(
        files.map(async (file) => {
          const { key, url } = await this.uploadFile(
            file.buffer,
            folder,
            file.originalname,
            file.mimetype
          );
          return { key, url, originalName: file.originalname };
        })
      );

      return uploads;
    } catch (error) {
      logDeduplicator.error('Error uploading multiple files to R2', { error });
      throw error;
    }
  }

  /**
   * Supprime un fichier de R2
   * @param key Clé du fichier dans R2
   */
  async deleteFile(key: string): Promise<void> {
    try {
      if (!this.s3Client) {
        throw new Error('Storage service is not configured (R2 disabled for this environment)');
      }
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key
      });

      await this.s3Client.send(command);

      logDeduplicator.info('File deleted from R2', { key });
    } catch (error) {
      logDeduplicator.error('Error deleting file from R2', { error, key });
      throw new Error('Failed to delete file from storage');
    }
  }

  /**
   * Vérifie si un fichier existe dans R2
   * @param key Clé du fichier
   * @returns true si le fichier existe
   */
  async fileExists(key: string): Promise<boolean> {
    try {
      if (!this.s3Client) {
        return false;
      }
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key
      });

      await this.s3Client.send(command);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Génère une URL signée pour un accès temporaire (si besoin privé)
   * @param key Clé du fichier
   * @param expiresIn Durée de validité en secondes (défaut: 1h)
   * @returns URL signée
   */
  async getSignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    try {
      if (!this.s3Client) {
        throw new Error('Storage service is not configured (R2 disabled for this environment)');
      }
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key
      });

      const signedUrl = await getSignedUrl(this.s3Client, command, { expiresIn });
      return signedUrl;
    } catch (error) {
      logDeduplicator.error('Error generating signed URL', { error, key });
      throw new Error('Failed to generate signed URL');
    }
  }

  /**
   * Parse une URL R2 pour extraire la clé
   * @param url URL complète du fichier
   * @returns Clé du fichier ou null si invalide
   */
  parseR2Url(url: string): string | null {
    try {
      const urlObj = new URL(url);
      // Extraire le path sans le leading /
      return urlObj.pathname.substring(1);
    } catch {
      return null;
    }
  }
}

export const storageService = StorageService.getInstance();

