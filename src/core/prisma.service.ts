import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { logDeduplicator } from '../utils/logDeduplicator';

/**
 * Service Prisma singleton pour optimiser les connexions à la base de données
 * Garantit qu'une seule instance de PrismaClient est utilisée dans toute l'application
 */
class PrismaService {
  private static instance: PrismaClient;
  
  /**
   * Récupère l'instance unique de PrismaClient
   * Crée l'instance si elle n'existe pas encore
   */
  public static getInstance(): PrismaClient {
    if (!PrismaService.instance) {
      logDeduplicator.info('Initializing PrismaClient singleton instance');

      // Adapter officiel Prisma 7 pour Postgres (engine type "client")
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
      });
      const adapter = new PrismaPg(pool);

      PrismaService.instance = new PrismaClient({
        adapter,
        log: ['error', 'warn'],
      });
      
      // Gestion des événements de connexion
      // Note: Les événements $on ne sont pas correctement typés dans Prisma
      // Nous utilisons une approche alternative pour le logging
      PrismaService.instance.$connect()
        .then(() => {
          logDeduplicator.info('Successfully connected to database');
        })
        .catch((error: unknown) => {
          logDeduplicator.error('Failed to connect to database', { error });
        });
    }
    
    return PrismaService.instance;
  }
  
  /**
   * Ferme proprement la connexion à la base de données
   * À appeler lors de l'arrêt de l'application
   */
  public static async disconnect(): Promise<void> {
    if (PrismaService.instance) {
      logDeduplicator.info('Disconnecting PrismaClient');
      await PrismaService.instance.$disconnect();
    }
  }
}

// Export de l'instance unique
export const prisma = PrismaService.getInstance(); 