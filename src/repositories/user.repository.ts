import { PrismaClient, Prisma, User, UserRole } from '@prisma/client';
import { prisma } from '../core/prisma.service';
import { logDeduplicator } from '../utils/logDeduplicator';
import { scopedClient } from '../utils/tx-scope';
import { UserRepository } from './interfaces/user.repository.interface';

export class UserRepositoryImpl implements UserRepository {
  /**
   * The transaction this repository is bound to in the current async context
   * (see runWithTx), else the Core client. Resolved on each access, never stored:
   * the repository is a singleton shared by all requests, and a client kept on
   * it would leak to concurrent requests and outlive its transaction.
   */
  private get prismaClient(): PrismaClient | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'> {
    return scopedClient<PrismaClient | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>>(this) ?? prisma;
  }

  async findById(id: number): Promise<User | null> {
    return this.prismaClient.user.findUnique({
      where: { id }
    });
  }

  async findByPrivyUserId(privyUserId: string): Promise<User | null> {
    return this.prismaClient.user.findUnique({
      where: { privyUserId }
    });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.prismaClient.user.findUnique({
      where: { email }
    });
  }

  async create(data: {
    privyUserId: string;
    name: string;
    email?: string;
    role?: UserRole;
    verified?: boolean;
  }): Promise<User> {
    return this.prismaClient.user.create({
      data
    });
  }

  async update(id: number, data: {
    name?: string;
    email?: string | null;
    role?: UserRole;
    verified?: boolean;
  }): Promise<User> {
    return this.prismaClient.user.update({
      where: { id },
      data
    });
  }

  async delete(id: number): Promise<User> {
    return this.prismaClient.user.delete({
      where: { id }
    });
  }

  async findOrCreate(privyUserId: string, data: {
    name: string;
    email?: string;
    role?: UserRole;
    verified?: boolean;
  }): Promise<User> {
    return this.prismaClient.user.upsert({
      where: { privyUserId },
      update: {
        name: data.name,
        email: data.email,
        role: data.role,
        verified: data.verified
      },
      create: {
        privyUserId,
        name: data.name,
        email: data.email,
        role: data.role,
        verified: data.verified
      }
    });
  }

  async findMany(options: {
    skip?: number;
    take?: number;
    search?: string;
    verified?: boolean;
    orderBy?: { [key: string]: 'asc' | 'desc' };
  }): Promise<User[]> {
    const whereClause: Prisma.UserWhereInput = {};

    if (options.search) {
      whereClause.OR = [
        { name: { contains: options.search, mode: 'insensitive' } },
        { email: { contains: options.search, mode: 'insensitive' } },
        { privyUserId: { contains: options.search, mode: 'insensitive' } }
      ];
    }

    if (options.verified !== undefined) {
      whereClause.verified = options.verified;
    }

    return this.prismaClient.user.findMany({
      where: whereClause,
      skip: options.skip,
      take: options.take,
      orderBy: options.orderBy || { createdAt: 'desc' }
    });
  }

  async count(options: {
    search?: string;
    verified?: boolean;
  }): Promise<number> {
    const whereClause: Prisma.UserWhereInput = {};

    if (options.search) {
      whereClause.OR = [
        { name: { contains: options.search, mode: 'insensitive' } },
        { email: { contains: options.search, mode: 'insensitive' } },
        { privyUserId: { contains: options.search, mode: 'insensitive' } }
      ];
    }

    if (options.verified !== undefined) {
      whereClause.verified = options.verified;
    }

    return this.prismaClient.user.count({
      where: whereClause
    });
  }

  async existsByPrivyUserId(privyUserId: string): Promise<boolean> {
    const user = await this.findByPrivyUserId(privyUserId);
    return !!user;
  }

  async existsByEmail(email: string, excludeUserId?: number): Promise<boolean> {
    const whereClause: Prisma.UserWhereInput = { email };
    
    if (excludeUserId) {
      whereClause.NOT = { id: excludeUserId };
    }

    const user = await this.prismaClient.user.findFirst({
      where: whereClause
    });
    
    return !!user;
  }
}

export const userRepository = new UserRepositoryImpl(); 