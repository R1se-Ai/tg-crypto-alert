import type { Kline, MarketSnapshot, SymbolConfig, WindowKey } from './types';

import { defaultFetch, type FetchLike } from './http';

export type { FetchLike } from './http';
export { defaultFetch };

export const BINANCE_FAPI = 'https://fapi.binance.com';
export const OKX_API = 'https://www.okx.com';

/**
 * 只有服务端错误值得重试；403 这类地域限制重试也没用，429 也不重试。
 *
 * 429 不重试是刻意的：Cron 每 2 分钟就有一轮，下一轮自然会重试；
 * 而在单轮内重试三次（每次最长 8 秒）会把整轮耗时拖到数分钟，
 * 最终撞上 Workers 的执行上限被**静默掐断**——不抛异常，
 * 因此既不写巡检结果也不写错误，表现为监控停摆却毫无痕迹。
 */
export function isRetryableStatus(status: number): boolean {
  return status >= 500;
}

/** 重试退避（毫秒），总耗时控制在 Cron 周期内 */
export const RETRY_DELAYS_MS = [400, 1200];

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 带状态码的行情错误。
 * 上层据此区分「数据源不可用」（可切换备源）与「限流」（重试即可，不该切换）。
 */
export class MarketHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MarketHttpError';
  }

  /** 限流是暂时性的，换数据源通常无济于事（备源往往同样限流） */
  get rateLimited(): boolean {
    return this.status === 429;
  }
}

/** 带退避重试的 JSON 请求：限流（429）与 5xx 重试，其余错误立即抛出 */
export async function requestJson<T>(
  send: () => Promise<Response>,
  label: string,
  delays: number[] = RETRY_DELAYS_MS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const res = await send();
    if (res.ok) return (await res.json()) as T;
    lastError = new MarketHttpError(res.status, `${label} 返回 HTTP ${res.status}`);
    if (!isRetryableStatus(res.status) || attempt === delays.length) break;
    await sleep(delays[attempt]);
  }
  throw lastError;
}

/** 部分交易所会拒绝无 UA 的请求 */
export const DEFAULT_HEADERS: Record<string, string> = {
  accept: 'application/json',
  'user-agent': 'tg-crypto-alert/1.0 (+cloudflare-worker)',
};

export const WINDOW_MS: Record<WindowKey, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
};

const WINDOW_ORDER: WindowKey[] = ['1m', '5m', '15m', '1h'];

export interface PriceMap {
  /** symbol -> 标记价格 */
  mark: Map<string, number>;
  /** symbol -> 最新成交价 */
  last: Map<string, number>;
}

export interface KlineRange {
  startTime?: number;
  endTime?: number;
}

export interface MarketClient {
  readonly name: string;
  fetchPriceMap(symbols: string[]): Promise<PriceMap>;
  fetchKlines(
    symbol: string,
    window: WindowKey,
    limit: number,
    range?: KlineRange,
  ): Promise<Kline[]>;
  listSymbols(): Promise<string[]>;
}

/** 多个窗口共用的最小粒度 K 线，用于聚合出更大周期 */
export function baseWindowFor(windows: WindowKey[]): WindowKey {
  if (windows.length === 0) return '5m';
  return windows.reduce((a, b) =>
    WINDOW_ORDER.indexOf(b) < WINDOW_ORDER.indexOf(a) ? b : a,
  );
}

/** 为覆盖最大窗口所需拉取的最小粒度 K 线根数 */
export function barsNeeded(windows: WindowKey[], base: WindowKey): number {
  if (windows.length === 0) return 5;
  const max = Math.max(...windows.map((w) => WINDOW_MS[w]));
  return Math.min(100, Math.ceil(max / WINDOW_MS[base]) + 5);
}

/** Binance / OKX 的 K 线均为数组： [openTime, open, high, low, close, ...] */
export function parseKlineArray(raw: readonly unknown[]): Kline {
  return {
    openTime: Number(raw[0]),
    open: Number(raw[1]),
    high: Number(raw[2]),
    low: Number(raw[3]),
    close: Number(raw[4]),
  };
}

export function isValidKline(k: Kline): boolean {
  return [k.openTime, k.open, k.high, k.low, k.close].every((v) => Number.isFinite(v));
}

