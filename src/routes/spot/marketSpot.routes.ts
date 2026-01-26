import express, { Request, Response } from 'express';
import { SpotAssetContextService } from '../../services/spot/marketData.service';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import { marketSpotGetSchema } from '../../schemas/spot.schemas';
import { MarketDataError, RateLimitError } from '../../errors/spot.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = express.Router();
const marketService = SpotAssetContextService.getInstance();

// Appliquer le rate limiting et la sanitization
router.use(marketRateLimiter);

/**
 * @route GET /market/spot
 * @description Récupère les données de marché spot avec pagination
 * @query sortBy - Critère de tri ('volume', 'marketCap', 'change24h', par défaut 'volume')
 * @query sortOrder - Ordre de tri ('asc', 'desc', par défaut 'desc')
 * @query limit - Nombre d'éléments par page (1-100, par défaut 20)
 * @query page - Numéro de page (commence à 1, par défaut 1)
 * @query token - Filtre par nom de token
 * @query pair - Filtre par nom de paire
 */
router.get('/', validateGetRequest(marketSpotGetSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { 
      sortBy, 
      sortOrder, 
      limit, 
      page,
      token,
      pair 
    } = req.query;

    const result = await marketService.getMarketsData({
      sortBy: sortBy as 'volume' | 'marketCap' | 'change24h' | 'name' | 'price',
      sortOrder: sortOrder as 'asc' | 'desc',
      limit: limit ? Number(limit) : undefined,
      page: page ? Number(page) : undefined,
      token: token as string,
      pair: pair as string
    });

    logDeduplicator.info('Market data retrieved successfully', { 
      count: result.data.length,
      page: result.pagination.page,
      totalPages: result.pagination.totalPages
    });

    res.status(200).json({
      success: true,
      message: 'Market data retrieved successfully',
      data: result.data,
      pagination: result.pagination,
      metadata: result.metadata
    });
  } catch (error) {
    logDeduplicator.error('Error retrieving market data:', { error: error instanceof Error ? error.message : String(error) });
    
    if (error instanceof MarketDataError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
        code: error.code
      });
      return;
    }
    
    if (error instanceof RateLimitError) {
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

/**
 * @route GET /market/spot/tokens-without-pairs
 * @description Récupère les tokens sans paires de trading
 */
router.get('/tokens-without-pairs', validateGetRequest(marketSpotGetSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const tokens = await marketService.getTokensWithoutPairs();

    logDeduplicator.info('Tokens without pairs retrieved successfully', { 
      count: tokens.length
    });

    res.status(200).json({
      success: true,
      message: 'Tokens without pairs retrieved successfully',
      data: tokens
    });
  } catch (error) {
    logDeduplicator.error('Error retrieving tokens without pairs:', { error: error instanceof Error ? error.message : String(error) });
    
    if (error instanceof MarketDataError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
        code: error.code
      });
      return;
    }
    
    if (error instanceof RateLimitError) {
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