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
  settlePaidOrder,
  applyTx,
  claimDailyBonus,
  moscowDay,
  getGiftGallery,
  getInventory,
  openPaidCase,
  sellInventoryGift,
  requestGiftWithdrawal,
  getWithdrawalAccess,
  adminRemoveStars,
  adminRemoveGift,
  upgradeGift,
} from "./db";
import giftCatalog from "./giftCatalog.json";
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
  const [rc, drb, gallery, inventory, withdrawalAccess] = await Promise.all([countReferrals(u.id), dailyBonusReady(u.id), getGiftGallery(u.id), getInventory(u.id), getWithdrawalAccess(u.id)]);

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
      gallery,
      inventory,
      withdrawalAccess,
    },
  });
});

/** Presence is a rolling 60-second count of active Mini App users, not bot subscribers. */
router.post("/presence", requireAuth, async (req: any, res: Response) => {
  await ensureUser(req.auth.user.id, req.auth.user.username);
  await db.query(`INSERT INTO online_presence(user_id,seen_at) VALUES($1,now())
    ON CONFLICT(user_id) DO UPDATE SET seen_at=now()`, [req.auth.user.id]);
  const result = await db.query(`SELECT COUNT(*)::int AS online FROM online_presence
    WHERE seen_at > now() - interval '60 seconds'`);
  return res.json({ok:true,data:{online:Number(result.rows[0].online)}});
});

const giftIds = new Set(giftCatalog.map(gift => gift.id));
router.get("/gift-prices", requireAuth, async (_req, res: Response) => {
  const result = await db.query(`SELECT gift_id AS id, stars, updated_at AS "updatedAt" FROM telegram_gift_prices`);
  res.json({ ok: true, data: { prices: result.rows } });
});
router.post("/gallery", requireAuth, async (req: any, res: Response) => {
  const giftId = req.body.giftId;
  if (typeof giftId !== "string" || !giftIds.has(giftId)) return res.status(400).json({ ok: false, error: "invalid_gift" });
  const userId = req.auth.user.id;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Serialise additions per user so concurrent taps cannot exceed the 24-item limit.
    await client.query(`SELECT telegram_id FROM users WHERE telegram_id = $1 FOR UPDATE`, [userId]);
    await client.query(
      `INSERT INTO gift_gallery (user_id, gift_id)
       SELECT $1, $2 WHERE (SELECT COUNT(*) FROM gift_gallery WHERE user_id = $1) < 24
       ON CONFLICT DO NOTHING`, [userId, giftId]
    );
    await client.query("COMMIT");
    res.json({ ok: true, data: { gallery: await getGiftGallery(userId) } });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("gallery add failed", error);
    res.status(500).json({ ok: false, error: "gallery_failed" });
  } finally { client.release(); }
});

router.delete("/gallery/:giftId", requireAuth, async (req: any, res: Response) => {
  await db.query(`DELETE FROM gift_gallery WHERE user_id = $1 AND gift_id = $2`, [req.auth.user.id, req.params.giftId]);
  res.json({ ok: true, data: { gallery: await getGiftGallery(req.auth.user.id) } });
});

router.post("/cases/:caseId/open", requireAuth, async (req: any, res: Response) => {
  const userId = req.auth.user.id;
  const caseId = req.params.caseId;
  const betId = req.body.betId;
  if (typeof betId !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(betId))
    return res.status(400).json({ ok: false, error: "invalid_bet_id" });
  if (caseId === "daily") {
    try {
      const result = await claimDailyBonus(userId, 5);
      if (!result.granted) return res.status(409).json({ ok: false, error: "daily_already_claimed" });
      const user = await getUser(userId);
      return res.json({ ok: true, data: { caseId, price: 0, reward: { type: "stars", stars: 5 }, balance: Number(user.balance) } });
    } catch (e) { console.error("daily case failed",e); return res.status(500).json({ ok:false,error:"case_failed" }); }
  }
  try {
    const result = await openPaidCase(userId, caseId, betId);
    return res.json({ ok: true, data: result });
  } catch (e: any) {
    const code = e?.message;
    if (["invalid_case","insufficient_balance","duplicate_bet_id"].includes(code))
      return res.status(code === "duplicate_bet_id" ? 409 : 400).json({ ok:false,error:code });
    console.error("case opening failed",e);
    return res.status(500).json({ ok:false,error:"case_failed" });
  }
});

