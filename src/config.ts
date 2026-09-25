import type { SymbolConfig, EngineOptions } from './types';

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  // 休市时 markPrice 被平滑机制锁定，K 线振幅趋近于 0
  idleRangePercent: 0.05,
  gapMuteMinutes: 15,
};

/**
 * 同一标的两次告警之间的最短间隔，与最大窗口（15m）对齐：
 * 一个 15 分钟窗口内最多报一次，既能反映持续恶化的行情，又不会反复刷屏。
 * 可在 Telegram 里用 `/set BTCUSDT cooldown 30` 单独调整。
 */
export const DEFAULT_COOLDOWN_MINUTES = 15;

/**
 * 默认监控清单。
 * 阈值可在 Telegram 里用 /set 实时修改，无需改动代码。
 */
export const DEFAULT_SYMBOLS: SymbolConfig[] = [
  {
    symbol: 'BTCUSDT',
    display: 'BTC',
    enabled: true,
    assetClass: 'crypto',
    windows: ['5m', '15m'],
    threshold: { type: 'percent', value: 1 },
    criticalMultiplier: 2,
    cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
  },
  {
    symbol: 'ETHUSDT',
    display: 'ETH',
    enabled: true,
    assetClass: 'crypto',
    windows: ['5m', '15m'],
    // 用户指定按绝对金额告警
    threshold: { type: 'absolute', value: 50 },
    criticalMultiplier: 2,
    cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
  },
  {
    symbol: 'BNBUSDT',
    display: 'BNB',
    enabled: true,
    assetClass: 'crypto',
    windows: ['5m', '15m'],
    threshold: { type: 'percent', value: 2.5 },
    criticalMultiplier: 2,
    cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
  },
  {
    symbol: 'SNDKUSDT',
    display: 'SNDK 闪迪',
    enabled: true,
    assetClass: 'tradfi',
    windows: ['5m', '15m'],
    threshold: { type: 'percent', value: 3 },
    criticalMultiplier: 2,
    cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
  },
  {
    symbol: 'CLUSDT',
    display: 'CL 原油',
    enabled: true,
    assetClass: 'tradfi',
    windows: ['5m', '15m'],
    threshold: { type: 'percent', value: 2 },
    criticalMultiplier: 2,
    cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
  },
  {
    symbol: 'XAUUSDT',
    display: 'XAU 黄金',
    enabled: true,
    assetClass: 'tradfi',
    windows: ['5m', '15m'],
    threshold: { type: 'percent', value: 0.5 },
    criticalMultiplier: 2,
    cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
  },
];
