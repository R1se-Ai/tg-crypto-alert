import { DEFAULT_COOLDOWN_MINUTES } from './config';
import { thresholdToPercent } from './engine';
import type { MarketClient } from './market';
import { parseWindows, type Store } from './store';
import {
  alertKeyboard,
  escapeHtml,
  formatAlert,
  formatStatus,
  formatSymbolList,
  formatThreshold,
  formatThresholdUnit,
  formatTime,
  helpText,
  type Incoming,
  type InlineKeyboardMarkup,
} from './telegram';
import type { AssetClass, SymbolConfig, Threshold, WindowKey } from './types';

export interface BotDeps {
  store: Store;
  client: MarketClient;
  /** 只允许该会话下发命令；为空则首个交互的会话自动绑定 */
  allowedChatId?: string;
}

export interface BotReply {
  text: string;
  keyboard?: InlineKeyboardMarkup;
}

const DEFAULT_ADD_THRESHOLD: Threshold = { type: 'percent', value: 3 };
const DEFAULT_MUTE_MINUTES = 60;

export interface ParsedSpec {
  threshold?: Threshold;
  assetClass?: AssetClass;
  error?: string;
}

/** 解析阈值/资产类别参数，支持 pct|abs、tradfi|crypto 与数值的任意顺序组合 */
export function parseThresholdSpec(tokens: string[], fallback: Threshold): ParsedSpec {
  let type = fallback.type;
  let value: number | undefined;
  let assetClass: AssetClass | undefined;

  for (const raw of tokens) {
    const t = raw.toLowerCase();
    if (t === 'pct' || t === 'percent' || t === '%') {
      type = 'percent';
      continue;
    }
    if (t === 'abs' || t === 'absolute' || t === 'usdt') {
      type = 'absolute';
      continue;
    }
    if (t === 'tradfi' || t === 'stock') {
      assetClass = 'tradfi';
      continue;
    }
    if (t === 'crypto') {
      assetClass = 'crypto';
      continue;
    }

    // 数值可带单位后缀：1% / 1pct → 百分比，50u / 50usdt → 绝对金额。
    // 后缀优先级高于 fallback，否则「/set ETHUSDT 1%」会被沿用旧的绝对值口径。
    const m = /^(-?(?:[0-9]*\.?[0-9]+))(pct|percent|usdt|%|u)?$/.exec(t);
    if (m) {
      value = Number(m[1]);
      const unit = m[2];
      if (unit === '%' || unit === 'pct' || unit === 'percent') type = 'percent';
      else if (unit) type = 'absolute';
      continue;
    }
    return { error: `无法识别的参数：${escapeHtml(raw)}` };
  }

  if (value === undefined) return { error: '缺少阈值数值' };
  if (value <= 0) return { error: '阈值必须大于 0' };
  return { threshold: { type, value }, assetClass };
}

export function parseMinutes(tokens: string[], fallback: number): number | null {
  const raw = tokens.find((t) => /^\d+$/.test(t));
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return n > 0 && n <= 1440 ? n : null;
}

function usage(): BotReply {
  return { text: helpText() };
}

async function requireSymbol(
  deps: BotDeps,
  symbol: string | undefined,
): Promise<{ cfg?: SymbolConfig; reply?: BotReply }> {
  if (!symbol) return { reply: { text: '缺少交易对代码，例如 <code>/set BTCUSDT 1.5</code>' } };
  const cfg = await deps.store.getSymbol(symbol);
  if (!cfg) return { reply: { text: `未监控 ${escapeHtml(symbol)}，用 /list 查看清单` } };
  return { cfg };
}