/** 把小周期 K 线聚合为大周期：按开盘时间对齐到整点桶 */
export function aggregate(base: Kline[], bucketMs: number): Kline[] {
  const buckets = new Map<number, Kline>();
  for (const k of base) {
    if (!Number.isFinite(k.openTime)) continue;
    const b = Math.floor(k.openTime / bucketMs) * bucketMs;
    const cur = buckets.get(b);
    if (!cur) {
      buckets.set(b, { openTime: b, open: k.open, high: k.high, low: k.low, close: k.close });
      continue;
    }
    cur.high = Math.max(cur.high, k.high);
    cur.low = Math.min(cur.low, k.low);
    cur.close = k.close;
  }
  return [...buckets.values()].sort((a, b) => a.openTime - b.openTime);
}

/**
 * 用一份最小粒度 K 线聚合出所有需要的窗口。
 * 这样 5m/15m/1h 三个窗口只需要一次 K 线请求。
 */
export function aggregateWindows(
  base: Kline[],
  baseWindow: WindowKey,
  windows: WindowKey[],
): Partial<Record<WindowKey, Kline[]>> {
  const out: Partial<Record<WindowKey, Kline[]>> = {};
  if (base.length === 0) return out;
  for (const w of windows) {
    out[w] = w === baseWindow ? base.slice() : aggregate(base, WINDOW_MS[w]);
  }
  return out;
}

/* ------------------------------- Binance ------------------------------- */

export class BinanceClient implements MarketClient {
  readonly name = 'binance';

  constructor(
    private readonly baseUrl: string = BINANCE_FAPI,
    private readonly fetchFn: FetchLike = defaultFetch,
    private readonly timeoutMs: number = 8_000,
  ) {}

  private async getJson<T>(path: string): Promise<T> {
    return requestJson<T>(
      () =>
        this.fetchFn(`${this.baseUrl}${path}`, {
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: DEFAULT_HEADERS,
        }),
      `Binance ${path}`,
    );
  }

  async fetchPriceMap(_symbols: string[]): Promise<PriceMap> {
    // premiumIndex 是判定基准（markPrice），必须拿到；ticker/price 只是展示用 last。
    // 失败保留原始错误，不掩盖网络故障与限流的区别。
    let markError: unknown;
    const [premium, tickers] = await Promise.all([
      this.getJson<Array<Record<string, unknown>>>('/fapi/v1/premiumIndex').catch(
        (err: unknown) => {
          markError = err;
          return null;
        },
      ),
      this.getJson<Array<Record<string, unknown>>>('/fapi/v1/ticker/price').catch(() => null),
    ]);
    if (!premium) {
      throw markError ?? new MarketHttpError(429, 'Binance premiumIndex 不可用（可能被限流）');
    }
    const mark = new Map<string, number>();
    const last = new Map<string, number>();
    for (const r of premium ?? []) {
      const s = r?.symbol;
      if (typeof s === 'string' && Number.isFinite(Number(r.markPrice))) {
        mark.set(s, Number(r.markPrice));
      }
    }
    for (const r of tickers ?? []) {
      const s = r?.symbol;
      if (typeof s === 'string' && Number.isFinite(Number(r.price))) {
        last.set(s, Number(r.price));
      }
    }
    return { mark, last };
  }

  async fetchKlines(
    symbol: string,
    window: WindowKey,
    limit: number,
    range: KlineRange = {},
  ): Promise<Kline[]> {
    const params = new URLSearchParams({
      symbol,
      interval: window,
      limit: String(limit),
    });
    if (range.startTime !== undefined) params.set('startTime', String(range.startTime));
    if (range.endTime !== undefined) params.set('endTime', String(range.endTime));
    const raw = await this.getJson<Array<readonly unknown[]>>(`/fapi/v1/klines?${params}`);
    return (raw ?? []).map(parseKlineArray).filter(isValidKline);
  }

  async listSymbols(): Promise<string[]> {
    const info = await this.getJson<{ symbols?: Array<Record<string, unknown>> }>(
      '/fapi/v1/exchangeInfo',
    );
    return (info.symbols ?? [])
      .filter((s) => s.status === 'TRADING' && typeof s.symbol === 'string')
      .map((s) => String(s.symbol));
  }
}

/* --------------------------------- OKX --------------------------------- */

const OKX_BAR: Record<WindowKey, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H' };

