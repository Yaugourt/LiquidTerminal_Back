import express, { Request, Response, RequestHandler } from 'express';
import { AuctionPageService } from '../../services/spot/auction/auction.service';
import { SpotDeployStateApiService } from '../../services/spot/auction/auctionTiming.service';
import { validateGetRequest } from '../../middleware/validation';
import { auctionGetSchema } from '../../schemas/spot.schemas';
import { AuctionError, InvalidAuctionDataError } from '../../errors/spot.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = express.Router();
const spotDeployStateApi = SpotDeployStateApiService.getInstance();
const auctionService = AuctionPageService.getInstance(spotDeployStateApi);

// Appliquer le rate limiting et la sanitization

// Appliquer la validation des requêtes
router.get('/', validateGetRequest(auctionGetSchema),
  (async (_req: Request, res: Response) => {
    try {
      const auctionData = await auctionService.getAllAuctions();
      
      logDeduplicator.info('Auction data retrieved successfully', { 
        usdcAuctionsCount: auctionData.usdcAuctions.length,
        hypeAuctionsCount: auctionData.hypeAuctions.length,
        totalUsdcSpent: auctionData.totalUsdcSpent,
        totalHypeSpent: auctionData.totalHypeSpent
      });
      
      res.status(200).json({
        success: true,
        message: 'Auction data retrieved successfully',
        data: auctionData
      });
    } catch (error) {
      logDeduplicator.error('Error retrieving auction data:', { error: error instanceof Error ? error.message : String(error) });
      
      if (error instanceof AuctionError || error instanceof InvalidAuctionDataError) {
        return res.status(error.statusCode).json({
          success: false,
          error: error.message,
          code: error.code
        });
      }
      
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR'
      });
    }
  }) as RequestHandler
);

router.get('/timing', validateGetRequest(auctionGetSchema), (async (_req: Request, res: Response) => {
  try {
    const timingData = await spotDeployStateApi.getAuctionTiming();
    
    logDeduplicator.info('Auction timing retrieved successfully', { 
      currentStartTime: timingData.currentAuction.startTime,
      currentEndTime: timingData.currentAuction.endTime,
      nextStartTime: timingData.nextAuction.startTime
    });
    
    res.status(200).json({
      success: true,
      message: 'Auction timing retrieved successfully',
      data: timingData
    });
  } catch (error) {
    logDeduplicator.error('Error retrieving auction timing:', { error: error instanceof Error ? error.message : String(error) });
    
    if (error instanceof AuctionError || error instanceof InvalidAuctionDataError) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR'
    });
  }
}) as RequestHandler);

export default router; 