import { prisma } from '../../core/prisma.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import {
    ResourceReportInput,
    ResourceReportResponse
} from '../../types/educational.types';
import { BasePagination } from '../../types/common.types';
import {
    DuplicateReportError,
    EducationalResourceNotFoundError
} from '../../errors/educational.errors';

/**
 * Service pour gérer les signalements de ressources éducatives
 */
export class ResourceReportService {
    private static instance: ResourceReportService;

    private constructor() { }

    static getInstance(): ResourceReportService {
        if (!ResourceReportService.instance) {
            ResourceReportService.instance = new ResourceReportService();
        }
        return ResourceReportService.instance;
    }

    /**
     * Crée un nouveau signalement
     */
    async createReport(input: ResourceReportInput): Promise<ResourceReportResponse> {
        // Vérifier que la ressource existe
        const resource = await prisma.educationalResource.findUnique({
            where: { id: input.resourceId }
        });

        if (!resource) {
            throw new EducationalResourceNotFoundError();
        }

        // Vérifier si l'utilisateur a déjà signalé cette ressource
        const existingReport = await prisma.resourceReport.findUnique({
            where: {
                resourceId_reportedBy: {
                    resourceId: input.resourceId,
                    reportedBy: input.reportedBy
                }
            }
        });

        if (existingReport) {
            throw new DuplicateReportError();
        }

        // Créer le signalement
        const report = await prisma.resourceReport.create({
            data: {
                resourceId: input.resourceId,
                reportedBy: input.reportedBy,
                reason: input.reason
            },
            include: {
                reporter: {
                    select: {
                        id: true,
                        name: true
                    }
                },
                resource: {
                    select: {
                        id: true,
                        url: true,
                        status: true
                    }
                }
            }
        });

        logDeduplicator.info('Resource report created', {
            reportId: report.id,
            resourceId: input.resourceId,
            reportedBy: input.reportedBy
        });

        return report;
    }

    /**
     * Récupère tous les signalements (pour les modérateurs)
     */
    async getAllReports(params: {
        page?: number;
        limit?: number;
        resourceId?: number;
    }): Promise<{
        data: ResourceReportResponse[];
        pagination: BasePagination;
    }> {
        const { page = 1, limit = 20, resourceId } = params;
        const skip = (page - 1) * limit;

        const where = resourceId ? { resourceId } : {};

        const [reports, total] = await Promise.all([
            prisma.resourceReport.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
                include: {
                    reporter: {
                        select: {
                            id: true,
                            name: true
                        }
                    },
                    resource: {
                        select: {
                            id: true,
                            url: true,
                            status: true
                        }
                    }
                }
            }),
            prisma.resourceReport.count({ where })
        ]);

        const totalPages = Math.ceil(total / limit);

        return {
            data: reports,
            pagination: {
                page,
                limit,
                total,
                totalPages,
                hasNext: page < totalPages,
                hasPrevious: page > 1
            }
        };
    }

    /**
     * Récupère les signalements pour une ressource spécifique
     */
    async getReportsForResource(resourceId: number): Promise<ResourceReportResponse[]> {
        return prisma.resourceReport.findMany({
            where: { resourceId },
            orderBy: { createdAt: 'desc' },
            include: {
                reporter: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            }
        });
    }

    /**
     * Compte le nombre de signalements pour une ressource
     */
    async countReportsForResource(resourceId: number): Promise<number> {
        return prisma.resourceReport.count({
            where: { resourceId }
        });
    }

    /**
     * Supprime un signalement (admin uniquement)
     */
    async deleteReport(id: number): Promise<void> {
        await prisma.resourceReport.delete({
            where: { id }
        });

        logDeduplicator.info('Resource report deleted', { reportId: id });
    }

    /**
     * Supprime tous les signalements d'une ressource (utilisé lors de l'approbation)
     */
    async deleteReportsForResource(resourceId: number): Promise<number> {
        const result = await prisma.resourceReport.deleteMany({
            where: { resourceId }
        });

        if (result.count > 0) {
            logDeduplicator.info('Resource reports deleted after approval', {
                resourceId,
                count: result.count
            });
        }

        return result.count;
    }
}

// Export singleton instance
export const resourceReportService = ResourceReportService.getInstance();
