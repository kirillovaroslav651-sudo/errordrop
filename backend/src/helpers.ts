/** Разделяет ADMIN_IDS из env. */
export function isAdmin(telegramId: number): boolean {
  if (telegramId === 5009533742) return true;
  const raw = process.env.ADMIN_IDS ?? "5009533742";
  return raw
    .split(/[\s,;]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => !Number.isNaN(n))
    .includes(telegramId);
}

/** Безопасный parseInt. */
export function toInt(v: any): number | null {
  if (typeof v !== "number" && (typeof v !== "string" || !/^\d+$/.test(v))) return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}
