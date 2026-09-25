import { DEFAULT_ENGINE_OPTIONS } from './config';
import { klineRangePercent, percentChange } from './engine';
import { WINDOW_MS } from './market';
import type { AlertLevel, EngineOptions, Kline, SymbolConfig, WindowKey } from './types';

export interface ReplayAlert {
  ts: number;
  level: AlertLevel;
  window: WindowKey;
  changePct: number;
  changeAbs: number;
  price: number;
}

export interface ReplayResult {
  symbol: string;
  /** 扫描的 K 线根数 */
  scanned: number;
  alerts: ReplayAlert[];
  /** 因跳空被静默的候选次数 */
  gapSkipped: number;
  /** 单根 K 线窗口内的最大绝对波动百分比 */
  maxAbsPct: number;
  /** 若把阈值设为该百分比（或等价金额），历史会触发的次数 */
  thresholdScan: Array<{ percent: number; count: number }>;
}

const CANDIDATE_PERCENTS = [0.5, 1, 1.5, 2, 3, 4, 5, 8];

/**
 * 逐根 K 线回放判定逻辑，统计"如果按当前配置运行会响多少次"。
 * 与线上判定共用同一套纯函数规则，只是把窗口基准改为历史 K 线的开盘价。
 */
export function replaySymbol(
  cfg: SymbolConfig,
  base: Kline[],
  baseWindow: WindowKey = '5m',
  opts: EngineOptions = DEFAULT_ENGINE_OPTIONS,
): ReplayResult {
  const windows = cfg.windows.filter((w) => WINDOW_MS[w] >= WINDOW_MS[baseWindow]);
  const opens = new Map<WindowKey, Map<number, number>>();

  for (const w of windows) {
    const bucketMs = WINDOW_MS[w];
    const map = new Map<number, number>();
    for (const k of base) {
      const bucket = Math.floor(k.openTime / bucketMs) * bucketMs;
      if (!map.has(bucket)) map.set(bucket, k.open);
    }
    opens.set(w, map);
  }

  const alerts: ReplayAlert[] = [];
  const perBarMaxPct: number[] = [];
  let gapSkipped = 0;
  let lastAlertAt = 0;
  let gapMutedUntil = 0;
  let maxAbsPct = 0;

  base.forEach((k, i) => {
    const price = k.close;
    let bestPct = 0;
    let bestAbs = 0;
    let bestWindow: WindowKey = windows[0] ?? baseWindow;

    for (const w of windows) {
      const open = opens.get(w)!.get(Math.floor(k.openTime / WINDOW_MS[w]) * WINDOW_MS[w]);
      if (open === undefined) continue;
      const pct = percentChange(open, price);
      const abs = price - open;
      if (Math.abs(pct) > Math.abs(bestPct)) {
        bestPct = pct;
        bestAbs = abs;
        bestWindow = w;
      }
    }

    perBarMaxPct.push(Math.abs(bestPct));
    maxAbsPct = Math.max(maxAbsPct, Math.abs(bestPct));

    const magnitude = cfg.threshold.type === 'absolute' ? Math.abs(bestAbs) : Math.abs(bestPct);
    if (magnitude < cfg.threshold.value) return;

    // 跳空判定：前一根静止、本根一次性释放
    if (cfg.assetClass === 'tradfi' && i > 0) {
      const prev = base[i - 1];
      if (
        klineRangePercent(prev) < opts.idleRangePercent &&
        Math.abs(percentChange(prev.close, price)) >= cfg.threshold.value
      ) {
        gapSkipped += 1;
        gapMutedUntil = k.openTime + opts.gapMuteMinutes * 60_000;
        return;
      }
    }
    if (k.openTime < gapMutedUntil) {
      gapSkipped += 1;
      return;
    }
    if (lastAlertAt && k.openTime - lastAlertAt < cfg.cooldownMinutes * 60_000) return;

    lastAlertAt = k.openTime;
    alerts.push({
      ts: k.openTime,
      level: magnitude >= cfg.threshold.value * cfg.criticalMultiplier ? 'CRITICAL' : 'WARN',
      window: bestWindow,
      changePct: bestPct,
      changeAbs: bestAbs,
      price,
    });
  });

  const thresholdScan = CANDIDATE_PERCENTS.map((percent) => ({
    percent,
    count: perBarMaxPct.filter((p) => p >= percent).length,
  }));

  return { symbol: cfg.symbol, scanned: base.length, alerts, gapSkipped, maxAbsPct, thresholdScan };
}
