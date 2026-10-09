import crypto from "crypto";

export interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

export interface AuthPayload {
  user: TgUser | null;
  refCode?: string | null; // из поля start_param: ref_<ref_code>
}

/** HTTP-контекст запроса Express. */
declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN as string;
const MAX_AGE = parseInt(process.env.INITDATA_MAX_AGE ?? "86400", 10);

/** Канонизирует строку initData для проверки подписи.
 *  Telegram: data_check_string = пары key=value (ЗНАЧЕНИЯ ДЕКОДИРУЮТСЯ),
 *  отсортированные лексикографически по ключу, разделённые \n.
 *  Исключаем только поле `hash`. Поле `signature` включаем (современный формат). */
function sortInitData(initData: string): string {
  return [...new URLSearchParams(initData).entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/**
 * Валидирует Telegram WebApp initData (подпись HMAC-SHA256, поля внутри).
 * Возвращает распарсенный payload или null, если вредно/просрочено.
 */
export function validateInitData(
  initData: string,
  botToken: string = BOT_TOKEN
): AuthPayload | null {
  try {
    // 1. Вытащить hash и остальные поля
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;

    // 2. secret_key = HMAC_SHA256("WebAppData", bot_token)
    const secret = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();

    // 3. data_check_string для подписи
    const dataCheckString = sortInitData(initData);

    // 4. computed_hash = HMAC_SHA256(data_check_string, secret)
    const computed = crypto
      .createHmac("sha256", secret)
      .update(dataCheckString)
      .digest("hex");

    if (!/^[0-9a-f]{64}$/i.test(hash) || !crypto.timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(hash, "hex"))) return null;

    // 5. Проверка давности auth_date (защита от replay)
    const authDate = params.get("auth_date");
    if (!authDate || !/^\d+$/.test(authDate)) return null;
    const ageSec = Math.floor(Date.now() / 1000) - Number(authDate);
    if (ageSec < -30 || ageSec > MAX_AGE) return null;

    // 6. Распарсить user и start_param
    let user: TgUser | null = null;
    const userRaw = params.get("user");
    if (userRaw) user = JSON.parse(userRaw);
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return null;

    let refCode: string | null = null;
    const startParam = params.get("start_param");
    if (startParam) {
      // start_param = "ref_<ref_code>" — код пригласившего
      const m = startParam.match(/^ref_(.+)$/);
      if (m) refCode = m[1];
    }

    return { user, refCode };
  } catch {
    return null;
  }
}

/**
 * Express middleware: парсит initData из заголовка x-init-data,
 * валидирует, подсовывает req.auth.
 */
export function authGuard(req: any, _res: any, next: any) {
  const header = req.headers["x-init-data"] as string | undefined;
  if (!header) {
    req.auth = undefined;
    return next();
  }
  const payload = validateInitData(header);
  req.auth = payload ?? undefined;
  next();
}

/** Проверка, что юзер авторизован через initData (иначе 401). */
export function requireAuth(req: any, res: any, next: any) {
  if (!req.auth?.user) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}
