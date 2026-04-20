import {
  HypeDexerFundingClient,
  IndexerFundingHistoryQuery,
  IndexerUserFundingQuery,
} from '../../clients/hypedexer/rest/funding/funding.client';
import { cacheService } from '../../core/cache.service';
import { HYPEDEXER_CACHE_KEYS, HYPEDEXER_TTL, HYPEDEXER_USER_CACHE_KEY } from '../../constants/hypedexer.cache';

export class IndexerFundingService {
  private static instance: IndexerFundingService;
  private readonly client = HypeDexerFundingClient.getInstance();

  public static getInstance(): IndexerFundingService {
    if (!IndexerFundingService.instance) {
      IndexerFundingService.instance = new IndexerFundingService();
    }
    return IndexerFundingService.instance;
  }

  public async getFundingHistory(params: IndexerFundingHistoryQuery): Promise<unknown> {
    return this.client.getFundingHistory(params);
  }

  public async getPredictedFundings(): Promise<unknown> {
    return cacheService.getOrSet<unknown>(
      HYPEDEXER_CACHE_KEYS.fundingPredicted,
      () => this.client.getPredictedFundings(),
      HYPEDEXER_TTL.globalRolling
    );
  }

  public async getUserFunding(params: IndexerUserFundingQuery): Promise<unknown> {
    if (params.startTime || params.endTime) {
      return this.client.getUserFunding(params);
    }
    return cacheService.getOrSet(
      HYPEDEXER_USER_CACHE_KEY.userFunding(params.user),
      () => this.client.getUserFunding(params),
      HYPEDEXER_TTL.userAddress
    );
  }
}