router.post("/inventory/:id/upgrade", requireAuth, async (req: any, res: Response) => {
  const id=toInt(req.params.id), targetGiftId=req.body.targetGiftId;
  if (!id || typeof targetGiftId!=="string" || !giftIds.has(targetGiftId))
    return res.status(400).json({ok:false,error:"invalid_upgrade_target"});
  try { return res.json({ok:true,data:await upgradeGift(req.auth.user.id,id,targetGiftId)}); }
  catch(e:any) { const known=["gift_not_available","invalid_upgrade_target"].includes(e?.message);
    return res.status(known?409:500).json({ok:false,error:known?e.message:"upgrade_failed"}); }
});

router.post("/inventory/:id/sell", requireAuth, async (req: any, res: Response) => {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ok:false,error:"invalid_item"});
  try { const credited = await sellInventoryGift(req.auth.user.id,id);
    return res.json({ok:true,data:{credited,inventory:await getInventory(req.auth.user.id)}});
  } catch(e:any) { return res.status(e?.message === "gift_not_available" ? 409 : 500).json({ok:false,error:e?.message === "gift_not_available" ? e.message : "sale_failed"}); }
});

router.post("/inventory/:id/withdraw", requireAuth, async (req: any, res: Response) => {
  const id = toInt(req.params.id);
  if (!id) return res.status(400).json({ok:false,error:"invalid_item"});
  try { const requestId = await requestGiftWithdrawal(req.auth.user.id,id);
    return res.json({ok:true,data:{requestId,inventory:await getInventory(req.auth.user.id)}});
  } catch(e:any) { const known = ["gift_not_available", "withdrawal_locked", "level_required"].includes(e?.message); return res.status(known ? 409 : 500).json({ok:false,error:known ? e.message : "withdraw_failed"}); }
});

router.get("/admin/player", requireAuth, async (req: any, res: Response) => {
  if (!isAdmin(req.auth.user.id)) return res.status(403).json({ok:false,error:"forbidden"});
  const search = typeof req.query.q === "string" ? req.query.q.trim().replace(/^@/,"") : "";
  if (!/^[a-zA-Z0-9_]{5,32}$/.test(search) && !/^\d{1,16}$/.test(search))
    return res.status(400).json({ok:false,error:"invalid_search"});
  const found = await db.query(`SELECT telegram_id,username,balance FROM users
    WHERE lower(username)=lower($1) OR telegram_id::text=$1 ORDER BY created_at DESC LIMIT 5`,[search]);
  const players = await Promise.all(found.rows.map(async u => ({ telegramId:Number(u.telegram_id),username:u.username,
    balance:Number(u.balance), inventory:await getInventory(Number(u.telegram_id)) })));
  res.json({ok:true,data:{players}});
});

router.post("/admin/player/:id/remove-stars", requireAuth, async (req: any, res: Response) => {
  if (!isAdmin(req.auth.user.id)) return res.status(403).json({ok:false,error:"forbidden"});
  const targetId = toInt(req.params.id), amount = toInt(req.body.amount);
  const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";
  if (!targetId || !amount || amount < 1 || amount > 100000 || reason.length < 5 || reason.length > 300)
    return res.status(400).json({ok:false,error:"invalid_correction"});
  try { const balance = await adminRemoveStars(req.auth.user.id,targetId,amount,reason);
    return res.json({ok:true,data:{balance}});
  } catch(e:any) { const known=["user_not_found","insufficient_balance"].includes(e?.message);
    return res.status(known?409:500).json({ok:false,error:known?e.message:"correction_failed"}); }
});

router.post("/admin/player/:id/remove-gift", requireAuth, async (req: any, res: Response) => {
  if (!isAdmin(req.auth.user.id)) return res.status(403).json({ok:false,error:"forbidden"});
  const targetId=toInt(req.params.id), inventoryId=toInt(req.body.inventoryId);
  const reason=typeof req.body.reason === "string" ? req.body.reason.trim() : "";
  if (!targetId || !inventoryId || reason.length < 5 || reason.length > 300)
    return res.status(400).json({ok:false,error:"invalid_correction"});
  try { await adminRemoveGift(req.auth.user.id,targetId,inventoryId,reason);
    return res.json({ok:true,data:{removed:true}});
  } catch(e:any) { return res.status(e?.message==="gift_not_available"?409:500)
    .json({ok:false,error:e?.message==="gift_not_available"?e.message:"correction_failed"}); }
});

