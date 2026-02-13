import { ProjectRepository } from './interfaces/project.repository.interface';
import { CategoryRepository } from './interfaces/category.repository.interface';
import { EducationalCategoryRepository } from './interfaces/educational-category.repository.interface';
import { EducationalResourceRepository } from './interfaces/educational-resource.repository.interface';
import { ReadListRepository } from './interfaces/readlist.repository.interface';
import { ReadListItemRepository } from './interfaces/readlist-item.repository.interface';
import { LinkPreviewRepository } from './interfaces/linkPreview.repository.interface';
import { PublicGoodRepository } from './interfaces/publicgood.repository.interface';
import { HistoricalLiquidationRepository } from './interfaces/historical.repository.interface';
import { PrismaProjectRepository } from './prisma/prisma.project.repository';
import { PrismaCategoryRepository } from './prisma/prisma.category.repository';
import { PrismaEducationalCategoryRepository } from './prisma/prisma.educational-category.repository';
import { PrismaEducationalResourceRepository } from './prisma/prisma.educational-resource.repository';
import { PrismaReadListRepository } from './prisma/prisma.readlist.repository';
import { PrismaReadListItemRepository } from './prisma/prisma.readlist-item.repository';
import { PrismaLinkPreviewRepository } from './prisma/prisma.linkPreview.repository';
import { PrismaPublicGoodRepository } from './prisma/prisma.publicgood.repository';
import { PrismaHistoricalLiquidationRepository } from './prisma/prisma.historical.repository';

// Export des interfaces
export type { 
  ProjectRepository, 
  CategoryRepository, 
  EducationalCategoryRepository, 
  EducationalResourceRepository,
  ReadListRepository,
  ReadListItemRepository,
  LinkPreviewRepository,
  PublicGoodRepository,
  HistoricalLiquidationRepository
};

// Export des implémentations
export { 
  PrismaProjectRepository, 
  PrismaCategoryRepository, 
  PrismaEducationalCategoryRepository,
  PrismaEducationalResourceRepository,
  PrismaReadListRepository,
  PrismaReadListItemRepository,
  PrismaLinkPreviewRepository,
  PrismaPublicGoodRepository,
  PrismaHistoricalLiquidationRepository
};

// Instances par défaut
export const projectRepository: ProjectRepository = new PrismaProjectRepository();
export const categoryRepository: CategoryRepository = new PrismaCategoryRepository();
export const educationalCategoryRepository: EducationalCategoryRepository = new PrismaEducationalCategoryRepository();
export const educationalResourceRepository: EducationalResourceRepository = new PrismaEducationalResourceRepository();
export const readListRepository: ReadListRepository = new PrismaReadListRepository();
export const readListItemRepository: ReadListItemRepository = new PrismaReadListItemRepository();
export const linkPreviewRepository: LinkPreviewRepository = new PrismaLinkPreviewRepository();
export const publicGoodRepository: PublicGoodRepository = new PrismaPublicGoodRepository();
export const historicalLiquidationRepository: HistoricalLiquidationRepository = new PrismaHistoricalLiquidationRepository(); 