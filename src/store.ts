import { DEFAULT_COOLDOWN_MINUTES, DEFAULT_SYMBOLS } from './config';
import type { AlertLevel, AssetClass, SymbolConfig, ThresholdType, WindowKey } from './types';

export interface AlertRecord {
  symbol: string;
  level: AlertLevel;
  window: WindowKey;
  changeAbs: number;
  changePct: number;
  markPrice: number;
  lastPrice: number;
  createdAt: number;
}

/**
 * 存储只承担两件事：配置持久化 + 告警去重所需的极少量状态。
 * 价格基准仍来自交易所 K 线，因此这里不存历史价格。
 */
export interface Store {
  init(): Promise<void>;
  listSymbols(): Promise<SymbolConfig[]>;
  getSymbol(symbol: string): Promise<SymbolConfig | null>;
  upsertSymbol(cfg: SymbolConfig): Promise<void>;
  removeSymbol(symbol: string): Promise<void>;

  getLastAlertAt(symbol: string): Promise<number | undefined>;
  setLastAlertAt(symbol: string, ts: number): Promise<void>;

  getGapMutedUntil(symbol: string): Promise<number | undefined>;
  setGapMutedUntil(symbol: string, ts: number): Promise<void>;

  /** 全局暂停截止时间，用于告警消息上的「全部暂停」按钮 */
  getPausedUntil(): Promise<number | undefined>;
  setPausedUntil(ts: number): Promise<void>;

  /** 告警推送目标会话，首次与 bot 交互时自动绑定 */
  getChatId(): Promise<string | undefined>;
  setChatId(chatId: string): Promise<void>;

  /** 通用状态读写，用于 webhook 注册标记与运行诊断 */
  getState(key: string): Promise<string | undefined>;
  setState(key: string, value: string): Promise<void>;

  recordAlert(rec: AlertRecord): Promise<void>;
  recentAlerts(symbol: string, limit: number): Promise<AlertRecord[]>;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS symbols (
  symbol TEXT PRIMARY KEY,
  display TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  asset_class TEXT NOT NULL DEFAULT 'crypto',
  windows TEXT NOT NULL DEFAULT '5m,15m',
  threshold_type TEXT NOT NULL DEFAULT 'percent',
  threshold_value REAL NOT NULL DEFAULT 1,
  critical_multiplier REAL NOT NULL DEFAULT 2,
  cooldown_minutes INTEGER NOT NULL DEFAULT 15
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  level TEXT NOT NULL,
  window TEXT NOT NULL,
  change_abs REAL NOT NULL,
  change_pct REAL NOT NULL,
  mark_price REAL NOT NULL,
  last_price REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_symbol_time ON alerts(symbol, created_at);
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** 拆成单条语句，D1 的 prepare().run() 不支持一次执行多条 */
export const SCHEMA_STATEMENTS: string[] = SCHEMA_SQL.split(';')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

interface SymbolRow {
  symbol: string;
  display: string;
  enabled: number;
  asset_class: string;
  windows: string;
  threshold_type: string;
  threshold_value: number;
  critical_multiplier: number;
  cooldown_minutes: number;
}

interface AlertRow {
  symbol: string;
  level: string;
  window: string;
  change_abs: number;
  change_pct: number;
  mark_price: number;
  last_price: number;
  created_at: number;
}

export function parseWindows(raw: string): WindowKey[] {
  const valid: WindowKey[] = ['1m', '5m', '15m', '1h'];
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is WindowKey => (valid as string[]).includes(s));
  return parsed.length > 0 ? parsed : ['5m', '15m'];
}

export function serializeWindows(windows: WindowKey[]): string {
  return windows.join(',');
}

export function rowToConfig(row: SymbolRow): SymbolConfig {
  return {
    symbol: row.symbol,
    display: row.display || row.symbol,
    enabled: row.enabled !== 0,
    assetClass: (row.asset_class === 'tradfi' ? 'tradfi' : 'crypto') as AssetClass,
    windows: parseWindows(row.windows),
    threshold: {
      type: (row.threshold_type === 'absolute' ? 'absolute' : 'percent') as ThresholdType,
      value: Number(row.threshold_value),
    },
    criticalMultiplier: Number(row.critical_multiplier) || 2,
    cooldownMinutes: Number(row.cooldown_minutes) || DEFAULT_COOLDOWN_MINUTES,
  };
}

export function rowToAlert(row: AlertRow): AlertRecord {
  return {
    symbol: row.symbol,
    level: row.level === 'CRITICAL' ? 'CRITICAL' : 'WARN',
    window: parseWindows(row.window)[0],
    changeAbs: Number(row.change_abs),
    changePct: Number(row.change_pct),
    markPrice: Number(row.mark_price),
    lastPrice: Number(row.last_price),
    createdAt: Number(row.created_at),
  };
}

const STATE_KEYS = {
  lastAlert: (symbol: string) => `last_alert:${symbol}`,
  gapMuted: (symbol: string) => `gap_muted:${symbol}`,
  pausedUntil: 'paused_until',
  chatId: 'chat_id',
} as const;

/* ------------------------------ D1 实现 ------------------------------ */

export interface D1PreparedLike {
  bind(...values: unknown[]): D1PreparedLike;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  first<T = unknown>(col?: string): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedLike;
}

export class D1Store implements Store {
  constructor(private readonly db: D1DatabaseLike) {}

