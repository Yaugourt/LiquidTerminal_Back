/**
 * The backend could say nothing to anyone: the provider's outage of 17 October was seen by
 * chance (2026-11-11). Once a minute the alert service reads the ingestion's status and sends a
 * message when something has been wrong for long enough, again every six hours while it is, and
 * once when it is over.
 */
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../src/utils/logDeduplicator', () => ({ logDeduplicator: mockLog }));
const mockHash = new Map<string, string>();
const mockRedis = {
  locks: new Map<string, string>(),
  async set(key: string, value: string): Promise<'OK' | null> {
    if (this.locks.has(key)) return null;
    this.locks.set(key, value);
    return 'OK';
  },
  async eval(_script: string, _n: number, key: string, token: string): Promise<number> {
    if (this.locks.get(key) === token) this.locks.delete(key);
    return 1;
  },
  hgetall: async () => Object.fromEntries(mockHash),
  hset: async (_key: string, field: string, value: string) => void mockHash.set(field, value),
  hdel: async (_key: string, field: string) => void mockHash.delete(field),
  expire: async () => 1,
};
jest.mock('../../../src/core/redis.service', () => ({ redisService: { getClient: () => mockRedis } }));
let mockStatus: Record<string, unknown>;
jest.mock('../../../src/services/elysium/elysium-analytics.service', () => ({
  ElysiumAnalyticsService: { getInstance: () => ({ getStatus: async () => ({ data: mockStatus }) }) },
}));

import { alertConditions, ElysiumAlertService } from '../../../src/services/elysium/elysium-alert.service';

const NOW = Date.parse('2026-11-11T18:00:00Z');
const MIN = 60_000;
const healthy = (): Record<string, unknown> => ({
  streams: [
    { stream: 'tx', state: 'ok', lagSeconds: 20, lastError: null },
    { stream: 'dex', state: 'ok', lagSeconds: 40, lastError: null },
    { stream: 'tokens', state: 'ok', lagSeconds: null, lastError: null },
  ],
  provider: { headAt: '2026-11-11T17:59:50.000Z', lagSeconds: 10 },
  rollups: { waitingDays: 0, lastError: null },
  completeness: { days: [{ day: '2026-11-10', status: 'ok', txs: 689379, providerTxs: 689379, spam: 0, providerSpam: 0 }] },
  rejects: [],
  upkeep: [{ name: 'kilngrads', done: true, lastError: null }],
  views: [{ view: 'elysium:analytics:fees:7d', lastError: null }],
  credits: { days: [{ day: '2026-11-11', credits: 700_000 }, { day: '2026-11-10', credits: 1_000_000 }, { day: '2026-11-09', credits: 950_000 }, { day: '2026-11-08', credits: 900_000 }] },
  database: { bytes: 60e9, volumeBytes: 100e9, usedShare: 0.6 },
});
const keys = (status: Record<string, unknown>): string[] => alertConditions(status as never, NOW).map((c) => c.key);

