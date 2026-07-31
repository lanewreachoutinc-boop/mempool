import PoolsRepository, { POOLS_STATS_INTERVALS } from '../repositories/PoolsRepository';
import { setupTestDatabase, waitForDatabase, cleanupTestData, insertTestPool, insertTestBlock, insertTestBlockAudit } from './test-helpers';

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3600000);
}

/** Block hashes only need to be unique and 64 hex chars wide for these tests. */
function blockHash(height: number): string {
  return height.toString(16).padStart(64, '0');
}

describe('PoolsRepository Integration Tests', () => {
  beforeAll(async () => {
    await waitForDatabase();
    await setupTestDatabase();
  }, 120000);

  beforeEach(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  test('should insert and retrieve a pool', async () => {
    const poolData = {
      name: 'Foundry USA',
      slug: 'foundryusa',
      link: 'https://foundrydigital.com',
      addresses: JSON.stringify(['bc1qxhmdufsvnuaaaer4ynz88fspdsxq2h9e9cetdj']),
      regexes: JSON.stringify(['/Foundry USA Pool/'])
    };

    const poolId = await insertTestPool(poolData);
    expect(poolId).toBeGreaterThan(0);

    const pools = await PoolsRepository.$getPools();
    const insertedPool = pools.find(p => p.id === poolId);

    expect(insertedPool).toBeDefined();
    expect(insertedPool?.name).toBe(poolData.name);
    expect(insertedPool?.slug).toBe(poolData.slug);
  });

  test('should get pool by slug', async () => {
    await insertTestPool({
      name: 'AntPool',
      slug: 'antpool',
      link: 'https://antpool.com'
    });

    const pool = await PoolsRepository.$getPool('antpool');

    expect(pool).toBeDefined();
    expect(pool!.name).toBe('AntPool');
    expect(pool!.slug).toBe('antpool');
  });

  test('should get all pools', async () => {
    await insertTestPool({
      name: 'Pool 1',
      slug: 'pool-1'
    });
    await insertTestPool({
      name: 'Pool 2',
      slug: 'pool-2'
    });
    await insertTestPool({
      name: 'Pool 3',
      slug: 'pool-3'
    });

    const pools = await PoolsRepository.$getPools();

    expect(pools.length).toBeGreaterThanOrEqual(3);
  });

  test('should handle pool with addresses', async () => {
    const addresses = ['bc1qtest1', 'bc1qtest2', '3TestAddress'];
    await insertTestPool({
      name: 'Multi Address Pool',
      slug: 'multi-address-pool',
      addresses: JSON.stringify(addresses)
    });

    const pool = await PoolsRepository.$getPool('multi-address-pool', false);

    expect(pool).toBeDefined();
    const poolAddresses = JSON.parse(pool!.addresses);
    expect(poolAddresses).toHaveLength(3);
    expect(poolAddresses).toContain('bc1qtest1');
  });

  test('should handle pool with regexes', async () => {
    const regexes = ['/Pool Name/', '/Alternative Name/'];
    await insertTestPool({
      name: 'Regex Pool',
      slug: 'regex-pool',
      regexes: JSON.stringify(regexes)
    });

    const pool = await PoolsRepository.$getPool('regex-pool', false);

    expect(pool).toBeDefined();
    const poolRegexes = JSON.parse(pool!.regexes);
    expect(poolRegexes).toHaveLength(2);
    expect(poolRegexes[0]).toBe('/Pool Name/');
  });

  test('should handle non-existent pool', async () => {
    const pool = await PoolsRepository.$getPool('non-existent-pool-slug');
    expect(pool).toBeNull();
  });

  test('should update pool information', async () => {
    const poolDbId = await insertTestPool({
      name: 'Original Pool Name',
      slug: 'original-pool'
    });

    // Update the pool name
    await PoolsRepository.$renameMiningPool(poolDbId, 'updated-pool', 'Updated Pool Name');

    const pool = await PoolsRepository.$getPool('updated-pool');
    expect(pool).toBeDefined();
    expect(pool!.name).toBe('Updated Pool Name');
  });

  describe('$getPoolsInfoPerInterval', () => {
    let poolA: number;
    let poolB: number;

    beforeEach(async () => {
      poolA = await insertTestPool({ id: 1, name: 'Pool A', slug: 'pool-a' });
      poolB = await insertTestPool({ id: 2, name: 'Pool B', slug: 'pool-b' });
    });

    test('should return an empty array for every interval on an empty database', async () => {
      const result = await PoolsRepository.$getPoolsInfoPerInterval();

      for (const interval of POOLS_STATS_INTERVALS) {
        expect(result[interval]).toEqual([]);
      }
    });

    test('should only count blocks inside each interval window', async () => {
      await insertTestBlock({ height: 1, hash: blockHash(1), blockTimestamp: hoursAgo(12), poolId: poolA });
      await insertTestBlock({ height: 2, hash: blockHash(2), blockTimestamp: hoursAgo(48), poolId: poolA });

      const result = await PoolsRepository.$getPoolsInfoPerInterval();

      expect(result['24h'][0].blockCount).toBe(1);
      expect(result['3d'][0].blockCount).toBe(2);
      expect(result['all'][0].blockCount).toBe(2);
    });

    test('should omit pools with no blocks in an interval', async () => {
      await insertTestBlock({ height: 1, hash: blockHash(1), blockTimestamp: hoursAgo(12), poolId: poolA });
      await insertTestBlock({ height: 2, hash: blockHash(2), blockTimestamp: hoursAgo(48), poolId: poolB });

      const result = await PoolsRepository.$getPoolsInfoPerInterval();

      expect(result['24h'].map(p => p.poolId)).toEqual([poolA]);
      expect(result['3d'].map(p => p.poolId).sort()).toEqual([poolA, poolB].sort());
    });

    test('should exclude stale blocks from every interval', async () => {
      await insertTestBlock({ height: 1, hash: blockHash(1), blockTimestamp: hoursAgo(1), poolId: poolA });
      await insertTestBlock({ height: 2, hash: blockHash(2), blockTimestamp: hoursAgo(1), poolId: poolA, stale: true });

      const result = await PoolsRepository.$getPoolsInfoPerInterval();

      expect(result['24h'][0].blockCount).toBe(1);
      expect(result['all'][0].blockCount).toBe(1);
    });

    test('should count empty blocks only within the interval', async () => {
      await insertTestBlock({ height: 1, hash: blockHash(1), blockTimestamp: hoursAgo(12), poolId: poolA, tx_count: 1 });
      await insertTestBlock({ height: 2, hash: blockHash(2), blockTimestamp: hoursAgo(12), poolId: poolA, tx_count: 500 });
      await insertTestBlock({ height: 3, hash: blockHash(3), blockTimestamp: hoursAgo(48), poolId: poolA, tx_count: 1 });

      const result = await PoolsRepository.$getPoolsInfoPerInterval();

      expect(result['24h'][0].emptyBlocks).toBe(1);
      expect(result['24h'][0].blockCount).toBe(2);
      expect(result['3d'][0].emptyBlocks).toBe(2);
    });

    test('should keep unaudited blocks and leave their averages null', async () => {
      await insertTestBlock({ height: 1, hash: blockHash(1), blockTimestamp: hoursAgo(1), poolId: poolA });

      const result = await PoolsRepository.$getPoolsInfoPerInterval();

      expect(result['24h'][0].blockCount).toBe(1);
      expect(result['24h'][0].avgMatchRate).toBeNull();
      expect(result['24h'][0].avgFeeDelta).toBeNull();
    });

    test('should average match rate over audited blocks only', async () => {
      await insertTestBlock({ height: 1, hash: blockHash(1), blockTimestamp: hoursAgo(1), poolId: poolA });
      await insertTestBlock({ height: 2, hash: blockHash(2), blockTimestamp: hoursAgo(1), poolId: poolA });
      await insertTestBlockAudit({ hash: blockHash(1), height: 1, matchRate: 90 });
      await insertTestBlockAudit({ hash: blockHash(2), height: 2, matchRate: 100 });

      const result = await PoolsRepository.$getPoolsInfoPerInterval();

      expect(result['24h'][0].blockCount).toBe(2);
      expect(Number(result['24h'][0].avgMatchRate)).toBeCloseTo(95, 5);
    });

    test('should compute the average fee delta against expected fees', async () => {
      // actual fees are 10% above expected, so the delta is 0.1
      await insertTestBlock({ height: 1, hash: blockHash(1), blockTimestamp: hoursAgo(1), poolId: poolA, fees: 1100 });
      await insertTestBlockAudit({ hash: blockHash(1), height: 1, matchRate: 100, expectedFees: 1000 });

      const result = await PoolsRepository.$getPoolsInfoPerInterval();

      expect(Number(result['24h'][0].avgFeeDelta)).toBeCloseTo(0.1, 5);
    });

    test('should sort pools by descending block count', async () => {
      await insertTestBlock({ height: 1, hash: blockHash(1), blockTimestamp: hoursAgo(1), poolId: poolA });
      await insertTestBlock({ height: 2, hash: blockHash(2), blockTimestamp: hoursAgo(1), poolId: poolB });
      await insertTestBlock({ height: 3, hash: blockHash(3), blockTimestamp: hoursAgo(1), poolId: poolB });

      const result = await PoolsRepository.$getPoolsInfoPerInterval();

      expect(result['24h'].map(p => p.poolId)).toEqual([poolB, poolA]);
      expect(result['24h'].map(p => p.blockCount)).toEqual([2, 1]);
    });

    test('should break block count ties deterministically', async () => {
      await insertTestBlock({ height: 1, hash: blockHash(1), blockTimestamp: hoursAgo(1), poolId: poolA });
      await insertTestBlock({ height: 2, hash: blockHash(2), blockTimestamp: hoursAgo(1), poolId: poolB });

      const first = await PoolsRepository.$getPoolsInfoPerInterval();
      const second = await PoolsRepository.$getPoolsInfoPerInterval();

      // unique_id decides, so the ranks assigned from this order stay stable across rebuilds
      expect(first['24h'].map(p => p.poolUniqueId)).toEqual([1, 2]);
      expect(second['24h'].map(p => p.poolUniqueId)).toEqual(first['24h'].map(p => p.poolUniqueId));
    });

    test('should match the legacy per-interval query', async () => {
      await insertTestBlock({ height: 1, hash: blockHash(1), blockTimestamp: hoursAgo(2), poolId: poolA, tx_count: 1 });
      await insertTestBlock({ height: 2, hash: blockHash(2), blockTimestamp: hoursAgo(3), poolId: poolA, fees: 1100 });
      await insertTestBlock({ height: 3, hash: blockHash(3), blockTimestamp: hoursAgo(4), poolId: poolB });
      await insertTestBlock({ height: 4, hash: blockHash(4), blockTimestamp: hoursAgo(48), poolId: poolB });
      await insertTestBlock({ height: 5, hash: blockHash(5), blockTimestamp: hoursAgo(2), poolId: poolB, stale: true });
      await insertTestBlockAudit({ hash: blockHash(2), height: 2, matchRate: 80, expectedFees: 1000 });

      const legacy = await PoolsRepository.$getPoolsInfo('24h');
      const combined = (await PoolsRepository.$getPoolsInfoPerInterval())['24h'];

      expect(combined.map(p => p.poolId)).toEqual(legacy.map(p => p.poolId));
      expect(combined.map(p => p.blockCount)).toEqual(legacy.map(p => p.blockCount));
      expect(combined.map(p => p.emptyBlocks)).toEqual(legacy.map(p => p.emptyBlocks));
      expect(combined.map(p => Number(p.avgMatchRate))).toEqual(legacy.map(p => Number(p.avgMatchRate)));
      expect(combined.map(p => Number(p.avgFeeDelta))).toEqual(legacy.map(p => Number(p.avgFeeDelta)));
    });
  });
});

