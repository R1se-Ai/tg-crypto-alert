import { beforeEach, describe, expect, it } from 'vitest';
import {
  D1Store,
  MemoryStore,
  parseWindows,
  rowToAlert,
  rowToConfig,
  SCHEMA_SQL,
  SCHEMA_STATEMENTS,
  serializeWindows,
  type D1DatabaseLike,
  type D1PreparedLike,
} from '../src/store';
import { DEFAULT_SYMBOLS } from '../src/config';
import type { SymbolConfig } from '../src/types';
import { cfg } from './helpers';

interface FakeQuery {
  rows?: unknown[];
  first?: unknown | null;
}

class FakeD1 implements D1DatabaseLike {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];

  constructor(private readonly handler: (sql: string, params: unknown[]) => FakeQuery = () => ({})) {}

  async exec(sql: string): Promise<unknown> {
    this.calls.push({ sql, params: [] });
    return { count: 1 };
  }

  prepare(sql: string): D1PreparedLike {
    const self = this;
    let params: unknown[] = [];
    const stmt: D1PreparedLike = {
      bind(...values: unknown[]) {
        params = values;
        return stmt;
      },
      async all<T>() {
        self.calls.push({ sql, params });
        return { results: (self.handler(sql, params).rows ?? []) as T[] };
      },
      async first<T>() {
        self.calls.push({ sql, params });
        return (self.handler(sql, params).first ?? null) as T | null;
      },
      async run() {
        self.calls.push({ sql, params });
        return { success: true };
      },
    };
    return stmt;
  }

  sqlLike(fragment: string): { sql: string; params: unknown[] } | undefined {
    return this.calls.find((c) => c.sql.includes(fragment));
  }
}

const SYMBOL_ROW = {
  symbol: 'ETHUSDT',
  display: 'ETH',
  enabled: 1,
  asset_class: 'crypto',
  windows: '5m,15m',
  threshold_type: 'absolute',
  threshold_value: 50,
  critical_multiplier: 2,
  cooldown_minutes: 45,
};

describe('行映射', () => {
  it('解析窗口字符串', () => {
    expect(parseWindows('5m,15m')).toEqual(['5m', '15m']);
    expect(parseWindows('1h, 5m')).toEqual(['1h', '5m']);
    expect(parseWindows('abc')).toEqual(['5m', '15m']);
    expect(serializeWindows(['15m', '1h'])).toBe('15m,1h');
  });

  it('行转配置', () => {
    const c = rowToConfig(SYMBOL_ROW);
    expect(c.threshold).toEqual({ type: 'absolute', value: 50 });
    expect(c.cooldownMinutes).toBe(45);
    expect(c.enabled).toBe(true);
    expect(c.assetClass).toBe('crypto');
  });

  it('停用与 TradFi 标记', () => {
    const c = rowToConfig({ ...SYMBOL_ROW, enabled: 0, asset_class: 'tradfi' });
    expect(c.enabled).toBe(false);
    expect(c.assetClass).toBe('tradfi');
  });

  it('行转告警记录', () => {
    const a = rowToAlert({
      symbol: 'BTCUSDT',
      level: 'CRITICAL',
      window: '15m',
      change_abs: -120,
      change_pct: -1.8,
      mark_price: 61000,
      last_price: 61010,
      created_at: 1700000000000,
    });
    expect(a.level).toBe('CRITICAL');
    expect(a.window).toBe('15m');
    expect(a.createdAt).toBe(1700000000000);
  });
});

describe('默认清单', () => {
  it('冷却默认与最大窗口对齐：15 分钟', () => {
    // 回归：曾经是 30 分钟，同一标的持续恶化时半小时才一条，太迟钝
    for (const c of DEFAULT_SYMBOLS) {
      expect(c.cooldownMinutes).toBe(15);
    }
  });

  it('种子化落库的冷却与代码默认值一致', async () => {
    const db = new FakeD1((sql) => (sql.includes('COUNT(*)') ? { first: { n: 0 } } : {}));
    await new D1Store(db).init();
    const inserts = db.calls.filter((c) => c.sql.includes('INSERT INTO symbols'));
    expect(inserts.length).toBeGreaterThan(0);
    // upsertSymbol 的第 9 个绑定参数是 cooldown_minutes
    for (const ins of inserts) expect(ins.params[8]).toBe(15);
  });
});

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore([cfg()]);
  });

  it('默认写入种子配置并可增删', async () => {
    expect((await store.listSymbols()).map((c) => c.symbol)).toEqual(['BTCUSDT']);
    await store.upsertSymbol(cfg({ symbol: 'SOLUSDT' }));
    expect(await store.getSymbol('SOLUSDT')).not.toBeNull();
    await store.removeSymbol('SOLUSDT');
    expect(await store.getSymbol('SOLUSDT')).toBeNull();
  });

  it('冷却与跳空静默读写', async () => {
    expect(await store.getLastAlertAt('BTCUSDT')).toBeUndefined();
    await store.setLastAlertAt('BTCUSDT', 1000);
    expect(await store.getLastAlertAt('BTCUSDT')).toBe(1000);
    await store.setGapMutedUntil('BTCUSDT', 2000);
    expect(await store.getGapMutedUntil('BTCUSDT')).toBe(2000);
  });

  it('全局暂停与会话绑定', async () => {
    await store.setPausedUntil(999);
    expect(await store.getPausedUntil()).toBe(999);
    await store.setChatId('-100123');
    expect(await store.getChatId()).toBe('-100123');
  });

  it('通用状态读写', async () => {
    expect(await store.getState('nope')).toBeUndefined();
    await store.setState('webhook_url', 'https://x.dev/webhook');
    expect(await store.getState('webhook_url')).toBe('https://x.dev/webhook');
  });

  it('记录并查询告警', async () => {
    await store.recordAlert({
      symbol: 'BTCUSDT',
      level: 'WARN',
      window: '5m',
      changeAbs: 100,
      changePct: 1.2,
      markPrice: 61000,
      lastPrice: 61005,
      createdAt: 1,
    });
    expect(await store.recentAlerts('BTCUSDT', 5)).toHaveLength(1);
    expect(await store.recentAlerts('ETHUSDT', 5)).toHaveLength(0);
  });
});