/** BTCUSDT -> BTC-USDT-SWAP */
export function toOkxInstId(symbol: string): string {
  return symbol.endsWith('USDT') ? `${symbol.slice(0, -4)}-USDT-SWAP` : symbol;
}

/** BTC-USDT-SWAP -> BTCUSDT */
export function fromOkxInstId(instId: string): string {
  const m = /^([A-Z0-9]+)-USDT-SWAP$/.exec(instId);
  return m ? `${m[1]}USDT` : instId;
}

export class OkxClient implements MarketClient {
  readonly name = 'okx';

  constructor(
    private readonly baseUrl: string = OKX_API,
    private readonly fetchFn: FetchLike = defaultFetch,
    private readonly timeoutMs: number = 8_000,
  ) {}

  private async getJson<T>(path: string): Promise<T> {
    return requestJson<T>(
      () =>
        this.fetchFn(`${this.baseUrl}${path}`, {
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: DEFAULT_HEADERS,
        }),
      `OKX ${path}`,
    );
  }

  async fetchPriceMap(symbols: string[]): Promise<PriceMap> {
    // mark-price 是判定基准，必须拿到；tickers 只是展示用 last。
    // 限流经常只打到其中一个接口，别让展示字段毁掉整轮判定。
    // 失败要保留原始错误：网络断和限流的处置方式完全不同，不能一律包装成限流。
    let markError: unknown;
    const [markRes, tickerRes] = await Promise.all([
      this.getJson<{ data?: Array<Record<string, unknown>> }>(
        '/api/v5/public/mark-price?instType=SWAP',
      ).catch((err: unknown) => {
        markError = err;
        return null;
      }),
      this.getJson<{ data?: Array<Record<string, unknown>> }>(
        '/api/v5/market/tickers?instType=SWAP',
      ).catch(() => null),
    ]);
    if (!markRes) {
      throw markError ?? new MarketHttpError(429, 'OKX mark-price 不可用（可能被限流）');
    }
    const wanted = new Set(symbols);
    const mark = new Map<string, number>();
    const last = new Map<string, number>();
    for (const r of markRes.data ?? []) {
      const id = typeof r.instId === 'string' ? fromOkxInstId(r.instId) : '';
      if (wanted.has(id) && Number.isFinite(Number(r.markPx))) mark.set(id, Number(r.markPx));
    }
    for (const r of tickerRes?.data ?? []) {
      const id = typeof r.instId === 'string' ? fromOkxInstId(r.instId) : '';
      if (wanted.has(id) && Number.isFinite(Number(r.last))) last.set(id, Number(r.last));
    }
    return { mark, last };
  }

  async fetchKlines(
    symbol: string,
    window: WindowKey,
    limit: number,
    range: KlineRange = {},
  ): Promise<Kline[]> {
    const instId = toOkxInstId(symbol);
    const path = range.startTime ? '/api/v5/market/history-candles' : '/api/v5/market/candles';
    const params = new URLSearchParams({ instId, bar: OKX_BAR[window], limit: String(limit) });
    if (range.startTime !== undefined) params.set('after', String(range.startTime));
    if (range.endTime !== undefined) params.set('before', String(range.endTime));
    const res = await this.getJson<{ data?: Array<readonly unknown[]> }>(`${path}?${params}`);
    // OKX 返回时间倒序，判定引擎要求升序
    return (res.data ?? []).map(parseKlineArray).filter(isValidKline).reverse();
  }

  async listSymbols(): Promise<string[]> {
    const res = await this.getJson<{ data?: Array<Record<string, unknown>> }>(
      '/api/v5/public/instruments?instType=SWAP',
    );
    return (res.data ?? [])
      .filter((r) => r.state === 'live' && typeof r.instId === 'string')
      .map((r) => fromOkxInstId(String(r.instId)));
  }
}

/* --------------------------------- Bybit --------------------------------- */

export const BYBIT_API = 'https://api.bybit.com';

/** Bybit 的 interval 用分钟数表示，1h 是 60 */
const BYBIT_BAR: Record<WindowKey, string> = { '1m': '1', '5m': '5', '15m': '15', '1h': '60' };

interface BybitEnvelope {
  retCode?: number;
  retMsg?: string;
}

