import { PrismaClient } from '@prisma/client';
import { prisma } from '../core/prisma.service';

export class WalletRepository {
  private prismaClient: PrismaClient | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'> = prisma;

  setPrismaClient(client: PrismaClient | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>): void {
    this.prismaClient = client;
  }

  resetPrismaClient(): void {
    this.prismaClient = prisma;
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