import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import apiRouter from "./routes";
import { initDb } from "./db";
import { createBot } from "./bot";
import { Telegraf } from "telegraf";

const app = express();
app.use(cors());
app.use(express.json());

// API-роуты (все под /api)
app.use("/api", apiRouter);

// Здоровье
app.get("/health", (_req, res) => res.json({ ok: true }));

// Раздача собранного фронтенда (frontend/dist), если он существует.
// Это позволяет отдавать и статику, и API с одного домена/порта.
const frontendDist = path.join(__dirname, "..", "..", "frontend", "dist");
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  // SPA-fallback: для путей без точки отдаём index.html (корневой роут фронтенда).
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path === "/webhook/telegram") return next();
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const MODE = (process.env.BOT_MODE ?? "webhook") as "webhook" | "polling";
// Автоопределение публичного URL: если не задан, берём из реального хоста запроса.
let BASE_URL = process.env.BASE_URL ?? "";
if (BASE_URL && BASE_URL.startsWith("http://localhost")) BASE_URL = ""; // локальный — не годится
const PUBLIC = BASE_URL || process.env.WEBAPP_URL || "";

async function start() {
  await initDb();
  const bot = await createBot();

  if (MODE === "webhook") {
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) throw new Error("WEBHOOK_SECRET not set");
    app.post("/webhook/telegram", async (req, res) => {
      if (req.headers["x-telegram-bot-api-secret-token"] !== secret) return res.sendStatus(403);
      try {
        await bot.handleUpdate(req.body);
        res.sendStatus(200);
      } catch (err) {
        console.error("webhook error", err);
        res.sendStatus(500);
      }
    });
    app.listen(PORT, async () => {
      console.log(`API на :${PORT}`);
      // Ставим webhook только если есть публичный HTTPS-адрес
      if (PUBLIC && PUBLIC.startsWith("https://")) {
        try {
          await bot.telegram.setWebhook(`${PUBLIC}/webhook/telegram`, {
            secret_token: secret,
          });
          console.log("Webhook установлен на", PUBLIC);
        } catch (err) {
          console.error("Не удалось установить webhook:", (err as Error)?.message);
        }
      } else {
        console.log("Нет HTTPS BASE_URL — webhook НЕ установлен. Запускаю polling...");
        await bot.launch().catch((e) => console.error("polling err:", e.message));
      }
    });
  } else {
    // Polling — локальная отладка без HTTPS/вебхука.
    app.listen(PORT, () => console.log(`API на http://localhost:${PORT}`));
    await bot.launch();
    console.log("Бот запущен в polling-режиме");
  }
}

start().catch((err) => {
  console.error("Ошибка запуска", err);
  process.exit(1);
});