/**
 * Bybit v5。U 本位永续在 `category=linear` 下，合约代码就是 BTCUSDT，
 * 无需像 OKX 那样拼 -USDT-SWAP。
 * 选它当第三个源的原因：Binance 对 Cloudflare 出口 IP 恒定 403 形同虚设，
 * 而 Bybit 没有地域封锁，主流币种覆盖齐全。
 */
export class BybitClient implements MarketClient {
  readonly name = 'bybit';

  constructor(
    private readonly baseUrl: string = BYBIT_API,
    private readonly fetchFn: FetchLike = defaultFetch,
    private readonly timeoutMs: number = 8_000,
  ) {}

  /** Bybit 的失败藏在 HTTP 200 的 retCode 里，必须单独校验 */
  private async getJson<T>(path: string): Promise<T> {
    const res = await requestJson<T & BybitEnvelope>(
      () =>
        this.fetchFn(`${this.baseUrl}${path}`, {
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: DEFAULT_HEADERS,
        }),
      `Bybit ${path}`,
    );
    if (res.retCode !== undefined && res.retCode !== 0) {
      throw new Error(`Bybit ${path} 返回 retCode ${res.retCode}: ${res.retMsg ?? ''}`);
    }
    return res;
  }

  async fetchPriceMap(symbols: string[]): Promise<PriceMap> {
    const res = await this.getJson<{
      result?: { list?: Array<Record<string, unknown>> };
    }>('/v5/market/tickers?category=linear');
    const wanted = new Set(symbols);
    const mark = new Map<string, number>();
    const last = new Map<string, number>();
    for (const r of res.result?.list ?? []) {
      const s = typeof r.symbol === 'string' ? r.symbol : '';
      if (!wanted.has(s)) continue;
      if (Number.isFinite(Number(r.markPrice))) mark.set(s, Number(r.markPrice));
      if (Number.isFinite(Number(r.lastPrice))) last.set(s, Number(r.lastPrice));
    }
    return { mark, last };
  }

  async fetchKlines(
    symbol: string,
    window: WindowKey,
    limit: number,
    _range: KlineRange = {},
  ): Promise<Kline[]> {
    const params = new URLSearchParams({
      category: 'linear',
      symbol,
      interval: BYBIT_BAR[window],
      limit: String(limit),
    });
    const res = await this.getJson<{ result?: { list?: Array<readonly unknown[]> } }>(
      `/v5/market/kline?${params}`,
    );
    // Bybit 返回时间倒序，判定引擎要求升序
    return (res.result?.list ?? []).map(parseKlineArray).filter(isValidKline).reverse();
  }

  async listSymbols(): Promise<string[]> {
    const res = await this.getJson<{
      result?: { list?: Array<Record<string, unknown>> };
    }>('/v5/market/instruments-info?category=linear');
    return (res.result?.list ?? [])
      .filter((r) => r.status === 'Trading' && typeof r.symbol === 'string')
      .map((r) => String(r.symbol));
  }
}

/* ------------------------------ 多源 failover ------------------------------ */

/** 某个数据源失败后多久重新探测（毫秒） */
export const DEGRADE_WINDOW_MS = 10 * 60_000;

/** 限流类失败的降级窗口更短：限流常是共享出口 IP 的暂时性惩罚，短探快回 */
export const RATE_LIMIT_DEGRADE_MS = 2 * 60_000;

/** 相邻两个 K 线请求之间的间隔，避免整批请求撞进同一个限流窗口 */
export const KLINE_REQUEST_GAP_MS = 600;

export class FailoverMarketClient implements MarketClient {
  get name(): string {
    return this.active?.name ?? this.sources[0]?.name ?? 'none';
  }

  private active: MarketClient | null = null;
  /** 源名称 -> 下次允许重试的时间戳 */
  private readonly cooldown = new Map<string, number>();