export async function handleIncoming(
  deps: BotDeps,
  incoming: Incoming,
  now: number,
): Promise<BotReply> {
  if (incoming.kind !== 'command') {
    return { text: helpText() };
  }

  const { store } = deps;
  const [head, ...rest] = incoming.args;

  switch (incoming.command) {
    case 'start':
    case 'help':
      return usage();

    case 'list': {
      const cfgs = await store.listSymbols();
      return { text: formatSymbolList(cfgs) };
    }

    case 'add': {
      const symbol = (head ?? '').toUpperCase();
      if (!symbol) return { text: '用法：<code>/add SOLUSDT pct 3</code>' };
      if (await store.getSymbol(symbol)) {
        return { text: `${escapeHtml(symbol)} 已在监控清单中` };
      }
      const spec = parseThresholdSpec(rest, DEFAULT_ADD_THRESHOLD);
      if (spec.error || !spec.threshold) return { text: `❌ ${spec.error ?? '参数无效'}` };

      const available = new Set(await deps.client.listSymbols());
      if (!available.has(symbol)) {
        return { text: `❌ 交易所不存在 ${escapeHtml(symbol)}，请核对代码` };
      }

      await store.upsertSymbol({
        symbol,
        display: symbol.replace('USDT', ''),
        enabled: true,
        assetClass: spec.assetClass ?? 'crypto',
        windows: ['5m', '15m'],
        threshold: spec.threshold,
        criticalMultiplier: 2,
        cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
      });
      return { text: `✅ 已添加 ${escapeHtml(symbol)}，阈值 ${formatThresholdUnit(spec.threshold)}` };
    }

    case 'set': {
      const symbol = (head ?? '').toUpperCase();
      const found = await requireSymbol(deps, symbol);
      if (found.reply || !found.cfg) return found.reply!;
      const cfg = found.cfg;
      const sub = (rest[0] ?? '').toLowerCase();

      if (sub === 'cooldown') {
        const m = parseMinutes(rest.slice(1), 0);
        if (m === null) return { text: '❌ 冷却时间需为 1-1440 分钟' };
        await store.upsertSymbol({ ...cfg, cooldownMinutes: m });
        return { text: `✅ ${escapeHtml(symbol)} 冷却时间设为 ${m} 分钟` };
      }

      if (sub === 'windows' || sub === 'window') {
        const windows = parseWindows(rest.slice(1).join(','));
        if (windows.length === 0) return { text: '❌ 可选窗口：1m / 5m / 15m / 1h' };
        await store.upsertSymbol({ ...cfg, windows });
        return { text: `✅ ${escapeHtml(symbol)} 窗口设为 ${windows.join('/')}` };
      }

      const spec = parseThresholdSpec(rest, cfg.threshold);
      if (spec.error || !spec.threshold) return { text: `❌ ${spec.error ?? '参数无效'}` };
      const next: SymbolConfig = {
        ...cfg,
        threshold: spec.threshold,
        assetClass: spec.assetClass ?? cfg.assetClass,
      };
      await store.upsertSymbol(next);
      return { text: `✅ ${escapeHtml(symbol)} 阈值设为 ${formatThresholdUnit(next.threshold)}` };
    }

    case 'remove': {
      const symbol = (head ?? '').toUpperCase();
      const found = await requireSymbol(deps, symbol);
      if (found.reply) return found.reply;
      await store.removeSymbol(symbol);
      return { text: `✅ 已移除 ${escapeHtml(symbol)}` };
    }

    case 'on':
    case 'off': {
      const symbol = (head ?? '').toUpperCase();
      const found = await requireSymbol(deps, symbol);
      if (found.reply || !found.cfg) return found.reply!;
      const enabled = incoming.command === 'on';
      await store.upsertSymbol({ ...found.cfg, enabled });
      return { text: `${enabled ? '✅ 已启用' : '⏸ 已停用'} ${escapeHtml(symbol)}` };
    }

    case 'pause': {
      const m = parseMinutes(incoming.args, DEFAULT_MUTE_MINUTES);
      if (m === null) return { text: '❌ 暂停时长需为 1-1440 分钟' };
      await store.setPausedUntil(now + m * 60_000);
      return { text: `⏸ 全局暂停 ${m} 分钟，至 ${formatTime(now + m * 60_000)}` };
    }

    case 'resume': {
      await store.setPausedUntil(0);
      return { text: '▶️ 已恢复告警' };
    }

    case 'mute': {
      const symbol = (head ?? '').toUpperCase();
      const found = await requireSymbol(deps, symbol);
      if (found.reply) return found.reply;
      const m = parseMinutes(rest, DEFAULT_MUTE_MINUTES);
      if (m === null) return { text: '❌ 静默时长需为 1-1440 分钟' };
      await store.setGapMutedUntil(symbol, now + m * 60_000);
      return { text: `🔇 ${escapeHtml(symbol)} 静默 ${m} 分钟` };
    }

    case 'unmute': {
      const symbol = (head ?? '').toUpperCase();
      const found = await requireSymbol(deps, symbol);
      if (found.reply) return found.reply;
      await store.setGapMutedUntil(symbol, 0);
      return { text: `🔔 ${escapeHtml(symbol)} 已解除静默` };
    }

    case 'status': {
      const cfgs = await store.listSymbols();
      const pausedUntil = await store.getPausedUntil();
      const chatId = await store.getChatId();
      const recent: string[] = [];
      for (const c of cfgs.filter((x) => x.enabled)) {
        const rows = await store.recentAlerts(c.symbol, 1);
        const last = rows[rows.length - 1];
        if (last) recent.push(`${escapeHtml(c.display)} · ${last.level} · ${formatTime(last.createdAt)}`);
      }
      return {
        text: formatStatus({
          now,
          pausedUntil: pausedUntil ?? undefined,
          symbolCount: cfgs.length,
          enabledCount: cfgs.filter((c) => c.enabled).length,
          chatId: chatId ?? deps.allowedChatId,
          recent,
        }),
      };
    }

    case 'test':
      return handleTest(deps, now);

    default:
      return { text: `未识别的命令 /${escapeHtml(incoming.command)}\n\n${helpText()}` };
  }
}

