import { describe, expect, it, vi } from 'vitest';
import { handleIncoming, parseMinutes, parseThresholdSpec, type BotDeps } from '../src/bot';
import { MemoryStore } from '../src/store';
import type { Incoming } from '../src/telegram';
import type { MarketClient } from '../src/market';
import type { SymbolConfig } from '../src/types';
import { cfg } from './helpers';

const PCT = { type: 'percent', value: 1 } as const;
const ABS = { type: 'absolute', value: 50 } as const;

describe('阈值参数解析', () => {
  it('百分号后缀强制按百分比解析', () => {
    // 回归：曾经 fallback 是绝对值时，「1%」被解析成「1 USDT」
    expect(parseThresholdSpec(['1%'], ABS)).toEqual({ threshold: { type: 'percent', value: 1 }, assetClass: undefined });
    expect(parseThresholdSpec(['1.5%'], ABS)).toEqual({
      threshold: { type: 'percent', value: 1.5 },
      assetClass: undefined,
    });
    expect(parseThresholdSpec(['2pct'], ABS)).toEqual({
      threshold: { type: 'percent', value: 2 },
      assetClass: undefined,
    });
    expect(parseThresholdSpec(['2percent'], ABS)).toEqual({
      threshold: { type: 'percent', value: 2 },
      assetClass: undefined,
    });
  });

  it('u/usdt 后缀强制按绝对金额解析', () => {
    expect(parseThresholdSpec(['60u'], PCT)).toEqual({
      threshold: { type: 'absolute', value: 60 },
      assetClass: undefined,
    });
    expect(parseThresholdSpec(['60usdt'], PCT)).toEqual({
      threshold: { type: 'absolute', value: 60 },
      assetClass: undefined,
    });
  });

  it('裸数值沿用当前口径', () => {
    expect(parseThresholdSpec(['2'], PCT).threshold).toEqual({ type: 'percent', value: 2 });
    expect(parseThresholdSpec(['80'], ABS).threshold).toEqual({ type: 'absolute', value: 80 });
  });

  it('显式关键字仍可用，且支持任意顺序', () => {
    expect(parseThresholdSpec(['abs', '60'], PCT).threshold).toEqual({ type: 'absolute', value: 60 });
    expect(parseThresholdSpec(['60', 'pct'], ABS).threshold).toEqual({ type: 'percent', value: 60 });
    expect(parseThresholdSpec(['tradfi', '1%'], ABS)).toEqual({
      threshold: { type: 'percent', value: 1 },
      assetClass: 'tradfi',
    });
    expect(parseThresholdSpec(['crypto', '3'], PCT).assetClass).toBe('crypto');
  });

  it('小数、非法值与边界', () => {
    expect(parseThresholdSpec(['.5%'], ABS).threshold).toEqual({ type: 'percent', value: 0.5 });
    expect(parseThresholdSpec(['x'], PCT).error).toContain('无法识别');
    expect(parseThresholdSpec(['-1'], PCT).error).toBe('阈值必须大于 0');
    expect(parseThresholdSpec(['0'], PCT).error).toBe('阈值必须大于 0');
    expect(parseThresholdSpec([], PCT).error).toBe('缺少阈值数值');
  });
});

describe('分钟数解析', () => {
  it('取首个整数并限制范围', () => {
    expect(parseMinutes(['60'], 5)).toBe(60);
    expect(parseMinutes([], 5)).toBe(5);
    expect(parseMinutes(['0'], 5)).toBeNull();
    expect(parseMinutes(['9999'], 5)).toBeNull();
  });
});

function incoming(text: string): Incoming {
  const [head, ...args] = text.replace(/^\//, '').split(/\s+/);
  return {
    kind: 'command',
    chatId: '1',
    messageId: 1,
    userId: 1,
    command: head.toLowerCase(),
    args,
    raw: text,
  };
}

function deps(initial: SymbolConfig[]): BotDeps {
  const client = {
    name: 'fake',
    listSymbols: async () => ['SOLUSDT'],
  } as unknown as MarketClient;
  return { store: new MemoryStore(initial), client };
}

describe('改阈值回复明确标注口径', () => {
  it('原本是绝对金额，改百分比时落库为百分比而不是 USDT', async () => {
    const d = deps([cfg({ symbol: 'ETHUSDT', threshold: { type: 'absolute', value: 50 } })]);
    const reply = await handleIncoming(d, incoming('/set ETHUSDT 1%'), Date.now());
    expect(reply?.text).toContain('1%（百分比）');
    expect((await d.store.getSymbol('ETHUSDT'))?.threshold).toEqual({ type: 'percent', value: 1 });
  });

  it('绝对值口径回复带上 USDT 说明', async () => {
    const d = deps([cfg({ symbol: 'ETHUSDT', threshold: { type: 'percent', value: 1 } })]);
    const reply = await handleIncoming(d, incoming('/set ETHUSDT 60u'), Date.now());
    expect(reply?.text).toContain('60 USDT（绝对金额）');
  });

  it('新增标的同样标注口径', async () => {
    const d = deps([]);
    const reply = await handleIncoming(d, incoming('/add SOLUSDT 2%'), Date.now());
    expect(reply?.text).toContain('2%（百分比）');
  });

  it('窗口与冷却子命令不受影响', async () => {
    const d = deps([cfg({ symbol: 'BTCUSDT' })]);
    const w = await handleIncoming(d, incoming('/set BTCUSDT windows 15m,1h'), Date.now());
    expect(w?.text).toContain('15m/1h');
    expect((await d.store.getSymbol('BTCUSDT'))?.windows).toEqual(['15m', '1h']);

    const c = await handleIncoming(d, incoming('/set BTCUSDT cooldown 45'), Date.now());
    expect(c?.text).toContain('45 分钟');
    expect((await d.store.getSymbol('BTCUSDT'))?.cooldownMinutes).toBe(45);
  });
});