  constructor(
    private readonly sources: MarketClient[],
    private readonly onError: (err: unknown) => void = () => {},
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * 第一个源（最高优先级）是否已失败过。
   * 粘滞是必要的：同一轮里价格与 K 线必须来自同一个交易所，
   * 否则两个所的标记价格口径不同，会直接扭曲窗口涨跌幅。
   */
  get degraded(): boolean {
    return (this.cooldown.get(this.sources[0]?.name ?? '') ?? 0) > this.now();
  }

  async fetchPriceMap(symbols: string[]): Promise<PriceMap> {
    return this.run((c) => c.fetchPriceMap(symbols));
  }

  async fetchKlines(symbol: string, window: WindowKey, limit: number): Promise<Kline[]> {
    return this.run((c) => c.fetchKlines(symbol, window, limit));
  }

  async listSymbols(): Promise<string[]> {
    return this.run((c) => c.listSymbols());
  }

  /**
   * 按优先级依次尝试，谁通谁上。失败的源进入冷却，冷却期内后续标的直接跳过它——
   * 这既保证同一轮内不跨所混用，也保证某个所持续限流时系统能漂到还能用的源，
   * 而不是陪它一起停摆。冷却到期后自动回探更高优先级的源。
   */
  private async run<T>(fn: (c: MarketClient) => Promise<T>): Promise<T> {
    let lastError: unknown;
    // 全部冷却时重新全部试一遍：宁可多打一次，也不要因为冷却算错而彻底停摆
    const candidates = this.available().length > 0 ? this.available() : this.sources;

    for (const source of candidates) {
      try {
        const r = await fn(source);
        this.active = source;
        this.cooldown.delete(source.name);
        return r;
      } catch (err) {
        lastError = err;
        this.onError(err);
        // 限流的冷却更短：常是共享出口 IP 的暂时性惩罚，短探快回
        const limited = err instanceof MarketHttpError && err.rateLimited;
        this.cooldown.set(
          source.name,
          this.now() + (limited ? RATE_LIMIT_DEGRADE_MS : DEGRADE_WINDOW_MS),
        );
      }
    }
    throw lastError;
  }

  private available(): MarketClient[] {
    const now = this.now();
    return this.sources.filter((c) => (this.cooldown.get(c.name) ?? 0) <= now);
  }
}

/* ------------------------------ K 线缓存层 ------------------------------ */

export interface CachedKlines {
  /** 缓存这批 K 线时，最后一根所属窗口的起点，用于判断是否需要刷新 */
  bucketStart: number;
  klines: Kline[];
}

export interface KlineCache {
  get(key: string): Promise<CachedKlines | null>;
  set(key: string, value: CachedKlines): Promise<void>;
}

export class MemoryKlineCache implements KlineCache {
  private readonly data = new Map<string, CachedKlines>();

  async get(key: string): Promise<CachedKlines | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: CachedKlines): Promise<void> {
    this.data.set(key, value);
  }
}

/** 窗口起点（整点对齐），与判定引擎的窗口口径一致 */
export function bucketStartOf(ts: number, window: WindowKey): number {
  return Math.floor(ts / WINDOW_MS[window]) * WINDOW_MS[window];
}

/**
 * 缓存 K 线，避免每轮巡检都打交易所。
 *
 * 窗口基准价是「当前窗口的开盘价」，在一个窗口内恒定不变，
 * 因此 5m 窗口的 K 线每 5 分钟才需要真正请求一次。
 * 这不是为了省请求而牺牲实时性：价格仍是每轮实时拉取，只有基准价走缓存。
 */