describe('what is worth a message', () => {
  it('nothing, when everything is in order', () => {
    expect(alertConditions(healthy() as never, NOW)).toEqual([]);
  });

  it('a stream that fails, does not run or is behind, after 3 minutes; not one that waits for the provider', () => {
    const s = healthy();
    s.streams = [
      { stream: 'tx', state: 'waiting-provider', lagSeconds: 21_600, lastError: null },
      { stream: 'dex', state: 'failing', lagSeconds: 400, lastError: 'upstream_http_503' },
      { stream: 'launchpad', state: 'behind', lagSeconds: 1_800, lastError: null },
      { stream: 'tokens', state: 'stalled', lagSeconds: null, lastError: null },
    ];
    const got = alertConditions(s as never, NOW);
    expect(got.map((c) => [c.key, c.forS])).toEqual([['stream:dex', 180], ['stream:launchpad', 180], ['stream:tokens', 180]]);
    expect(got[0].text).toBe('stream dex is failing, data 7 min old, last error: upstream_http_503');
  });

  it('the provider standing still for more than 10 minutes, once, for all the streams that wait for it', () => {
    const s = healthy();
    s.provider = { headAt: '2026-11-11T12:08:58.000Z', lagSeconds: 21_062 };
    const got = alertConditions(s as never, NOW);
    expect(got.map((c) => c.key)).toEqual(['provider']);
    expect(got[0].text).toContain('has not moved for 6 h');
    s.provider = { headAt: 'x', lagSeconds: 500 };
    expect(keys(s)).toEqual([]);
  });

  it('a closed day that differs from the provider, at once, with both counts', () => {
    const s = healthy();
    s.completeness = { days: [{ day: '2026-11-10', status: 'gap', txs: 689000, providerTxs: 689379, spam: 0, providerSpam: 0 }] };
    const got = alertConditions(s as never, NOW);
    expect(got).toEqual([expect.objectContaining({ key: 'day:2026-11-10', forS: 0 })]);
    expect(got[0].text).toContain('689000 transactions here, 689379 there');
  });

  it('rows left out that should not be, once a day; not the ones that are expected', () => {
    const s = healthy();
    s.rejects = [
      { stream: 'launchpad', reason: 'launch-unknown-emitter', today: 3 },
      { stream: 'launchstats', reason: 'token-unreadable', today: 40 },
      { stream: 'tx', reason: 'row-refused', today: 0 },
    ];
    expect(alertConditions(s as never, NOW)).toEqual([
      expect.objectContaining({ key: 'reject:launchpad:launch-unknown-emitter:2026-11-11', endsQuietly: true }),
    ]);
  });

  it('rollups that fail or wait, a job or a view in error', () => {
    const s = healthy();
    s.rollups = { waitingDays: 3, lastError: 'timeout' };
    s.upkeep = [{ name: 'launchstate', done: false, lastError: 'db_error' }];
    s.views = [{ view: 'elysium:analytics:fees:30d', lastError: 'deadline' }];
    expect(keys(s)).toEqual(['rollups:error', 'rollups:waiting', 'upkeep:launchstate', 'view:elysium:analytics:fees:30d']);
  });

  it('a day of credits over 1.3 times the highest of the days before, when at least three are known', () => {
    const s = healthy();
    s.credits = { days: [{ day: '2026-11-11', credits: 1_400_000 }, { day: '2026-11-10', credits: 1_000_000 }, { day: '2026-11-09', credits: 950_000 }, { day: '2026-11-08', credits: 900_000 }] };
    expect(keys(s)).toEqual(['credits:2026-11-11']);
    s.credits = { days: [{ day: '2026-11-11', credits: 1_400_000 }, { day: '2026-11-10', credits: 1_000_000 }, { day: '2026-11-09', credits: null }] };
    expect(keys(s)).toEqual([]);
    s.credits = null;
    expect(keys(s)).toEqual([]);
  });

  it('a database that fills 80% of its volume, when the volume\'s size is given', () => {
    const s = healthy();
    s.database = { bytes: 81e9, volumeBytes: 100e9, usedShare: 0.81 };
    expect(keys(s)).toEqual(['database']);
    s.database = { bytes: 81e9, volumeBytes: null, usedShare: null };
    expect(keys(s)).toEqual([]);
  });
});

