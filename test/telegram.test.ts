import { describe, expect, it } from 'vitest';
import {
  alertKeyboard,
  apiUrl,
  escapeHtml,
  formatAlert,
  formatNumber,
  formatSigned,
  formatSymbolList,
  formatThreshold,
  parseUpdate,
  thresholdText,
} from '../src/telegram';
import type { Evaluation } from '../src/types';
import { cfg } from './helpers';

const NOW = 1_700_000_000_000;

function ev(overrides: Partial<Evaluation> = {}): Evaluation {
  return {
    symbol: 'BTCUSDT',
    markPrice: 61_234.5,
    lastPrice: 61_240.1,
    triggered: true,
    level: 'WARN',
    window: '5m',
    changeAbs: 1_100,
    changePct: 1.83,
    skipped: null,
    gapDetected: false,
    windows: [],
    ...overrides,
  };
}

describe('文本处理', () => {
  it('转义 HTML 特殊字符', () => {
    expect(escapeHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
  });

  it('数字带千分位与符号', () => {
    expect(formatNumber(61234.5)).toBe('61,234.50');
    expect(formatSigned(1.83)).toBe('+1.83');
    expect(formatSigned(-1.83)).toBe('-1.83');
  });

  it('阈值文案区分百分比与金额', () => {
    expect(formatThreshold({ type: 'percent', value: 1 })).toBe('1%');
    expect(formatThreshold({ type: 'absolute', value: 50 })).toBe('50 USDT');
    expect(thresholdText(cfg({ threshold: { type: 'absolute', value: 50 } }))).toBe('50 USDT');
  });
});

describe('告警文案', () => {
  it('百分比阈值以百分比为主', () => {
    const text = formatAlert(cfg(), ev(), NOW);
    expect(text).toContain('🔴 涨');
    expect(text).toContain('+1.83%');
    expect(text).toContain('+1,100.00 USDT');
    expect(text).toContain('阈值 1%');
    expect(text).toContain('BTCUSDT');
  });

  it('下跌用绿色方向标记', () => {
    const text = formatAlert(cfg(), ev({ changePct: -1.83, changeAbs: -1100 }), NOW);
    expect(text).toContain('🟢 跌');
    expect(text).toContain('-1.83%');
  });

  it('绝对金额阈值以金额为主', () => {
    const text = formatAlert(
      cfg({ symbol: 'ETHUSDT', display: 'ETH', threshold: { type: 'absolute', value: 50 } }),
      ev({ changeAbs: 62.5, changePct: 2.1, markPrice: 3000, lastPrice: 3001 }),
      NOW,
    );
    expect(text).toContain('+62.50 USDT');
    expect(text).toContain('阈值 50 USDT');
  });

  it('剧烈异动使用更高级别标识', () => {
    const text = formatAlert(cfg(), ev({ level: 'CRITICAL' }), NOW);
    expect(text).toContain('剧烈异动');
  });
});

describe('按钮', () => {
  it('告警消息携带静音与暂停按钮', () => {
    const kb = alertKeyboard('BTCUSDT');
    expect(kb.inline_keyboard[0][0].callback_data).toBe('mute:BTCUSDT:60');
    expect(kb.inline_keyboard[0][1].callback_data).toBe('pause:60');
  });
});

describe('清单展示', () => {
  it('展示开关、阈值与窗口', () => {
    const text = formatSymbolList([
      cfg({ display: 'BTC' }),
      cfg({ symbol: 'SOLUSDT', display: 'SOL', enabled: false, assetClass: 'tradfi' }),
    ]);
    expect(text).toContain('✅');
    expect(text).toContain('⏸');
    expect(text).toContain('TradFi');
  });

  it('空清单给出引导', () => {
    expect(formatSymbolList([])).toContain('/add');
  });
});

describe('update 解析', () => {
  it('解析命令与参数', () => {
    const r = parseUpdate({
      message: {
        message_id: 10,
        chat: { id: -1001 },
        from: { id: 7 },
        text: '/set BTCUSDT 1.5',
      },
    });
    expect(r?.kind).toBe('command');
    if (r?.kind === 'command') {
      expect(r.command).toBe('set');
      expect(r.args).toEqual(['BTCUSDT', '1.5']);
      expect(r.chatId).toBe('-1001');
      expect(r.userId).toBe(7);
    }
  });

  it('识别带 @bot 后缀的命令', () => {
    const r = parseUpdate({ message: { chat: { id: 1 }, text: '/list@my_bot' } });
    expect(r?.kind).toBe('command');
    if (r?.kind === 'command') expect(r.command).toBe('list');
  });

  it('普通文本不是命令', () => {
    const r = parseUpdate({ message: { chat: { id: 1 }, text: '你好' } });
    expect(r?.kind).toBe('text');
  });

  it('解析回调按钮', () => {
    const r = parseUpdate({
      callback_query: {
        id: 'cb1',
        data: 'mute:BTCUSDT:60',
        from: { id: 7 },
        message: { message_id: 11, chat: { id: -1001 } },
      },
    });
    expect(r?.kind).toBe('callback');
    if (r?.kind === 'callback') {
      expect(r.data).toBe('mute:BTCUSDT:60');
      expect(r.callbackId).toBe('cb1');
    }
  });

  it('无法处理的更新返回 null', () => {
    expect(parseUpdate({})).toBeNull();
    expect(parseUpdate({ channel_post: {} })).toBeNull();
    expect(parseUpdate({ callback_query: { id: 'x', data: 'y' } })).toBeNull();
  });
});

describe('API 地址', () => {
  it('拼接 bot token', () => {
    expect(apiUrl('123:abc', 'sendMessage')).toBe('https://api.telegram.org/bot123:abc/sendMessage');
  });
});
