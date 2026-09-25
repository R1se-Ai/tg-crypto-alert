import { defaultFetch, type FetchLike } from './http';
import type { Evaluation, SymbolConfig, Threshold } from './types';

export const TELEGRAM_API = 'https://api.telegram.org';

export type { FetchLike } from './http';

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineButton[][];
}

export interface SendMessageParams {
  chat_id: string | number;
  text: string;
  parse_mode?: 'HTML';
  disable_web_page_preview?: boolean;
  reply_markup?: InlineKeyboardMarkup;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export class TelegramError extends Error {}

export function apiUrl(token: string, method: string): string {
  return `${TELEGRAM_API}/bot${token}/${method}`;
}

export async function callApi<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  fetchFn: FetchLike = defaultFetch,
  timeoutMs = 8_000,
): Promise<T> {
  const res = await fetchFn(apiUrl(token, method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = (await res.json()) as TelegramResponse<T>;
  if (!res.ok || !payload.ok) {
    throw new TelegramError(`Telegram ${method} 失败：${payload.description ?? res.status}`);
  }
  return payload.result as T;
}

export function sendMessage(
  token: string,
  params: SendMessageParams,
  fetchFn: FetchLike = defaultFetch,
): Promise<unknown> {
  return callApi(token, 'sendMessage', { ...params }, fetchFn);
}

export function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string,
  fetchFn: FetchLike = defaultFetch,
): Promise<unknown> {
  return callApi(token, 'answerCallbackQuery', { callback_query_id: callbackQueryId, text }, fetchFn);
}

export function setWebhook(
  token: string,
  url: string,
  secretToken?: string,
  fetchFn: FetchLike = defaultFetch,
): Promise<unknown> {
  const body: Record<string, unknown> = { url, drop_pending_updates: false };
  if (secretToken) body.secret_token = secretToken;
  return callApi(token, 'setWebhook', body, fetchFn);
}

export function deleteWebhook(token: string, fetchFn: FetchLike = defaultFetch): Promise<unknown> {
  return callApi(token, 'deleteWebhook', { drop_pending_updates: false }, fetchFn);
}

export function getWebhookInfo(token: string, fetchFn: FetchLike = defaultFetch): Promise<unknown> {
  return callApi(token, 'getWebhookInfo', {}, fetchFn);
}

/* ------------------------------- 消息格式化 ------------------------------- */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatNumber(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatSigned(n: number, digits = 2): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${formatNumber(n, digits)}`;
}

const TIME_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatTime(ts: number): string {
  return `${TIME_FMT.format(new Date(ts))} (UTC+8)`;
}

export function formatThreshold(t: Threshold): string {
  return t.type === 'percent' ? `${t.value}%` : `${t.value} USDT`;
}

export function thresholdText(cfg: SymbolConfig): string {
  return formatThreshold(cfg.threshold);
}

/** 带口径说明的阈值文案，用于设置类回复，避免「%」与「USDT」两种口径互相混淆 */
export function formatThresholdUnit(t: Threshold): string {
  return t.type === 'percent' ? `${t.value}%（百分比）` : `${t.value} USDT（绝对金额）`;
}

/** 告警正文：涨用红、跌用绿符合国内习惯，这里用 emoji 表达方向 */
export function formatAlert(cfg: SymbolConfig, ev: Evaluation, now: number): string {
  const arrow = ev.changePct >= 0 ? '🔴 涨' : '🟢 跌';
  const level = ev.level === 'CRITICAL' ? '🚨🚨 剧烈异动' : '🚨 异动';
  const change =
    cfg.threshold.type === 'absolute'
      ? `${formatSigned(ev.changeAbs)} USDT（${formatSigned(ev.changePct)}%）`
      : `${formatSigned(ev.changePct)}%（${formatSigned(ev.changeAbs)} USDT）`;
  return [
    `${level} <b>${escapeHtml(cfg.display || cfg.symbol)}</b>`,
    `${arrow} ${change}`,
    `窗口 ${ev.window} · 阈值 ${thresholdText(cfg)}`,
    `标记价 ${formatNumber(ev.markPrice)} · 最新 ${formatNumber(ev.lastPrice)}`,
    `${escapeHtml(cfg.symbol)} · ${formatTime(now)}`,
  ].join('\n');
}

export function alertKeyboard(symbol: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '此币种静音 1 小时', callback_data: `mute:${symbol}:60` },
        { text: '全部暂停 1 小时', callback_data: 'pause:60' },
      ],
    ],
  };
}

export function helpText(): string {
  return [
    '<b>合约异动告警 Bot</b>',
    '',
    '/list 查看监控清单与阈值',
    '/add 代码 [pct|abs] [值] 新增标的，如 <code>/add SOLUSDT pct 3</code>',
    '/set 代码 值 修改阈值，如 <code>/set BTCUSDT 1.5%</code> 或 <code>/set ETHUSDT 60u</code>',
    '　　阈值可写 <code>1.5%</code>（百分比）或 <code>60u</code>（USDT 绝对值）；不写单位则沿用该标的当前口径',
    '/remove 代码 删除标的',
    '/on 代码 / /off 代码 启停单个标的',
    '/pause [分钟] 全局静默，/resume 恢复',
    '/mute 代码 [分钟] 静默单个标的',
    '/status 查看当前状态',
    '/test 发送一条测试告警',
  ].join('\n');
}

export function formatSymbolList(cfgs: SymbolConfig[]): string {
  if (cfgs.length === 0) return '监控清单为空，用 /add 添加标的。';
  const lines = cfgs.map((c) => {
    const flag = c.enabled ? '✅' : '⏸';
    const kind = c.assetClass === 'tradfi' ? 'TradFi' : 'Crypto';
    return `${flag} <b>${escapeHtml(c.display || c.symbol)}</b> ${thresholdText(c)} · ${c.windows.join('/')} · ${kind}`;
  });
  return ['<b>监控清单</b>', ...lines].join('\n');
}

export function formatStatus(input: {
  now: number;
  pausedUntil?: number;
  symbolCount: number;
  enabledCount: number;
  chatId?: string;
  recent?: string[];
}): string {
  const paused =
    input.pausedUntil && input.pausedUntil > input.now
      ? `已暂停至 ${formatTime(input.pausedUntil)}`
      : '运行中';
  const lines = [
    '<b>运行状态</b>',
    `状态：${paused}`,
    `标的：${input.enabledCount}/${input.symbolCount} 启用`,
    `推送会话：${input.chatId ? escapeHtml(input.chatId) : '未绑定（给 bot 发任意消息即自动绑定）'}`,
    `当前时间：${formatTime(input.now)}`,
  ];
  if (input.recent && input.recent.length > 0) {
    lines.push('', '<b>最近告警</b>', ...input.recent);
  }
  return lines.join('\n');
}

/* -------------------------------- update 解析 -------------------------------- */

export type Incoming =
  | {
      kind: 'command';
      chatId: string;
      messageId: number;
      userId: number;
      command: string;
      args: string[];
      raw: string;
    }
  | { kind: 'text'; chatId: string; messageId: number; userId: number; raw: string }
  | {
      kind: 'callback';
      chatId: string;
      messageId: number;
      callbackId: string;
      data: string;
      userId: number;
    };

const COMMAND_RE = /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?\s*(.*)$/s;

/** Telegram update -> 内部事件；无法处理的更新返回 null */
export function parseUpdate(update: Record<string, any>): Incoming | null {
  if (update.callback_query) {
    const q = update.callback_query;
    const chatId = q.message?.chat?.id;
    if (chatId === undefined) return null;
    return {
      kind: 'callback',
      chatId: String(chatId),
      messageId: Number(q.message?.message_id ?? 0),
      callbackId: String(q.id ?? ''),
      data: typeof q.data === 'string' ? q.data : '',
      userId: Number(q.from?.id ?? 0),
    };
  }

  const msg = update.message ?? update.edited_message;
  if (!msg || msg.chat?.id === undefined) return null;
  const chatId = String(msg.chat.id);
  const messageId = Number(msg.message_id ?? 0);
  const userId = Number(msg.from?.id ?? 0);
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';

  const m = COMMAND_RE.exec(text);
  if (m) {
    return {
      kind: 'command',
      chatId,
      messageId,
      userId,
      command: m[1].toLowerCase(),
      args: (m[2] ?? '').split(/\s+/).filter(Boolean),
      raw: text,
    };
  }
  return { kind: 'text', chatId, messageId, userId, raw: text };
}
