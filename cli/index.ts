#!/usr/bin/env node
/**
 * 本地命令行工具。
 * 与云端 Worker 复用同一套判定引擎，因此本地调好的阈值可以直接上线。
 *
 *   npm run cli -- check [--symbol BTCUSDT] [--verbose] [--json]
 *   npm run cli -- replay [--days 7] [--symbol BTCUSDT] [--json]
 *   npm run cli -- symbols
 */
import { DEFAULT_SYMBOLS } from '../src/config';
import { evaluateAll } from '../src/engine';
import {
  baseWindowFor,
  BINANCE_FAPI,
  BinanceClient,
  BYBIT_API,
  BybitClient,
  FailoverMarketClient,
  fetchHistory,
  fetchSnapshots,
  OKX_API,
  OkxClient,
  validateSymbols,
  type MarketClient,
} from '../src/market';
import { replaySymbol } from '../src/replay';
import { formatNumber, formatSigned, formatThreshold, formatTime } from '../src/telegram';
import type { SymbolConfig } from '../src/types';

type Flags = Record<string, string | boolean>;

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function client(): MarketClient {
  // 本机通常直连不了交易所，多挂几个源，能通哪个用哪个
  const sources = [
    new BinanceClient(process.env.BINANCE_BASE_URL ?? BINANCE_FAPI),
    new OkxClient(process.env.OKX_BASE_URL ?? OKX_API),
    new BybitClient(process.env.BYBIT_BASE_URL ?? BYBIT_API),
  ];
  return new FailoverMarketClient(sources, (err) => {
    process.stderr.write(`数据源失败，切换下一个源：${err instanceof Error ? err.message : err}\n`);
  });
}

function select(symbolFlag: string | boolean | undefined): SymbolConfig[] {
  if (typeof symbolFlag !== 'string') return DEFAULT_SYMBOLS;
  const wanted = symbolFlag.toUpperCase().split(',');
  return DEFAULT_SYMBOLS.filter((c) => wanted.includes(c.symbol));
}

function statusText(ev: ReturnType<typeof evaluateAll>[number], cfg: SymbolConfig): string {
  if (ev.triggered) return `${ev.level === 'CRITICAL' ? '🚨 剧烈异动' : '🚨 异动'} ${ev.window}`;
  switch (ev.skipped) {
    case 'disabled':
      return '已停用';
    case 'no-data':
      return '无行情数据';
    case 'gap':
      return '跳空静默';
    case 'cooldown':
      return `冷却中（${cfg.cooldownMinutes} 分钟）`;
    default: {
      const worst = ev.windows.reduce((a, b) =>
        b.distanceToThreshold < a.distanceToThreshold ? b : a,
      );
      const unit = cfg.threshold.type === 'percent' ? '%' : ' USDT';
      return `未触发 · 最近 ${worst.window} 还差 ${formatNumber(worst.distanceToThreshold, 2)}${unit}`;
    }
  }
}

async function commandCheck(flags: Flags): Promise<void> {
  const now = Date.now();
  const cfgs = select(flags.symbol);
  if (cfgs.length === 0) {
    console.error(`未找到标的：${flags.symbol}`);
    process.exitCode = 1;
    return;
  }

  const { snapshots, failures, source } = await fetchSnapshots(client(), cfgs, now);
  const evaluations = evaluateAll(cfgs, snapshots, () => ({ now }));

  const rows = evaluations.map((ev) => {
    const cfg = cfgs.find((c) => c.symbol === ev.symbol)!;
    const byWindow = (w: string) => {
      const found = ev.windows.find((x) => x.window === w);
      return found ? formatSigned(found.changePct) : '-';
    };
    return {
      symbol: ev.symbol,
      mark: formatNumber(ev.markPrice),
      last: formatNumber(ev.lastPrice),
      w5m: byWindow('5m'),
      w15m: byWindow('15m'),
      threshold: formatThreshold(cfg.threshold),
      status: statusText(ev, cfg),
    };
  });

  if (flags.json) {
    console.log(JSON.stringify({ source, now, rows, failures }, null, 2));
  } else {
    console.log(`数据源 ${source} · ${formatTime(now)}`);
    console.log(
      ['标的', '标记价', '最新价', '5m', '15m', '阈值', '结果'].join('  '),
    );
    for (const r of rows) {
      console.log(
        [r.symbol, r.mark, r.last, r.w5m, r.w15m, r.threshold, r.status].join('  '),
      );
    }
  }

  if (failures.length > 0) {
    console.error('\n行情拉取失败：');
    for (const f of failures) console.error(`  ${f.symbol}: ${f.reason}`);
  }

  if (flags.verbose) {
    for (const ev of evaluations) {
      const cfg = cfgs.find((c) => c.symbol === ev.symbol)!;
      console.log(`\n── ${cfg.display} (${cfg.symbol}) ──`);
      console.log(`  资产类别 ${cfg.assetClass} · 窗口 ${cfg.windows.join('/')} · 冷却 ${cfg.cooldownMinutes} 分钟`);
      console.log(`  跳空检测 ${ev.gapDetected ? '命中' : '未命中'}`);
      for (const w of ev.windows) {
        console.log(
          `  ${w.window}: ${formatSigned(w.changePct)}% / ${formatSigned(w.changeAbs)} USDT · ${
            w.breached ? `已超阈值（${w.level}）` : `差 ${formatNumber(w.distanceToThreshold, 2)}`
          }`,
        );
      }
      const snap = snapshots.get(cfg.symbol);
      if (snap) {
        for (const [w, series] of Object.entries(snap.klines)) {
          const last = (series as Array<{ open: number; openTime: number }>).at(-1);
          if (last) console.log(`  ${w} 窗口开盘 ${formatNumber(last.open)} @ ${formatTime(last.openTime)}`);
        }
      }
    }
  }

  const triggered = evaluations.filter((e) => e.triggered);
  if (!flags.json) {
    console.log(`\n共 ${evaluations.length} 个标的，其中 ${triggered.length} 个触发阈值。`);
  }
}

