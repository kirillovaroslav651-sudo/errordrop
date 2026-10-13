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
  { id: "pkg-300", amount: 300, title: "300 звёзд" },
  { id: "pkg-500", amount: 500, title: "500 звёзд" },
];

// Комиссия рефереферала, % от пополнения приглашённым
export const REFERRAL_PERCENT = 10;

export type BetResult = "win" | "lose";
export type TxType =
  | "purchase"
  | "bet_win"
  | "bet_lose"
  | "referral_bonus" | "first_purchase_bonus"
  | "admin_credit" | "admin_debit"
  | "daily_bonus" | "case_open" | "case_reward" | "gift_sale";

export type CaseReward = { type: "stars" | "gift"; stars: number; giftId?: string; inventoryId?: number; value?: number };
export type CaseOpenResult = { caseId: string; price: number; reward: CaseReward; balance: number };
let liveGiftPrices: Record<string, number> = {};
export function setLiveGiftPrices(prices: Record<string, number>) { liveGiftPrices = prices; }
export function effectiveGiftPrice(id: string): number | null {
  const override = liveGiftPrices[id];
  if (Number.isSafeInteger(override) && override > 0) return override;
  const gift = giftCatalog.find(g => g.id === id);
  return gift ? giftStarValue(gift.price, gift.currency) : null;
}
const basePlayableGifts = giftCatalog.map(g => ({ ...g, value: giftStarValue(g.price, g.currency) }))
  .filter((g): g is typeof g & { value: number } => g.value !== null);
