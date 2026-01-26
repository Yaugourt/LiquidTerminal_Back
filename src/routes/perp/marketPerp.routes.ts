import express, { Request, Response } from 'express';
import { PerpAssetContextService } from '../../services/perp/perpAssetContext.service';
import { validateGetRequest } from '../../middleware/validation';
import { marketPerpGetSchema } from '../../schemas/perp.schemas';
import { PerpMarketDataError, PerpTimeoutError } from '../../errors/perp.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = express.Router();
const perpMarketService = PerpAssetContextService.getInstance();

router.get('/', validateGetRequest(marketPerpGetSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { 
      sortBy, 
      sortOrder, 
      limit, 
      page,
      token,
      pair 
    } = req.query;

    const result = await perpMarketService.getPerpMarketsData({
      sortBy: sortBy as 'volume' | 'openInterest' | 'change24h' | 'name' | 'price',
      sortOrder: sortOrder as 'asc' | 'desc',
      limit: limit ? Number(limit) : undefined,
      page: page ? Number(page) : undefined,
      token: token as string,
      pair: pair as string
    });

    logDeduplicator.info('Perp market data retrieved successfully', { 
      count: result.data.length,
      page: result.pagination.page,
      totalPages: result.pagination.totalPages,
      sortBy,
      sortOrder
    });

    res.status(200).json({
      success: true,
      message: 'Perp market data retrieved successfully',
      data: result.data,
      pagination: result.pagination,
      metadata: result.metadata
    });
  } catch (error) {
    logDeduplicator.error('Error retrieving perp market data:', { error });
    
    if (error instanceof PerpMarketDataError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
        code: error.code
      });
      return;
    }
    
    if (error instanceof PerpTimeoutError) {
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