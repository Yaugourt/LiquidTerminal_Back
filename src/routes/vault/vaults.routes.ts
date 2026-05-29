import express, { Request, Response } from 'express';
import { VaultsService } from '../../services/vault/vaults.service';
import { validateGetRequest } from '../../middleware/validation';
import { vaultsGetSchema } from '../../schemas/vault.schemas';
import { VaultsError, VaultsTimeoutError } from '../../errors/vault.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = express.Router();
const vaultsService = VaultsService.getInstance();


router.get('/', validateGetRequest(vaultsGetSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      sortBy,
      sortOrder,
      limit,
      page,
      name,
      leader,
      isClosed,
      includeClosed
    } = req.query;

    const result = await vaultsService.getVaultsList({
      sortBy: sortBy as 'apr' | 'tvl' | 'createTime',
      sortOrder: sortOrder as 'asc' | 'desc',
      limit: limit ? Number(limit) : undefined,
      page: page ? Number(page) : undefined,
      name: name as string,
      leader: leader as string,
      isClosed: isClosed !== undefined ? isClosed === 'true' : undefined,
      includeClosed: includeClosed !== undefined ? includeClosed === 'true' : undefined
    });

    logDeduplicator.info('Vaults list retrieved successfully', { 
      count: result.data.length,
      page: result.pagination.page,
      totalPages: result.pagination.totalPages
    });

    res.status(200).json(result);
  } catch (error) {
    logDeduplicator.error('Error retrieving vaults list:', { error: error instanceof Error ? error.message : String(error) });
    
    if (error instanceof VaultsError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
        code: error.code
      });
      return;
    }
    
    if (error instanceof VaultsTimeoutError) {
      res.status(error.statusCode).json({
        error: error.code,
        message: error.message
      });
      return;
    }
    
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR'
    });
  }
});

export default router; 