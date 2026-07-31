const mockGetPoolsInfoPerInterval = jest.fn();
const mockBlockCount = jest.fn();
const mockGetNetworkHashPs = jest.fn();

jest.mock('../../repositories/PoolsRepository', () => ({
  __esModule: true,
  default: { $getPoolsInfoPerInterval: mockGetPoolsInfoPerInterval },
  POOLS_STATS_INTERVALS: ['24h', 'all'],
}));

jest.mock('../../repositories/BlocksRepository', () => ({
  __esModule: true,
  default: { $blockCount: mockBlockCount },
}));

jest.mock('../../api/bitcoin/bitcoin-client', () => ({
  __esModule: true,
  default: { getNetworkHashPs: mockGetNetworkHashPs },
}));

// mining.ts pulls these in transitively, and merely importing them opens handles (a polling interval
// in backend-info, a mysql pool) that would keep the test runner alive after the suite finishes
jest.mock('../../repositories/PricesRepository', () => ({ __esModule: true, default: {} }));
jest.mock('../../database', () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock('../../api/bitcoin/bitcoin-api-factory', () => ({ __esModule: true, default: {} }));

import mining from '../../api/mining/mining';

/**
 * Builds a repository result whose block counts identify which rebuild produced it, so a test can tell
 * a superseded snapshot apart from a current one.
 */
function poolsInfo(blockCount: number) {
  const pool = {
    poolId: 1,
    name: 'Pool',
    link: '',
    slug: 'pool',
    poolUniqueId: 1,
    blockCount,
    emptyBlocks: 0,
    avgMatchRate: null,
    avgFeeDelta: null,
  };
  return { '24h': [pool], 'all': [pool] };
}

/** Lets a test hold a rebuild open until it decides to release it. */
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function resetCache() {
  const state = mining as unknown as Record<string, unknown>;
  state.poolsStatsCache = null;
  state.poolsStatsRebuild = null;
  state.poolsStatsGeneration = 0;
  state.poolsStatsSyncedGeneration = -1;
}

describe('Mining pools stats cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetCache();
    mockBlockCount.mockResolvedValue(0);
    mockGetNetworkHashPs.mockResolvedValue(0);
  });

  test('serves the cached snapshot without querying again', async () => {
    mockGetPoolsInfoPerInterval.mockResolvedValue(poolsInfo(1));

    const first = await mining.$getPoolsStats('24h');
    const second = await mining.$getPoolsStats('24h');

    expect(first.blockCount).toBe(1);
    expect(second.blockCount).toBe(1);
    expect(mockGetPoolsInfoPerInterval).toHaveBeenCalledTimes(1);
  });

  test('collapses concurrent cold-start requests into one rebuild', async () => {
    mockGetPoolsInfoPerInterval.mockResolvedValue(poolsInfo(1));

    await Promise.all([
      mining.$getPoolsStats('24h'),
      mining.$getPoolsStats('all'),
      mining.$getPoolsStats('24h'),
    ]);

    expect(mockGetPoolsInfoPerInterval).toHaveBeenCalledTimes(1);
  });

  test('does not rebuild while the cache is clean', async () => {
    mockGetPoolsInfoPerInterval.mockResolvedValue(poolsInfo(1));
    await mining.$getPoolsStats('24h');

    await mining.$getPoolsStats('24h');
    await mining.$getPoolsStats('all');

    expect(mockGetPoolsInfoPerInterval).toHaveBeenCalledTimes(1);
  });

  test('rebuilds on the next read once marked dirty', async () => {
    mockGetPoolsInfoPerInterval.mockResolvedValue(poolsInfo(1));
    await mining.$getPoolsStats('24h');

    mockGetPoolsInfoPerInterval.mockResolvedValue(poolsInfo(2));
    mining.markPoolsStatsDirty();

    // the read is served from the old snapshot, and kicks off the rebuild in the background
    expect((await mining.$getPoolsStats('24h')).blockCount).toBe(1);
    await new Promise(process.nextTick);

    expect(mockGetPoolsInfoPerInterval).toHaveBeenCalledTimes(2);
    expect((await mining.$getPoolsStats('24h')).blockCount).toBe(2);
  });

  test('an invalidation during a rebuild is not lost', async () => {
    const inFlight = deferred();
    mockGetPoolsInfoPerInterval.mockReturnValueOnce(inFlight.promise);

    const rebuilding = mining.$rebuildPoolsStatsCache();

    // a reorg lands while the first query is still running against pre-reorg rows
    mining.markPoolsStatsDirty();

    mockGetPoolsInfoPerInterval.mockResolvedValue(poolsInfo(2));
    inFlight.resolve(poolsInfo(1));
    await rebuilding;
    await new Promise(process.nextTick);

    // the superseded result must not be left behind as the current snapshot
    expect(mockGetPoolsInfoPerInterval).toHaveBeenCalledTimes(2);
    expect((await mining.$getPoolsStats('24h')).blockCount).toBe(2);
  });

  test('keeps serving the previous snapshot when a rebuild fails', async () => {
    mockGetPoolsInfoPerInterval.mockResolvedValue(poolsInfo(1));
    await mining.$getPoolsStats('24h');

    mockGetPoolsInfoPerInterval.mockRejectedValue(new Error('db is down'));
    await mining.$rebuildPoolsStatsCache();

    expect((await mining.$getPoolsStats('24h')).blockCount).toBe(1);
  });

  test('a failed rebuild does not retry itself in a loop', async () => {
    mockGetPoolsInfoPerInterval.mockResolvedValue(poolsInfo(1));
    await mining.$getPoolsStats('24h');

    mockGetPoolsInfoPerInterval.mockRejectedValue(new Error('db is down'));
    await mining.$rebuildPoolsStatsCache();
    const callsAfterFailure = mockGetPoolsInfoPerInterval.mock.calls.length;

    await new Promise(process.nextTick);
    await new Promise(process.nextTick);

    expect(mockGetPoolsInfoPerInterval).toHaveBeenCalledTimes(callsAfterFailure);
  });

  test('a failed rebuild leaves the cache dirty so the next read retries', async () => {
    mockGetPoolsInfoPerInterval.mockResolvedValue(poolsInfo(1));
    await mining.$getPoolsStats('24h');

    mockGetPoolsInfoPerInterval.mockRejectedValue(new Error('db is down'));
    await mining.$rebuildPoolsStatsCache();

    mockGetPoolsInfoPerInterval.mockResolvedValue(poolsInfo(2));
    await mining.$getPoolsStats('24h');
    await new Promise(process.nextTick);

    expect((await mining.$getPoolsStats('24h')).blockCount).toBe(2);
  });

  test('falls back to the all interval for an unrecognised one', async () => {
    mockGetPoolsInfoPerInterval.mockResolvedValue(poolsInfo(1));

    const stats = await mining.$getPoolsStats('not-an-interval');

    expect(stats).toBeDefined();
    expect(stats.blockCount).toBe(1);
  });
});
