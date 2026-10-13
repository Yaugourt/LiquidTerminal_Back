import { Router, Request, Response, RequestHandler } from 'express';
import { StakedHoldersService, StakedHoldersUnavailableError } from '../../services/staking/stakedHolders.service';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';

const router = Router();
const stakedHoldersService = StakedHoldersService.getInstance();

// Middleware global pour rate limiting
router.use(marketRateLimiter);

/**
 * The list can't be read from Hypurrscan and nothing is kept (Redis keeps the
 * last one for 6 h): a temporary condition, so 503 with a short Retry-After.
 */
function sendUnavailable(res: Response): void {
  res.setHeader('Retry-After', '30');
  res.status(503).json({
    success: false,
    error: 'Staked holders temporarily unavailable',
    code: 'STAKED_HOLDERS_UNAVAILABLE'
  });
}

/**
 * GET /api/staking/holders
 * Récupère la liste paginée des holders de stakedHYPE triés par montant décroissant
 */
router.get('/', 
  (async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      
      const result = await stakedHoldersService.getStakedHolders(page, limit);

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      if (error instanceof StakedHoldersUnavailableError) return sendUnavailable(res);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        code: 'STAKED_HOLDERS_ERROR'
      });
    }
  }) as RequestHandler
);

/**
 * GET /api/staking/holders/top
 * Récupère les top holders de stakedHYPE
 */
router.get('/top',
  (async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      
      const holders = await stakedHoldersService.getTopHolders(limit);

      res.json({
        success: true,
        data: holders
      });
    } catch (error) {
      if (error instanceof StakedHoldersUnavailableError) return sendUnavailable(res);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        code: 'TOP_HOLDERS_ERROR'
      });
    }
  }) as RequestHandler
);

/**
 * GET /api/staking/holders/stats
 * Récupère les statistiques des holders de stakedHYPE
 */
router.get('/stats',
  (async (req: Request, res: Response) => {
    try {
      const stats = await stakedHoldersService.getHoldersStats();

      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      if (error instanceof StakedHoldersUnavailableError) return sendUnavailable(res);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        code: 'HOLDERS_STATS_ERROR'
      });
    }
  }) as RequestHandler
);

/**
 * GET /api/staking/holders/:address
 * Récupère un holder spécifique par son adresse
 */
router.get('/:address',
  (async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      
      const holder = await stakedHoldersService.getHolderByAddress(String(address));

      if (!holder) {
        return res.status(404).json({
          success: false,
          error: 'Holder not found',
          code: 'HOLDER_NOT_FOUND'
        });
      }

      res.json({
        success: true,
        data: holder
      });
    } catch (error) {
      if (error instanceof StakedHoldersUnavailableError) return sendUnavailable(res);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        code: 'HOLDER_ERROR'
      });
    }
  }) as RequestHandler
);

export default router; 