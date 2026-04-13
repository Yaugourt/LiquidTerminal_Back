import { Router } from 'express';
import { FeesService } from '../../services/fees/fees.service';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { FeesError } from '../../types/fees.types';

const router = Router();
const feesService = FeesService.getInstance();

router.get('', async (req, res) => {
  try {
    const stats = await feesService.getFeesStats();
    res.json({
      success: true,
      data: stats
    });
  } catch (error: unknown) {
    logDeduplicator.error('Error fetching fees stats:', { error: error instanceof Error ? error.message : String(error) });
    
    if (error instanceof FeesError) {
      res.status(error.statusCode).json({
        success: false,
        error: {
          message: error.message,
          code: error.code
        }
      });
    } else {
      res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Internal server error',
          code: 'INTERNAL_SERVER_ERROR'
        }
      });
    }
  }
});

// Route pour les données brutes avec conversion
router.get('/raw', async (req, res) => {
  try {
    const convertedData = await feesService.getRawFeesDataWithConversion();
    
    res.json({
      success: true,
      data: convertedData
    });
  } catch (error: unknown) {
    logDeduplicator.error('Error fetching raw fees data:', { error: error instanceof Error ? error.message : String(error) });
    
    if (error instanceof FeesError) {
      res.status(error.statusCode).json({
        success: false,
        error: {
          message: error.message,
          code: error.code
        }
      });
    } else {
      res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Internal server error',
          code: 'INTERNAL_SERVER_ERROR'
        }
      });
    }
  }
});

export default router; 