  async init(): Promise<void> {
    // 逐条执行，避免依赖 exec 的多语句能力
    for (const sql of SCHEMA_STATEMENTS) {
      await this.db.prepare(sql).run();
    }
    await this.seedDefaults();
  }

  /**
   * 空表时把默认清单落库。
   * 否则 listSymbols 有回落、getSymbol 没有，会出现"巡检正常但 /set 提示未监控"的割裂。
   */
  private async seedDefaults(): Promise<void> {
    if (!(await this.isEmpty())) return;
    for (const cfg of DEFAULT_SYMBOLS) {
      await this.upsertSymbol(cfg);
    }
  }

  private async isEmpty(): Promise<boolean> {
    try {
      const row = await this.db
        .prepare('SELECT COUNT(*) AS n FROM symbols')
        .first<{ n: number }>();
      return Number(row?.n ?? 0) === 0;
    } catch {
      // 表还没建好时按空处理，交给 seed 前的建表语句兜底
      return true;
    }
  }

  async listSymbols(): Promise<SymbolConfig[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM symbols ORDER BY rowid')
      .all<SymbolRow>();
    const rows = results ?? [];
    if (rows.length === 0) return DEFAULT_SYMBOLS.map((c) => ({ ...c }));
    return rows.map(rowToConfig);
  }

  async getSymbol(symbol: string): Promise<SymbolConfig | null> {
    const row = await this.db
      .prepare('SELECT * FROM symbols WHERE symbol = ?')
      .bind(symbol)
      .first<SymbolRow>();
    if (row) return rowToConfig(row);
    // 表为空（尚未种子化）时与 listSymbols 保持一致，回落到默认清单
    if (await this.isEmpty()) {
      const fallback = DEFAULT_SYMBOLS.find((c) => c.symbol === symbol);
      return fallback ? { ...fallback, windows: [...fallback.windows] } : null;
    }
    return null;
  }