router.get("/admin/actions", requireAuth, async (req: any, res: Response) => {
  if (!isAdmin(req.auth.user.id)) return res.status(403).json({ok:false,error:"forbidden"});
  const actions=await db.query(`SELECT id,admin_id AS "adminId",target_id AS "targetId",action,amount,
    inventory_id AS "inventoryId",reason,extract(epoch from created_at)::int AS "createdAt"
    FROM admin_actions ORDER BY id DESC LIMIT 50`);
  return res.json({ok:true,data:{actions:actions.rows}});
});

router.get("/admin/withdrawals", requireAuth, async (req: any, res: Response) => {
  if (!isAdmin(req.auth.user.id)) return res.status(403).json({ok:false,error:"forbidden"});
  const r = await db.query(`SELECT w.id,w.inventory_id AS "inventoryId",w.user_id AS "userId",
    w.status,i.gift_id AS "giftId",u.username,extract(epoch from w.created_at)::int AS "createdAt"
    FROM gift_withdrawals w JOIN gift_inventory i ON i.id=w.inventory_id
    JOIN users u ON u.telegram_id=w.user_id ORDER BY w.id DESC LIMIT 100`);
  res.json({ok:true,data:{requests:r.rows}});
});

router.post("/admin/withdrawals/:id/review", requireAuth, async (req: any, res: Response) => {
  if (!isAdmin(req.auth.user.id)) return res.status(403).json({ok:false,error:"forbidden"});
  const id = toInt(req.params.id), action = req.body.action;
  if (!id || !["reject","fulfilled"].includes(action)) return res.status(400).json({ok:false,error:"invalid_request"});
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(`SELECT * FROM gift_withdrawals WHERE id=$1 FOR UPDATE`,[id]);
    if (!r.rows[0] || r.rows[0].status !== "pending") { await client.query("ROLLBACK"); return res.status(409).json({ok:false,error:"request_not_pending"}); }
    await client.query(`UPDATE gift_withdrawals SET status=$1,reviewed_at=now() WHERE id=$2`,[action,id]);
    await client.query(`UPDATE gift_inventory SET status=$1,updated_at=now() WHERE id=$2`,[action === "reject" ? "owned" : "withdrawn",r.rows[0].inventory_id]);
    await client.query("COMMIT");
    return res.json({ok:true,data:{status:action}});
  } catch(e) { await client.query("ROLLBACK"); console.error("review failed",e); return res.status(500).json({ok:false,error:"review_failed"}); }
  finally { client.release(); }
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
  const rawTarget = typeof req.body.target === "string" ? req.body.target.trim().replace(/^@/, "") : req.body.target;
  const target = toInt(rawTarget);
  let targetId = target && target > 0 ? target : id;
  if (!target && rawTarget) {
    if (!/^[a-zA-Z0-9_]{5,32}$/.test(rawTarget)) return res.status(400).json({ ok: false, error: "invalid_target" });
    const found = await db.query(`SELECT telegram_id FROM users WHERE lower(username)=lower($1) LIMIT 1`, [rawTarget]);
    if (!found.rows[0]) return res.status(404).json({ ok: false, error: "user_not_found" });
    targetId = Number(found.rows[0].telegram_id);
  }
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
  const { granted, bonus } = await claimDailyBonus(id, 5);
  const u = await getUser(id);
  const balance = Number(u?.balance ?? 0);
  res.json({ ok: true, data: { granted, bonus, balance } });
});

/** POST /api/invoice — создать invoice link для покупки XTR. */
router.post("/invoice", requireAuth, async (req: any, res: Response) => {
  const u = req.auth.user as TgUser;
  const amount = toInt(req.body.amount);
  if (!amount || amount < 50 || amount > 100000)
    return res.status(400).json({ ok: false, error: "invalid_amount" });

  const payload = `o_${crypto.randomBytes(10).toString("hex")}`;
  await createOrder(payload, u.id, "custom", amount);

  try {
    const invoiceLink = await createInvoiceLink(`${amount} игровых звёзд ErrorDrop`, amount, payload);
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

  const VALID_GAMES = ["roulette", "coin"];
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

  const settled = await settlePaidOrder(payment.invoice_payload ?? "",
    payment.telegram_payment_charge_id ?? "", Number(payment.total_amount));
  if (settled) console.log("✅ платёж зачислен", payment.invoice_payload);
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