async function commandReplay(flags: Flags): Promise<void> {
  const now = Date.now();
  const days = Number(flags.days ?? 7);
  const since = now - days * 86_400_000;
  const cfgs = select(flags.symbol).filter((c) => c.enabled);

  const results = [];
  for (const cfg of cfgs) {
    const base = baseWindowFor(cfg.windows);
    let series;
    try {
      series = await fetchHistory(client(), cfg.symbol, base, since, now);
    } catch (err) {
      console.error(`${cfg.symbol} 历史数据拉取失败：${err instanceof Error ? err.message : err}`);
      continue;
    }
    const r = replaySymbol(cfg, series, base);
    results.push(r);
    if (flags.json) continue;

    const warn = r.alerts.filter((a) => a.level === 'WARN').length;
    const critical = r.alerts.length - warn;
    console.log(`\n${cfg.display} (${cfg.symbol}) · 近 ${days} 天`);
    console.log(
      `  扫描 ${r.scanned} 根 ${base} K 线 · 告警 ${r.alerts.length} 次（WARN ${warn} / CRITICAL ${critical}） · 跳空静默 ${r.gapSkipped} 次`,
    );
    console.log(`  单窗口最大波动 ${formatNumber(r.maxAbsPct, 2)}%`);
    console.log('  阈值候选（历史上会触发的 K 线根数）：');
    for (const t of r.thresholdScan) {
      console.log(`    ${String(t.percent).padStart(4)}% → ${t.count} 根`);
    }
    for (const a of r.alerts.slice(0, 5)) {
      console.log(
        `  最近告警 ${formatTime(a.ts)} ${a.level} ${a.window} ${formatSigned(a.changePct)}%`,
      );
    }
  }

  if (flags.json) console.log(JSON.stringify(results, null, 2));
}

async function commandSymbols(): Promise<void> {
  const symbols = DEFAULT_SYMBOLS.map((c) => c.symbol);
  const check = await validateSymbols(client(), symbols);
  console.log(`可用 ${check.ok.length} 个：${check.ok.join(', ')}`);
  if (check.missing.length > 0) {
    console.error(`交易所不存在 ${check.missing.length} 个：${check.missing.join(', ')}`);
    process.exitCode = 1;
  }
}

function help(): void {
  console.log(`合约异动告警 CLI

  check    拉取当前行情并给出判定结果（含未触发项距阈值差值）
           --symbol BTCUSDT  只看指定标的
           --verbose         打印每个窗口的开价与跳空详情
           --json            输出 JSON
  replay   回放历史 K 线，统计告警次数，用于定阈值
           --days 7          回放天数
           --symbol BTCUSDT  只看指定标的
  symbols  校验默认清单里的交易对是否真实存在
`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (cmd) {
    case 'check':
    case undefined:
      await commandCheck(flags);
      break;
    case 'replay':
      await commandReplay(flags);
      break;
    case 'symbols':
      await commandSymbols();
      break;
    case 'help':
    case '--help':
      help();
      break;
    default:
      console.error(`未知命令 ${cmd}`);
      help();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`执行失败：${msg}`);
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|timeout/i.test(msg)) {
    console.error('提示：当前网络可能无法直连交易所，云端 Worker 不受影响。');
  }
  process.exitCode = 1;
});
