import { DEFAULT_ENGINE_OPTIONS } from './config';
import { evaluateAll, gapMuteUntil } from './engine';
import { fetchSnapshots, type MarketClient, type SnapshotFailure } from './market';
import type { Store } from './store';
import type { EngineOptions, Evaluation, SymbolConfig } from './types';

export interface CheckDeps {
  store: Store;
  client: MarketClient;
  /** 真正推送告警的回调，测试可替换为记录器 */
  sendAlert: (cfg: SymbolConfig, ev: Evaluation, now: number) => Promise<void>;
  options?: EngineOptions;
}

export interface CheckResult {
  now: number;
  /** 全局暂停中，本轮未做任何判定 */
  paused: boolean;
  pausedUntil?: number;
  evaluations: Evaluation[];
  /** 本轮实际推送的标的 */
  alerted: string[];
  /** 行情拉取失败的标的 */
  failures: SnapshotFailure[];
  source: string;
}

/**
 * 一轮巡检：拉配置 -> 拉行情 -> 纯函数判定 -> 推送 -> 记录冷却。
 * 判定本身无状态，存储只用于冷却与跳空静默。
 */
export async function runCheck(deps: CheckDeps, now: number = Date.now()): Promise<CheckResult> {
  const { store, client } = deps;
  await store.init();

  const pausedUntil = await store.getPausedUntil();
  if (pausedUntil && now < pausedUntil) {
    return {
      now,
      paused: true,
      pausedUntil,
      evaluations: [],
      alerted: [],
      failures: [],
      source: client.name,
    };
  }

  const configs = await store.listSymbols();
  const { snapshots, failures, source } = await fetchSnapshots(client, configs, now);

  const ctxFor = async (cfg: SymbolConfig) => ({
    now,
    lastAlertAt: await store.getLastAlertAt(cfg.symbol),
    gapMutedUntil: await store.getGapMutedUntil(cfg.symbol),
  });

  // 逐标的串行读取状态，避免 D1 并发读放大；标的数量级很小
  const resolved: Evaluation[] = [];
  for (const cfg of configs) {
    const snap = snapshots.get(cfg.symbol);
    if (!snap) {
      resolved.push(emptyEval(cfg.symbol));
      continue;
    }
    const ctx = await ctxFor(cfg);
    const [ev] = evaluateAll(
      [cfg],
      new Map([[cfg.symbol, snap]]),
      () => ctx,
      deps.options ?? DEFAULT_ENGINE_OPTIONS,
    );
    resolved.push(ev);
  }

  const alerted: string[] = [];
  for (const ev of resolved) {
    const cfg = configs.find((c) => c.symbol === ev.symbol);
    if (!cfg) continue;

    // 开盘跳空：写静默窗口，本轮不告警也不刷新冷却
    if (ev.gapDetected && ev.skipped === 'gap') {
      const until = gapMuteUntil(now, deps.options ?? DEFAULT_ENGINE_OPTIONS);
      const current = await store.getGapMutedUntil(cfg.symbol);
      if (!current || current < until) await store.setGapMutedUntil(cfg.symbol, until);
      continue;
    }

    if (!ev.triggered) continue;

    await deps.sendAlert(cfg, ev, now);
    await store.setLastAlertAt(cfg.symbol, now);
    await store.recordAlert({
      symbol: cfg.symbol,
      level: ev.level ?? 'WARN',
      window: ev.window ?? cfg.windows[0],
      changeAbs: ev.changeAbs,
      changePct: ev.changePct,
      markPrice: ev.markPrice,
      lastPrice: ev.lastPrice,
      createdAt: now,
    });
    alerted.push(cfg.symbol);
  }

  return { now, paused: false, pausedUntil, evaluations: resolved, alerted, failures, source };

}

function emptyEval(symbol: string): Evaluation {
  return {
    symbol,
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
  };
}
