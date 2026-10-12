import { Telegraf } from "telegraf";
import { handlePaymentUpdate } from "./routes";
import { db, ensureUser } from "./db";

/**
 * Бот обрабатывает успешные платежи (successful_payment) и команды.
 * В webhook-режиме апдейты приходят на /webhook/telegram,
 * в polling-режиме бот сам их качает.
 */

/** Полный URL приложения, без хвостовых слэшей. */
function webAppUrl(): string {
  const raw = process.env.WEBAPP_URL ?? process.env.BASE_URL ?? "";
  return raw.replace(/\/+$/, "");
}

export async function createBot(): Promise<Telegraf> {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN not set");
  const bot = new Telegraf(token);
  const appUrl = webAppUrl();
  // Telegram принимает web_app-кнопки только по HTTPS
  const httpsOk = appUrl.startsWith("https://");

  // Веб-кнопка под полем ввода (setChatMenuButton) — только если HTTPS.
  if (httpsOk) {
    await bot.telegram
      .setChatMenuButton({
        menuButton: {
          type: "web_app",
          text: "🎮 Играть",
          web_app: { url: appUrl },
        },
      })
      .catch((err) => console.warn("Не удалось установить кнопку меню:", err.message));
  }

  // Команда /start — приветствие + кнопка запуска (если HTTPS) или текст.
  bot.start(async (ctx) => {
    const startPayload = ctx.startPayload;
    const refCode = startPayload?.match(/^ref_([0-9a-f]{8})$/)?.[1];
    const ref = refCode ? await db.query(`SELECT telegram_id FROM users WHERE ref_code = $1`, [refCode]) : null;
    const refId = ref?.rows[0] ? Number(ref.rows[0].telegram_id) : null;
    await ensureUser(ctx.from.id, ctx.from.username, refId !== ctx.from.id ? refId : null);
    await db.query(`UPDATE users SET daily_reminders=TRUE WHERE telegram_id=$1`, [ctx.from.id]);

    if (!httpsOk) {
      return ctx.reply(
        "👋 Добро пожаловать в «ErrorDrop»! 🔴\n\n⚠️ Mini App ещё не подключён по HTTPS. " +
          "Установи туннель (cloudflared) и пропиши WEBAPP_URL с https://, чтобы открыть игру."
      );
    }

    const markup = {
      reply_markup: {
        inline_keyboard: [[{ text: "🎮 Играть", web_app: { url: appUrl } }]],
      },
    };
    // Custom emoji IDs verified against emoji.wivvi.net; fallback for clients/bots without support.
    await ctx.reply(
      '<tg-emoji emoji-id="5773677501825945508">🎁</tg-emoji> <b>Добро пожаловать в ErrorDrop!</b>\n' +
      'Открывай кейсы, получай игровые звёзды <tg-emoji emoji-id="6028338546736107668">⭐</tg-emoji> и приглашай друзей.',
      { ...markup, parse_mode: "HTML" }
    ).catch(() => ctx.reply("🎁 Добро пожаловать в ErrorDrop! Открывай кейсы и приглашай друзей.", markup));
  });

  bot.command("mute", async ctx => {
    await db.query(`UPDATE users SET daily_reminders=FALSE WHERE telegram_id=$1`, [ctx.from.id]);
    await ctx.reply("Напоминания о бесплатном кейсе отключены. Вернуть: /unmute");
  });
  bot.command("unmute", async ctx => {
    await ensureUser(ctx.from.id, ctx.from.username);
    await db.query(`UPDATE users SET daily_reminders=TRUE WHERE telegram_id=$1`, [ctx.from.id]);
    await ctx.reply("Напоминания о бесплатном кейсе включены. Отключить: /mute");
  });

  // Обработчик успешной оплаты.
  bot.on("pre_checkout_query", (ctx) => ctx.answerPreCheckoutQuery(true));
  bot.on("message", async (ctx) => {
    if (ctx.message && "successful_payment" in ctx.message) {
      await handlePaymentUpdate(ctx.message as any);
    }
  });

  return bot;
}
