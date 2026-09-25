import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, {
  bootstrap,
  createCheckDeps,
  defaultNotify,
  makeClient,
  makeStore,
  maybeProbeSources,
  probeSources,
  recordDiagnostics,
  resolveSourceOrder,
  route,
  runCheckOnce,
  runWatchdog,
  WATCHDOG_KEYS,
  WATCHDOG_STALE_MS,
  type Env,
} from '../src/worker';
import type { MarketClient } from '../src/market';
import { MemoryStore } from '../src/store';
import type { Kline } from '../src/types';
import { cfg } from './helpers';

const NOW = 1_700_000_000_000;

interface Sent {
  method: string;
  body: Record<string, any>;
}

let sent: Sent[] = [];

const TRADED = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SNDKUSDT',
  'CLUSDT',
  'XAUUSDT',
  'SOLUSDT',
];

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** 同时桩掉 Telegram API 与三个行情源，让整条链路可离线回放 */
function fakeFetch(): typeof fetch {
  const okxId = (s: string) => `${s.replace(/USDT$/, '')}-USDT-SWAP`;
  const bar = [[0, '100', '110', '99', '110']];

  return (async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('api.telegram.org')) {
      const method = url.split('/').pop() ?? '';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};
      sent.push({ method, body });
      return json({ ok: true, result: {} });
    }

    // Bybit：路径以 /v5/ 开头，需先于 OKX 的 /api/v5/ 判断
    if (url.includes('instruments-info')) {
      return json({ retCode: 0, result: { list: TRADED.map((s) => ({ symbol: s, status: 'Trading' })) } });
    }
    if (url.includes('/v5/market/tickers')) {
      return json({
        retCode: 0,
        result: { list: TRADED.map((s) => ({ symbol: s, markPrice: '110', lastPrice: '110.5' })) },
      });
    }
    if (url.includes('/v5/market/kline')) {
      return json({ retCode: 0, result: { list: bar } });
    }

    // OKX
    if (url.includes('/api/v5/public/instruments')) {
      return json({ data: TRADED.map((s) => ({ instId: okxId(s), state: 'live' })) });
    }
    if (url.includes('mark-price')) {
      return json({ data: TRADED.map((s) => ({ instId: okxId(s), markPx: '110' })) });
    }
    if (url.includes('/api/v5/market/tickers')) {
      return json({ data: TRADED.map((s) => ({ instId: okxId(s), last: '110.5' })) });
    }
    if (url.includes('candles')) {
      return json({ data: bar });
    }

    // Binance
    if (url.includes('exchangeInfo')) {
      return json({ symbols: TRADED.map((s) => ({ symbol: s, status: 'TRADING' })) });
    }
    if (url.includes('premiumIndex')) {
      return json(TRADED.map((s) => ({ symbol: s, markPrice: '110' })));
    }
    if (url.includes('ticker/price')) {
      return json(TRADED.map((s) => ({ symbol: s, price: '110.5' })));
    }
    if (url.includes('klines')) {
      return json(bar);
    }
    return json({});
  }) as unknown as typeof fetch;
}

function kline(openTime: number, open: number, close: number, range = 0): Kline {
  return { openTime, open, high: Math.max(open, close) + range, low: Math.min(open, close) - range, close };
}

interface FakeMarketOpts {
  mark?: number;
  last?: number;
  klines?: Kline[];
  symbols?: string[];
}

function fakeMarket(opts: FakeMarketOpts = {}): MarketClient {
  const mark = opts.mark ?? 110;
  return {
    name: 'fake',
    fetchPriceMap: async () => ({
      mark: new Map([['BTCUSDT', mark], ['XAUUSDT', mark]]),
      last: new Map([['BTCUSDT', (opts.last ?? mark) + 0.5], ['XAUUSDT', mark]]),
    }),
    fetchKlines: async () => opts.klines ?? [kline(0, 100, mark)],
    listSymbols: async () => opts.symbols ?? ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  };
}

function baseEnv(overrides: Partial<Env> = {}): Env {
  return { TELEGRAM_BOT_TOKEN: 'token', ...overrides };
}

function depsFor(env: Env, client: MarketClient) {
  const store = new MemoryStore([cfg()]);
  return { store, deps: createCheckDeps(env, store, client) };
}

