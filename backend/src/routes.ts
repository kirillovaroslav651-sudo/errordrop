import { Router, Response } from "express";
import crypto from "crypto";
import {
  db,
  ensureUser,
  getUser,
  getTransactions,
  placeBet,
  adminCredit,
  grantReferralBonus,
  createOrder,
  getOrder,
  markOrderPaid,
  applyTx,
  claimDailyBonus,
  moscowDay,
  PACKAGES,
} from "./db";
import { authGuard, requireAuth, TgUser } from "./auth";
import { isAdmin, toInt } from "./helpers";

const router = Router();
const BOT_TOKEN = process.env.BOT_TOKEN as string;

router.use(authGuard);

/** Resolve ref-кода в telegram_id (для /me). */
async function resolveRef(refCode: string | null): Promise<number | null> {
  if (!refCode) return null;
  const row = await db.query(`SELECT telegram_id FROM users WHERE ref_code = $1`, [refCode]);
  return row.rows[0] ? Number(row.rows[0].telegram_id) : null;
}

/** GET /api/me — юзер + баланс + история + флаги админа. */
router.get("/me", requireAuth, async (req: any, res: Response) => {
  const u = req.auth.user as TgUser;
  const refId = await resolveRef(req.auth.refCode ?? null);

  const user = await ensureUser(u.id, u.username, refId && refId !== u.id ? refId : null);
  const tx = await getTransactions(u.id, 25);
  const [rc, drb] = await Promise.all([countReferrals(u.id), dailyBonusReady(u.id)]);

  res.json({
    ok: true,
    data: {
      user: {
        telegramId: user.telegram_id,
        username: user.username,
        balance: Number(user.balance),
        refCode: user.ref_code,
        isAdmin: isAdmin(u.id),
        referralCount: rc,
        dailyBonusReady: drb,
      },
      transactions: tx,
    },
  });
});

/** Проверить, доступен ли ежедневный бонус сегодня. */
async function dailyBonusReady(userId: number): Promise<boolean> {
  const row = await db.query(`SELECT last_day FROM daily_bonus WHERE user_id = $1`, [userId]);
  return !(row.rows[0] && row.rows[0].last_day === moscowDay());
}

/** GET /api/referrals — рефералы. */
router.get("/referrals", requireAuth, async (req: any, res: Response) => {
  const id = req.auth.user.id;
  const myUser = await getUser(id);
  const myCode = myUser?.ref_code ?? null;
  const refs = await db.query(
    `SELECT username, extract(epoch from created_at)::int AS created_at
     FROM users WHERE referred_by = $1 ORDER BY created_at DESC LIMIT 100`,
    [id]
  );
  res.json({ ok: true, data: { refCode: myCode, referrals: refs.rows } });
});

/** POST /api/admin/credit — magic-кнопка накрутки (только админ). */
router.post("/admin/credit", requireAuth, async (req: any, res: Response) => {
  const id = req.auth.user.id;
  if (!isAdmin(id)) return res.status(403).json({ ok: false, error: "forbidden" });

  const amount = toInt(req.body.amount);
  const target = toInt(req.body.target);
  const targetId = target && target > 0 ? target : id;
  if (!amount || amount <= 0 || amount > 100000)
    return res.status(400).json({ ok: false, error: "invalid_amount" });

  try {
    const balance = await adminCredit(targetId, amount);
    return res.json({ ok: true, data: { target: targetId, credited: amount, balance } });
  } catch (e: any) {
    return res.status(400).json({ ok: false, error: e?.message || "credit_failed" });
  }
});

/** POST /api/daily-bonus — бесплатные звёзды раз в сутки. */
router.post("/daily-bonus", requireAuth, async (req: any, res: Response) => {
  const id = req.auth.user.id;
  const DAILY_BONUS = parseInt(process.env.DAILY_BONUS ?? "5", 10);
  const { granted, bonus } = await claimDailyBonus(id, DAILY_BONUS);
  const u = await getUser(id);
  const balance = Number(u?.balance ?? 0);
  res.json({ ok: true, data: { granted, bonus, balance } });
});

