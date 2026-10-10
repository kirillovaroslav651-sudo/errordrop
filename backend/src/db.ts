import { Pool } from "pg";
import crypto from "crypto";
import giftCatalog from "./giftCatalog.json";
import caseConfig from "./caseConfig.json";
import { giftStarValue, giftTier } from "./pricing";

// Единый пул подключений к Postgres.
// Строка подключения берётся из DATABASE_URL (её даст Supabase).
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL (Supabase Postgres) не задан");
}

export const pool = new Pool({
  connectionString,
  ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1") ? false : { rejectUnauthorized: false },
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
  | "daily_bonus" | "case_open" | "case_reward" | "gift_sale";

export type CaseReward = { type: "stars" | "gift"; stars: number; giftId?: string; inventoryId?: number; value?: number };
export type CaseOpenResult = { caseId: string; price: number; reward: CaseReward; balance: number };
const playableGifts = giftCatalog.map(g => ({ ...g, value: giftStarValue(g.price, g.currency) }))
  .filter((g): g is typeof g & { value: number } => g.value !== null);

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
      CREATE TABLE IF NOT EXISTS gift_gallery (
        user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
        gift_id TEXT NOT NULL,
        added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, gift_id)
      );
      CREATE TABLE IF NOT EXISTS gift_inventory (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(telegram_id),
        gift_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        display_value INTEGER NOT NULL,
        sell_value INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'owned',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_inventory_user ON gift_inventory(user_id, id DESC);
      CREATE TABLE IF NOT EXISTS case_spins (
        bet_id TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(telegram_id),
        case_id TEXT NOT NULL,
        price INTEGER NOT NULL,
        reward_type TEXT NOT NULL,
        stars INTEGER NOT NULL DEFAULT 0,
        gift_id TEXT,
        inventory_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS gift_withdrawals (
        id BIGSERIAL PRIMARY KEY,
        inventory_id BIGINT NOT NULL UNIQUE REFERENCES gift_inventory(id),
        user_id BIGINT NOT NULL REFERENCES users(telegram_id),
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        reviewed_at TIMESTAMPTZ
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
  if (existing) {
    if (username && existing.username !== username) {
      const updated = await pool.query(`UPDATE users SET username=$1 WHERE telegram_id=$2 RETURNING *`, [username, telegramId]);
      return updated.rows[0];
    }
    return existing;
  }

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

/** Personal visual gallery; not a record of ownership of a Telegram gift. */
export async function getGiftGallery(telegramId: number): Promise<string[]> {
  const r = await pool.query(
    `SELECT gift_id FROM gift_gallery WHERE user_id = $1 ORDER BY added_at DESC LIMIT 24`, [telegramId]
  );
  return r.rows.map(row => row.gift_id);
}

export async function getInventory(userId: number) {
  const r = await pool.query(`SELECT i.id, i.gift_id AS "giftId", i.case_id AS "caseId",
    i.display_value AS "value", i.sell_value AS "sellValue", i.status,
    extract(epoch from i.created_at)::int AS "createdAt"
    FROM gift_inventory i WHERE i.user_id=$1 ORDER BY i.id DESC LIMIT 200`, [userId]);
  return r.rows;
}

/** All paid-case outcomes are decided and persisted server-side in one transaction. */
export async function openPaidCase(userId: number, caseId: string, betId: string): Promise<CaseOpenResult> {
  const c = caseConfig.find(c => c.id === caseId && c.price > 0);
  if (!c) throw new Error("invalid_case");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const user = await client.query(`SELECT balance FROM users WHERE telegram_id=$1 FOR UPDATE`, [userId]);
    if (!user.rows[0]) throw new Error("user_not_found");
    const old = await client.query(`SELECT * FROM case_spins WHERE bet_id=$1`, [betId]);
    if (old.rows[0]) {
      const spin = old.rows[0];
      if (Number(spin.user_id) !== userId || spin.case_id !== caseId) throw new Error("duplicate_bet_id");
      await client.query("COMMIT");
      return { caseId, price: c.price, reward: { type: spin.reward_type, stars: spin.stars,
        giftId: spin.gift_id ?? undefined, inventoryId: spin.inventory_id ? Number(spin.inventory_id) : undefined },
        balance: Number(user.rows[0].balance) };
    }
    if (Number(user.rows[0].balance) < c.price) throw new Error("insufficient_balance");
    const roll = crypto.randomInt(10000);
    const giftRoll = roll < c.giftChance * 100;
    let reward: CaseReward;
    if (giftRoll) {
      const poolForCase = playableGifts.filter(g => giftTier(g.value) === Number(c.code));
      const g = poolForCase[crypto.randomInt(poolForCase.length)];
      const sellValue = Math.max(1, Math.round(g.value * 0.1));
      const inv = await client.query(`INSERT INTO gift_inventory(user_id,gift_id,case_id,display_value,sell_value)
        VALUES($1,$2,$3,$4,$5) RETURNING id`, [userId,g.id,caseId,g.value,sellValue]);
      reward = { type: "gift", stars: 0, giftId: g.id, inventoryId: Number(inv.rows[0].id), value: g.value };
    } else {
      // 75% of all openings: 10–55% of the case price; remaining star outcomes: 56–95%.
      const lowBand = roll < 7500;
      const pct = lowBand ? crypto.randomInt(10,56) : crypto.randomInt(56,96);
      reward = { type: "stars", stars: Math.max(1, Math.floor(c.price * pct / 100)) };
    }
    const balance = Number(user.rows[0].balance) - c.price + reward.stars;
    await client.query(`UPDATE users SET balance=$1 WHERE telegram_id=$2`, [balance,userId]);
    await client.query(`INSERT INTO transactions(user_id,type,amount,bet_id,game,choice)
      VALUES($1,'case_open',$2,$3,'case',$4)`, [userId,-c.price,betId,caseId]);
    if (reward.stars) await client.query(`INSERT INTO transactions(user_id,type,amount,game,choice)
      VALUES($1,'case_reward',$2,'case',$3)`, [userId,reward.stars,caseId]);
    await client.query(`INSERT INTO case_spins(bet_id,user_id,case_id,price,reward_type,stars,gift_id,inventory_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [betId,userId,caseId,c.price,reward.type,reward.stars,reward.giftId??null,reward.inventoryId??null]);
    await client.query("COMMIT");
    return { caseId, price: c.price, reward, balance };
  } catch(e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

export async function sellInventoryGift(userId: number, inventoryId: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const item = await client.query(`SELECT * FROM gift_inventory WHERE id=$1 AND user_id=$2 FOR UPDATE`,[inventoryId,userId]);
    if (!item.rows[0] || item.rows[0].status !== "owned") throw new Error("gift_not_available");
    const value = Number(item.rows[0].sell_value);
    await client.query(`UPDATE gift_inventory SET status='sold',updated_at=now() WHERE id=$1`,[inventoryId]);
    await client.query(`UPDATE users SET balance=balance+$1 WHERE telegram_id=$2`,[value,userId]);
    await client.query(`INSERT INTO transactions(user_id,type,amount,ref) VALUES($1,'gift_sale',$2,$3)`,[userId,value,`gift-sale:${inventoryId}`]);
    await client.query("COMMIT");
    return value;
  } catch(e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

export async function requestGiftWithdrawal(userId: number, inventoryId: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const item = await client.query(`SELECT * FROM gift_inventory WHERE id=$1 AND user_id=$2 FOR UPDATE`,[inventoryId,userId]);
    if (!item.rows[0] || item.rows[0].status !== "owned") throw new Error("gift_not_available");
    const result = await client.query(`INSERT INTO gift_withdrawals(inventory_id,user_id) VALUES($1,$2) RETURNING id`,[inventoryId,userId]);
    await client.query(`UPDATE gift_inventory SET status='pending',updated_at=now() WHERE id=$1`,[inventoryId]);
    await client.query("COMMIT");
    return Number(result.rows[0].id);
  } catch(e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

/** Резолвер исхода игры. */
function resolveGame(
  game: string,
  choice?: string
): { won: boolean; multiplier: number; label: string } {
  switch (game) {
    case "coin": {
      const result = crypto.randomInt(2) === 0 ? "heads" : "tails";
      return { won: choice === result, multiplier: 2, label: result };
    }
    case "case": {
      const roll = crypto.randomInt(10000) / 10000;
      let rarity: { mult: number; name: string };
      if (roll < 0.5) rarity = { mult: 1, name: "обычный" };
      else if (roll < 0.75) rarity = { mult: 2, name: "редкий" };
      else if (roll < 0.93) rarity = { mult: 4, name: "эпический" };
      else rarity = { mult: 10, name: "легендарный" };
      const won = rarity.mult > 1;
      return { won, multiplier: rarity.mult, label: rarity.name };
    }
    default:
      return { won: crypto.randomInt(2) === 0, multiplier: 2, label: "" };
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
    // Telegram IDs are 64-bit values in practice (and can exceed a Postgres
    // 32-bit integer), so do not pass them to pg_advisory_xact_lock(int,int).
    // The user row is created during /me and provides a natural per-user
    // transaction lock for concurrent daily claims.
    await client.query(`SELECT telegram_id FROM users WHERE telegram_id = $1 FOR UPDATE`, [telegramId]);
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

