import { Pool } from "pg";
import crypto from "crypto";

// Единый пул подключений к Postgres.
// Строка подключения берётся из DATABASE_URL (её даст Supabase).
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL (Supabase Postgres) не задан");
}

export const pool = new Pool({
  connectionString,
  ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1") ? false : { rejectUnauthorized: true },
  // Принудительно IPv4 — Render не имеет IPv6-маршрута (иначе ENETUNREACH)
  family: 4,
} as any);

/** Пакет покупки: стоимость в XTR = количество звёзд. */
type Package = {
  id: string;
  amount: number;
  title: string;
};

export const PACKAGES: Package[] = [
  { id: "pkg-50", amount: 50, title: "50 звёзд" },
  { id: "pkg-100", amount: 100, title: "100 звёзд" },
  { id: "pkg-250", amount: 250, title: "250 звёзд" },
  { id: "pkg-500", amount: 500, title: "500 звёзд" },
];

// Комиссия рефереферала, % от пополнения приглашённым
export const REFERRAL_PERCENT = 10;

export type BetResult = "win" | "lose";
export type TxType =
  | "purchase"
  | "bet_win"
  | "bet_lose"
  | "referral_bonus"
  | "admin_credit"
  | "daily_bonus";

/** Инициализация схемы (idempotent). */
export async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id   BIGINT PRIMARY KEY,
        username      TEXT,
        balance       INTEGER NOT NULL DEFAULT 0,
        ref_code      TEXT UNIQUE,
        referred_by   BIGINT REFERENCES users(telegram_id),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id          SERIAL PRIMARY KEY,
        user_id     BIGINT NOT NULL REFERENCES users(telegram_id),
        type        TEXT NOT NULL,
        amount      INTEGER NOT NULL,
        game        TEXT,
        choice      TEXT,
        ref         TEXT,
        bet_id      TEXT,
        spin_result TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_bet ON transactions(bet_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_daily ON transactions(user_id, ref) WHERE type = 'daily_bonus';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_purchase_ref ON transactions(ref);
      CREATE TABLE IF NOT EXISTS orders (
        payload      TEXT PRIMARY KEY,
        user_id      BIGINT NOT NULL,
        package_id   TEXT NOT NULL,
        amount       INTEGER NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
      CREATE TABLE IF NOT EXISTS daily_bonus (
        user_id     BIGINT PRIMARY KEY,
        last_day    TEXT NOT NULL
      );
    `);

    // ref_code для всех, у кого его нет
    const missing = await client.query(
      `SELECT telegram_id FROM users WHERE ref_code IS NULL`
    );
    for (const u of missing.rows as any[]) {
      await client.query(`UPDATE users SET ref_code = $1 WHERE telegram_id = $2`, [
        makeRefCode(),
        u.telegram_id,
      ]);
    }
  } finally {
    client.release();
  }
}

/** Случайный короткий реферальный код. */
export function makeRefCode(): string {
  return crypto.randomBytes(4).toString("hex");
}

/** Возвращает запись юзера или undefined. Row — объект с полями snake_case? Нет, из pg — lowercased имена. */
export async function getRawUser(telegramId: number): Promise<any> {
  const r = await pool.query(`SELECT * FROM users WHERE telegram_id = $1`, [telegramId]);
  return r.rows[0];
}

export async function getUser(telegramId: number): Promise<any> {
  return getRawUser(telegramId);
}

/** Создать юзера при первом входе (upsert по telegram_id). */
export async function ensureUser(
  telegramId: number,
  username: string | undefined,
  referredBy: number | null = null
): Promise<any> {
  const existing = await getRawUser(telegramId);
  if (existing) return existing;

  await pool.query(
    `INSERT INTO users (telegram_id, username, ref_code, referred_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_id) DO NOTHING`,
    [telegramId, username ?? null, makeRefCode(), referredBy]
  );
  return getRawUser(telegramId);
}

/**
 * Начислить/списать с созданием транзакции, с идемпотентностью.
 */
export async function applyTx(
  telegramId: number,
  type: TxType,
  amount: number,
  opts: {
    ref?: string;
    betId?: string;
    spinResult?: BetResult;
    game?: string;
    choice?: string;
  } = {}
): Promise<void> {
  if (opts.betId) {
    const exists = await pool.query(`SELECT id FROM transactions WHERE bet_id = $1`, [opts.betId]);
    if (exists.rows[0]) return;
  }
  if (opts.ref) {
    const exists = await pool.query(`SELECT id FROM transactions WHERE ref = $1`, [opts.ref]);
    if (exists.rows[0]) return;
  }

  if (amount < 0) {
    const u = await getRawUser(telegramId);
    if (!u || Number(u.balance) + amount < 0) throw new Error("insufficient_balance");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE users SET balance = balance + $1 WHERE telegram_id = $2`, [
      amount,
      telegramId,
    ]);
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, ref, bet_id, spin_result, game, choice)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        telegramId,
        type,
        amount,
        opts.ref ?? null,
        opts.betId ?? null,
        opts.spinResult ?? null,
        opts.game ?? null,
        opts.choice ?? null,
      ]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** История транзакций юзера. */
