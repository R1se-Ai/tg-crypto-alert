import { handleCallback, handleIncoming, type BotDeps } from './bot';
import { thresholdToPercent } from './engine';
import {
  BINANCE_FAPI,
  BinanceClient,
  BYBIT_API,
  BybitClient,
  CachedMarketClient,
  FailoverMarketClient,
  MemoryKlineCache,
  OKX_API,
  OkxClient,
  validateSymbols,
  type CachedKlines,
  type KlineCache,
  type MarketClient,
} from './market';
import { runCheck, type CheckDeps } from './monitor';
import { D1Store, MemoryStore, type D1DatabaseLike, type Store } from './store';
import {
  alertKeyboard,
  answerCallbackQuery,
  formatAlert,
  getWebhookInfo,
  parseUpdate,
  sendMessage,
  setWebhook,
  type FetchLike,
} from './telegram';
import type { Evaluation, SymbolConfig } from './types';

export interface Env {
  DB?: D1DatabaseLike;
  TELEGRAM_BOT_TOKEN?: string;
  /** 固定推送会话；不设置时由首个与 bot 交互的会话自动绑定 */
  TELEGRAM_CHAT_ID?: string;
  /** webhook 路径与 Telegram secret_token 校验用 */
  WEBHOOK_SECRET?: string;
  /** Worker 自身地址，用于自动注册 Telegram Webhook */
  WORKER_BASE_URL?: string;
  /**
   * 数据源优先顺序，逗号分隔，默认 okx,bybit,binance。
   * 只配 MARKET_PRIMARY 时它排第一，其余按默认顺序跟在后面。
   */
  MARKET_SOURCES?: string;
  MARKET_PRIMARY?: 'binance' | 'okx' | 'bybit';
  BINANCE_BASE_URL?: string;
  OKX_BASE_URL?: string;
  BYBIT_BASE_URL?: string;
}

export const DIAG_KEYS = {
  webhookUrl: 'webhook_url',
  webhookResult: 'webhook_result',
  symbolCheck: 'symbol_check',
  lastRun: 'last_run',
  lastBeat: 'last_beat',
  lastError: 'last_error',
  lastUpdate: 'last_update',
  webhookInfo: 'webhook_info',
  sourceProbe: 'source_probe',
} as const;

/** 数据源连通性探测的间隔（毫秒） */
export const SOURCE_PROBE_INTERVAL_MS = 6 * 60 * 60_000;

/** 看门狗用的三枚标记：巡检开始、巡检完成、中断告警已发出 */
export const WATCHDOG_KEYS = {
  start: 'check_start',
  done: 'check_done',
  alertedAt: 'watchdog_alert_at',
} as const;

/**
 * 判定一轮巡检"烂尾"的容忍时间。
 * Cron 每 2 分钟一轮，容忍 6 分钟即连续三三轮没有结果才告警，避免偶发抖动误报。
 */
export const WATCHDOG_STALE_MS = 6 * 60_000;

export type SendAlertFn = (cfg: SymbolConfig, ev: Evaluation, now: number) => Promise<void>;

// 未绑定 D1 时（本地调试/测试）按 env 复用同一个内存实例，避免状态每次请求丢失
const memoryStores = new WeakMap<Env, Store>();

export function makeStore(env: Env): Store {
  if (env.DB) return new D1Store(env.DB);
  let store = memoryStores.get(env);
  if (!store) {
    store = new MemoryStore();
    memoryStores.set(env, store);
  }
  return store;
}

/** 默认数据源顺序：Binance 对 Cloudflare 出口 IP 恒定 403，垫底只作兜底 */
export const DEFAULT_SOURCE_ORDER = ['okx', 'bybit', 'binance'];