beforeEach(() => {
  sent = [];
  vi.stubGlobal('fetch', fakeFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('巡检主流程', () => {
  it('触发阈值时推送告警并记录冷却', async () => {
    const env = baseEnv({ TELEGRAM_CHAT_ID: '-1001' });
    const { store, deps } = depsFor(env, fakeMarket());

    const r = await runCheckOnce(env, NOW, deps);
    expect(r.paused).toBe(false);
    expect(r.alerted).toEqual(['BTCUSDT']);
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('sendMessage');
    expect(sent[0].body.chat_id).toBe('-1001');
    expect(sent[0].body.text).toContain('BTCUSDT');
    expect(sent[0].body.text).toContain('+10.00%');
    expect(sent[0].body.reply_markup.inline_keyboard[0][0].callback_data).toBe('mute:BTCUSDT:60');
    expect(await store.getLastAlertAt('BTCUSDT')).toBe(NOW);
  });

  it('冷却期内不重复推送', async () => {
    const env = baseEnv({ TELEGRAM_CHAT_ID: '-1001' });
    const { deps } = depsFor(env, fakeMarket());

    await runCheckOnce(env, NOW, deps);
    const second = await runCheckOnce(env, NOW + 60_000, deps);
    expect(second.alerted).toEqual([]);
    expect(second.evaluations[0].skipped).toBe('cooldown');
    expect(sent).toHaveLength(1);
  });

  it('未达阈值不推送', async () => {
    const env = baseEnv({ TELEGRAM_CHAT_ID: '-1001' });
    const { deps } = depsFor(env, fakeMarket({ mark: 100.5 }));
    const r = await runCheckOnce(env, NOW, deps);
    expect(r.alerted).toEqual([]);
    expect(r.evaluations[0].skipped).toBe('below-threshold');
    expect(sent).toHaveLength(0);
  });

  it('全局暂停期间整轮跳过', async () => {
    const env = baseEnv({ TELEGRAM_CHAT_ID: '-1001' });
    const { store, deps } = depsFor(env, fakeMarket());
    await store.setPausedUntil(NOW + 3_600_000);

    const r = await runCheckOnce(env, NOW, deps);
    expect(r.paused).toBe(true);
    expect(r.evaluations).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('未配置 token 时不推送但完成判定', async () => {
    const env: Env = {};
    const { deps } = depsFor(env, fakeMarket());
    const r = await runCheckOnce(env, NOW, deps);
    expect(r.alerted).toEqual(['BTCUSDT']);
    expect(sent).toHaveLength(0);
  });

  it('行情拉取失败的标的进入 failures', async () => {
    const env = baseEnv({ TELEGRAM_CHAT_ID: '-1001' });
    const broken: MarketClient = {
      ...fakeMarket(),
      fetchKlines: async () => {
        throw new Error('boom');
      },
    };
    const r = await runCheckOnce(env, NOW, createCheckDeps(env, new MemoryStore([cfg()]), broken));
    expect(r.failures[0]).toEqual({ symbol: 'BTCUSDT', reason: 'boom' });
    expect(r.alerted).toEqual([]);
  });
});

describe('数据源探测', () => {
  it('逐个探测并记录每个源是否可用', async () => {
    const env = baseEnv();
    const results = await probeSources(env);
    expect(results.map((r) => r.name)).toEqual(['okx', 'bybit', 'binance']);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('不可达的源记录原因而不是整轮失败', async () => {
    vi.stubGlobal(
      'fetch',
      (async (input: string) => {
        // 只让 Bybit 挂掉，验证探测能区分出单个源
        if (String(input).includes('bybit')) throw new Error('bybit unreachable');
        return json({ data: TRADED.map((s) => ({ instId: `${s.replace(/USDT$/, '')}-USDT-SWAP`, state: 'live' })) });
      }) as unknown as typeof fetch,
    );
    const results = await probeSources(baseEnv());
    const bybit = results.find((r) => r.name === 'bybit');
    expect(bybit?.ok).toBe(false);
    expect(bybit?.error).toContain('bybit unreachable');
    expect(results.find((r) => r.name === 'okx')?.ok).toBe(true);
  });

  it('单个源挂起时按超时放弃，不拖垮整轮', async () => {
    // 回归：探测曾用 listSymbols 拉全市场合约（几 MB），卡住后巡检整轮跑不到，
    // 表现为监控中断两小时却只在心跳里留痕。
    vi.stubGlobal(
      'fetch',
      (async () => new Promise(() => {})) as unknown as typeof fetch,
    );
    const started = Date.now();
    const results = await probeSources(baseEnv(), Date.now(), undefined, 50);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results[0].error).toContain('探测超时');
  });

  it('未到间隔时跳过探测，到点后写入状态', async () => {
    const env = baseEnv({ WORKER_BASE_URL: 'https://x.dev' });
    const store = new MemoryStore();
    await maybeProbeSources(env, store, 1_000_000);
    expect(await store.getState('source_probe')).toBeDefined();

    await store.setState('source_probe', JSON.stringify({ at: 1_000_000, results: [] }));
    await maybeProbeSources(env, store, 1_000_000 + 60_000);
    expect(JSON.parse((await store.getState('source_probe'))!).results).toEqual([]);
  });
});

describe('数据源顺序', () => {
  it('默认 okx 优先、binance 垫底（对 CF 出口 IP 恒定 403）', () => {
    expect(resolveSourceOrder({})).toEqual(['okx', 'bybit', 'binance']);
  });

  it('MARKET_PRIMARY 提到最前，其余保持默认顺序', () => {
    expect(resolveSourceOrder({ MARKET_PRIMARY: 'binance' })).toEqual([
      'binance',
      'okx',
      'bybit',
    ]);
  });

  it('MARKET_SOURCES 完全覆盖默认顺序', () => {
    expect(resolveSourceOrder({ MARKET_SOURCES: 'bybit, okx' })).toEqual(['bybit', 'okx']);
  });
});

describe('看门狗', () => {
  /** 一轮巡检开始了但没有写出结果——正是被平台静默掐断的形态 */
  async function stalledStore(startedAt: number): Promise<MemoryStore> {
    const store = new MemoryStore();
    await store.setState(WATCHDOG_KEYS.start, String(startedAt));
    return store;
  }

  it('巡检烂尾超时后主动推送中断告警', async () => {
    const store = await stalledStore(NOW - WATCHDOG_STALE_MS - 1);
    const notices: string[] = [];

    await runWatchdog(store, async (t) => void notices.push(t), NOW);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('监控已中断');
    expect(notices[0]).toContain('不会产生任何告警');
    expect(await store.getState(WATCHDOG_KEYS.alertedAt)).toBe(String(NOW));
  });

  it('中断期间只告警一次，不重复打扰', async () => {
    const store = await stalledStore(NOW - WATCHDOG_STALE_MS - 1);
    const notices: string[] = [];
    const notify = async (t: string) => void notices.push(t);

    await runWatchdog(store, notify, NOW);
    await runWatchdog(store, notify, NOW + 2 * 60_000);
    await runWatchdog(store, notify, NOW + 20 * 60_000);

    expect(notices).toHaveLength(1);
  });

  it('容忍期内未完成不报警，避免偶发抖动误报', async () => {
    const store = await stalledStore(NOW - WATCHDOG_STALE_MS + 1_000);
    const notices: string[] = [];

    await runWatchdog(store, async (t) => void notices.push(t), NOW);
    expect(notices).toHaveLength(0);
  });

  it('正常完成的一轮不触发告警', async () => {
    const store = new MemoryStore();
    await store.setState(WATCHDOG_KEYS.start, String(NOW - 10 * 60_000));
    await store.setState(WATCHDOG_KEYS.done, String(NOW - 10 * 60_000 + 5_000));
    const notices: string[] = [];

    await runWatchdog(store, async (t) => void notices.push(t), NOW);
    expect(notices).toHaveLength(0);
  });

  it('从未巡检过时不误报', async () => {
    const notices: string[] = [];
    await runWatchdog(new MemoryStore(), async (t) => void notices.push(t), NOW);
    expect(notices).toHaveLength(0);
  });

  it('恢复后推送已恢复并清除标记', async () => {
    const store = await stalledStore(NOW - WATCHDOG_STALE_MS - 1);
    const notices: string[] = [];
    const notify = async (t: string) => void notices.push(t);

    await runWatchdog(store, notify, NOW);
    // 下一轮巡检成功：完成标记追上开始标记
    const recovered = NOW + 2 * 60_000;
    await store.setState(WATCHDOG_KEYS.start, String(recovered - 5_000));
    await store.setState(WATCHDOG_KEYS.done, String(recovered - 4_000));

    await runWatchdog(store, notify, recovered);
    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain('监控已恢复');
    expect(await store.getState(WATCHDOG_KEYS.alertedAt)).toBe('');
  });

  it('通知走固定会话并在缺 token 时静默跳过', async () => {
    const env = baseEnv({ TELEGRAM_CHAT_ID: '-1001' });
    await defaultNotify(env, new MemoryStore())('hello');
    expect(sent.some((s) => s.method === 'sendMessage' && s.body.text === 'hello')).toBe(true);

    sent = [];
    await defaultNotify({}, new MemoryStore())('hello');
    expect(sent).toHaveLength(0);
  });

  it('Cron 入口在巡检前后写入开始与完成标记', async () => {
    const env = baseEnv({ WORKER_BASE_URL: 'https://x.dev' });
    await worker.scheduled(
      {} as ScheduledEvent,
      env,
      { waitUntil: () => {} } as unknown as ExecutionContext,
    );
    const store = makeStore(env);
    const started = Number(await store.getState(WATCHDOG_KEYS.start));
    const finished = Number(await store.getState(WATCHDOG_KEYS.done));
    expect(started).toBeGreaterThan(0);
    expect(finished).toBeGreaterThanOrEqual(started);
  });
});

describe('TradFi 跳空', () => {
  it('休市后跳空不告警，并写入静默窗口', async () => {
    const env = baseEnv({ TELEGRAM_CHAT_ID: '-1001' });
    const tradfi = cfg({
      symbol: 'XAUUSDT',
      display: 'XAU',
      assetClass: 'tradfi',
      threshold: { type: 'percent', value: 0.5 },
    });
    const klines = [kline(0, 100, 100), kline(300_000, 100, 106)];
    const store = new MemoryStore([tradfi]);
    const deps = createCheckDeps(env, store, fakeMarket({ mark: 106, klines }));

    const r = await runCheckOnce(env, NOW, deps);
    expect(r.evaluations[0].gapDetected).toBe(true);
    expect(r.evaluations[0].skipped).toBe('gap');
    expect(r.alerted).toEqual([]);
    expect(sent).toHaveLength(0);
    expect(await store.getGapMutedUntil('XAUUSDT')).toBe(NOW + 15 * 60_000);
  });
});

describe('启动自检与自愈', () => {
  it('注册 webhook 并写入诊断状态', async () => {
    const env = baseEnv({ WORKER_BASE_URL: 'https://x.dev', WEBHOOK_SECRET: 'sec' });
    await bootstrap(env);
    expect(sent.some((s) => s.method === 'setWebhook')).toBe(true);
    const store = makeStore(env);
    expect(await store.getState('webhook_url')).toBe('https://x.dev/webhook');
    expect(await store.getState('symbol_check')).toContain('BTCUSDT');
  });

  it('webhook 未变化时不再重复注册', async () => {
    const env = baseEnv({ WORKER_BASE_URL: 'https://x.dev', WEBHOOK_SECRET: 'sec' });
    await bootstrap(env);
    sent = [];
    await bootstrap(env);
    expect(sent.some((s) => s.method === 'setWebhook')).toBe(false);
  });

  it('占位域名不拿去注册 webhook', async () => {
    // 回归：一键部署（Deploy to Cloudflare 按钮）后用户还没填真实域名，
    // 拿占位符注册会把 Telegram 指向不存在的地址，且极难排查。
    const env = baseEnv({ WORKER_BASE_URL: 'https://tg-crypto-alert.YOUR_SUBDOMAIN.workers.dev' });
    await bootstrap(env);
    expect(sent.some((s) => s.method === 'setWebhook')).toBe(false);
  });

  it('缺少地址或 token 时跳过注册', async () => {
    await bootstrap(baseEnv({ WORKER_BASE_URL: 'https://x.dev' }));
    expect(sent.some((s) => s.method === 'setWebhook')).toBe(true);
    sent = [];
    await bootstrap({});
    expect(sent.some((s) => s.method === 'setWebhook')).toBe(false);
  });

  it('巡检结果写入诊断状态', async () => {
    const env = baseEnv({ TELEGRAM_CHAT_ID: '-1001' });
    const store = new MemoryStore([cfg()]);
    await runCheckOnce(env, NOW, createCheckDeps(env, store, fakeMarket()));
    await recordDiagnostics(store, {
      now: NOW,
      source: 'fake',
      alerted: ['BTCUSDT'],
      failures: [],
      paused: false,
    });
    expect(await store.getState('last_run')).toContain('BTCUSDT');
  });

  it('诊断记录每个标的的偏离度与未触发原因', async () => {
    const env = baseEnv({ TELEGRAM_CHAT_ID: '-1001' });
    const store = new MemoryStore([cfg({ threshold: { type: 'percent', value: 50 } })]);
    const result = await runCheckOnce(env, NOW, createCheckDeps(env, store, fakeMarket()));
    await recordDiagnostics(store, {
      now: NOW,
      source: 'fake',
      alerted: result.alerted,
      failures: result.failures,
      paused: result.paused,
      evaluations: result.evaluations,
    });

    const run = JSON.parse((await store.getState('last_run')) ?? '{}');
    const btc = run.detail.find((d: Record<string, unknown>) => d.symbol === 'BTCUSDT');
    expect(btc.thrPct).toBe(50);
    // 未触发时能看到"还差多少"以及原因，用来回答"明明涨了为什么不报警"
    expect(btc.triggered).toBe(false);
    expect(typeof btc.gapPct).toBe('number');
    expect(typeof btc.skipped).toBe('string');
  });

  it('主数据源失败时通过回调上报原因', async () => {
    vi.stubGlobal(
      'fetch',
      (async () => {
        throw new Error('primary down');
      }) as unknown as typeof fetch,
    );
    const errors: string[] = [];
    const client = makeClient({}, undefined, (e) => errors.push(String(e)));
    await client.fetchPriceMap(['BTCUSDT']).catch(() => {});
    // 三个源都会各报一次，逐个尝试后整单失败
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('primary down');
  });

  it('Cron 入口写入心跳与巡检诊断', async () => {
    const env = baseEnv({ WORKER_BASE_URL: 'https://x.dev' });
    await worker.scheduled(
      {} as ScheduledEvent,
      env,
      { waitUntil: () => {} } as unknown as ExecutionContext,
    );
    const store = makeStore(env);
    expect(await store.getState('last_beat')).toBeDefined();
    const run = JSON.parse((await store.getState('last_run')) ?? '{}');
    expect(run.source).toBeDefined();
    expect(Array.isArray(run.alerted)).toBe(true);
  });

  it('启动自检失败时把错误写进状态而不是静默失败', async () => {
    const env = baseEnv({ WORKER_BASE_URL: 'https://x.dev' });
    const store = makeStore(env);
    vi.stubGlobal(
      'fetch',
      (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    );
    await worker.scheduled(
      {} as ScheduledEvent,
      env,
      { waitUntil: () => {} } as unknown as ExecutionContext,
    );
    const err = JSON.parse((await store.getState('last_error')) ?? '{}');
    // bootstrap 与 check 都会失败，最后一次写入的是 check
    expect(['bootstrap', 'check']).toContain(err.stage);
    expect(err.message).toContain('network down');
  });

  it('阶段恢复后清掉该阶段留下的错误', async () => {
    const env = baseEnv({ WORKER_BASE_URL: 'https://x.dev' });
    const store = makeStore(env);
    await store.setState('last_error', JSON.stringify({ at: 1, stage: 'check', message: 'old' }));
    await worker.scheduled(
      {} as ScheduledEvent,
      env,
      { waitUntil: () => {} } as unknown as ExecutionContext,
    );
    expect(await store.getState('last_error')).toBe('');
  });

  it('可用 MARKET_PRIMARY 指定主数据源', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      (async (input: string) => {
        urls.push(input);
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    );
    await makeClient({ MARKET_PRIMARY: 'okx' }).listSymbols();
    expect(urls[0]).toContain('okx.com');
  });

  it('/diag 需要密钥并输出诊断状态', async () => {
    const env = baseEnv({ WORKER_BASE_URL: 'https://x.dev', WEBHOOK_SECRET: 'sec' });
    await bootstrap(env);
    const denied = await route(new Request('https://x.dev/diag'), env);
    expect(denied.status).toBe(401);

    const res = await route(new Request('https://x.dev/diag?key=sec'), env);
    const json = (await res.json()) as { state: Record<string, string> };
    expect(json.state.webhook_url).toBe('https://x.dev/webhook');
    expect(json.state.last_run).toBeUndefined();
  });
});

describe('HTTP 路由', () => {
  it('/health 返回健康状态', async () => {
    const res = await route(new Request('https://x.dev/health'), baseEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('未知路径 404', async () => {
    const res = await route(new Request('https://x.dev/nope'), baseEnv());
    expect(res.status).toBe(404);
  });

  it('/run 无密钥时拒绝', async () => {
    const res = await route(
      new Request('https://x.dev/run'),
      baseEnv({ WEBHOOK_SECRET: 's3cret' }),
    );
    expect(res.status).toBe(401);
  });

  it('/run 带密钥可执行巡检', async () => {
    const env = baseEnv({ WEBHOOK_SECRET: 's3cret' });
    const res = await route(new Request('https://x.dev/run?key=s3cret'), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; evaluated: unknown[] };
    expect(json.ok).toBe(true);
    expect(json.evaluated.length).toBeGreaterThan(0);
  });

  it('/setup 绑定 webhook 并自检交易对', async () => {
    const env = baseEnv({ WEBHOOK_SECRET: 's3cret' });
    const res = await route(
      new Request('https://x.dev/setup?key=s3cret'),
      env,
    );
    const json = (await res.json()) as { webhookUrl: string; symbols: { ok: string[]; missing: string[] } };
    expect(json.webhookUrl).toBe('https://x.dev/webhook');
    expect(json.symbols.ok).toContain('BTCUSDT');
    const setWebhookCall = sent.find((s) => s.method === 'setWebhook');
    expect(setWebhookCall?.body.url).toBe('https://x.dev/webhook');
    expect(setWebhookCall?.body.secret_token).toBe('s3cret');
  });

  it('/setup 缺少 token 时报错', async () => {
    const res = await route(new Request('https://x.dev/setup'), {});
    expect(res.status).toBe(500);
  });
});

describe('Telegram 交互', () => {
  function webhook(update: unknown): Request {
    return new Request('https://x.dev/webhook', {
      method: 'POST',
      body: JSON.stringify(update),
      headers: { 'content-type': 'application/json' },
    });
  }

  function textUpdate(text: string, chatId = -1001): unknown {
    return { message: { message_id: 1, chat: { id: chatId }, from: { id: 7 }, text } };
  }

  it('首个交互自动绑定推送会话', async () => {
    const env = baseEnv();
    await route(webhook(textUpdate('/start')), env);
    const reply = sent.find((s) => s.method === 'sendMessage');
    expect(reply!.body.text).toContain('合约异动告警');
    expect(await makeStore(env).getChatId()).toBe('-1001');
  });

  it('暂停命令对后续巡检生效', async () => {
    const env = baseEnv({ TELEGRAM_CHAT_ID: '-1001' });
    await route(webhook(textUpdate('/pause 30')), env);
    const r = await runCheckOnce(env, Date.now());
    expect(r.paused).toBe(true);
  });

  it('执行 /pause 后暂停告警', async () => {
    const env = baseEnv();
    await route(webhook(textUpdate('/pause 30')), env);
    const reply = sent.find((s) => s.method === 'sendMessage');
    expect(reply!.body.text).toContain('全局暂停 30 分钟');
  });

  it('执行 /set 修改阈值', async () => {
    const env = baseEnv();
    await route(webhook(textUpdate('/set BTCUSDT 2.5')), env);
    const reply = sent.find((s) => s.method === 'sendMessage');
    expect(reply!.body.text).toContain('2.5%');
  });

  it('执行 /add 校验交易对存在', async () => {
    const env = baseEnv();
    await route(webhook(textUpdate('/add SOLUSDT pct 4')), env);
    const reply = sent.find((s) => s.method === 'sendMessage');
    expect(reply!.body.text).toContain('已添加 SOLUSDT');
  });

  it('/add 不存在的交易对时报错', async () => {
    const env = baseEnv();
    await route(webhook(textUpdate('/add FAKEUSDT 3')), env);
    const reply = sent.find((s) => s.method === 'sendMessage');
    expect(reply!.body.text).toContain('不存在');
  });

  it('/test 用真实行情渲染测试告警', async () => {
    const env = baseEnv();
    await route(webhook(textUpdate('/test')), env);
    const reply = sent.find((s) => s.method === 'sendMessage');
    expect(reply!.body.text).toContain('测试告警');
  });

  it('/test 不因 K 线被限流而失败', async () => {
    // 回归：/test 只渲染一条模拟告警，本不需要 K 线。
    // 原先走 fetchSnapshots 搭上了 K 线请求，5 分钟整点缓存失效那一瞬撞上 429，
    // 命令就报「行情拉取失败」，把数据源状态和推送链路混为一谈。
    vi.stubGlobal(
      'fetch',
      (async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('api.telegram.org')) {
          const method = url.split('/').pop() ?? '';
          const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};
          sent.push({ method, body });
          return json({ ok: true, result: {} });
        }
        if (url.includes('premiumIndex'))
          return json(TRADED.map((s) => ({ symbol: s, markPrice: '110' })));
        if (url.includes('ticker/price'))
          return json(TRADED.map((s) => ({ symbol: s, price: '110.5' })));
        return new Response('{}', { status: 429 });
      }) as unknown as typeof fetch,
    );

    const env = baseEnv();
    await route(webhook(textUpdate('/test')), env);
    const reply = sent.find((s) => s.method === 'sendMessage');
    expect(reply?.body.text).toContain('测试告警');
    expect(reply?.body.text).not.toContain('行情拉取失败');
  });

  it('按钮回调写入静默并回执', async () => {
    const env = baseEnv();
    const res = await route(
      webhook({
        callback_query: {
          id: 'cb1',
          data: 'mute:BTCUSDT:60',
          from: { id: 7 },
          message: { message_id: 2, chat: { id: -1001 } },
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const ack = sent.find((s) => s.method === 'answerCallbackQuery');
    expect(ack?.body.text).toContain('BTCUSDT 静默 60 分钟');
  });

  it('非授权会话的命令被忽略', async () => {
    const env = baseEnv({ TELEGRAM_CHAT_ID: '-1001' });
    await route(webhook(textUpdate('/pause', -9999)), env);
    expect(sent).toHaveLength(0);
  });

  it('webhook 密钥不匹配时拒绝', async () => {
    const env = baseEnv({ WEBHOOK_SECRET: 's3cret' });
    const res = await route(webhook(textUpdate('/list')), env);
    expect(res.status).toBe(401);
  });

  it('收到的回调写入诊断状态，便于无法直连时排查', async () => {
    const env = baseEnv();
    await route(webhook(textUpdate('/start')), env);
    const last = JSON.parse((await makeStore(env).getState('last_update')) ?? '{}');
    expect(last.stage).toBe('replied');
    expect(last.chatId).toBe('-1001');
  });

  it('密钥不匹配的回调也会留痕', async () => {
    const env = baseEnv({ WEBHOOK_SECRET: 's3cret' });
    await route(webhook(textUpdate('/list')), env);
    const last = JSON.parse((await makeStore(env).getState('last_update')) ?? '{}');
    expect(last.stage).toBe('rejected');
    expect(last.reason).toBe('secret mismatch');
  });

  it('处理异常时仍回 200 并提示', async () => {
    const env = baseEnv();
    const broken = webhook(textUpdate('/set'));
    const res = await route(broken, env);
    expect(res.status).toBe(200);
    const reply = sent.find((s) => s.method === 'sendMessage');
    expect(reply!.body.text).toContain('缺少交易对代码');
  });
});
