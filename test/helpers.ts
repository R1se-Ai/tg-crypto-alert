import type { Kline, MarketSnapshot, SymbolConfig, WindowKey } from '../src/types';

export function kline(open: number, close: number, opts: Partial<Kline> = {}): Kline {
  return {
    openTime: 0,
    open,
    high: opts.high ?? Math.max(open, close),
    low: opts.low ?? Math.min(open, close),
    close: opts.close ?? close,
    ...opts,
  };
}

export interface SnapshotParams {
  symbol: string;
  markPrice: number;
  lastPrice?: number;
  /** 当前 5m 窗口开盘价 */
  open5m?: number;
  /** 当前 15m 窗口开盘价 */
  open15m?: number;
  /** 上一根已收盘 5m K 线，用于跳空检测 */
  prev5m?: Kline;
}

export function snapshot(p: SnapshotParams): MarketSnapshot {
  const klines: Partial<Record<WindowKey, Kline[]>> = {};
  if (p.open5m !== undefined) {
    const series: Kline[] = [];
    if (p.prev5m) series.push(p.prev5m);
    series.push(kline(p.open5m, p.markPrice));
    klines['5m'] = series;
  }
  if (p.open15m !== undefined) {
    klines['15m'] = [kline(p.open15m, p.markPrice)];
  }
  return {
    symbol: p.symbol,
    markPrice: p.markPrice,
    lastPrice: p.lastPrice ?? p.markPrice,
    klines,
    fetchedAt: 0,
  };
}

export function cfg(overrides: Partial<SymbolConfig> = {}): SymbolConfig {
  return {
    symbol: 'BTCUSDT',
    display: 'BTC',
    enabled: true,
    assetClass: 'crypto',
    windows: ['5m', '15m'],
    threshold: { type: 'percent', value: 1 },
    criticalMultiplier: 2,
    cooldownMinutes: 15,
    ...overrides,
  };
}