export class CachedMarketClient implements MarketClient {
  constructor(
    private readonly inner: MarketClient,
    private readonly cache: KlineCache = new MemoryKlineCache(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  get name(): string {
    return this.inner.name;
  }

  fetchPriceMap(symbols: string[]): Promise<PriceMap> {
    return this.inner.fetchPriceMap(symbols);
  }

  listSymbols(): Promise<string[]> {
    return this.inner.listSymbols();
  }

  async fetchKlines(symbol: string, window: WindowKey, limit: number): Promise<Kline[]> {
    const key = `${symbol}:${window}:${limit}`;
    const currentBucket = bucketStartOf(this.now(), window);
    const cached = await this.cache.get(key);
    // 缓存里最后一根正好属于当前窗口时直接复用
    if (cached && cached.bucketStart === currentBucket && cached.klines.length > 0) {
      return cached.klines;
    }

    const klines = await this.inner.fetchKlines(symbol, window, limit);
    const last = klines[klines.length - 1];
    if (last) {
      await this.cache.set(key, { bucketStart: last.openTime, klines });
    }
    return klines;
  }
}

/* -------------------------------- 组装快照 -------------------------------- */

export interface SnapshotFailure {
  symbol: string;
  reason: string;
}

/**
 * 单轮 K 线拉取的总预算（毫秒）。
 *
 * 数据源被限流时，串行请求会一路拖长；耗尽预算后跳过剩余标的，
 * 保证本轮**一定**能带着 partial 结果返回并记录诊断。
 * 宁可少监控几个标的，也不要整轮被掐断——后者是彻底的黑盒。
 */
export const SNAPSHOT_BUDGET_MS = 15_000;

export interface FetchSnapshotsResult {
  snapshots: Map<string, MarketSnapshot>;
  failures: SnapshotFailure[];
  /** 实际使用的数据源名称 */
  source: string;
}

/**
 * 拉取全部监控标的的快照。
 * 价格只需两次批量请求，K 线按标的并发拉取后聚合出各窗口。
 */
export async function fetchSnapshots(
  client: MarketClient,
  configs: SymbolConfig[],
  now: number = Date.now(),
  budgetMs: number = SNAPSHOT_BUDGET_MS,
): Promise<FetchSnapshotsResult> {
  const startedAt = Date.now();
  const targets = configs.filter((c) => c.enabled);
  const snapshots = new Map<string, MarketSnapshot>();
  const failures: SnapshotFailure[] = [];
  if (targets.length === 0) {
    return { snapshots, failures, source: client.name };
  }

  const priceMap = await client.fetchPriceMap(targets.map((c) => c.symbol));

  interface SnapshotResult {
    cfg: SymbolConfig;
    snapshot?: MarketSnapshot;
    error?: string;
  }

  // 串行 + 错峰：并发 6 个 K 线请求会直接撞上交易所的限流窗口
  const results: SnapshotResult[] = [];
  for (const [index, cfg] of targets.entries()) {
    if (Date.now() - startedAt >= budgetMs) {
      results.push({ cfg, error: `超出单轮预算 ${budgetMs}ms，本轮跳过` });
      continue;
    }
    const base = baseWindowFor(cfg.windows);
    const limit = barsNeeded(cfg.windows, base);
    try {
      const klines = await client.fetchKlines(cfg.symbol, base, limit);
      if (klines.length === 0) throw new Error('K 线为空');
      results.push({
        cfg,
        snapshot: {
          symbol: cfg.symbol,
          markPrice: priceMap.mark.get(cfg.symbol) ?? 0,
          lastPrice: priceMap.last.get(cfg.symbol) ?? 0,
          klines: aggregateWindows(klines, base, cfg.windows),
          fetchedAt: now,
        } satisfies MarketSnapshot,
      });
    } catch (err) {
      results.push({ cfg, error: err instanceof Error ? err.message : String(err) });
    }
    if (index < targets.length - 1) await sleep(KLINE_REQUEST_GAP_MS);
  }

  for (const r of results) {
    if (r.snapshot) snapshots.set(r.cfg.symbol, r.snapshot);
    else failures.push({ symbol: r.cfg.symbol, reason: r.error ?? '未知错误' });
  }
  return { snapshots, failures, source: client.name };
}

/**
 * 分页拉取历史 K 线，用于本地回放调阈值。
 * 单次请求上限 1000 根，按时间窗向前翻页。
 */
export async function fetchHistory(
  client: MarketClient,
  symbol: string,
  window: WindowKey,
  since: number,
  until: number,
  pageSize = 1000,
): Promise<Kline[]> {
  const step = WINDOW_MS[window];
  const out: Kline[] = [];
  let cursor = since;
  while (cursor < until) {
    const batch = await client.fetchKlines(symbol, window, pageSize, {
      startTime: cursor,
      endTime: until,
    });
    if (batch.length === 0) break;
    for (const k of batch) {
      if (k.openTime >= cursor && (out.length === 0 || k.openTime > out[out.length - 1].openTime)) {
        out.push(k);
      }
    }
    const last = batch[batch.length - 1].openTime;
    if (last <= cursor) break;
    cursor = last + step;
    if (batch.length < pageSize) break;
  }
  return out;
}

/**
 * 启动自检：校验配置的交易对是否真实存在。
 * 交易所没有该合约时静默失败最危险，宁可启动即报错。
 */
export async function validateSymbols(
  client: MarketClient,
  symbols: string[],
): Promise<{ ok: string[]; missing: string[] }> {
  const available = new Set(await client.listSymbols());
  const ok: string[] = [];
  const missing: string[] = [];
  for (const s of symbols) {
    (available.has(s) ? ok : missing).push(s);
  }
  return { ok, missing };
}
