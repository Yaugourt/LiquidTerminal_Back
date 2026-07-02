import { Router, Request, Response } from 'express';
import { ValidatorVotesService } from '../../services/staking/votes.service';
import { ValidatorVotesResponse } from '../../types/staking.types';
import { marketRateLimiter } from '../../middleware/apiRateLimiter';
import { validateGetRequest } from '../../middleware/validation';
import { validatorVotesGetSchema } from '../../schemas/staking.schema';
import { ValidatorVotesError } from '../../errors/staking.errors';
import { logDeduplicator } from '../../utils/logDeduplicator';

const router = Router();
const votesService = ValidatorVotesService.getInstance();

// Appliquer le rate limiter à toutes les routes
router.use(marketRateLimiter);

/**
 * @route GET /staking/validators/votes
 * @description Snapshot des votes L1 PENDING joints aux validateurs
 *              (participation, poids-stake, split Fondation, quorum).
 */
router.get('/', validateGetRequest(validatorVotesGetSchema), async (_req: Request, res: Response) => {
  try {
    logDeduplicator.info('Fetching validator L1 votes');

    const { votes, stats } = await votesService.getValidatorVotes();
    const response: ValidatorVotesResponse = {
      success: true,
      data: votes,
      stats
    };

    logDeduplicator.info('Validator votes retrieved successfully', {
      pendingCount: votes.length,
      totalValidators: stats.totalValidators
    });

    res.json(response);
  } catch (error) {
    logDeduplicator.error('Error in /votes route:', {
      error: error instanceof Error ? error.message : String(error)
    });

    if (error instanceof ValidatorVotesError) {
      res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch validator votes',
        code: 'UNKNOWN_ERROR'
      });
    }
  }
});

export default router;
