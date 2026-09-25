import { DEFAULT_ENGINE_OPTIONS } from './config';
import type {
  AlertLevel,
  EngineOptions,
  EvaluatedWindow,
  EvaluateContext,
  Evaluation,
  Kline,
  MarketSnapshot,
  SymbolConfig,
  Threshold,
  WindowKey,
} from './types';

/** 价格变动百分比，1.5 表示 +1.5% */
export function percentChange(open: number, last: number): number {
  if (!open) return 0;
  return ((last - open) / open) * 100;
}

/** K 线振幅百分比 */
export function klineRangePercent(k: Kline): number {
  if (!k.low) return 0;
  return ((k.high - k.low) / k.low) * 100;
}

/** 把绝对金额阈值换算成当前价格下的百分比，便于跨类型比较 */
export function thresholdToPercent(t: Threshold, price: number): number {
  if (t.type === 'percent') return t.value;
  return price ? (t.value / price) * 100 : 0;
}

/** 某窗口的告警强度，单位与阈值类型一致 */
function magnitudeOf(cfg: SymbolConfig, w: EvaluatedWindow): number {
  return cfg.threshold.type === 'absolute' ? Math.abs(w.changeAbs) : Math.abs(w.changePct);
}

/**
 * 开盘跳空识别。
 * TradFi 合约（股票/原油/黄金）休市时 markPrice 被平滑机制锁定，
 * 前一根 K 线振幅趋近于 0；开盘瞬间一次性释放积累的涨跌。
 * 这种变动是正常现象，不应作为异动告警。
 */
export function detectGap(
  cfg: SymbolConfig,
  snap: MarketSnapshot,
  opts: EngineOptions = DEFAULT_ENGINE_OPTIONS,
): boolean {
  if (cfg.assetClass !== 'tradfi') return false;
  const series = snap.klines['5m'];
  if (!series || series.length < 2) return false;

  const prev = series[series.length - 2];
  const curr = series[series.length - 1];
  // 前一根并非静止，说明当时在交易，不是休市后的跳空
  if (klineRangePercent(prev) >= opts.idleRangePercent) return false;

  const change = Math.abs(percentChange(prev.close, curr.close));
  return change >= thresholdToPercent(cfg.threshold, prev.close);
}

/** 跳空静默截止时间戳 */
export function gapMuteUntil(
  now: number,
  opts: EngineOptions = DEFAULT_ENGINE_OPTIONS,
): number {
  return now + opts.gapMuteMinutes * 60_000;
}

function emptyEvaluation(snap: MarketSnapshot): Evaluation {
  return {
    symbol: snap.symbol,
    markPrice: snap.markPrice,
    lastPrice: snap.lastPrice,
    triggered: false,
    level: null,
    window: null,
    changeAbs: 0,
    changePct: 0,
    skipped: null,
    gapDetected: false,
    windows: [],
  };
}

/**
 * 核心判定：纯函数，不依赖网络与存储。
 * 价格基准取自交易所 K 线开盘价，因此无需自行持久化历史价格。
 */
export function evaluateSymbol(
  cfg: SymbolConfig,
  snap: MarketSnapshot,
  ctx: EvaluateContext,
  opts: EngineOptions = DEFAULT_ENGINE_OPTIONS,
): Evaluation {
  const result = emptyEvaluation(snap);

  if (!cfg.enabled) {
    return { ...result, skipped: 'disabled' };
  }

  const price = snap.markPrice > 0 ? snap.markPrice : snap.lastPrice;
  result.markPrice = snap.markPrice;
  result.lastPrice = snap.lastPrice;

  const windows: EvaluatedWindow[] = [];
  for (const key of cfg.windows) {
    const series = snap.klines[key];
    if (!series || series.length === 0) continue;
    const k = series[series.length - 1];
    const changeAbs = price - k.open;
    const changePct = percentChange(k.open, price);
    const magnitude = cfg.threshold.type === 'absolute' ? Math.abs(changeAbs) : Math.abs(changePct);
    const breached = magnitude >= cfg.threshold.value;
    const level: AlertLevel | null = breached
      ? magnitude >= cfg.threshold.value * cfg.criticalMultiplier
        ? 'CRITICAL'
        : 'WARN'
      : null;

    windows.push({
      window: key as WindowKey,
      changeAbs,
      changePct,
      breached,
      level,
      distanceToThreshold: breached ? 0 : cfg.threshold.value - magnitude,
    });
  }

  result.windows = windows;
  if (windows.length === 0) {
    return { ...result, skipped: 'no-data' };
  }

  const gapDetected = detectGap(cfg, snap, opts);
  result.gapDetected = gapDetected;

  const best = windows.reduce((a, b) => (magnitudeOf(cfg, b) > magnitudeOf(cfg, a) ? b : a));
  result.changeAbs = best.changeAbs;
  result.changePct = best.changePct;

  if (!windows.some((w) => w.breached)) {
    return { ...result, skipped: 'below-threshold' };
  }

  // 跳空静默优先于冷却判定：静默期内不告警，也不刷新冷却
  if (ctx.gapMutedUntil && ctx.now < ctx.gapMutedUntil) {
    return { ...result, skipped: 'gap' };
  }
  if (gapDetected) {
    return { ...result, skipped: 'gap' };
  }

  if (ctx.lastAlertAt && ctx.now - ctx.lastAlertAt < cfg.cooldownMinutes * 60_000) {
    return { ...result, skipped: 'cooldown' };
  }

  const triggered = windows
    .filter((w) => w.breached)
    .reduce((a, b) => (magnitudeOf(cfg, b) > magnitudeOf(cfg, a) ? b : a));

  return {
    ...result,
    triggered: true,
    level: triggered.level,
    window: triggered.window,
    changeAbs: triggered.changeAbs,
    changePct: triggered.changePct,
    skipped: null,
  };
}

/** 批量判定，按配置顺序返回 */
export function evaluateAll(
  configs: SymbolConfig[],
  snapshots: Map<string, MarketSnapshot>,
  ctxFor: (cfg: SymbolConfig) => EvaluateContext,
  opts: EngineOptions = DEFAULT_ENGINE_OPTIONS,
): Evaluation[] {
  const out: Evaluation[] = [];
  for (const cfg of configs) {
    const snap = snapshots.get(cfg.symbol);
    if (!snap) {
      out.push({
        symbol: cfg.symbol,
        markPrice: 0,
        lastPrice: 0,
        triggered: false,
        level: null,
        window: null,
        changeAbs: 0,
        changePct: 0,
        skipped: 'no-data',
        gapDetected: false,
        windows: [],
      });
      continue;
    }
    out.push(evaluateSymbol(cfg, snap, ctxFor(cfg), opts));
  }
  return out;
}