/** 解析数据源优先顺序；未知名称会被忽略 */
export function resolveSourceOrder(env: Env): string[] {
  const explicit = (env.MARKET_SOURCES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (explicit.length > 0) return explicit;

  const primary = env.MARKET_PRIMARY?.trim().toLowerCase();
  if (primary) return [primary, ...DEFAULT_SOURCE_ORDER.filter((s) => s !== primary)];
  return [...DEFAULT_SOURCE_ORDER];
}

/** 按名称构造单个数据源；未知名称返回 null */
export function createSource(
  env: Env,
  name: string,
  fetchFn?: FetchLike,
): MarketClient | null {
  switch (name) {
    case 'binance':
      return new BinanceClient(env.BINANCE_BASE_URL ?? BINANCE_FAPI, fetchFn);
    case 'okx':
      return new OkxClient(env.OKX_BASE_URL ?? OKX_API, fetchFn);
    case 'bybit':
      return new BybitClient(env.BYBIT_BASE_URL ?? BYBIT_API, fetchFn);
    default:
      return null;
  }
}

export function makeClient(
  env: Env,
  fetchFn?: FetchLike,
  onError?: (err: unknown) => void,
  cache?: KlineCache,
): MarketClient {
  const ordered = resolveSourceOrder(env)
    .map((name) => createSource(env, name, fetchFn))
    .filter((c): c is MarketClient => Boolean(c));
  const sources =
    ordered.length > 0
      ? ordered
      : DEFAULT_SOURCE_ORDER.map((n) => createSource(env, n, fetchFn)!).filter(Boolean);

  return new CachedMarketClient(
    new FailoverMarketClient(
      sources,
      onError ??
        ((err) => {
          console.warn('数据源失败，切换到下一个源：', err instanceof Error ? err.message : err);
        }),
    ),
    cache ?? new MemoryKlineCache(),
  );
}

/**
 * 逐个探测数据源连通性并写入 D1。
 *
 * 加了新数据源必须能确认它在这个运行环境里真的可达——
 * Binance 对 Cloudflare 出口 IP 恒定 403 就是教训：备源挂了一年没人发现。
 * 只用 `last_run.source` 看不出来，因为首选源正常时备源永远不会被碰到。
 */
/** 单个源的探测超时（毫秒）。探测是旁路任务，绝不能拖累主流程 */
export const PROBE_TIMEOUT_MS = 5_000;

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function probeSources(
  env: Env,
  now: number = Date.now(),
  fetchFn?: FetchLike,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
  const results: Array<{ name: string; ok: boolean; error?: string }> = [];
  for (const name of resolveSourceOrder(env)) {
    const client = createSource(env, name, fetchFn);
    if (!client) {
      results.push({ name, ok: false, error: '未知数据源' });
      continue;
    }
    try {
      // 只取一根 K 线：响应几十字节，还算直接验证了"拿得到行情"。
      // 不要用 listSymbols——全市场合约列表动辄几 MB，解析开销能拖垮整轮巡检。
      await withDeadline(client.fetchKlines('BTCUSDT', '5m', 1), timeoutMs, `${name} 探测超时`);
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/** 探测很便宜但没必要每轮都做；结果落在 state 里随时可查 */
export async function maybeProbeSources(
  env: Env,
  store: Store,
  now: number = Date.now(),
  intervalMs: number = SOURCE_PROBE_INTERVAL_MS,
): Promise<void> {
  const raw = await store.getState(DIAG_KEYS.sourceProbe);
  // 从未探测过要立刻探一次：否则新加的源要等满一个间隔才知道它通不通
  if (raw) {
    const lastAt = Number((JSON.parse(raw) as { at?: number }).at ?? 0);
    if (Number.isFinite(lastAt) && now - lastAt < intervalMs) return;
  }

  const results = await probeSources(env, now);
  await store.setState(DIAG_KEYS.sourceProbe, JSON.stringify({ at: now, results }));
  const down = results.filter((r) => !r.ok).map((r) => r.name);
  console.log(
    `数据源探测：可用=${results.filter((r) => r.ok).map((r) => r.name).join(',') || '无'}` +
      (down.length > 0 ? ` 不可用=${down.join(',')}` : ''),
  );
}

/**
 * 把 K 线缓存落到 D1。
 * Worker 实例随时可能被回收，内存缓存留不住；存进 state 表后，
 * 5m 窗口的 K 线在整个集群里每 5 分钟才真正请求一次交易所。
 */
export class StoreKlineCache implements KlineCache {
  constructor(private readonly store: Store) {}

  async get(key: string): Promise<CachedKlines | null> {
    const raw = await this.store.getState(`kline:${key}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CachedKlines;
    } catch {
      return null;
    }
  }

  async set(key: string, value: CachedKlines): Promise<void> {
    await this.store.setState(`kline:${key}`, JSON.stringify(value));
  }
}

/** 告警推送：优先用环境变量里的固定会话，否则用已绑定的会话 */
export function defaultSendAlert(env: Env, store: Store, fetchFn?: FetchLike): SendAlertFn {
  return async (cfg, ev, now) => {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.error('未配置 TELEGRAM_BOT_TOKEN，跳过推送');
      return;
    }
    const chatId = env.TELEGRAM_CHAT_ID ?? (await store.getChatId());
    if (!chatId) {
      console.error('未绑定推送会话，跳过推送');
      return;
    }
    await sendMessage(
      token,
      {
        chat_id: chatId,
        text: formatAlert(cfg, ev, now),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: alertKeyboard(cfg.symbol),
      },
      fetchFn,
    );
  };
}

export function createCheckDeps(
  env: Env,
  store: Store = makeStore(env),
  client: MarketClient = makeClient(env),
  sendAlert: SendAlertFn = defaultSendAlert(env, store),
): CheckDeps {
  return { store, client, sendAlert };
}

/**
 * 看门狗：巡检被平台静默掐断时的唯一自救手段。
 *
 * 整轮执行超时不会抛异常（既进不了 catch 也写不下 last_error），
 * 表现为"监控悄悄停摆而用户毫无察觉"。这里用 check_start / check_done 两个标记自检：
 * 开始写了、结果没写、且已超过容忍期，就主动推送中断告警；下一轮恢复正常时再推送恢复。
 */
export async function runWatchdog(
  store: Store,
  notify: (text: string) => Promise<void>,
  now: number = Date.now(),
): Promise<void> {
  const started = readTimestamp(await store.getState(WATCHDOG_KEYS.start));
  const finished = readTimestamp(await store.getState(WATCHDOG_KEYS.done));
  const alertedAt = readTimestamp(await store.getState(WATCHDOG_KEYS.alertedAt));

  const stalled =
    started > 0 && started > finished && now - started > WATCHDOG_STALE_MS;

  if (stalled) {
    // 中断期间只报一次，恢复前不重复打扰
    if (alertedAt > 0) return;
    await store.setState(WATCHDOG_KEYS.alertedAt, String(now));
    const minutes = Math.round((now - started) / 60_000);
    await notify(
      [
        '⚠️ <b>监控已中断</b>',
        `最近一轮巡检在 ${minutes} 分钟前开始后始终没有完成，期间不会产生任何告警。`,
        '常见原因是数据源持续限流拖垮本轮执行，通常可自行恢复。',
      ].join('\n'),
    );
    return;
  }

  if (alertedAt > 0) {
    await store.setState(WATCHDOG_KEYS.alertedAt, '');
    await notify('✅ <b>监控已恢复</b>\n巡检重新开始正常产出结果。');
  }
}

function readTimestamp(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** 系统级通知（中断/恢复）的推送通道，优先用环境变量里的固定会话 */
export function defaultNotify(
  env: Env,
  store: Store,
  fetchFn?: FetchLike,
): (text: string) => Promise<void> {
  return async (text) => {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.error('未配置 TELEGRAM_BOT_TOKEN，跳过通知');
      return;
    }
    const chatId = env.TELEGRAM_CHAT_ID ?? (await store.getChatId());
    if (!chatId) {
      console.error('未绑定推送会话，跳过通知');
      return;
    }
    await sendMessage(
      token,
      { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true },
      fetchFn,
    );
  };
}

/** 一轮巡检，供 Cron 与手动 /run 共用 */
export async function runCheckOnce(env: Env, now = Date.now(), deps?: CheckDeps) {
  return runCheck(deps ?? createCheckDeps(env), now);
}

/**
 * 启动自检与自愈：
 * 1. 注册（或更新）Telegram Webhook——云端主动调用，不依赖本机能否访问 Telegram；
 * 2. 校验监控清单里的交易对是否真实存在，结果写入 D1 便于排查。
 */
/**
 * 仓库默认配置里的占位域名。
 * 用「Deploy to Cloudflare」按钮一键部署时用户往往还不知道自己的域名，
 * 这时拿占位符去注册 webhook 会把 Telegram 指向一个不存在的地址，
 * 且失败原因很难排查——宁可不注册，留到用户访问 /setup 时用真实域名补上。
 */
export function isPlaceholderWorkerUrl(url: string): boolean {
  return /YOUR_SUBDOMAIN|YOUR_WORKER|YOUR_ACCOUNT|example\.(com|workers\.dev)/i.test(url);
}

export async function bootstrap(env: Env, store: Store = makeStore(env)): Promise<void> {
  await store.init();

  if (env.WORKER_BASE_URL && env.TELEGRAM_BOT_TOKEN) {
    if (isPlaceholderWorkerUrl(env.WORKER_BASE_URL)) {
      console.warn(
        'WORKER_BASE_URL 仍是占位符，跳过自动注册；部署后请访问 /setup 用真实域名注册',
      );
      return;
    }
    const target = `${env.WORKER_BASE_URL.replace(/\/+$/, '')}/webhook`;
    if ((await store.getState(DIAG_KEYS.webhookUrl)) !== target) {
      const res = await setWebhook(env.TELEGRAM_BOT_TOKEN, target, env.WEBHOOK_SECRET);
      await store.setState(DIAG_KEYS.webhookUrl, target);
      await store.setState(DIAG_KEYS.webhookResult, JSON.stringify(res ?? {}));
    }
    // Telegram 侧的 webhook 状态（含投递失败原因）回写 D1，便于无法直连 Telegram 时排查
    try {
      const info = await getWebhookInfo(env.TELEGRAM_BOT_TOKEN);
      await store.setState(DIAG_KEYS.webhookInfo, JSON.stringify({ at: Date.now(), info }));
    } catch (err) {
      await store.setState(
        DIAG_KEYS.webhookInfo,
        JSON.stringify({ at: Date.now(), error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  if (!(await store.getState(DIAG_KEYS.symbolCheck))) {
    const symbols = (await store.listSymbols()).map((s) => s.symbol);
    const check = await validateSymbols(makeClient(env), symbols);
    await store.setState(
      DIAG_KEYS.symbolCheck,
      JSON.stringify({ at: Date.now(), ...check }),
    );
  }
}

/**
 * 把本轮巡检结果写入 D1，便于在无法直接访问 Worker 时排查。
 * 每个标的都记录"当前偏离 / 阈值 / 未触发原因"，用来回答"明明涨了为什么不报警"。
 */
export async function recordDiagnostics(
  store: Store,
  info: {
    now: number;
    source: string;
    alerted: string[];
    failures: unknown[];
    paused: boolean;
    sourceError?: string;
    evaluations?: Evaluation[];
  },
): Promise<void> {
  const { evaluations, ...rest } = info;
  const detail = await buildDetail(store, evaluations ?? []);
  await store.setState(
    DIAG_KEYS.lastRun,
    JSON.stringify({ ...rest, detail }),
  );
}

async function buildDetail(store: Store, evaluations: Evaluation[]) {
  if (evaluations.length === 0) return [];
  const cfgs = await store.listSymbols();
  const bySymbol = new Map(cfgs.map((c) => [c.symbol, c]));
  return evaluations.map((ev) => {
    const cfg = bySymbol.get(ev.symbol);
    const thresholdPct = cfg ? thresholdToPercent(cfg.threshold, ev.markPrice) : null;
    return {
      symbol: ev.symbol,
      mark: round2(ev.markPrice),
      last: round2(ev.lastPrice),
      pct: round2(ev.changePct),
      thrPct: thresholdPct === null ? null : round2(thresholdPct),
      triggered: ev.triggered,
      level: ev.level,
      window: ev.window,
      skipped: ev.skipped,
      gap: ev.gapDetected,
      /** 距离触发还差多少（百分点），负数表示已超阈值 */
      gapPct: thresholdPct === null ? null : round2(Math.abs(ev.changePct) - thresholdPct),
    };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* --------------------------------- 路由 --------------------------------- */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function webhookAuthorized(request: Request, env: Env): boolean {
  if (!env.WEBHOOK_SECRET) return true;
  return request.headers.get('x-telegram-bot-api-secret-token') === env.WEBHOOK_SECRET;
}

/**
 * 记录最近一次 Telegram 回调（无论成功与否）。
 * 本机无法直连 Telegram，只能靠这条记录判断消息到底有没有打进来。
 */
async function recordIncoming(env: Env, payload: Record<string, unknown>): Promise<void> {
  try {
    const store = makeStore(env);
    await store.init();
    await store.setState(DIAG_KEYS.lastUpdate, JSON.stringify({ at: Date.now(), ...payload }));
  } catch (err) {
    console.error('写入回调诊断失败：', err);
  }
}

async function handleTelegramUpdate(env: Env, update: Record<string, any>): Promise<void> {
  const incoming = parseUpdate(update);
  if (!incoming) {
    await recordIncoming(env, {
      stage: 'unparsed',
      updateId: update?.update_id ?? null,
      keys: Object.keys(update ?? {}),
    });
    return;
  }

  await recordIncoming(env, {
    stage: 'received',
    updateId: update?.update_id ?? null,
    chatId: incoming.chatId,
    kind: incoming.kind,
    text: incoming.kind === 'callback' ? incoming.data : incoming.raw,
  });

  const allowed = env.TELEGRAM_CHAT_ID;
  if (allowed && incoming.chatId !== allowed) {
    console.warn('忽略非授权会话的请求：', incoming.chatId);
    return;
  }

  const store = makeStore(env);
  await store.init();

  // 首个与 bot 交互的会话自动成为推送目标
  const bound = await store.getChatId();
  if (!bound && !allowed) await store.setChatId(incoming.chatId);

  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('未配置 TELEGRAM_BOT_TOKEN，无法响应指令');
    return;
  }

  // bot 命令与 Cron 共用同一份 K 线缓存：命令的高频查看不再额外敲交易所，
  // 在数据源被限流时尤其重要——缓存在，/test /list 才不至于跟着报错。
  const deps: BotDeps = {
    store,
    client: makeClient(env, undefined, undefined, new StoreKlineCache(store)),
    allowedChatId: allowed,
  };

  try {
    if (incoming.kind === 'callback') {
      const { toast } = await handleCallback(deps, incoming.data, Date.now());
      await answerCallbackQuery(token, incoming.callbackId, toast);
      return;
    }

    const reply = await handleIncoming(deps, incoming, Date.now());
    await sendMessage(
      token,
      {
        chat_id: incoming.chatId,
        text: reply.text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: reply.keyboard,
      },
    );
    await recordIncoming(env, { stage: 'replied', chatId: incoming.chatId, text: reply.text.slice(0, 120) });
  } catch (err) {
    console.error('处理 Telegram 更新失败：', err);
    await recordIncoming(env, {
      stage: 'error',
      chatId: incoming.chatId,
      message: err instanceof Error ? err.message : String(err),
    });
    try {
      await sendMessage(token, {
        chat_id: incoming.chatId,
        text: `⚠️ 处理失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } catch {
      /* 忽略二次失败 */
    }
  }
}

export async function route(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/health') {
    return json({ ok: true, time: new Date().toISOString() });
  }

  if (path === '/run') {
    if (env.WEBHOOK_SECRET && url.searchParams.get('key') !== env.WEBHOOK_SECRET) {
      return json({ ok: false, error: 'unauthorized' }, 401);
    }
    const result = await runCheckOnce(env);
    return json({
      ok: true,
      paused: result.paused,
      source: result.source,
      alerted: result.alerted,
      failures: result.failures,
      evaluated: result.evaluations.map((e) => ({
        symbol: e.symbol,
        triggered: e.triggered,
        level: e.level,
        skipped: e.skipped,
        changePct: Number(e.changePct.toFixed(3)),
        markPrice: e.markPrice,
      })),
    });
  }

  if (path === '/setup') {
    if (env.WEBHOOK_SECRET && url.searchParams.get('key') !== env.WEBHOOK_SECRET) {
      return json({ ok: false, error: 'unauthorized' }, 401);
    }
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) return json({ ok: false, error: 'missing TELEGRAM_BOT_TOKEN' }, 500);

    const target = url.searchParams.get('url') ?? new URL('/webhook', url.origin).toString();
    const webhookUrl = target.endsWith('/webhook') ? target : `${target.replace(/\/$/, '')}/webhook`;
    const info = await setWebhook(token, webhookUrl, env.WEBHOOK_SECRET);

    const symbols = await makeStore(env).listSymbols();
    const check = await validateSymbols(makeClient(env), symbols.map((s) => s.symbol));
    return json({ ok: true, webhookUrl, telegram: info, symbols: check });
  }

  if (path === '/diag') {
    if (env.WEBHOOK_SECRET && url.searchParams.get('key') !== env.WEBHOOK_SECRET) {
      return json({ ok: false, error: 'unauthorized' }, 401);
    }
    const store = makeStore(env);
    await store.init();
    const state: Record<string, string | undefined> = {};
    for (const key of [...Object.values(DIAG_KEYS), ...Object.values(WATCHDOG_KEYS)]) {
      state[key] = await store.getState(key);
    }
    state.chat_id = await store.getChatId();
    state.paused_until = String((await store.getPausedUntil()) ?? '');
    return json({ ok: true, state });
  }

  if (path === '/webhook-info') {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) return json({ ok: false, error: 'missing TELEGRAM_BOT_TOKEN' }, 500);
    return json({ ok: true, info: await getWebhookInfo(token) });
  }

  if (path === '/webhook') {
    if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
    if (!webhookAuthorized(request, env)) {
      // secret 不匹配是"消息打了进来却被拒"的典型原因，必须留痕
      await recordIncoming(env, {
        stage: 'rejected',
        reason: 'secret mismatch',
        header: request.headers.get('x-telegram-bot-api-secret-token'),
      });
      return json({ ok: false, error: 'unauthorized' }, 401);
    }
    let update: Record<string, any>;
    try {
      update = (await request.json()) as Record<string, any>;
    } catch {
      return json({ ok: false, error: 'invalid payload' }, 400);
    }
    // Telegram 超时只有几秒，先回 200，实际处理放进 waitUntil
    if (ctx) ctx.waitUntil(handleTelegramUpdate(env, update));
    else await handleTelegramUpdate(env, update);
    return json({ ok: true });
  }

  return json({ ok: false, error: 'not found' }, 404);
}

/** 某个阶段恢复后清掉它留下的错误，让 last_error 只反映当前状态 */
async function clearError(store: Store, stage: string): Promise<void> {
  try {
    const raw = await store.getState(DIAG_KEYS.lastError);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { stage?: string };
    if (parsed.stage === stage) await store.setState(DIAG_KEYS.lastError, '');
  } catch {
    /* 诊断写失败不影响主流程 */
  }
}

async function writeError(store: Store, stage: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`${stage} 失败：`, message);
  try {
    await store.setState(DIAG_KEYS.lastError, JSON.stringify({ at: Date.now(), stage, message }));
  } catch {
    /* 诊断写失败不影响主流程 */
  }
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const store = makeStore(env);
    const now = Date.now();

    // 心跳：证明 Cron 确实触发了
    try {
      await store.init();
      await store.setState(DIAG_KEYS.lastBeat, String(now));
    } catch (err) {
      await writeError(store, 'beat', err);
      return;
    }

    try {
      await bootstrap(env, store);
      await clearError(store, 'bootstrap');
    } catch (err) {
      await writeError(store, 'bootstrap', err);
    }

    let sourceError = '';
    const client = makeClient(
      env,
      undefined,
      (err) => {
        sourceError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      },
      new StoreKlineCache(store),
    );

    // 先看上一轮有没有烂尾，再写本轮的开始标记
    try {
      await runWatchdog(store, defaultNotify(env, store), now);
    } catch (err) {
      await writeError(store, 'watchdog', err);
    }

    try {
      await store.setState(WATCHDOG_KEYS.start, String(now));
      const result = await runCheckOnce(env, now, createCheckDeps(env, store, client));
      await recordDiagnostics(store, {
        now,
        source: result.source,
        alerted: result.alerted,
        failures: result.failures,
        paused: result.paused,
        sourceError,
        evaluations: result.evaluations,
      });
      await store.setState(WATCHDOG_KEYS.done, String(now));
      await clearError(store, 'check');
      console.log(
        `巡检完成：数据源=${result.source} 告警=${result.alerted.length} 失败=${result.failures.length}`,
      );

      // 探测排在巡检之后：它要拉全市场合约列表，响应可能是几 MB，
      // 是最容易被拖垮的一步。放在前面时一旦卡住，整轮告警就跑不到了
      // （2026-09-25 就因此中断了两小时——心跳和 bootstrap 都正常，
      // 唯独巡检没有任何痕迹）。
      try {
        await maybeProbeSources(env, store, now);
      } catch (err) {
        await writeError(store, 'probe', err);
      }
    } catch (err) {
      await writeError(store, 'check', err);
      // 巡检整体失败时，主源的错误原因是最有用的线索
      try {
        await store.setState('last_source_error', sourceError);
      } catch {
        /* 忽略 */
      }
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return route(request, env, ctx);
  },
};
