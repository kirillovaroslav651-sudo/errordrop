# ErrorDrop — Telegram Mini App

Красное мини-приложение для [@ErrorDrop_Bot](https://t.me/ErrorDrop_Bot): кейсы, ежедневный бонус, рефералы, история, личная витрина подарков и админ-панель. React/TypeScript + Express/Telegraf + PostgreSQL (в том числе Supabase). Баланс, история и подборка картинок хранятся на сервере по подтверждённому Telegram ID, поэтому сохраняются после выхода из приложения.

## Подарки и игровые награды

В `frontend/src/giftCatalog.json` и `frontend/public/gifts/all/` сохранён снимок 151 коллекции с [Telegifter](https://telegifter.ru/gifts/collections/) от 10 октября 2026 года: изображения, названия, справочные цены и ссылки на источник. Цена в TON или статус Pre-market не является стоимостью открытия кейса. Это **не полный реестр всех когда-либо выпущенных Telegram-подарков**, а содержимое указанной страницы на дату снимка. Цены не обновляются автоматически — при изменениях источника каталог надо обновить и пересобрать. `backend/src/giftCatalog.json` содержит IDs для проверки личной подборки.

Кейс начисляет только **внутренние игровые ⭐**, а не Telegram Stars и не NFT. Картинки подарков — справочная витрина, не список возможных выигрышей и не доказательство владения. Экран «Призы» показывает шансы сервера: 50% ×1, 25% ×2, 18% ×4, 7% ×10 (множитель к цене кейса). После оплаты настоящими XTR пополняется лишь внутриигровой баланс; вывести его нельзя.

## Развёртывание на Render

Репозиторий содержит `render.yaml` и Dockerfile для **одного Web Service**, который отдаёт и Mini App, и API, и принимает Telegram webhook. Static Site отдельно не нужен.

1. Создай Supabase-проект и скопируй **Postgres connection string** для Session pooler (IPv4), не `anon key` и не Storage. Пароль базы не публикуй в репозитории.
2. В Render создай Blueprint из этого репозитория или Web Service с Dockerfile. Укажи секреты в Environment: `DATABASE_URL`, `BOT_TOKEN` (новый токен после перевыпуска), `WEBHOOK_SECRET` (случайная строка 32+ символов). Укажи `ADMIN_IDS=5009533742`, `BOT_MODE=webhook`, `WEBAPP_URL` и `BASE_URL` равными реальному `https://...onrender.com` адресу сервиса. Текущий `render.yaml` использует `https://errordrop.onrender.com`; при другом имени сервиса обнови оба URL.
3. После Deploy открой `/health` (должен ответить `{"ok":true}`), затем зайди в @ErrorDrop_Bot и отправь `/start`. Бот покажет кнопку «🎮 Играть» и добавит её в меню.
4. Проверяй Mini App **в Telegram**: вне Telegram сервер отклонит запросы без подписанного `initData`.

Внимание: игровые звёзды на внутреннем балансе не являются выводимыми Telegram Stars. Telegram NFT-подарки/вывод не реализованы. Покупка пополняет игровой баланс после подтверждённого Telegram XTR-платежа. Не публикуй токены в чате или GitHub. Перед публичным запуском платных случайных кейсов проверь актуальные правила Telegram и применимое законодательство.

## Локальная проверка

Установи Node.js 22+, заполни `backend/.env` по `backend/.env.example` (включая `DATABASE_URL`), затем:

```sh
npm ci --prefix backend
npm ci --prefix frontend
npm run build --prefix backend
npm run build --prefix frontend
npm start --prefix backend
```

Для локальной разработки `BOT_MODE=polling`; для рабочей кнопки Telegram нужен HTTPS `WEBAPP_URL`.
Для визуальной проверки без Telegram запусти `npm run dev --prefix frontend` и открой `http://localhost:5173/?preview=1` (демо работает только в Vite dev-сборке, не в production).