/** /test：用真实行情渲染一条模拟告警，用来确认推送链路与文案格式 */
export async function handleTest(deps: BotDeps, now: number): Promise<BotReply> {
  const cfgs = await deps.store.listSymbols();
  const target = cfgs.find((c) => c.enabled) ?? cfgs[0];
  if (!target) return { text: '监控清单为空，先用 /add 添加标的' };

  // 模拟告警只需要当前价格，不判定，因此不该牵连 K 线。
  // 走 fetchSnapshots 会搭上 K 线请求：限流时（尤其 5 分钟整点缓存失效那一瞬）
  // 一条"测试"命令就报行情拉取失败，把数据源状态和推送链路混为一谈。
  const { mark, last } = await deps.client.fetchPriceMap([target.symbol]);
  const markPrice = mark.get(target.symbol) ?? 0;
  const lastPrice = last.get(target.symbol) ?? markPrice;
  const price = markPrice || lastPrice;
  if (!price) return { text: `⚠️ ${escapeHtml(target.symbol)} 行情拉取失败，请检查数据源` };

  const pct = thresholdToPercent(target.threshold, price) || 1;
  const abs = (price * pct) / 100;
  const window: WindowKey = target.windows[0] ?? '5m';

  return {
    text: formatAlert(
      target,
      {
        symbol: target.symbol,
        markPrice,
        lastPrice,
        triggered: true,
        level: 'WARN',
        window,
        changeAbs: abs,
        changePct: pct,
        skipped: null,
        gapDetected: false,
        windows: [],
      },
      now,
    ).replace('🚨 异动', '🧪 测试告警'),
    keyboard: alertKeyboard(target.symbol),
  };
}

/** 告警消息上的按钮回调 */
export async function handleCallback(
  deps: BotDeps,
  data: string,
  now: number,
): Promise<{ toast: string }> {
  const [action, arg, minutes] = data.split(':');

  if (action === 'pause') {
    const m = Number(minutes ?? DEFAULT_MUTE_MINUTES);
    await deps.store.setPausedUntil(now + (Number.isFinite(m) ? m : DEFAULT_MUTE_MINUTES) * 60_000);
    return { toast: `全局暂停 ${Number.isFinite(m) ? m : DEFAULT_MUTE_MINUTES} 分钟` };
  }

  if (action === 'mute' && arg) {
    const m = Number(minutes ?? DEFAULT_MUTE_MINUTES);
    await deps.store.setGapMutedUntil(arg, now + (Number.isFinite(m) ? m : DEFAULT_MUTE_MINUTES) * 60_000);
    return { toast: `${arg} 静默 ${Number.isFinite(m) ? m : DEFAULT_MUTE_MINUTES} 分钟` };
  }

  return { toast: '未知操作' };
}
