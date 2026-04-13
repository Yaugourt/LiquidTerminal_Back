import { IndexerFillsService } from '../../../src/services/indexer/indexer-fills.service';
import { redisService } from '../../../src/core/redis.service';
import { HypeDexerFillsClient } from '../../../src/clients/hypedexer/rest/fills/fills.client';

jest.mock('../../../src/core/redis.service', () => ({
  redisService: {
    get: jest.fn(),
    set: jest.fn(),
  },
}));

jest.mock('../../../src/clients/hypedexer/rest/fills/fills.client', () => ({
  HypeDexerFillsClient: {
    getInstance: jest.fn(),
  },
}));

describe('IndexerFillsService', () => {
  const mockGet = jest.fn();
  const mockGetFillsCount = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset singleton so each test gets a client built from current mocks
    (IndexerFillsService as unknown as { instance?: IndexerFillsService }).instance = undefined;
    (HypeDexerFillsClient.getInstance as jest.Mock).mockReturnValue({
      getFills: mockGet,
      getFillsRecent: mockGet,
      getFillsCount: mockGetFillsCount,
    });
  });

  it('getFillsCount returns cached payload when Redis hit', async () => {
    (redisService.get as jest.Mock).mockResolvedValue(JSON.stringify({ success: true, data: { count: 42 } }));
    const svc = IndexerFillsService.getInstance();
    const out = await svc.getFillsCount();
    expect(out).toEqual({ success: true, data: { count: 42 } });
    expect(mockGetFillsCount).not.toHaveBeenCalled();
  });

  it('getFillsCount fetches upstream and sets cache on miss', async () => {
    (redisService.get as jest.Mock).mockResolvedValue(null);
    mockGetFillsCount.mockResolvedValue({ success: true, data: { count: 7 } });
    (redisService.set as jest.Mock).mockResolvedValue(undefined);

    const svc = IndexerFillsService.getInstance();
    const out = await svc.getFillsCount();
    expect(out).toEqual({ success: true, data: { count: 7 } });
    expect(mockGetFillsCount).toHaveBeenCalled();
    expect(redisService.set).toHaveBeenCalled();
  });
});