function playableGifts() { return basePlayableGifts.map(g => ({ ...g, value: liveGiftPrices[g.id] ?? g.value })); }

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
      CREATE TABLE IF NOT EXISTS online_presence (
        user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
        seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_online_presence_seen ON online_presence(seen_at);
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
      CREATE TABLE IF NOT EXISTS daily_case_notifications (
        user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        sent_at TIMESTAMPTZ,
        PRIMARY KEY (user_id, day)
      );
      ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_reminders BOOLEAN NOT NULL DEFAULT TRUE;
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
      CREATE TABLE IF NOT EXISTS telegram_gift_prices (
        gift_id TEXT PRIMARY KEY,
        stars INTEGER NOT NULL CHECK (stars > 0),
        telegram_gift_id TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- Gift sales use the displayed in-game value. Repair older rows that
      -- were created with the previous 10% resale rule.
      UPDATE gift_inventory SET sell_value = display_value WHERE sell_value < display_value;
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
      CREATE TABLE IF NOT EXISTS upgrades (
        id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(telegram_id),
        source_inventory_id BIGINT NOT NULL, target_gift_id TEXT NOT NULL, target_value INTEGER NOT NULL,
        chance NUMERIC NOT NULL, success BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS gift_withdrawals (
        id BIGSERIAL PRIMARY KEY,
        inventory_id BIGINT NOT NULL UNIQUE REFERENCES gift_inventory(id),
        user_id BIGINT NOT NULL REFERENCES users(telegram_id),
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        reviewed_at TIMESTAMPTZ
      );
      ALTER TABLE gift_withdrawals ADD COLUMN IF NOT EXISTS funding_method TEXT;
      ALTER TABLE gift_withdrawals ADD COLUMN IF NOT EXISTS committed_xtr INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE gift_withdrawals ADD COLUMN IF NOT EXISTS level_snapshot INTEGER;
      UPDATE gift_withdrawals w SET level_snapshot = 1 + (
        SELECT COUNT(*)::int / 10 FROM case_spins s WHERE s.user_id=w.user_id AND s.created_at<=w.created_at
      ) WHERE level_snapshot IS NULL AND status IN ('pending','fulfilled');
      CREATE TABLE IF NOT EXISTS withdrawal_referrals (
        withdrawal_id BIGINT NOT NULL REFERENCES gift_withdrawals(id),
        friend_id BIGINT NOT NULL REFERENCES users(telegram_id),
        PRIMARY KEY (withdrawal_id, friend_id)
      );
      CREATE TABLE IF NOT EXISTS admin_actions (
        id BIGSERIAL PRIMARY KEY,
        admin_id BIGINT NOT NULL,
        target_id BIGINT NOT NULL,
        action TEXT NOT NULL,
        amount INTEGER,
        inventory_id BIGINT,
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // Reprice owned inventory to the current catalogue snapshot. Historical sold
    // items and pending withdrawals remain untouched; no balance is changed.
    const savedPrices = await client.query(`SELECT gift_id, stars FROM telegram_gift_prices`);
    setLiveGiftPrices(Object.fromEntries(savedPrices.rows.map(row => [row.gift_id, Number(row.stars)])));
    const currentPrices = playableGifts().map(g => ({ id: g.id, value: g.value }));
    await client.query(`
      UPDATE gift_inventory AS i SET display_value = p.value,
        sell_value = p.value, updated_at = now()
      FROM jsonb_to_recordset($1::jsonb) AS p(id text, value integer)
      WHERE i.gift_id = p.id AND i.status = 'owned'
        AND (i.display_value <> p.value OR i.sell_value <> p.value)
    `, [JSON.stringify(currentPrices)]);

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

/** Confirmed purchases and referrals available for individual gift requests. */
export async function getWithdrawalAccess(userId: number, client: { query: (sql: string, params?: any[]) => Promise<any> } = pool) {
  const result = await client.query(`SELECT
    COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id=$1 AND type='purchase'),0)::int AS paid,
    COALESCE((SELECT SUM(committed_xtr) FROM gift_withdrawals WHERE user_id=$1 AND status IN ('pending','fulfilled')),0)::int AS committed,
    (SELECT COUNT(*)::int FROM users WHERE referred_by=$1) AS referral_count,
    (SELECT COUNT(*)::int FROM case_spins WHERE user_id=$1) AS opened_cases,
    (SELECT MAX(level_snapshot) FROM gift_withdrawals WHERE user_id=$1 AND status IN ('pending','fulfilled')) AS last_withdrawal_level`, [userId]);
  const { paid, committed, referral_count: referralCount, opened_cases: openedCases, last_withdrawal_level: lastWithdrawalLevel } = result.rows[0];
  const friends = await client.query(`SELECT f.telegram_id AS id,
    COALESCE(SUM(t.amount) FILTER (WHERE t.type='purchase'),0)::int AS paid
    FROM users f LEFT JOIN transactions t ON t.user_id=f.telegram_id
    WHERE f.referred_by=$1 AND NOT EXISTS (
      SELECT 1 FROM withdrawal_referrals wr JOIN gift_withdrawals w ON w.id=wr.withdrawal_id
      WHERE wr.friend_id=f.telegram_id AND w.status IN ('pending','fulfilled'))
    GROUP BY f.telegram_id ORDER BY f.telegram_id`,[userId]);
  const level = 1 + Math.floor(openedCases / 10);
  const requiredLevel = lastWithdrawalLevel === null ? 1 : Number(lastWithdrawalLevel) + 1;
  return { paid, committed, availableXtr: paid-committed, referralCount, openedCases, level, requiredLevel,
    friendPayments: friends.rows.map((row: any) => Number(row.paid)) };
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
    const outcomes = c.outcomes ?? [];
    const total = outcomes.reduce((sum, item) => sum + item.chance, 0);
    const pick = crypto.randomInt(Math.max(1, total));
    let cursor = 0;
    const outcome = outcomes.find(item => (cursor += item.chance) > pick) ?? outcomes[0];
    let reward: CaseReward;
    // Smaller cases pay ordinary outcomes as Stars; high-tier cases
    // (999/2499/4999) deliver gifts near their configured outcome value.
    const highTierGift = c.id === "pulse" || c.id === "blackout" || c.id === "ultraviolet";
    if (!giftRoll && !highTierGift) {
      reward = { type: "stars", stars: outcome?.stars ?? c.price };
    } else {
    const target = giftRoll
      ? c.price + crypto.randomInt(Math.max(1, (c.bonusMax ?? c.price) - c.price + 1))
      : (outcome?.stars ?? c.price);
    const minValue = giftRoll ? Math.max(c.price, Math.floor(target * 0.8)) : Math.max(1, Math.floor(target * 0.8));
    const maxValue = giftRoll ? Math.min(c.bonusMax ?? c.price, Math.ceil(target * 1.2)) : Math.ceil(target * 1.2);
    const currentGifts = playableGifts();
    const candidates = currentGifts.filter(g => g.value >= minValue && g.value <= maxValue);
    // Never replace a low-value outcome with the nearest (often much more
    // expensive) catalog gift. If the market has no gift in this band,
    // credit the outcome as in-game stars instead.
    if (candidates.length === 0) {
      reward = { type: "stars", stars: target };
    } else {
    const g = candidates[crypto.randomInt(candidates.length)];
    const sellValue = g.value;
    const inv = await client.query(`INSERT INTO gift_inventory(user_id,gift_id,case_id,display_value,sell_value)
      VALUES($1,$2,$3,$4,$5) RETURNING id`, [userId,g.id,caseId,g.value,sellValue]);
    reward = { type: "gift", stars: 0, giftId: g.id, inventoryId: Number(inv.rows[0].id), value: g.value };
    }
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

export async function upgradeGift(userId: number, sourceId: number, targetGiftId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const item = await client.query(`SELECT * FROM gift_inventory WHERE id=$1 AND user_id=$2 FOR UPDATE`,[sourceId,userId]);
    if (!item.rows[0] || item.rows[0].status !== "owned") throw new Error("gift_not_available");
    const target = playableGifts().find(g => g.id === targetGiftId);
    const sourceValue = Number(item.rows[0].display_value);
    if (!target || target.value <= sourceValue) throw new Error("invalid_upgrade_target");
    const chanceBps = Math.floor(sourceValue / target.value * 9000);
    if (chanceBps <= 0) throw new Error("invalid_upgrade_target");
    const roll = crypto.randomInt(10000);
    const success = roll < chanceBps;
    await client.query(`UPDATE gift_inventory SET status=$1,updated_at=now() WHERE id=$2`,[success?"upgraded":"burned",sourceId]);
    let inventoryId: number | null = null;
    if (success) {
      const created = await client.query(`INSERT INTO gift_inventory(user_id,gift_id,case_id,display_value,sell_value)
        VALUES($1,$2,'upgrade',$3,$3) RETURNING id`,[userId,target.id,target.value]);
      inventoryId = Number(created.rows[0].id);
    }
    await client.query(`INSERT INTO upgrades(user_id,source_inventory_id,target_gift_id,target_value,chance,success)
      VALUES($1,$2,$3,$4,$5,$6)`,[userId,sourceId,target.id,target.value,chanceBps/100,success]);
    await client.query("COMMIT");
    return { success, chance:chanceBps/100, targetGiftId:target.id, targetValue:target.value, inventoryId, roll:roll/100 };
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
    await client.query(`SELECT telegram_id FROM users WHERE telegram_id=$1 FOR UPDATE`, [userId]);
    const item = await client.query(`SELECT * FROM gift_inventory WHERE id=$1 AND user_id=$2 FOR UPDATE`,[inventoryId,userId]);
    if (!item.rows[0] || item.rows[0].status !== "owned") throw new Error("gift_not_available");
    const access = await getWithdrawalAccess(userId, client);
    if (access.level < access.requiredLevel) throw new Error("level_required");
    const value = Number(item.rows[0].display_value);
    const friendThreshold = Math.ceil(value / 5);
    const method = access.availableXtr >= value ? "purchase" : access.friendPayments.filter((paid: number) => paid >= friendThreshold).length >= 5 ? "referrals" : null;
    if (!method) throw new Error("withdrawal_locked");
    const result = await client.query(`INSERT INTO gift_withdrawals(inventory_id,user_id,funding_method,committed_xtr,level_snapshot)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT (inventory_id) DO UPDATE
      SET status='pending', reviewed_at=NULL, funding_method=EXCLUDED.funding_method,
          committed_xtr=EXCLUDED.committed_xtr,level_snapshot=EXCLUDED.level_snapshot
      WHERE gift_withdrawals.status='reject' AND gift_withdrawals.user_id=EXCLUDED.user_id
      RETURNING id`,[inventoryId,userId,method,method === "purchase" ? value : 0,access.level]);
    if (!result.rows[0]) throw new Error("gift_not_available");
    if (method === "referrals") {
      await client.query(`DELETE FROM withdrawal_referrals WHERE withdrawal_id=$1`, [result.rows[0].id]);
      const assigned = await client.query(`INSERT INTO withdrawal_referrals(withdrawal_id,friend_id)
        SELECT $1,f.telegram_id FROM users f WHERE f.referred_by=$2
        AND (SELECT COALESCE(SUM(amount),0) FROM transactions
             WHERE user_id=f.telegram_id AND type='purchase') >= $3
        AND NOT EXISTS (SELECT 1 FROM withdrawal_referrals wr JOIN gift_withdrawals w ON w.id=wr.withdrawal_id
                        WHERE wr.friend_id=f.telegram_id AND w.status IN ('pending','fulfilled') AND w.id<>$1)
        ORDER BY f.telegram_id LIMIT 5`,[result.rows[0].id,userId,friendThreshold]);
      if (assigned.rowCount !== 5) throw new Error("withdrawal_locked");
    }
    await client.query(`UPDATE gift_inventory SET status='pending',updated_at=now() WHERE id=$1`,[inventoryId]);
    await client.query("COMMIT");
    return Number(result.rows[0].id);
  } catch(e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

export async function adminRemoveStars(adminId: number, targetId: number, amount: number, reason: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const user = await client.query(`SELECT balance FROM users WHERE telegram_id=$1 FOR UPDATE`, [targetId]);
    if (!user.rows[0]) throw new Error("user_not_found");
    if (Number(user.rows[0].balance) < amount) throw new Error("insufficient_balance");
    const balance = Number(user.rows[0].balance) - amount;
    await client.query(`UPDATE users SET balance=$1 WHERE telegram_id=$2`, [balance, targetId]);
    await client.query(`INSERT INTO transactions(user_id,type,amount,ref) VALUES($1,'admin_debit',$2,$3)`,
      [targetId,-amount,`admin-debit:${crypto.randomUUID()}`]);
    await client.query(`INSERT INTO admin_actions(admin_id,target_id,action,amount,reason) VALUES($1,$2,'remove_stars',$3,$4)`,
      [adminId,targetId,amount,reason]);
    await client.query("COMMIT");
    return balance;
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

export async function adminRemoveGift(adminId: number, targetId: number, inventoryId: number, reason: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT telegram_id FROM users WHERE telegram_id=$1 FOR UPDATE`, [targetId]);
    const item = await client.query(`SELECT status FROM gift_inventory WHERE id=$1 AND user_id=$2 FOR UPDATE`, [inventoryId,targetId]);
    if (!item.rows[0] || item.rows[0].status !== "owned") throw new Error("gift_not_available");
    await client.query(`UPDATE gift_inventory SET status='removed',updated_at=now() WHERE id=$1`, [inventoryId]);
    await client.query(`INSERT INTO admin_actions(admin_id,target_id,action,inventory_id,reason) VALUES($1,$2,'remove_gift',$3,$4)`,
      [adminId,targetId,inventoryId,reason]);
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
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

/** Credit a confirmed XTR payment exactly once, including first-purchase bonus. */
export async function settlePaidOrder(payload: string, chargeId: string, paidAmount: number): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const orderResult = await client.query(`SELECT * FROM orders WHERE payload=$1 FOR UPDATE`, [payload]);
    const order = orderResult.rows[0];
    if (!order || Number(order.amount) !== paidAmount || !chargeId) throw new Error("invalid_payment");
    if (order.status === "paid") { await client.query("COMMIT"); return false; }
    const userId = Number(order.user_id);
    const userResult = await client.query(`SELECT referred_by FROM users WHERE telegram_id=$1 FOR UPDATE`, [userId]);
    if (!userResult.rows[0]) throw new Error("user_not_found");
    const previous = await client.query(`SELECT 1 FROM transactions WHERE user_id=$1 AND type='purchase' LIMIT 1`, [userId]);
    const firstBonus = previous.rows.length ? 0 : Math.floor(paidAmount / 2);
    await client.query(`UPDATE users SET balance=balance+$1 WHERE telegram_id=$2`, [paidAmount+firstBonus,userId]);
    await client.query(`INSERT INTO transactions(user_id,type,amount,ref) VALUES($1,'purchase',$2,$3)`,
      [userId,paidAmount,`purchase:${chargeId}`]);
    if (firstBonus) await client.query(`INSERT INTO transactions(user_id,type,amount,ref)
      VALUES($1,'first_purchase_bonus',$2,$3)`, [userId,firstBonus,`first-bonus:${payload}`]);
    const referrer = userResult.rows[0].referred_by;
    if (referrer) {
      const referralBonus = Math.round(paidAmount * REFERRAL_PERCENT / 100);
      await client.query(`UPDATE users SET balance=balance+$1 WHERE telegram_id=$2`, [referralBonus,referrer]);
      await client.query(`INSERT INTO transactions(user_id,type,amount,ref)
        VALUES($1,'referral_bonus',$2,$3)`, [referrer,referralBonus,`referral:${payload}`]);
    }
    await client.query(`UPDATE orders SET status='paid' WHERE payload=$1`,[payload]);
    await client.query("COMMIT");
    return true;
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
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

