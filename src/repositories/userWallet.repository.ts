import { PrismaClient } from '@prisma/client';
import { prisma } from '../core/prisma.service';

export class UserWalletRepository {
  private prismaClient: PrismaClient | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'> = prisma;

  setPrismaClient(client: PrismaClient | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>): void {
    this.prismaClient = client;
  }

  resetPrismaClient(): void {
    this.prismaClient = prisma;
  }

  async findById(id: number) {
    return this.prismaClient.userWallet.findUnique({
      where: { id },
      include: {
        Wallet: true
      }
    });
  }

  async findByUserAndWallet(userId: number, walletId: number) {
    return this.prismaClient.userWallet.findUnique({
      where: {
        userId_walletId: {
          userId,
          walletId
        }
      },
      include: {
        Wallet: true
      }
    });
  }

  async findByUser(userId: number, options?: { skip?: number; take?: number }) {
    return this.prismaClient.userWallet.findMany({
      where: { userId },
      orderBy: { addedAt: 'desc' },
      include: {
        Wallet: true
      },
      skip: options?.skip,
      take: options?.take
    });
  }

  async create(data: { userId: number; walletId: number; name?: string }) {
    return this.prismaClient.userWallet.create({
      data,
      include: {
        Wallet: true
      }
    });
  }

  async updateName(id: number, name: string) {
    return this.prismaClient.userWallet.update({
      where: { id },
      data: { name },
      include: {
        Wallet: true
      }
    });
  }

  async countByUser(userId: number): Promise<number> {
    return this.prismaClient.userWallet.count({
      where: { userId }
    });
  }

  async countByWallet(walletId: number): Promise<number> {
    return this.prismaClient.userWallet.count({
      where: { walletId }
    });
  }

  async delete(id: number): Promise<void> {
    await this.prismaClient.userWallet.delete({
      where: { id }
    });
  }

  async bulkCreate(data: Array<{ userId: number; walletId: number; name?: string }>) {
    // Use createMany with skipDuplicates to avoid conflicts
    await this.prismaClient.userWallet.createMany({
      data,
      skipDuplicates: true
    });
  }

  async findManyByUserAndWallets(userId: number, walletIds: number[]) {
    return this.prismaClient.userWallet.findMany({
      where: {
        userId,
        walletId: {
          in: walletIds
        }
      },
      include: {
        Wallet: true
      }
    });
  }

  async bulkDeleteByUserAndWallets(userId: number, walletIds: number[]) {
    return this.prismaClient.userWallet.deleteMany({
      where: {
        userId,
        walletId: {
          in: walletIds
        }
      }
    });
  }
}

export const userWalletRepository = new UserWalletRepository(); 