describe('D1Store', () => {
  it('建表语句覆盖三张表', () => {
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS symbols');
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS alerts');
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS state');
  });

  it('init 逐条执行建表语句', async () => {
    const db = new FakeD1();
    await new D1Store(db).init();
    expect(db.calls[0].sql).toContain('CREATE TABLE IF NOT EXISTS symbols');
    // 每条建表语句都是单条，不含分号，D1 的 prepare().run() 才能执行
    for (const c of db.calls.slice(0, SCHEMA_STATEMENTS.length)) {
      expect(c.sql).not.toContain(';');
    }
  });

  it('init 在空表时种子化默认清单', async () => {
    const db = new FakeD1((sql) =>
      sql.includes('COUNT(*)') ? { first: { n: 0 } } : {},
    );
    await new D1Store(db).init();
    const inserts = db.calls.filter((c) => c.sql.includes('INSERT INTO symbols'));
    expect(inserts.length).toBe(DEFAULT_SYMBOLS.length);
    expect(inserts.map((c) => c.params[0])).toContain('BTCUSDT');
  });

  it('已有配置时不重复种子', async () => {
    const db = new FakeD1((sql) =>
      sql.includes('COUNT(*)') ? { first: { n: 3 } } : {},
    );
    await new D1Store(db).init();
    expect(db.calls.filter((c) => c.sql.includes('INSERT INTO symbols'))).toHaveLength(0);
  });

  it('空表时 getSymbol 与 listSymbols 一致地回落默认清单', async () => {
    const db = new FakeD1((sql) =>
      sql.includes('COUNT(*)') ? { first: { n: 0 } } : {},
    );
    const store = new D1Store(db);
    // 修复前：listSymbols 有回落、getSymbol 没有，导致 /set 提示"未监控"
    expect(await store.getSymbol('ETHUSDT')).not.toBeNull();
    expect((await store.getSymbol('ETHUSDT'))!.threshold).toEqual({ type: 'absolute', value: 50 });
    expect(await store.getSymbol('FAKEUSDT')).toBeNull();
  });

  it('表非空时 getSymbol 不回落，找不到就是没有', async () => {
    const db = new FakeD1((sql) => {
      if (sql.includes('COUNT(*)')) return { first: { n: 1 } };
      if (sql.includes('FROM symbols WHERE')) return {};
      return {};
    });
    expect(await new D1Store(db).getSymbol('ETHUSDT')).toBeNull();
  });

  it('空表时回落到默认配置', async () => {
    const db = new FakeD1();
    const list = await new D1Store(db).listSymbols();
    expect(list.length).toBeGreaterThan(0);
    expect(list.map((c) => c.symbol)).toContain('BTCUSDT');
  });

  it('读取已存配置', async () => {
    const db = new FakeD1(() => ({ rows: [SYMBOL_ROW] }));
    const list = await new D1Store(db).listSymbols();
    expect(list).toHaveLength(1);
    expect(list[0].threshold).toEqual({ type: 'absolute', value: 50 });
  });

  it('写入配置时绑定全部字段', async () => {
    const db = new FakeD1();
    const c: SymbolConfig = cfg({ symbol: 'ETHUSDT', display: 'ETH', threshold: { type: 'absolute', value: 50 } });
    await new D1Store(db).upsertSymbol(c);
    const call = db.sqlLike('INSERT INTO symbols')!;
    expect(call.params).toEqual([
      'ETHUSDT',
      'ETH',
      1,
      'crypto',
      '5m,15m',
      'absolute',
      50,
      2,
      15,
    ]);
  });

  it('状态表读写为字符串并按需取回', async () => {
    const db = new FakeD1((sql) => {
      if (sql.includes('FROM state')) return { first: { value: '12345' } };
      return {};
    });
    const store = new D1Store(db);
    await store.setLastAlertAt('BTCUSDT', 12345);
    expect(await store.getLastAlertAt('BTCUSDT')).toBe(12345);
    expect(await store.getChatId()).toBe('12345');
    expect(await store.getPausedUntil()).toBe(12345);
  });

  it('状态缺失时返回 undefined', async () => {
    const store = new D1Store(new FakeD1(() => ({})));
    expect(await store.getLastAlertAt('BTCUSDT')).toBeUndefined();
    expect(await store.getChatId()).toBeUndefined();
  });

  it('通用状态读写落到 state 表', async () => {
    const db = new FakeD1((sql) => {
      if (sql.includes('FROM state')) return { first: { value: 'https://x.dev/webhook' } };
      return {};
    });
    const store = new D1Store(db);
    await store.setState('webhook_url', 'https://x.dev/webhook');
    expect(await store.getState('webhook_url')).toBe('https://x.dev/webhook');
    expect(db.sqlLike('INSERT INTO state')).toBeDefined();
  });

  it('写入告警记录', async () => {
    const db = new FakeD1();
    await new D1Store(db).recordAlert({
      symbol: 'BTCUSDT',
      level: 'WARN',
      window: '5m',
      changeAbs: 1,
      changePct: 2,
      markPrice: 3,
      lastPrice: 4,
      createdAt: 5,
    });
    const call = db.sqlLike('INSERT INTO alerts')!;
    expect(call.params).toEqual(['BTCUSDT', 'WARN', '5m', 1, 2, 3, 4, 5]);
  });
});
