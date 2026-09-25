import { describe, expect, it } from 'vitest';
import { DEFAULT_SYMBOLS } from '../src/config';
import {
  detectGap,
  evaluateSymbol,
  gapMuteUntil,
  klineRangePercent,
  percentChange,
  thresholdToPercent,
} from '../src/engine';
import type { SymbolConfig } from '../src/types';
import { cfg, kline, snapshot } from './helpers';

const NOW = 1_700_000_000_000;

function find(symbol: string): SymbolConfig {
  const c = DEFAULT_SYMBOLS.find((s) => s.symbol === symbol);
  if (!c) throw new Error(`默认配置中缺少 ${symbol}`);
  return c;
}

describe('基础数学', () => {
  it('百分比变动带符号', () => {
    expect(percentChange(100, 101)).toBeCloseTo(1);
    expect(percentChange(100, 98)).toBeCloseTo(-2);
  });

  it('K 线振幅', () => {
    expect(klineRangePercent(kline(100, 100, { high: 100, low: 100 }))).toBe(0);
    expect(klineRangePercent(kline(100, 102, { high: 104, low: 100 }))).toBeCloseTo(4);
  });

  it('绝对阈值换算为百分比', () => {
    expect(thresholdToPercent({ type: 'absolute', value: 50 }, 1000)).toBeCloseTo(5);
    expect(thresholdToPercent({ type: 'percent', value: 1 }, 1000)).toBe(1);
  });
});

describe('百分比阈值判定', () => {
  it('BTC 5m 涨 1.2% 触发 WARN', () => {
    const snap = snapshot({ symbol: 'BTCUSDT', markPrice: 101.2, open5m: 100 });
    const r = evaluateSymbol(find('BTCUSDT'), snap, { now: NOW });
    expect(r.triggered).toBe(true);
    expect(r.level).toBe('WARN');
    expect(r.window).toBe('5m');
    expect(r.changePct).toBeCloseTo(1.2);
  });

  it('达到阈值两倍判为 CRITICAL', () => {
    const snap = snapshot({ symbol: 'BTCUSDT', markPrice: 103, open5m: 100 });
    const r = evaluateSymbol(find('BTCUSDT'), snap, { now: NOW });
    expect(r.triggered).toBe(true);
    expect(r.level).toBe('CRITICAL');
  });

  it('未达阈值时给出距触发的差值', () => {
    const snap = snapshot({ symbol: 'BTCUSDT', markPrice: 100.4, open5m: 100 });
    const r = evaluateSymbol(find('BTCUSDT'), snap, { now: NOW });
    expect(r.triggered).toBe(false);
    expect(r.skipped).toBe('below-threshold');
    expect(r.windows[0].distanceToThreshold).toBeCloseTo(0.6);
  });

  it('下跌同样触发且为负值', () => {
    const snap = snapshot({ symbol: 'BTCUSDT', markPrice: 97, open5m: 100 });
    const r = evaluateSymbol(find('BTCUSDT'), snap, { now: NOW });
    expect(r.triggered).toBe(true);
    expect(r.changePct).toBeCloseTo(-3);
    expect(r.level).toBe('CRITICAL');
  });
});

describe('绝对金额阈值（ETH 50 USDT）', () => {
  it('变动 60 USDT 触发', () => {
    const snap = snapshot({ symbol: 'ETHUSDT', markPrice: 3060, open5m: 3000 });
    const r = evaluateSymbol(find('ETHUSDT'), snap, { now: NOW });
    expect(r.triggered).toBe(true);
    expect(r.changeAbs).toBeCloseTo(60);
    expect(r.level).toBe('WARN');
  });

  it('变动 30 USDT 不触发，差值 20', () => {
    const snap = snapshot({ symbol: 'ETHUSDT', markPrice: 3030, open5m: 3000 });
    const r = evaluateSymbol(find('ETHUSDT'), snap, { now: NOW });
    expect(r.triggered).toBe(false);
    expect(r.windows[0].distanceToThreshold).toBeCloseTo(20);
  });

  it('变动 120 USDT 判为 CRITICAL', () => {
    const snap = snapshot({ symbol: 'ETHUSDT', markPrice: 3120, open5m: 3000 });
    const r = evaluateSymbol(find('ETHUSDT'), snap, { now: NOW });
    expect(r.level).toBe('CRITICAL');
  });

  it('价格高位时百分比换算随之变化，但绝对阈值不变', () => {
    // ETH 涨到 6000 后，50 USDT 仅相当于 0.83%；判定始终以 50 USDT 为准
    const snap = snapshot({ symbol: 'ETHUSDT', markPrice: 6060, open5m: 6000 });
    const r = evaluateSymbol(find('ETHUSDT'), snap, { now: NOW });
    expect(r.triggered).toBe(true);
    expect(r.changeAbs).toBeCloseTo(60);
    expect(r.changePct).toBeCloseTo(1);
  });

  it('高位下不足 50 USDT 的波动不触发', () => {
    const snap = snapshot({ symbol: 'ETHUSDT', markPrice: 6040, open5m: 6000 });
    const r = evaluateSymbol(find('ETHUSDT'), snap, { now: NOW });
    expect(r.triggered).toBe(false);
    expect(r.windows[0].distanceToThreshold).toBeCloseTo(10);
  });
});