  async upsertSymbol(cfg: SymbolConfig): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO symbols
         (symbol, display, enabled, asset_class, windows, threshold_type, threshold_value, critical_multiplier, cooldown_minutes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET
           display = excluded.display,
           enabled = excluded.enabled,
           asset_class = excluded.asset_class,
           windows = excluded.windows,
           threshold_type = excluded.threshold_type,
           threshold_value = excluded.threshold_value,
           critical_multiplier = excluded.critical_multiplier,
           cooldown_minutes = excluded.cooldown_minutes`,
      )
      .bind(
        cfg.symbol,
        cfg.display,
        cfg.enabled ? 1 : 0,
        cfg.assetClass,
        serializeWindows(cfg.windows),
        cfg.threshold.type,
        cfg.threshold.value,
        cfg.criticalMultiplier,
        cfg.cooldownMinutes,
      )
      .run();
  }

  async removeSymbol(symbol: string): Promise<void> {
    await this.db.prepare('DELETE FROM symbols WHERE symbol = ?').bind(symbol).run();
  }

  async getLastAlertAt(symbol: string): Promise<number | undefined> {
    return this.readNumber(STATE_KEYS.lastAlert(symbol));
  }

  async setLastAlertAt(symbol: string, ts: number): Promise<void> {
    await this.writeState(STATE_KEYS.lastAlert(symbol), String(ts));
  }

  async getGapMutedUntil(symbol: string): Promise<number | undefined> {
    return this.readNumber(STATE_KEYS.gapMuted(symbol));
  }

  async setGapMutedUntil(symbol: string, ts: number): Promise<void> {
    await this.writeState(STATE_KEYS.gapMuted(symbol), String(ts));
  }

  async getPausedUntil(): Promise<number | undefined> {
    return this.readNumber(STATE_KEYS.pausedUntil);
  }

  async setPausedUntil(ts: number): Promise<void> {
    await this.writeState(STATE_KEYS.pausedUntil, String(ts));
  }

  async getChatId(): Promise<string | undefined> {
    return this.getState(STATE_KEYS.chatId);
  }

  async setChatId(chatId: string): Promise<void> {
    await this.setState(STATE_KEYS.chatId, chatId);
  }

  async getState(key: string): Promise<string | undefined> {
    const row = await this.db
      .prepare('SELECT value FROM state WHERE key = ?')
      .bind(key)
      .first<{ value: string }>();
    return row?.value;
  }

  async setState(key: string, value: string): Promise<void> {
    await this.writeState(key, value);
  }

  async recordAlert(rec: AlertRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO alerts (symbol, level, window, change_abs, change_pct, mark_price, last_price, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        rec.symbol,
        rec.level,
        rec.window,
        rec.changeAbs,
        rec.changePct,
        rec.markPrice,
        rec.lastPrice,
        rec.createdAt,
      )
      .run();
  }

  async recentAlerts(symbol: string, limit: number): Promise<AlertRecord[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM alerts WHERE symbol = ? ORDER BY created_at DESC LIMIT ?')
      .bind(symbol, limit)
      .all<AlertRow>();
    return (results ?? []).map(rowToAlert);
  }

  private async readNumber(key: string): Promise<number | undefined> {
    const row = await this.db
      .prepare('SELECT value FROM state WHERE key = ?')
      .bind(key)
      .first<{ value: string }>();
    if (!row) return undefined;
    const n = Number(row.value);
    return Number.isFinite(n) ? n : undefined;
  }

  private async writeState(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, value, Date.now())
      .run();
  }
}

/* --------------------------- 内存实现（测试/CLI） --------------------------- */

export class MemoryStore implements Store {
  private readonly symbols = new Map<string, SymbolConfig>();
  private readonly state = new Map<string, string>();
  private readonly alerts: AlertRecord[] = [];

  constructor(seed: SymbolConfig[] = DEFAULT_SYMBOLS) {
    for (const c of seed) this.symbols.set(c.symbol, { ...c, windows: [...c.windows] });
  }

  async init(): Promise<void> {}

  async listSymbols(): Promise<SymbolConfig[]> {
    return [...this.symbols.values()].map((c) => ({ ...c, windows: [...c.windows] }));
  }

  async getSymbol(symbol: string): Promise<SymbolConfig | null> {
    const c = this.symbols.get(symbol);
    return c ? { ...c, windows: [...c.windows] } : null;
  }

  async upsertSymbol(cfg: SymbolConfig): Promise<void> {
    this.symbols.set(cfg.symbol, { ...cfg, windows: [...cfg.windows] });
  }

  async removeSymbol(symbol: string): Promise<void> {
    this.symbols.delete(symbol);
  }

  async getLastAlertAt(symbol: string): Promise<number | undefined> {
    return this.readNumber(STATE_KEYS.lastAlert(symbol));
  }

  async setLastAlertAt(symbol: string, ts: number): Promise<void> {
    this.state.set(STATE_KEYS.lastAlert(symbol), String(ts));
  }

  async getGapMutedUntil(symbol: string): Promise<number | undefined> {
    return this.readNumber(STATE_KEYS.gapMuted(symbol));
  }

  async setGapMutedUntil(symbol: string, ts: number): Promise<void> {
    this.state.set(STATE_KEYS.gapMuted(symbol), String(ts));
  }

  async getPausedUntil(): Promise<number | undefined> {
    return this.readNumber(STATE_KEYS.pausedUntil);
  }

  async setPausedUntil(ts: number): Promise<void> {
    this.state.set(STATE_KEYS.pausedUntil, String(ts));
  }

  async getChatId(): Promise<string | undefined> {
    return this.getState(STATE_KEYS.chatId);
  }

  async setChatId(chatId: string): Promise<void> {
    await this.setState(STATE_KEYS.chatId, chatId);
  }

  async getState(key: string): Promise<string | undefined> {
    return this.state.get(key);
  }

  async setState(key: string, value: string): Promise<void> {
    this.state.set(key, value);
  }

  async recordAlert(rec: AlertRecord): Promise<void> {
    this.alerts.push(rec);
  }

  async recentAlerts(symbol: string, limit: number): Promise<AlertRecord[]> {
    return this.alerts.filter((a) => a.symbol === symbol).slice(-limit);
  }

  private readNumber(key: string): number | undefined {
    const raw = this.state.get(key);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
}
