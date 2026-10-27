import { PrismaClient } from '@prisma/client';
import { prisma } from './prisma.service';
import { logDeduplicator } from '../utils/logDeduplicator';

/**
 * Service de gestion des transactions
 * Permet d'exécuter des opérations dans un contexte transactionnel
 */
export class TransactionService {
  private readonly prismaClient: PrismaClient = prisma;

  /**
   * Exécute une opération dans un contexte transactionnel
   * @param operation Fonction à exécuter dans le contexte de la transaction
   * @returns Résultat de l'opération
   */
  async execute<T>(
    operation: (tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>) => Promise<T>
  ): Promise<T> {
    try {
      logDeduplicator.info('Starting transaction', { timestamp: new Date().toISOString() });
      
      const result = await this.prismaClient.$transaction(operation, {
        timeout: 10000 // 10 secondes - optimisé pour éviter les transactions longues
      });
      
      logDeduplicator.info('Transaction completed successfully', { 
        timestamp: new Date().toISOString(),
        resultType: typeof result
      });
      return result;
    } catch (error) {
      logDeduplicator.error('Transaction failed', { 
        error,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        errorStack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }
}

// Instance singleton du service de transaction
export const transactionService = new TransactionService(); 