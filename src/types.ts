export type AssetClass = 'crypto' | 'tradfi';

/** 窗口周期，对应交易所现成 K 线周期 */
export type WindowKey = '1m' | '5m' | '15m' | '1h';

export type ThresholdType = 'percent' | 'absolute';

export interface Threshold {
  /** percent：value 单位为百分数，1 表示 1%；absolute：value 单位为计价货币（USDT） */
  type: ThresholdType;
  value: number;
}

export interface SymbolConfig {
  /** 交易所原始交易对，如 BTCUSDT */
  symbol: string;
  /** 人类可读展示名 */
  display: string;
  enabled: boolean;
  assetClass: AssetClass;
  /** 参与判定的窗口，按优先级排列 */
  windows: WindowKey[];
  threshold: Threshold;
  /** 达到 阈值 × criticalMultiplier 判定为 CRITICAL */
  criticalMultiplier: number;
  /** 同一品种两次告警之间的最小间隔（分钟） */
  cooldownMinutes: number;
}

/** 单根 K 线。close 为最新价（末根未收盘时为当前价） */
export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface MarketSnapshot {
  symbol: string;
  /** 标记价格，判定口径 */
  markPrice: number;
  /** 最新成交价，仅用于展示 */
  lastPrice: number;
  /** 按时间升序，最后一根为当前未收盘 K 线 */
  klines: Partial<Record<WindowKey, Kline[]>>;
  fetchedAt: number;
}

export type AlertLevel = 'WARN' | 'CRITICAL';

export type SkipReason = 'disabled' | 'no-data' | 'gap' | 'cooldown' | 'below-threshold';

export interface EvaluatedWindow {
  window: WindowKey;
  /** 绝对变动金额，带符号 */
  changeAbs: number;
  /** 变动百分比，带符号，1.5 表示 +1.5% */
  changePct: number;
  breached: boolean;
  level: AlertLevel | null;
  /** 距离触发还差多少，单位与阈值类型一致；已触发时为 0 */
  distanceToThreshold: number;
}

export interface Evaluation {
  symbol: string;
  markPrice: number;
  lastPrice: number;
  triggered: boolean;
  level: AlertLevel | null;
  /** 触发所依据的窗口 */
  window: WindowKey | null;
  changeAbs: number;
  changePct: number;
  /** 未触发的原因；触发时为 null */
  skipped: SkipReason | null;
  /** 检测到开盘跳空 */
  gapDetected: boolean;
  windows: EvaluatedWindow[];
}

export interface EvaluateContext {
  now: number;
  /** 该品种上次告警时间戳（毫秒），无则 undefined */
  lastAlertAt?: number;
  /** 该品种因跳空进入静默的截止时间戳（毫秒） */
  gapMutedUntil?: number;
}

export interface EngineOptions {
  /** 前一根 K 线振幅低于该比例即视为休市（百分数） */
  idleRangePercent: number;
  /** 判定为跳空后该品种的静默时长（分钟） */
  gapMuteMinutes: number;
}
