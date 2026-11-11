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
/** When the status was computed; null: as the look is made. */
let mockComputedAt: number | null = null;
let mockStatusFails = false;
jest.mock('../../../src/services/elysium/elysium-analytics.service', () => ({
  ElysiumAnalyticsService: {
    getInstance: () => ({
      getStatus: async () => {
        if (mockStatusFails) throw new Error('VIEW_WARMING');
        return { data: mockStatus, computedAt: new Date(mockComputedAt ?? Date.now()).toISOString() };
      },
    }),
  },
}));

import { alertConditions, alertUnknown, ElysiumAlertService } from '../../../src/services/elysium/elysium-alert.service';

const NOW = Date.parse('2026-11-11T18:00:00Z');
const MIN = 60_000;
const healthy = (): Record<string, unknown> => ({
  partial: [],
  streams: [
    { stream: 'tx', state: 'ok', lagSeconds: 20, everyS: 30, lastError: null },
    { stream: 'dex', state: 'ok', lagSeconds: 40, everyS: 60, lastError: null },
    { stream: 'tokens', state: 'ok', lagSeconds: null, everyS: 900, lastError: null },
  ],
  provider: { headAt: '2026-11-11T17:59:50.000Z', lagSeconds: 10 },
  rollups: { waitingDays: 0, lastError: null },
  completeness: { days: [{ day: '2026-11-10', status: 'ok', txs: 689379, providerTxs: 689379, spam: 0, providerSpam: 0 }] },
  rejects: [],
  upkeep: [{ name: 'kilngrads', done: true, lastError: null }],
  views: [{ view: 'elysium:analytics:fees:7d', everyS: 600, lastError: null }],
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
      { stream: 'tx', state: 'waiting-provider', lagSeconds: 21_600, everyS: 30, lastError: null },
      { stream: 'bridge', state: 'backfilling', lagSeconds: 5_000_000, everyS: 60, lastError: null },
      { stream: 'dex', state: 'failing', lagSeconds: 400, everyS: 60, lastError: 'upstream_http_503' },
      { stream: 'launchpad', state: 'behind', lagSeconds: 1_800, everyS: 30, lastError: null },
      { stream: 'tokens', state: 'stalled', lagSeconds: null, everyS: 900, lastError: null },
    ];
    const got = alertConditions(s as never, NOW);
    expect(got.map((c) => [c.key, c.forS])).toEqual([['stream:dex', 180], ['stream:launchpad', 180], ['stream:tokens', 180]]);
    expect(got[0].text).toBe('stream dex is failing, data 7 min old, last error: upstream_http_503');
  });

  it('one failed run of a stream that runs every 15 minutes is not news: it has to outlast its next run', () => {
    const s = healthy();
    s.streams = [
      { stream: 'tokens', state: 'failing', lagSeconds: null, everyS: 900, lastError: 'upstream_http_502' },
      { stream: 'methods', state: 'failing', lagSeconds: null, everyS: 1800, lastError: 'timeout' },
      { stream: 'tx', state: 'failing', lagSeconds: 90, everyS: 30, lastError: 'upstream_http_502' },
    ];
    expect(alertConditions(s as never, NOW).map((c) => [c.key, c.forS])).toEqual([['stream:tokens', 2700], ['stream:methods', 5400], ['stream:tx', 180]]);
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

  it('a closed day still different after being read again whole, at once, with both counts', () => {
    const s = healthy();
    s.completeness = { days: [{ day: '2026-11-10', status: 'unrepaired', txs: 689000, providerTxs: 689379, spam: 0, providerSpam: 0 }] };
    const got = alertConditions(s as never, NOW);
    expect(got).toEqual([expect.objectContaining({ key: 'day:2026-11-10', forS: 0 })]);
    expect(got[0].text).toContain('689000 transactions here, 689379 there');
  });

  it('a day that differs and is being read again only when that has not made it equal after 3 hours, under the same key', () => {
    const s = healthy();
    for (const status of ['gap', 'repairing']) {
      s.completeness = { days: [{ day: '2026-11-10', status, txs: 1, providerTxs: 2, spam: 0, providerSpam: 0 }] };
      expect(alertConditions(s as never, NOW)).toEqual([expect.objectContaining({ key: 'day:2026-11-10', forS: 3 * 3600 })]);
    }
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
    s.views = [{ view: 'elysium:analytics:fees:30d', everyS: 1800, lastError: 'deadline' }];
    expect(keys(s)).toEqual(['rollups:error', 'rollups:waiting', 'upkeep:launchstate', 'view:elysium:analytics:fees:30d']);
  });

  it('not a view computed on demand that failed once: nobody may ask for it again, and its error would stay for ever', () => {
    const s = healthy();
    s.views = [{ view: 'elysium:analytics:users:d90', everyS: null, lastError: 'deadline' }];
    expect(keys(s)).toEqual([]);
  });

  it('a part of the status that could not be read says nothing, and is named as unknown', () => {
    const s = healthy();
    s.partial = ['rollups', 'completeness', 'rejects', 'database'];
    s.rollups = { waitingDays: null, lastError: null };
    s.completeness = { days: [] };
    s.database = { bytes: null, volumeBytes: 100e9, usedShare: null };
    s.credits = null;
    expect(keys(s)).toEqual([]);
    expect(alertUnknown(s as never, NOW)).toEqual(['rollups:waiting', 'day:', 'reject:', 'database', 'credits:']);
    expect(alertUnknown(healthy() as never, NOW)).toEqual([]);
  });

  it('a status computed more than 5 minutes ago says one thing: that it is old; the views are still looked at', () => {
    const s = healthy();
    s.streams = [{ stream: 'dex', state: 'failing', lagSeconds: 400, everyS: 60, lastError: 'upstream_http_503' }];
    s.views = [{ view: 'elysium:analytics:status:v5', everyS: 15, lastError: 'db_error' }];
    const got = alertConditions(s as never, NOW, NOW - 12 * MIN);
    expect(got.map((c) => c.key)).toEqual(['status', 'view:elysium:analytics:status:v5']);
    expect(got[0].text).toContain('has not been computed for 12 min');
    expect(alertUnknown(s as never, NOW, NOW - 12 * MIN)).toEqual(expect.arrayContaining(['stream:', 'day:', 'database']));
  });

  it('a count of the day is keyed by the day the status counted it in, not by the clock of the look', () => {
    const s = healthy();
    s.rejects = [{ stream: 'launchpad', reason: 'market-unknown', today: 3 }];
    // The look falls 20 seconds after midnight, on a status computed 10 seconds before it.
    const midnight = Date.parse('2026-11-12T00:00:00Z');
    expect(alertConditions(s as never, midnight + 20_000, midnight - 10_000).map((c) => c.key)).toEqual(['reject:launchpad:market-unknown:2026-11-11']);
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
    mockStatus.streams = [{ stream: 'dex', state: 'failing', lagSeconds: 400, everyS: 60, lastError: 'upstream_http_503' }];
  };
  const unrepairedDay = (): void => {
    mockStatus.completeness = { days: [{ day: '2026-11-10', status: 'unrepaired', txs: 1, providerTxs: 2, spam: 0, providerSpam: 0 }] };
  };

  beforeEach(() => {
    clock = NOW;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    mockHash.clear();
    mockRedis.locks.clear();
    mockStatus = healthy();
    mockComputedAt = null;
    mockStatusFails = false;
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
    // Over once it has been gone for 5 minutes, not at the first look where it is not seen.
    for (let i = 0; i < 5; i++) await look();
    expect(sent).toHaveLength(2);
    await look();
    expect(sent).toHaveLength(3);
    expect(sent[2].body.content).toMatch(/^\[Elysium\] over: stream dex \(after 6 h\)$/);
    await look();
    expect(sent).toHaveLength(3);
    expect(mockHash.size).toBe(0);
  });

  it('says nothing of the end of something it never said had started', async () => {
    failingDex();
    await look();
    mockStatus = healthy();
    for (let i = 0; i < 7; i++) await look();
    expect(sent).toEqual([]);
    expect(mockHash.size).toBe(0);
  });

  it('a stream that fails every other run is said: a look between two failures does not start its count over', async () => {
    for (let i = 0; i < 5; i++) {
      if (i % 2 === 0) failingDex();
      else mockStatus = healthy();
      await look();
      if (i < 4) expect(sent).toEqual([]);
    }
    // Failing at minutes 1, 3 and 5, fine at 2 and 4: at the third failure it has lasted four minutes, and is said.
    expect(sent).toHaveLength(1);
    expect(sent[0].body.content).toContain('stream dex is failing');
  });

  it('a condition said that is not seen at one look is not over: no "over", then "failing" again', async () => {
    failingDex();
    for (let i = 0; i < 4; i++) await look();
    expect(sent).toHaveLength(1);
    mockStatus = healthy();
    await look();
    failingDex();
    await look();
    await look(10);
    expect(sent).toHaveLength(1);
  });

  it('a part of the status that could not be read ends nothing: the day is neither over nor said again', async () => {
    unrepairedDay();
    await look();
    expect(sent).toHaveLength(1);
    // The query of the compared days fails for ten minutes.
    mockStatus = { ...healthy(), partial: ['completeness'], completeness: { days: [] } };
    for (let i = 0; i < 10; i++) await look();
    unrepairedDay();
    await look();
    expect(sent).toHaveLength(1);
  });

  it('a status that is not computed any more is said, and ends nothing', async () => {
    failingDex();
    for (let i = 0; i < 4; i++) await look();
    expect(sent).toHaveLength(1);
    // The status stays as it was computed at that time, with dex failing in it or not: it is old.
    mockComputedAt = clock;
    mockStatus = healthy();
    for (let i = 0; i < 8; i++) await look();
    expect(sent.map((m) => String(m.body.content))).toEqual([expect.stringContaining('stream dex is failing'), expect.stringContaining('has not been computed for 6 min')]);
    // Computed again, with dex still failing: nothing was over meanwhile.
    mockComputedAt = null;
    failingDex();
    for (let i = 0; i < 6; i++) await look();
    expect(sent).toHaveLength(3);
    expect(sent[2].body.content).toMatch(/^\[Elysium\] over: status/);
  });

  it('a day that leaves the list of compared days was not made equal: no "over" for it', async () => {
    unrepairedDay();
    await look();
    expect(sent).toHaveLength(1);
    mockStatus.completeness = { days: [{ day: '2026-11-11', status: 'ok', txs: 5, providerTxs: 5, spam: 0, providerSpam: 0 }] };
    for (let i = 0; i < 8; i++) await look();
    expect(sent).toHaveLength(1);
    expect(mockHash.size).toBe(0);
  });

  it('a day made equal is over', async () => {
    unrepairedDay();
    await look();
    mockStatus = healthy();
    for (let i = 0; i < 7; i++) await look();
    expect(sent.map((m) => String(m.body.content))[1]).toMatch(/^\[Elysium\] over: day 2026-11-10/);
  });

  it('a webhook that does not answer is asked once a look, not once per message', async () => {
    failingDex();
    unrepairedDay();
    mockStatus.database = { bytes: 81e9, volumeBytes: 100e9, usedShare: 0.81 };
    (global.fetch as jest.Mock).mockRejectedValue(new Error('connect ETIMEDOUT'));
    for (let i = 0; i < 4; i++) await look();
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(4);
  });

  it('says that nothing is being watched when the status cannot be read for 5 looks, and when it can again', async () => {
    mockStatusFails = true;
    for (let i = 0; i < 4; i++) await look();
    expect(sent).toEqual([]);
    await look();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.content).toBe('[Elysium] the status of the ingestion could not be read for 5 min: nothing is being watched meanwhile');
    for (let i = 0; i < 30; i++) await look();
    expect(sent).toHaveLength(1);
    mockStatusFails = false;
    await look();
    expect(sent).toHaveLength(2);
    expect(sent[1].body.content).toBe('[Elysium] over: the status of the ingestion can be read again');
    await look();
    expect(sent).toHaveLength(2);
  });

  it('warns at start when the address is Telegram\'s and no chat is given: no message would arrive', () => {
    process.env.ELYSIUM_ALERT_WEBHOOK_URL = 'https://api.telegram.org/botTOKEN/sendMessage';
    svc.start();
    svc.stop();
    expect(mockLog.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockLog.error.mock.calls)).not.toContain('TOKEN');
    mockLog.error.mockClear();
    process.env.ELYSIUM_ALERT_TELEGRAM_CHAT_ID = '-100123';
    svc.start();
    svc.stop();
    expect(mockLog.error).not.toHaveBeenCalled();
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
    unrepairedDay();
    await look();
    expect(sent[0].body).toMatchObject({ chat_id: '-100123', text: expect.stringContaining('2026-11-10 still differs from the provider') });
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