/** POST /api/invoice — создать invoice link для покупки XTR. */
router.post("/invoice", requireAuth, async (req: any, res: Response) => {
  const u = req.auth.user as TgUser;
  const pkg = PACKAGES.find((p) => p.id === req.body.packageId);
  if (!pkg) return res.status(400).json({ ok: false, error: "invalid_package" });

  const payload = `o_${crypto.randomBytes(10).toString("hex")}`;
  await createOrder(payload, u.id, pkg.id, pkg.amount);

  try {
    const invoiceLink = await createInvoiceLink(pkg.title, pkg.amount, payload);
    return res.json({ ok: true, data: { invoiceLink, payload } });
  } catch (err) {
    console.error("invoice error", err);
    return res.status(500).json({ ok: false, error: "invoice_failed" });
  }
});

/** POST /api/bet — выбрать игру и поставить. */
router.post("/bet", requireAuth, async (req: any, res: Response) => {
  const u = req.auth.user as TgUser;
  const betAmount = toInt(req.body.amount);
  const betId = (req.body.betId as string) ?? "";
  const game = (req.body.game as string) ?? "roulette";
  const choice = (req.body.choice as string) ?? undefined;

  const VALID_GAMES = ["roulette", "coin", "case"];
  if (!VALID_GAMES.includes(game))
    return res.status(400).json({ ok: false, error: "invalid_game" });

  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(betId)) return res.status(400).json({ ok: false, error: "invalid_bet_id" });
  if (!betAmount || betAmount <= 0 || betAmount > 100000)
    return res.status(400).json({ ok: false, error: "invalid_bet" });

  try {
    const user = await getUser(u.id);
    if (!user) return res.status(404).json({ ok: false, error: "user_not_found" });
    if (betAmount > Number(user.balance))
      return res.status(400).json({ ok: false, error: "insufficient_balance" });

    const result = await placeBet(u.id, betAmount, betId, game, choice);
    const after = await getUser(u.id);
    const balance = Number(after.balance);
    return res.json({ ok: true, data: { ...result, balance } });
  } catch (err: any) {
    if (err?.message === "insufficient_balance")
      return res.status(400).json({ ok: false, error: "insufficient_balance" });
    if (err?.message === "duplicate_bet_id") return res.status(409).json({ ok: false, error: "duplicate_bet_id" });
    console.error("bet error", err);
    return res.status(500).json({ ok: false, error: "bet_failed" });
  }
});

/**
 * Обработка апдейта Telegram (вебхук): successful_payment → пополнение + реф.
 * Вызывается bot'om после проверки секрета.
 */
export async function handlePaymentUpdate(msg: {
  successful_payment?: { invoice_payload?: string; telegram_payment_charge_id?: string; total_amount?: number };
}): Promise<void> {
  const payment = msg.successful_payment;
  if (!payment) return;

  const payload = payment.invoice_payload ?? "";
  const order = await getOrder(payload);
  if (!order) return;

  if (order.status === "paid") return;
  if (Number(order.amount) !== Number(payment.total_amount)) return;

  const ref = `${order.user_id}:${payment.telegram_payment_charge_id ?? payload}`;
  await applyTx(order.user_id, "purchase", order.amount, { ref });
  await markOrderPaid(payload);

  const me = await getUser(order.user_id);
  if (me?.referred_by) {
    await grantReferralBonus(me.referred_by, order.amount);
  }
  console.log(`✅ пополнено ${order.amount} звёзд юзеру ${order.user_id}`);
}

async function countReferrals(userId: number): Promise<number> {
  const r = await db.query(`SELECT COUNT(*) AS c FROM users WHERE referred_by = $1`, [userId]);
  return Number(r.rows[0]?.c ?? 0);
}

/** Прямой вызов Bot API createInvoiceLink. */
async function createInvoiceLink(title: string, amount: number, payload: string): Promise<string> {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN not set");
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      description: "Пополнение игрового баланса в ErrorDrop",
      payload,
      provider_token: "",
      currency: "XTR",
      prices: [{ label: `${amount} звёзд`, amount }],
    }),
  });
  const json: any = await res.json();
  if (!json.ok) throw new Error(`Bot API: ${json.description}`);
  return json.result;
}

export default router;