describe('ElysiumAlertService', () => {
  let svc: ElysiumAlertService;
  let sent: Array<{ url: string; body: Record<string, unknown> }>;
  let clock: number;
  const failingDex = (): void => {
    mockStatus.streams = [{ stream: 'dex', state: 'failing', lagSeconds: 400, lastError: 'upstream_http_503' }];
  };

  beforeEach(() => {
    clock = NOW;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    mockHash.clear();
    mockRedis.locks.clear();
    mockStatus = healthy();
    sent = [];
    process.env.ELYSIUM_ALERT_WEBHOOK_URL = 'https://hooks.example/abc';
    jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown> });
      return new Response('{}', { status: 200 });
    });
    for (const m of Object.values(mockLog)) m.mockClear();
    (ElysiumAlertService as unknown as { instance?: unknown }).instance = undefined;
    svc = ElysiumAlertService.getInstance();
  });
  afterEach(() => {
    delete process.env.ELYSIUM_ALERT_WEBHOOK_URL;
    delete process.env.ELYSIUM_ALERT_TELEGRAM_CHAT_ID;
    jest.restoreAllMocks();
  });
  const look = async (minutesLater = 1): Promise<void> => {
    clock += minutesLater * MIN;
    await svc.tick();
  };

  it('says nothing while everything is in order', async () => {
    for (let i = 0; i < 5; i++) await look();
    expect(sent).toEqual([]);
  });

  it('says nothing of a tick that fails once, and speaks once it has failed for 3 minutes', async () => {
    failingDex();
    await look();
    await look();
    expect(sent).toEqual([]);
    await look();
    await look();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.content).toBe('[Elysium] stream dex is failing, data 7 min old, last error: upstream_http_503');
    // Not again a minute later, nor an hour later.
    await look();
    await look(60);
    expect(sent).toHaveLength(1);
  });

  it('says it again after six hours, and once when it is over', async () => {
    failingDex();
    for (let i = 0; i < 4; i++) await look();
    await look(6 * 60);
    expect(sent).toHaveLength(2);
    expect(sent[1].body.content).toContain('(still, for 6 h)');
    mockStatus = healthy();
    await look();
    expect(sent).toHaveLength(3);
    expect(sent[2].body.content).toMatch(/^\[Elysium\] over: stream dex \(after 6 h\)$/);
    await look();
    expect(sent).toHaveLength(3);
  });

  it('says nothing of the end of something it never said had started', async () => {
    failingDex();
    await look();
    mockStatus = healthy();
    await look();
    expect(sent).toEqual([]);
    expect(mockHash.size).toBe(0);
  });

  it('a count of one day is said once, and its day ends without a message', async () => {
    mockStatus.rejects = [{ stream: 'launchpad', reason: 'launch-unknown-emitter', today: 2 }];
    await look();
    await look();
    expect(sent).toHaveLength(1);
    mockStatus = healthy();
    await look();
    expect(sent).toHaveLength(1);
  });

  it('remembers across a restart what it said', async () => {
    failingDex();
    for (let i = 0; i < 4; i++) await look();
    (ElysiumAlertService as unknown as { instance?: unknown }).instance = undefined;
    svc = ElysiumAlertService.getInstance();
    await look();
    expect(sent).toHaveLength(1);
  });

  it('tries again at the next look when the message could not be sent', async () => {
    failingDex();
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('connect ETIMEDOUT')).mockResolvedValueOnce(new Response('', { status: 500 }));
    for (let i = 0; i < 4; i++) await look();
    await look();
    expect(sent).toEqual([]);
    await look();
    expect(sent).toHaveLength(1);
    // The address, which holds a secret, is in no log line.
    expect(JSON.stringify(mockLog.warn.mock.calls)).not.toContain('hooks.example');
  });

  it('sends Telegram its chat and text when a chat is given', async () => {
    process.env.ELYSIUM_ALERT_WEBHOOK_URL = 'https://api.telegram.org/botTOKEN/sendMessage';
    process.env.ELYSIUM_ALERT_TELEGRAM_CHAT_ID = '-100123';
    mockStatus.completeness = { days: [{ day: '2026-11-10', status: 'gap', txs: 1, providerTxs: 2, spam: 0, providerSpam: 0 }] };
    await look();
    expect(sent[0].body).toMatchObject({ chat_id: '-100123', text: expect.stringContaining('2026-11-10 differs from the provider') });
  });

  it('writes the same lines to the log when no webhook is set', async () => {
    delete process.env.ELYSIUM_ALERT_WEBHOOK_URL;
    mockStatus.database = { bytes: 81e9, volumeBytes: 100e9, usedShare: 0.81 };
    await look();
    await look();
    expect(sent).toEqual([]);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith('Elysium alert (no webhook set)', { text: '[Elysium] the historical database fills 81% of its volume' });
  });

  it('lets one process look at a time', async () => {
    mockRedis.locks.set('poll:elysium-alerts', 'another-process');
    failingDex();
    for (let i = 0; i < 5; i++) await look();
    expect(sent).toEqual([]);
  });

  it('never throws, whatever fails', async () => {
    mockStatus = null as never;
    await expect(svc.tick()).resolves.toBeUndefined();
  });
});
