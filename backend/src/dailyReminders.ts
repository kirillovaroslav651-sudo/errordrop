import { Telegraf } from "telegraf";
import { pool, moscowDay } from "./db";

/** One daily reminder after 09:00 Moscow, only while the free case is unclaimed. */
export function startDailyReminders(bot: Telegraf, appUrl: string): void {
  if (!appUrl.startsWith("https://")) return;
  let running = false;
  const run = async () => {
    if (running) return;
    const hour = (new Date().getUTCHours() + 3) % 24;
    if (hour < 9) return;
    running = true;
    try {
      const day = moscowDay();
      const eligible = await pool.query(`SELECT u.telegram_id FROM users u
        LEFT JOIN daily_bonus b ON b.user_id=u.telegram_id
        LEFT JOIN daily_case_notifications n ON n.user_id=u.telegram_id AND n.day=$1
        WHERE u.daily_reminders=TRUE AND (b.last_day IS NULL OR b.last_day<>$1)
          AND n.user_id IS NULL ORDER BY u.created_at LIMIT 50`, [day]);
      for (const row of eligible.rows) {
        const id = Number(row.telegram_id);
        const claimed = await pool.query(`INSERT INTO daily_case_notifications(user_id,day)
          SELECT $1,$2 WHERE NOT EXISTS(SELECT 1 FROM daily_bonus WHERE user_id=$1 AND last_day=$2)
          ON CONFLICT DO NOTHING RETURNING user_id`, [id,day]);
        if (!claimed.rowCount) continue;
        try {
          await bot.telegram.sendMessage(id,
            "🎁 <b>Вам снова доступен бесплатный кейс!</b>\n\nОткройте его и получите 5 игровых ⭐. Один раз в сутки.",
            { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Открыть бесплатно ↗", web_app: { url: appUrl } }]] } });
          await pool.query(`UPDATE daily_case_notifications SET sent_at=now() WHERE user_id=$1 AND day=$2`, [id,day]);
        } catch (error: any) {
          if (error?.response?.error_code === 403) {
            await pool.query(`UPDATE users SET daily_reminders=FALSE WHERE telegram_id=$1`, [id]);
          }
          await pool.query(`DELETE FROM daily_case_notifications WHERE user_id=$1 AND day=$2 AND sent_at IS NULL`, [id,day]);
          console.warn("daily reminder failed", id, error?.message);
        }
      }
    } catch (error) { console.error("daily reminders failed", error); }
    finally { running = false; }
  };
  setTimeout(() => void run(), 15_000);
  setInterval(() => void run(), 15 * 60_000);
}
