import { User, UserRole } from '@prisma/client';
import { userRepository } from '../../repositories/user.repository';
import { logDeduplicator } from '../../utils/logDeduplicator';

export class UserService {
  private static instance: UserService;

  private constructor() {}

  public static getInstance(): UserService {
    if (!UserService.instance) {
      UserService.instance = new UserService();
    }
    return UserService.instance;
  }

  /**
   * Masque les données sensibles d'un utilisateur pour les réponses API
   */
  private maskSensitiveData(user: User): Omit<User, 'email' | 'privyUserId'> & {
    email?: string;
    privyUserId?: string;
  } {
    return {
      id: user.id,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt,
      verified: user.verified,
      referredBy: user.referredBy,
      referralCount: user.referralCount,
      // XP System
      totalXp: user.totalXp,
      level: user.level,
      lastLoginAt: user.lastLoginAt,
      loginStreak: user.loginStreak,
      // Masquer email et privyUserId par défaut
      email: undefined,
      privyUserId: undefined
    };
  }

  /**
   * Masque les données sensibles pour les listes d'utilisateurs
   */
  private maskUserListData(users: User[]): Array<Omit<User, 'email' | 'privyUserId'> & {
    email?: string;
    privyUserId?: string;
  }> {
    return users.map(user => this.maskSensitiveData(user));
  }

  /**
   * Récupère les utilisateurs avec pagination et masquage des données sensibles
   */
  async getUsers(options: {
    page?: number;
    limit?: number;
    search?: string;
    verified?: boolean;
  }) {
    const { page = 1, limit = 20, search, verified } = options;
    const skip = (page - 1) * limit;

    try {
      const users = await userRepository.findMany({
        skip,
        take: limit,
        search,
        verified,
        orderBy: { createdAt: 'desc' }
      });

      const total = await userRepository.count({ search, verified });
      const pages = Math.ceil(total / limit);

      // Masquer les données sensibles
      const maskedUsers = this.maskUserListData(users);

      logDeduplicator.info('Users list retrieved', { 
        count: maskedUsers.length,
        total,
        page,
        pages
      });

      return {
        users: maskedUsers,
        total,
        pages
      };
    } catch (error) {
      logDeduplicator.error('Error retrieving users list', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Récupère un utilisateur par ID avec masquage des données sensibles
   */
  async getUserById(userId: number) {
    try {
      const user = await userRepository.findById(userId);
      if (!user) {
        return null;
      }

      // Masquer les données sensibles
      const maskedUser = this.maskSensitiveData(user);

      logDeduplicator.info('User retrieved by ID', { 
        userId,
        role: maskedUser.role
      });

      return maskedUser;
    } catch (error) {
      logDeduplicator.error('Error retrieving user by ID', { error: error instanceof Error ? error.message : String(error), userId });
      throw error;
    }
  }

  /**
   * Met à jour un utilisateur
   */
  async updateUser(userId: number, data: {
    name?: string;
    email?: string | null;
    role?: UserRole;
    verified?: boolean;
  }) {
    try {
      const updatedUser = await userRepository.update(userId, data);
      
      // Masquer les données sensibles
      const maskedUser = this.maskSensitiveData(updatedUser);

      logDeduplicator.info('User updated', { 
        userId,
        updatedFields: Object.keys(data)
      });

      return maskedUser;
    } catch (error) {
      logDeduplicator.error('Error updating user', { error: error instanceof Error ? error.message : String(error), userId });
      throw error;
    }
  }

  /**
   * Supprime un utilisateur
   */
  async deleteUser(userId: number) {
    try {
      const deletedUser = await userRepository.delete(userId);
      
      // Masquer les données sensibles
      const maskedUser = this.maskSensitiveData(deletedUser);

      logDeduplicator.info('User deleted', { 
        userId,
        userName: maskedUser.name
      });

      return maskedUser;
    } catch (error) {
      logDeduplicator.error('Error deleting user', { error: error instanceof Error ? error.message : String(error), userId });
      throw error;
    }
  }

  /**
   * Vérifie si un utilisateur peut être supprimé
   */
  canDeleteUser(targetUserId: number, adminId: number): boolean {
    // Empêcher l'admin de se supprimer lui-même
    return targetUserId !== adminId;
  }
} 