export async function getTransactions(telegramId: number, limit = 20): Promise<any[]> {
  const r = await pool.query(
    `SELECT id, type, amount, spin_result, game, choice,
            extract(epoch from created_at)::int AS created_at
     FROM transactions WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
    [telegramId, limit]
  );
  return r.rows;
}

/** Резолвер исхода игры. */
function resolveGame(
  game: string,
  choice?: string
): { won: boolean; multiplier: number; label: string } {
  switch (game) {
    case "coin": {
      const result = Math.random() < 0.5 ? "heads" : "tails";
      return { won: choice === result, multiplier: 2, label: result };
    }
    case "case": {
      const roll = Math.random();
      let rarity: { mult: number; name: string };
      if (roll < 0.5) rarity = { mult: 1, name: "обычный" };
      else if (roll < 0.75) rarity = { mult: 2, name: "редкий" };
      else if (roll < 0.93) rarity = { mult: 4, name: "эпический" };
      else rarity = { mult: 10, name: "легендарный" };
      const won = rarity.mult > 1;
      return { won, multiplier: rarity.mult, label: rarity.name };
    }
    default:
      return { won: Math.random() < 0.5, multiplier: 2, label: "" };
  }
}

/**
 * Выполнить ставку атомарно (идемпотентно по betId).
 */
export async function placeBet(
  telegramId: number,
  betAmount: number,
  betId: string,
  game: string = "roulette",
  choice?: string
): Promise<{ won: boolean; delta: number; outcome?: string; multiplier?: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(`SELECT user_id, amount, game, spin_result, choice FROM transactions WHERE bet_id = $1`, [betId]);
    if (existing.rows[0]) {
      const prev = existing.rows[0];
      if (Number(prev.user_id) !== telegramId || prev.game !== game) throw new Error("duplicate_bet_id");
      await client.query("ROLLBACK");
      return {
        won: prev.spin_result === "win",
        delta: Number(prev.amount),
      };
    }

    const userRes = await client.query(`SELECT * FROM users WHERE telegram_id = $1 FOR UPDATE`, [telegramId]);
    const user = userRes.rows[0];
    if (!user) throw new Error("user_not_found");
    if (betAmount <= 0) throw new Error("invalid_bet");
    if (betAmount > Number(user.balance)) throw new Error("insufficient_balance");

    const outcome = resolveGame(game, choice);
    let delta: number;
    if (game === "case") {
      delta = Math.round(betAmount * (outcome.multiplier - 1));
    } else {
      delta = outcome.won ? Math.round(betAmount * (outcome.multiplier - 1)) : -betAmount;
    }

    await client.query(`UPDATE users SET balance = balance + $1 WHERE telegram_id = $2`, [delta, telegramId]);
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, bet_id, spin_result, game, choice)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        telegramId,
        outcome.won ? "bet_win" : "bet_lose",
        delta,
        betId,
        outcome.won ? "win" : "lose",
        game,
        choice ?? null,
      ]
    );

    await client.query("COMMIT");
    return { won: outcome.won, delta, outcome: outcome.label, multiplier: outcome.multiplier };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Накрутка звёзд админом. */
export async function adminCredit(telegramId: number, amount: number): Promise<number> {
  await ensureUser(telegramId, undefined);
  await applyTx(telegramId, "admin_credit", amount);
  const u = await getRawUser(telegramId);
  return Number(u.balance);
}

/** Создание заказа для invoice. */
export async function createOrder(payload: string, userId: number, packageId: string, amount: number): Promise<void> {
  await pool.query(
    `INSERT INTO orders (payload, user_id, package_id, amount) VALUES ($1,$2,$3,$4)
     ON CONFLICT (payload) DO NOTHING`,
    [payload, userId, packageId, amount]
  );
}

export async function getOrder(payload: string): Promise<any> {
  const r = await pool.query(`SELECT * FROM orders WHERE payload = $1`, [payload]);
  return r.rows[0];
}

export async function markOrderPaid(payload: string): Promise<void> {
  await pool.query(`UPDATE orders SET status = 'paid' WHERE payload = $1`, [payload]);
}

/** Московская дата (YYYY-MM-DD). */
export function moscowDay(): string {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Начислить ежедневный бонус, если сегодня ещё не начисляли. */
export async function claimDailyBonus(telegramId: number, amount: number): Promise<{ granted: boolean; bonus: number }> {
  const day = moscowDay();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [17, telegramId]);
    const before = await client.query(`SELECT last_day FROM daily_bonus WHERE user_id = $1 FOR UPDATE`, [telegramId]);
    if (before.rows[0] && before.rows[0].last_day === day) {
      await client.query("ROLLBACK");
      return { granted: false, bonus: 0 };
    }
    await client.query(
      `INSERT INTO daily_bonus (user_id, last_day) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET last_day = EXCLUDED.last_day`,
      [telegramId, day]
    );
    await client.query(`UPDATE users SET balance = balance + $1 WHERE telegram_id = $2`, [amount, telegramId]);
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, ref) VALUES ($1, 'daily_bonus', $2, $3)`,
      [telegramId, amount, `daily:${telegramId}:${day}`]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  return { granted: true, bonus: amount };
}

/** Бонус пригласившему за покупку. */
export async function grantReferralBonus(referrerId: number, purchaseAmount: number): Promise<number> {
  const bonus = Math.round(purchaseAmount * (REFERRAL_PERCENT / 100));
  if (bonus <= 0) return 0;
  await applyTx(referrerId, "referral_bonus", bonus);
  return bonus;
}

export { db };

const db = pool;
