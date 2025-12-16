import { prisma } from '../../core/prisma.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { xpService } from '../xp/xp.service';

export interface ReferralStats {
  referralCount: number;
  referredBy: string | null;
  referrals: Array<{
    id: number;
    name: string | null;
    createdAt: Date;
  }>;
}

export class ReferralService {
  private static instance: ReferralService;
  
  public static getInstance(): ReferralService {
    if (!ReferralService.instance) {
      ReferralService.instance = new ReferralService();
    }
    return ReferralService.instance;
  }

  // Valider si un name de parrain existe (insensible à la casse)
  async validateReferrerName(name: string): Promise<boolean> {
    try {
      const referrer = await prisma.user.findFirst({
        where: {
          name: {
            equals: name,
            mode: 'insensitive' // Recherche insensible à la casse
          }
        }
      });
      
      logDeduplicator.info('Referrer validation', { 
        name, 
        exists: !!referrer,
        foundName: referrer?.name // Le nom exact trouvé
      });
      
      return !!referrer;
    } catch (error) {
      logDeduplicator.error('Error validating referrer name', {
        error: error instanceof Error ? error.message : String(error),
        name
      });
      return false;
    }
  }
  
  // Associer un utilisateur à un parrain
  async assignReferrer(userId: number, referrerName: string): Promise<void> {
    try {
      logDeduplicator.info('Assigning referrer', { 
        userId, 
        referrerName 
      });

      // Recherche insensible à la casse pour trouver le parrain
      const referrer = await prisma.user.findFirst({
        where: {
          name: {
            equals: referrerName,
            mode: 'insensitive'
          }
        }
      });
      
      if (!referrer) {
        logDeduplicator.warn('Referrer not found', { referrerName });
        throw new Error('Referrer not found');
      }
      
      // Vérifier qu'on ne s'auto-réfère pas
      if (referrer.id === userId) {
        logDeduplicator.warn('Self referral attempt', { userId, referrerName });
        throw new Error('Cannot refer yourself');
      }
      
      // Transaction pour garantir la cohérence et éviter les race conditions
      await prisma.$transaction(async (tx: any) => {
        // Vérifier que l'utilisateur n'a pas déjà un parrain DANS la transaction
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { referredBy: true }
        });
        
        if (user?.referredBy) {
          logDeduplicator.warn('User already has referrer', { userId, existingReferrer: user.referredBy });
          throw new Error('User already has a referrer');
        }
        
        // Associer le nouveau user au parrain (utiliser le nom exact du parrain)
        await tx.user.update({
          where: { id: userId },
          data: { referredBy: referrer.name } // Utiliser le nom exact trouvé
        });
        
        // Incrémenter le compteur du parrain
        await tx.user.update({
          where: { id: referrer.id },
          data: { referralCount: { increment: 1 } }
        });
      });
      
      // Attribuer l'XP de referral au parrain
      try {
        await xpService.grantXp({
          userId: referrer.id,
          actionType: 'REFERRAL_SUCCESS',
          referenceId: `referral-${userId}`,
          description: `Referral bonus for inviting user ${userId}`,
        });
        logDeduplicator.info('Referral XP granted', { 
          referrerId: referrer.id, 
          referredUserId: userId 
        });
      } catch (xpError) {
        logDeduplicator.warn('Failed to grant referral XP', {
          referrerId: referrer.id,
          referredUserId: userId,
          error: xpError instanceof Error ? xpError.message : String(xpError),
        });
      }
      
      logDeduplicator.info('Referrer assigned successfully', { 
        userId, 
        referrerName,
        referrerId: referrer.id
      });
    } catch (error) {
      logDeduplicator.error('Error assigning referrer', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        referrerName
      });
      throw error;
    }
  }
  
  // Récupérer les statistiques de referral
  async getReferralStats(userId: number): Promise<ReferralStats> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          referrals: {
            select: {
              id: true,
              name: true,
              createdAt: true
            },
            orderBy: {
              createdAt: 'desc'
            }
          }
        }
      });
      
      if (!user) {
        throw new Error('User not found');
      }
      
      const stats: ReferralStats = {
        referralCount: user.referralCount || 0,
        referredBy: user.referredBy || null,
        referrals: user.referrals?.filter((ref: any) => ref.name !== null) || []
      };
      
      logDeduplicator.info('Referral stats retrieved', { 
        userId, 
        referralCount: stats.referralCount 
      });
      
      return stats;
    } catch (error) {
      logDeduplicator.error('Error getting referral stats', {
        error: error instanceof Error ? error.message : String(error),
        userId
      });
      throw error;
    }
  }
} 