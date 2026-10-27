import { PrismaClient, Prisma } from '@prisma/client';
import { prisma } from '../core/prisma.service';
import { logDeduplicator } from '../utils/logDeduplicator';
import { scopedClient } from '../utils/tx-scope';

export class WalletRepository {
  /**
   * The transaction this repository is bound to in the current async context
   * (see runWithTx), else the Core client. Resolved on each access, never stored:
   * the repository is a singleton shared by all requests, and a client kept on
   * it would leak to concurrent requests and outlive its transaction.
   */
  private get prismaClient(): PrismaClient | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'> {
    return scopedClient<PrismaClient | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>>(this) ?? prisma;
  }

  async findById(id: number) {
    return this.prismaClient.wallet.findUnique({
      where: { id }
    });
  }

  async findByAddress(address: string) {
    return this.prismaClient.wallet.findUnique({
      where: { address }
    });
  }

  async findByUser(userId: number, options?: { skip?: number; take?: number }) {
    return this.prismaClient.wallet.findMany({
      where: {
        UserWallets: {
          some: {
            userId
          }
        }
      },
      orderBy: { addedAt: 'desc' },
      skip: options?.skip,
      take: options?.take
    });
  }

  async create(data: { address: string; name?: string }) {
    return this.prismaClient.wallet.create({
      data
    });
  }

  async existsByAddress(address: string): Promise<boolean> {
    const wallet = await this.findByAddress(address);
    return !!wallet;
  }

  async countByUser(userId: number): Promise<number> {
    return this.prismaClient.wallet.count({
      where: {
        UserWallets: {
          some: {
            userId
          }
        }
      }
    });
  }

  async delete(id: number): Promise<void> {
    await this.prismaClient.wallet.delete({
      where: { id }
    });
  }

  async bulkCreate(addresses: string[]) {
    // Use createMany with skipDuplicates to avoid conflicts
    await this.prismaClient.wallet.createMany({
      data: addresses.map(address => ({ address })),
      skipDuplicates: true
    });
  }

  async findManyByAddresses(addresses: string[]) {
    return this.prismaClient.wallet.findMany({
      where: {
        address: {
          in: addresses
        }
      }
    });
  }
}

export const walletRepository = new WalletRepository(); 