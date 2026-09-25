import { describe, expect, it } from 'vitest';
import { replaySymbol } from '../src/replay';
import type { Kline } from '../src/types';
import { cfg } from './helpers';

const T5 = 300_000;

function bars(closes: number[], range = 0): Kline[] {
  return closes.map((close, i) => ({
    openTime: i * T5,
    open: 100,
    high: Math.max(100, close) + range,
    low: Math.min(100, close) - range,
    close,
  }));
}

describe('历史回放', () => {
  it('统计触发次数并遵守冷却', () => {
    const closes = [100, 100, 100, 100, 101.5, 101.5, 100, 100, 100, 100, 103, 100];
    const r = replaySymbol(cfg({ threshold: { type: 'percent', value: 1 }, cooldownMinutes: 30 }), bars(closes));

    expect(r.scanned).toBe(12);
    // 第 5 根触发，随后 30 分钟内不重复，第 11 根（+3%，达到阈值两倍）再次触发
    expect(r.alerts).toHaveLength(2);
    expect(r.alerts[0].ts).toBe(4 * T5);
    expect(r.alerts[0].level).toBe('WARN');
    expect(r.alerts[1].ts).toBe(10 * T5);
    expect(r.alerts[1].level).toBe('CRITICAL');
    expect(r.maxAbsPct).toBeCloseTo(3);
  });

  it('阈值候选表给出各阈值下的触发根数', () => {
    const closes = [100, 100.6, 101.5, 103, 100, 108];
    const r = replaySymbol(cfg({ threshold: { type: 'percent', value: 1 } }), bars(closes));
    const at = (p: number) => r.thresholdScan.find((x) => x.percent === p)!.count;
    expect(at(0.5)).toBe(4);
    expect(at(1)).toBe(3);
    expect(at(3)).toBe(2);
    expect(at(8)).toBe(1);
  });

  it('15m 窗口以整点桶开盘价为基准', () => {
    // 前 3 根属于同一个 15m 桶，第 4 根进入新桶；同桶内后续触发被冷却挡掉
    const closes = [100, 101.2, 101.5, 100];
    const r = replaySymbol(
      cfg({ windows: ['15m'], threshold: { type: 'percent', value: 1 } }),
      bars(closes),
    );
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0].changePct).toBeCloseTo(1.2);
  });

  it('TradFi 休市后跳空被静默', () => {
    const tradfi = cfg({
      symbol: 'XAUUSDT',
      assetClass: 'tradfi',
      threshold: { type: 'percent', value: 0.5 },
    });
    const closes = [100, 106, 106.5, 106.8];
    const r = replaySymbol(tradfi, bars(closes));
    expect(r.alerts).toHaveLength(0);
    expect(r.gapSkipped).toBeGreaterThan(0);
  });

  it('加密资产不做跳空判定', () => {
    const r = replaySymbol(
      cfg({ threshold: { type: 'percent', value: 0.5 } }),
      bars([100, 106, 100, 100]),
    );
    expect(r.alerts).toHaveLength(1);
    expect(r.gapSkipped).toBe(0);
  });

  it('绝对金额阈值按金额判定', () => {
    const r = replaySymbol(
      cfg({ threshold: { type: 'absolute', value: 50 }, cooldownMinutes: 0 }),
      bars([100, 160, 100]),
    );
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0].changeAbs).toBeCloseTo(60);
  });
});
