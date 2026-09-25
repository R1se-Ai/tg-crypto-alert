-- D1 建表语句，与 src/store.ts 中的 SCHEMA_SQL 保持一致
CREATE TABLE IF NOT EXISTS symbols (
  symbol TEXT PRIMARY KEY,
  display TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  asset_class TEXT NOT NULL DEFAULT 'crypto',
  windows TEXT NOT NULL DEFAULT '5m,15m',
  threshold_type TEXT NOT NULL DEFAULT 'percent',
  threshold_value REAL NOT NULL DEFAULT 1,
  critical_multiplier REAL NOT NULL DEFAULT 2,
  cooldown_minutes INTEGER NOT NULL DEFAULT 15
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  level TEXT NOT NULL,
  window TEXT NOT NULL,
  change_abs REAL NOT NULL,
  change_pct REAL NOT NULL,
  mark_price REAL NOT NULL,
  last_price REAL NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alerts_symbol_time ON alerts(symbol, created_at);

CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
