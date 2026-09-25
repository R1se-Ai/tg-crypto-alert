import { describe, expect, it, vi } from 'vitest';
import {
  aggregate,
  aggregateWindows,
  barsNeeded,
  baseWindowFor,
  BinanceClient,
  bucketStartOf,
  BybitClient,
  CachedMarketClient,
  MemoryKlineCache,
  FailoverMarketClient,
  fetchSnapshots,
  fromOkxInstId,
  MarketHttpError,
  isValidKline,
  OkxClient,
  parseKlineArray,
  RATE_LIMIT_DEGRADE_MS,
  SNAPSHOT_BUDGET_MS,
  toOkxInstId,
  validateSymbols,
  type FetchLike,
  type MarketClient,
} from '../src/market';
import type { Kline, SymbolConfig, WindowKey } from '../src/types';
import { cfg } from './helpers';

const T5 = 300_000;

function k(openTime: number, open: number, close: number): Kline {
  return {
    openTime,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
  };
}

function jsonFetch(handler: (url: string) => unknown): FetchLike {
  return (async (input: string) => {
    const body = handler(input);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as FetchLike;
}

/** 按 URL 精细控制状态码，用来模拟"限流只打到其中一个接口" */
function statusFetch(
  handler: (url: string) => { status?: number; body?: unknown },
): FetchLike {
  return (async (input: string) => {
    const { status = 200, body } = handler(input);
    return new Response(JSON.stringify(body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as FetchLike;
}

function okxSeries(): Array<readonly unknown[]> {
  // OKX 返回时间倒序
  return [
    [3 * T5, '106', '106', '104', '104'],
    [2 * T5, '104', '105', '103', '103'],
    [1 * T5, '102', '103', '101', '101'],
    [0, '100', '102', '99', '99'],
  ];
}

describe('K 线聚合', () => {
  it('解析数组形式的 K 线', () => {
    const k = parseKlineArray([0, '100', '110', '90', '105', '12']);
    expect(k).toEqual({ openTime: 0, open: 100, high: 110, low: 90, close: 105 });
    expect(isValidKline(k)).toBe(true);
    expect(isValidKline(parseKlineArray([0, 'a', '1', '1', '1']))).toBe(false);
  });

  it('按整点桶聚合，开盘取桶内第一根', () => {
    const base = [k(0, 100, 101), k(T5, 101, 102), k(2 * T5, 102, 103)];
    const out = aggregate(base, 900_000);
    expect(out).toHaveLength(1);
    expect(out[0].open).toBe(100);
    expect(out[0].high).toBe(103);
    expect(out[0].low).toBe(100);
    expect(out[0].close).toBe(103);
  });

  it('跨桶时保留每个桶', () => {
    const base = [k(0, 100, 101), k(T5, 101, 102), k(2 * T5, 102, 103), k(3 * T5, 103, 104)];
    const out = aggregate(base, 900_000);
    expect(out.map((x) => x.openTime)).toEqual([0, 900_000]);
    expect(out[1].open).toBe(103);
  });

  it('一份 5m K 线聚合出 5m/15m/1h 三个窗口', () => {
    const base = Array.from({ length: 12 }, (_, i) => k(i * T5, 100 + i, 101 + i));
    const out = aggregateWindows(base, '5m', ['5m', '15m', '1h']);
    expect(out['5m']).toHaveLength(12);
    expect(out['15m']).toHaveLength(4);
    expect(out['1h']).toHaveLength(1);
    expect(out['1h']![0].open).toBe(100);
  });

  it('最小粒度与所需根数', () => {
    expect(baseWindowFor(['15m', '5m', '1h'])).toBe('5m');
    expect(baseWindowFor(['1m', '15m'])).toBe('1m');
    expect(barsNeeded(['5m', '15m'], '5m')).toBe(8);
    expect(barsNeeded(['1h'], '1m')).toBe(65);
  });
});

describe('Binance 数据源', () => {
  it('批量拉取标记价与最新价', async () => {
    const fetchFn = jsonFetch((url) => {
      if (url.includes('premiumIndex')) return [{ symbol: 'BTCUSDT', markPrice: '61000.5' }];
      if (url.includes('ticker/price')) return [{ symbol: 'BTCUSDT', price: '61005.1' }];
      return {};
    });
    const client = new BinanceClient('https://example.test', fetchFn);
    const map = await client.fetchPriceMap(['BTCUSDT']);
    expect(map.mark.get('BTCUSDT')).toBe(61000.5);
    expect(map.last.get('BTCUSDT')).toBe(61005.1);
  });

  it('拉取并解析 K 线', async () => {
    const fetchFn = jsonFetch(() => [
      [0, '100', '110', '90', '105'],
      [T5, '105', '120', '100', '118'],
    ]);
    const client = new BinanceClient('https://example.test', fetchFn);
    const klines = await client.fetchKlines('BTCUSDT', '5m', 2);
    expect(klines).toHaveLength(2);
    expect(klines[1].close).toBe(118);
  });

  it('仅返回 TRADING 状态的合约', async () => {
    const fetchFn = jsonFetch(() => ({
      symbols: [
        { symbol: 'BTCUSDT', status: 'TRADING' },
        { symbol: 'OLDUSDT', status: 'BREAK' },
      ],
    }));
    const client = new BinanceClient('https://example.test', fetchFn);
    expect(await client.listSymbols()).toEqual(['BTCUSDT']);
  });

  it('默认 fetch 走 globalThis（Workers 下解绑会 Illegal invocation）', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      (async (input: string) => {
        calls.push(input);
        return new Response('{"symbols":[]}', { status: 200 });
      }) as unknown as typeof fetch,
    );
    await new BinanceClient('https://example.test').listSymbols();
    expect(calls[0]).toContain('exchangeInfo');
    vi.unstubAllGlobals();
  });

  it('非 2xx 直接抛错', async () => {
    const fetchFn = (async () => new Response('nope', { status: 500 })) as FetchLike;
    await expect(new BinanceClient('https://example.test', fetchFn).listSymbols()).rejects.toThrow(
      /500/,
    );
  });

  it('ticker/price 被限流时 premiumIndex 仍支撑判定', async () => {
    const fetchFn = statusFetch((url) => {
      if (url.includes('ticker/price')) return { status: 429 };
      if (url.includes('premiumIndex'))
        return { body: [{ symbol: 'BTCUSDT', markPrice: '61000.5' }] };
      return { status: 200 };
    });
    const map = await new BinanceClient('https://example.test', fetchFn).fetchPriceMap(['BTCUSDT']);
    expect(map.mark.get('BTCUSDT')).toBe(61000.5);
    expect(map.last.size).toBe(0);
  });

  it('premiumIndex 被限流时判定基准缺失，明确抛错', async () => {
    const fetchFn = statusFetch((url) => {
      if (url.includes('premiumIndex')) return { status: 429 };
      if (url.includes('ticker/price')) return { body: [{ symbol: 'BTCUSDT', price: '61005' }] };
      return { status: 200 };
    });
    await expect(
      new BinanceClient('https://example.test', fetchFn).fetchPriceMap(['BTCUSDT']),
    ).rejects.toThrow(/premiumIndex/);
  });
});

describe('OKX 数据源', () => {
  it('合约代码互转', () => {
    expect(toOkxInstId('BTCUSDT')).toBe('BTC-USDT-SWAP');
    expect(toOkxInstId('XAUUSDT')).toBe('XAU-USDT-SWAP');
    expect(fromOkxInstId('BTC-USDT-SWAP')).toBe('BTCUSDT');
  });

  it('K 线由倒序翻正为升序', async () => {
    const fetchFn = jsonFetch(() => ({ data: okxSeries() }));
    const client = new OkxClient('https://example.test', fetchFn);
    const klines = await client.fetchKlines('BTCUSDT', '5m', 4);
    expect(klines.map((x) => x.openTime)).toEqual([0, T5, 2 * T5, 3 * T5]);
  });

  it('只保留目标标的的价格', async () => {
    const fetchFn = jsonFetch((url) => {
      if (url.includes('mark-price')) {
        return { data: [{ instId: 'BTC-USDT-SWAP', markPx: '61000' }, { instId: 'ETH-USDT-SWAP', markPx: '3000' }] };
      }
      return { data: [{ instId: 'BTC-USDT-SWAP', last: '61001' }] };
    });
    const client = new OkxClient('https://example.test', fetchFn);
    const map = await client.fetchPriceMap(['BTCUSDT']);
    expect([...map.mark.keys()]).toEqual(['BTCUSDT']);
    expect(map.last.get('BTCUSDT')).toBe(61001);
  });

  it('tickers 被限流时 mark-price 仍支撑判定', async () => {
    const fetchFn = statusFetch((url) => {
      if (url.includes('market/tickers')) return { status: 429 };
      if (url.includes('mark-price'))
        return { body: { data: [{ instId: 'BTC-USDT-SWAP', markPx: '61000.5' }] } };
      return { status: 200 };
    });
    const map = await new OkxClient('https://example.test', fetchFn).fetchPriceMap(['BTCUSDT']);
    expect(map.mark.get('BTCUSDT')).toBe(61000.5);
    expect(map.last.size).toBe(0);
  });

  it('mark-price 被限流时判定基准缺失，明确抛错', async () => {
    const fetchFn = statusFetch((url) => {
      if (url.includes('mark-price')) return { status: 429 };
      if (url.includes('market/tickers'))
        return { body: { data: [{ instId: 'BTC-USDT-SWAP', last: '61001' }] } };
      return { status: 200 };
    });
    await expect(
      new OkxClient('https://example.test', fetchFn).fetchPriceMap(['BTCUSDT']),
    ).rejects.toThrow(/mark-price/);
  });
});

describe('Bybit 数据源', () => {
  it('批量拉取标记价与最新价', async () => {
    const fetchFn = jsonFetch(() => ({
      retCode: 0,
      result: {
        list: [{ symbol: 'BTCUSDT', markPrice: '61000.5', lastPrice: '61005.1' }],
      },
    }));
    const map = await new BybitClient('https://example.test', fetchFn).fetchPriceMap(['BTCUSDT']);
    expect(map.mark.get('BTCUSDT')).toBe(61000.5);
    expect(map.last.get('BTCUSDT')).toBe(61005.1);
  });

  it('K 线返回倒序，需反转成升序', async () => {
    const fetchFn = jsonFetch(() => ({
      retCode: 0,
      result: {
        list: [
          [T5, '105', '120', '100', '118'],
          [0, '100', '110', '90', '105'],
        ],
      },
    }));
    const klines = await new BybitClient('https://example.test', fetchFn).fetchKlines(
      'BTCUSDT',
      '5m',
      2,
    );
    expect(klines.map((x) => x.openTime)).toEqual([0, T5]);
    expect(klines[1].close).toBe(118);
  });

  it('窗口映射为 Bybit 的分钟数（1h -> 60）', async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: string) => {
      urls.push(input);
      return new Response(JSON.stringify({ retCode: 0, result: { list: [] } }), { status: 200 });
    }) as FetchLike;
    await new BybitClient('https://example.test', fetchFn).fetchKlines('BTCUSDT', '1h', 8);
    expect(urls[0]).toContain('interval=60');
    expect(urls[0]).toContain('category=linear');
  });

  it('retCode 非 0 视为失败，即使 HTTP 200', async () => {
    const fetchFn = jsonFetch(() => ({ retCode: 10001, retMsg: 'params error' }));
    await expect(
      new BybitClient('https://example.test', fetchFn).fetchPriceMap(['BTCUSDT']),
    ).rejects.toThrow(/10001/);
  });

  it('只返回 Trading 状态的合约', async () => {
    const fetchFn = jsonFetch(() => ({
      retCode: 0,
      result: {
        list: [
          { symbol: 'BTCUSDT', status: 'Trading' },
          { symbol: 'OLDUSDT', status: 'Settling' },
        ],
      },
    }));
    expect(await new BybitClient('https://example.test', fetchFn).listSymbols()).toEqual([
      'BTCUSDT',
    ]);
  });
});

describe('限流重试', () => {
  it('429 快速失败：不重试，交给下一轮', async () => {
    let calls = 0;
    const fn = (async () => {
      calls += 1;
      if (calls === 1) return new Response('{}', { status: 429 });
      return new Response(JSON.stringify({ symbols: [] }), { status: 200 });
    }) as FetchLike;
    // 单轮内重试会把整轮耗时拖到数分钟，进而被平台静默掐断；
    // Cron 每 2 分钟一轮，下一轮自然重试，比在本轮死等划算得多。
    await expect(new BinanceClient('https://example.test', fn).listSymbols()).rejects.toThrow(
      /429/,
    );
    expect(calls).toBe(1);
  });

  it('403 属于地域限制，不重试', async () => {
    let calls = 0;
    const fn = (async () => {
      calls += 1;
      return new Response('{}', { status: 403 });
    }) as FetchLike;
    await expect(new BinanceClient('https://example.test', fn).listSymbols()).rejects.toThrow(
      /403/,
    );
    expect(calls).toBe(1);
  });

  it('重试次数用尽后抛出最后一次错误', async () => {
    let calls = 0;
    const fn = (async () => {
      calls += 1;
      return new Response('{}', { status: 500 });
    }) as FetchLike;
    await expect(new OkxClient('https://example.test', fn).listSymbols()).rejects.toThrow(/500/);
    expect(calls).toBe(3);
  });
});

describe('多源切换', () => {
  function fakeClient(name: string, behavior?: () => never): MarketClient {
    return {
      name,
      fetchPriceMap: async () => {
        if (behavior) behavior();
        return { mark: new Map([[name, 1]]), last: new Map([[name, 1]]) };
      },
      fetchKlines: async () => [k(0, 100, 100)],
      listSymbols: async () => [`${name}USDT`],
    };
  }

  it('首选源正常时不切换', async () => {
    const onError = vi.fn();
    const c = new FailoverMarketClient([fakeClient('okx'), fakeClient('bybit')], onError);
    expect((await c.fetchPriceMap(['BTCUSDT'])).mark.has('okx')).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(c.name).toBe('okx');
  });

  it('首选源失败时切到下一个源', async () => {
    const onError = vi.fn();
    const broken = fakeClient('okx', () => {
      throw new Error('timeout');
    });
    const c = new FailoverMarketClient([broken, fakeClient('bybit')], onError);
    expect((await c.fetchPriceMap(['BTCUSDT'])).mark.has('bybit')).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('前两个源都挂时第三个源顶上', async () => {
    const okx: MarketClient = {
      ...fakeClient('okx'),
      fetchKlines: async () => {
        throw new MarketHttpError(429, 'okx 返回 HTTP 429');
      },
    };
    const bybit: MarketClient = {
      ...fakeClient('bybit'),
      fetchKlines: async () => {
        throw new MarketHttpError(403, 'bybit 返回 HTTP 403');
      },
    };
    const c = new FailoverMarketClient([okx, bybit, fakeClient('binance')], () => {});
    expect((await c.fetchKlines('BTCUSDT', '5m', 8)).length).toBeGreaterThan(0);
    expect(c.name).toBe('binance');
  });

  it('失败的源进入冷却，同一轮内其余标的不再回探', async () => {
    let primaryCalls = 0;
    const primary: MarketClient = {
      ...fakeClient('okx'),
      fetchKlines: async () => {
        primaryCalls += 1;
        throw new Error('403');
      },
    };
    let now = 1_000_000;
    const c = new FailoverMarketClient([primary, fakeClient('bybit')], () => {}, () => now);

    await c.fetchKlines('BTCUSDT', '5m', 8);
    expect(primaryCalls).toBe(1);
    expect(c.degraded).toBe(true);

    // 同一轮内其余标的直接走下一个源，避免价格与 K 线跨所混用
    await c.fetchKlines('ETHUSDT', '5m', 8);
    await c.fetchPriceMap(['BTCUSDT']);
    expect(primaryCalls).toBe(1);
    expect(c.name).toBe('bybit');

    // 超过降级窗口后重新探测首选源
    now += 11 * 60_000;
    expect(c.degraded).toBe(false);
    await c.fetchKlines('BTCUSDT', '5m', 8);
    expect(primaryCalls).toBe(2);
  });

  it('限流（429）的冷却窗口更短，短探快回', async () => {
    let now = 1_000_000;
    const limited: MarketClient = {
      ...fakeClient('okx'),
      fetchKlines: async () => {
        throw new MarketHttpError(429, 'okx 返回 HTTP 429');
      },
    };
    const c = new FailoverMarketClient([limited, fakeClient('bybit')], () => {}, () => now);
    expect((await c.fetchKlines('BTCUSDT', '5m', 8)).length).toBeGreaterThan(0);
    expect(c.name).toBe('bybit');
    expect(c.degraded).toBe(true);
    now += RATE_LIMIT_DEGRADE_MS + 1;
    expect(c.degraded).toBe(false);
  });

  it('所有源都失败时抛最后一个错误，下次调用重新全部尝试', async () => {
    let now = 1_000_000;
    let primaryCalls = 0;
    const primary: MarketClient = {
      ...fakeClient('okx'),
      fetchKlines: async () => {
        primaryCalls += 1;
        throw new Error('timeout');
      },
    };
    const secondary: MarketClient = {
      ...fakeClient('bybit'),
      fetchKlines: async () => {
        throw new MarketHttpError(403, 'bybit 返回 HTTP 403');
      },
    };
    const c = new FailoverMarketClient([primary, secondary], () => {}, () => now);

    await expect(c.fetchKlines('BTCUSDT', '5m', 8)).rejects.toThrow(/403/);
    // 全部冷却后不能因为冷却算错而彻底停摆
    await expect(c.fetchKlines('BTCUSDT', '5m', 8)).rejects.toThrow();
    expect(primaryCalls).toBe(2);
  });
});

describe('K 线缓存', () => {
  function innerClient(calls: { count: number }, bucket: number): MarketClient {
    return {
      name: 'okx',
      fetchPriceMap: async () => ({ mark: new Map(), last: new Map() }),
      // 末根 K 线属于当前窗口，代表"数据已更新到最新"
      fetchKlines: async () => {
        calls.count += 1;
        return [
          { openTime: bucket - 300_000, open: 100, high: 110, low: 99, close: 105 },
          { openTime: bucket, open: 105, high: 106, low: 100, close: 106 },
        ];
      },
      listSymbols: async () => ['BTCUSDT'],
    };
  }

  it('同一窗口内复用缓存，不重复请求交易所', async () => {
    const bucket = 1_800_000_000_000 - (1_800_000_000_000 % 300_000);
    const calls = { count: 0 };
    const c = new CachedMarketClient(innerClient(calls, bucket), new MemoryKlineCache(), () => bucket);

    await c.fetchKlines('BTCUSDT', '5m', 8);
    // 缓存依据是最后一根 K 线所属窗口，同一窗口内直接复用
    await c.fetchKlines('BTCUSDT', '5m', 8);
    expect(calls.count).toBe(1);
  });

  it('跨窗口后重新拉取', async () => {
    const bucket = 1_800_000_000_000 - (1_800_000_000_000 % 300_000);
    const calls = { count: 0 };
    let now = bucket;
    const c = new CachedMarketClient(innerClient(calls, bucket), new MemoryKlineCache(), () => now);

    await c.fetchKlines('BTCUSDT', '5m', 8);
    now += 300_000;
    await c.fetchKlines('BTCUSDT', '5m', 8);
    expect(calls.count).toBe(2);
  });

  it('窗口起点按整点对齐', () => {
    const ts = 1_800_000_123_456;
    expect(bucketStartOf(ts, '5m') % 300_000).toBe(0);
    expect(bucketStartOf(ts, '15m') % 900_000).toBe(0);
    expect(bucketStartOf(ts, '1h') % 3_600_000).toBe(0);
    expect(bucketStartOf(ts, '5m')).toBeLessThanOrEqual(ts);
  });
});

describe('快照组装与自检', () => {
  function fakeMarket(): MarketClient {
    return {
      name: 'fake',
      fetchPriceMap: async () => ({
        mark: new Map([['BTCUSDT', 106]]),
        last: new Map([['BTCUSDT', 106.5]]),
      }),
      fetchKlines: async () => [k(0, 100, 101), k(T5, 101, 103), k(2 * T5, 103, 106)],
      listSymbols: async () => ['BTCUSDT', 'ETHUSDT'],
    };
  }

  it('组装出各窗口的聚合 K 线', async () => {
    const res = await fetchSnapshots(fakeMarket(), [cfg({ windows: ['5m', '15m'] })], 1000);
    const snap = res.snapshots.get('BTCUSDT')!;
    expect(snap.markPrice).toBe(106);
    expect(snap.lastPrice).toBe(106.5);
    expect(snap.fetchedAt).toBe(1000);
    expect(snap.klines['5m']).toHaveLength(3);
    expect(snap.klines['15m']).toHaveLength(1);
    expect(snap.klines['15m']![0].open).toBe(100);
  });

  it('未启用的标的不会被拉取', async () => {
    const res = await fetchSnapshots(
      fakeMarket(),
      [cfg({ symbol: 'BTCUSDT', enabled: false })],
      1000,
    );
    expect(res.snapshots.size).toBe(0);
    expect(res.failures).toHaveLength(0);
  });

  it('单个标的失败时记录原因而不中断整体', async () => {
    const client = fakeMarket();
    const failing: MarketClient = { ...client, fetchKlines: async () => [] };
    const res = await fetchSnapshots(failing, [cfg()], 1000);
    expect(res.failures).toEqual([{ symbol: 'BTCUSDT', reason: 'K 线为空' }]);
  });

  it('预算耗尽后跳过剩余标的，本轮仍返回结果', async () => {
    let klineCalls = 0;
    const slow: MarketClient = {
      ...fakeMarket(),
      fetchKlines: async () => {
        klineCalls += 1;
        return [k(0, 100, 101)];
      },
    };
    const targets = [cfg({ symbol: 'BTCUSDT' }), cfg({ symbol: 'ETHUSDT' })];
    const res = await fetchSnapshots(slow, targets, 1000, 0);

    // 关键不是"少拉了几个"，而是本轮仍然带着结果返回，
    // 不会把整轮拖到被平台掐断（那意味着彻底没有诊断痕迹）。
    expect(klineCalls).toBe(0);
    expect(res.snapshots.size).toBe(0);
    expect(res.failures).toHaveLength(2);
    expect(res.failures[0].reason).toContain('超出单轮预算');
    expect(res.source).toBe('fake');
  });

  it('预算充足时正常拉取全部标的', async () => {
    const res = await fetchSnapshots(
      fakeMarket(),
      [cfg({ symbol: 'BTCUSDT' }), cfg({ symbol: 'ETHUSDT' })],
      1000,
      SNAPSHOT_BUDGET_MS,
    );
    expect(res.snapshots.size).toBe(2);
    expect(res.failures).toHaveLength(0);
  });

  it('校验交易对是否存在', async () => {
    const check = await validateSymbols(fakeMarket(), ['BTCUSDT', 'FAKEUSDT']);
    expect(check.ok).toEqual(['BTCUSDT']);
    expect(check.missing).toEqual(['FAKEUSDT']);
  });
});
