import { Api, TelegramClient } from "teleproto";
import { MemorySession } from "teleproto/sessions";
import giftCatalog from "./giftCatalog.json";
import { pool, setLiveGiftPrices } from "./db";

const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const byName = new Map(giftCatalog.map(g => [normalize(g.name), g.id]));
let running = false;

/** Telegram resale floor in Stars; only exact collection-title matches are used. */
export async function refreshTelegramGiftPrices(): Promise<void> {
  if (running) return;
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  const token = process.env.BOT_TOKEN;
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash || !token) return;
  running = true;
  const client = new TelegramClient(new MemorySession(), apiId, apiHash, { connectionRetries: 3 });
  try {
    await client.start({ botAuthToken: token });
    const result = await client.invoke(new Api.payments.GetStarGifts({ hash: 0 }));
    if (!(result instanceof Api.payments.StarGifts)) return;
    const found = new Map<string, { stars: number; telegramId: string }>();
    for (const gift of result.gifts) {
      if (!(gift instanceof Api.StarGift) || !gift.title || !gift.resellMinStars) continue;
      const id = byName.get(normalize(gift.title));
      const stars = Number(gift.resellMinStars);
      if (!id || !Number.isSafeInteger(stars) || stars <= 0) continue;
      const prior = found.get(id);
      if (!prior || stars < prior.stars) found.set(id, { stars, telegramId: String(gift.id) });
    }
    if (found.size === 0) {
      console.warn("Telegram gift prices: no exact catalog titles matched; retained saved prices");
      return;
    }
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      for (const [id, value] of found) {
        await db.query(`INSERT INTO telegram_gift_prices(gift_id,stars,telegram_gift_id,updated_at)
          VALUES($1,$2,$3,now()) ON CONFLICT(gift_id) DO UPDATE SET
          stars=EXCLUDED.stars, telegram_gift_id=EXCLUDED.telegram_gift_id, updated_at=now()`,
          [id, value.stars, value.telegramId]);
        await db.query(`UPDATE gift_inventory SET display_value=$1,sell_value=$1,updated_at=now()
          WHERE gift_id=$2 AND status='owned' AND (display_value<>$1 OR sell_value<>$1)`,
          [value.stars, id]);
      }
      await db.query("COMMIT");
      const saved = await pool.query(`SELECT gift_id,stars FROM telegram_gift_prices`);
      setLiveGiftPrices(Object.fromEntries(saved.rows.map(row => [row.gift_id, Number(row.stars)])));
      console.log(`Telegram gift prices: matched ${found.size} of ${giftCatalog.length} catalog gifts`);
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally { db.release(); }
  } catch (error) {
    console.error("Telegram gift prices sync failed; saved prices retained:", error);
  } finally {
    await client.disconnect().catch(() => undefined);
    running = false;
  }
}

export function startTelegramPriceSync(): void {
  if (!process.env.TELEGRAM_API_ID || !process.env.TELEGRAM_API_HASH) {
    console.warn("Telegram price sync disabled: TELEGRAM_API_ID/HASH not configured");
    return;
  }
  void refreshTelegramGiftPrices();
  setInterval(() => void refreshTelegramGiftPrices(), 6 * 60 * 60 * 1000).unref();
}