describe('多窗口取最强信号', () => {
  it('5m 未触发而 15m 触发时按 15m 告警', () => {
    const snap = snapshot({
      symbol: 'BTCUSDT',
      markPrice: 105,
      open5m: 104.9,
      open15m: 100,
    });
    const r = evaluateSymbol(find('BTCUSDT'), snap, { now: NOW });
    expect(r.triggered).toBe(true);
    expect(r.window).toBe('15m');
    expect(r.changePct).toBeCloseTo(5);
  });
});

describe('开关与冷却', () => {
  it('停用品种直接跳过', () => {
    const snap = snapshot({ symbol: 'BTCUSDT', markPrice: 110, open5m: 100 });
    const r = evaluateSymbol(cfg({ enabled: false }), snap, { now: NOW });
    expect(r.skipped).toBe('disabled');
    expect(r.triggered).toBe(false);
  });

  it('冷却期内不重复告警', () => {
    const snap = snapshot({ symbol: 'BTCUSDT', markPrice: 105, open5m: 100 });
    const r = evaluateSymbol(find('BTCUSDT'), snap, {
      now: NOW,
      lastAlertAt: NOW - 10 * 60_000,
    });
    expect(r.skipped).toBe('cooldown');
  });

  it('超过冷却期可再次告警', () => {
    const snap = snapshot({ symbol: 'BTCUSDT', markPrice: 105, open5m: 100 });
    const r = evaluateSymbol(find('BTCUSDT'), snap, {
      now: NOW,
      lastAlertAt: NOW - 31 * 60_000,
    });
    expect(r.triggered).toBe(true);
  });

  it('缺少行情数据时标记 no-data', () => {
    const snap = snapshot({ symbol: 'BTCUSDT', markPrice: 105 });
    const r = evaluateSymbol(find('BTCUSDT'), snap, { now: NOW });
    expect(r.skipped).toBe('no-data');
  });
});

describe('开盘跳空识别（TradFi）', () => {
  const sndk = find('SNDKUSDT');

  it('休市静止后突然跳变判为跳空', () => {
    const snap = snapshot({
      symbol: 'SNDKUSDT',
      markPrice: 106,
      open5m: 100,
      prev5m: kline(100, 100, { high: 100, low: 100 }),
    });
    expect(detectGap(sndk, snap)).toBe(true);
    const r = evaluateSymbol(sndk, snap, { now: NOW });
    expect(r.gapDetected).toBe(true);
    expect(r.triggered).toBe(false);
    expect(r.skipped).toBe('gap');
  });

  it('前一根有真实交易则不算跳空', () => {
    const snap = snapshot({
      symbol: 'SNDKUSDT',
      markPrice: 106,
      open5m: 100,
      prev5m: kline(99, 100, { high: 101, low: 98 }),
    });
    expect(detectGap(sndk, snap)).toBe(false);
    const r = evaluateSymbol(sndk, snap, { now: NOW });
    expect(r.triggered).toBe(true);
  });

  it('跳空静默期内持续跳过', () => {
    const snap = snapshot({
      symbol: 'SNDKUSDT',
      markPrice: 108,
      open5m: 104,
      prev5m: kline(100, 100, { high: 100, low: 100 }),
    });
    const r = evaluateSymbol(sndk, snap, {
      now: NOW + 5 * 60_000,
      gapMutedUntil: gapMuteUntil(NOW),
    });
    expect(r.skipped).toBe('gap');
  });

  it('静默期结束后恢复告警', () => {
    // 开盘 20 分钟后市场已恢复交易，前一根 K 线有了真实振幅
    const snap = snapshot({
      symbol: 'SNDKUSDT',
      markPrice: 108,
      open5m: 104,
      prev5m: kline(103, 104, { high: 105, low: 102 }),
    });
    const r = evaluateSymbol(sndk, snap, {
      now: NOW + 20 * 60_000,
      gapMutedUntil: gapMuteUntil(NOW),
    });
    expect(r.gapDetected).toBe(false);
    expect(r.skipped).toBeNull();
    expect(r.triggered).toBe(true);
    expect(r.changePct).toBeCloseTo(3.85, 1);
  });

  it('加密货币不参与跳空判定', () => {
    const snap = snapshot({
      symbol: 'BTCUSDT',
      markPrice: 106,
      open5m: 100,
      prev5m: kline(100, 100, { high: 100, low: 100 }),
    });
    expect(detectGap(find('BTCUSDT'), snap)).toBe(false);
  });
});

describe('默认配置完整性', () => {
  it('覆盖用户指定的六个品种', () => {
    const symbols = DEFAULT_SYMBOLS.map((s) => s.symbol);
    expect(symbols).toEqual([
      'BTCUSDT',
      'ETHUSDT',
      'BNBUSDT',
      'SNDKUSDT',
      'CLUSDT',
      'XAUUSDT',
    ]);
  });

  it('ETH 使用绝对金额阈值，其余使用百分比', () => {
    const eth = find('ETHUSDT');
    expect(eth.threshold).toEqual({ type: 'absolute', value: 50 });
    for (const s of DEFAULT_SYMBOLS.filter((x) => x.symbol !== 'ETHUSDT')) {
      expect(s.threshold.type).toBe('percent');
    }
  });

  it('TradFi 品种标记为 tradfi', () => {
    expect(find('SNDKUSDT').assetClass).toBe('tradfi');
    expect(find('CLUSDT').assetClass).toBe('tradfi');
    expect(find('XAUUSDT').assetClass).toBe('tradfi');
    expect(find('BTCUSDT').assetClass).toBe('crypto');
  });
});
