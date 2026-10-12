/** Internal display value. 1 TON = ₽125 (owner-supplied); 100 in-game ⭐ = ₽150 for this catalogue only. */
export const TON_RUB = 125;
export const GAME_STAR_RUB = 1.5;
export const GIFT_MARKUP = 1.2;
export function giftStarValue(price: string, currency: string): number | null {
  if (price === "Pre-market") return null;
  const n = Number(price.replace(/^~/," ").trim().replace(",","."));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.round(n * (currency === "TON" ? TON_RUB / GAME_STAR_RUB : 1) * GIFT_MARKUP));
}
export function giftTier(value: number): number {
  if (value <= 400) return 1;
  if (value <= 1500) return 2;
  if (value <= 5000) return 3;
  if (value <= 15000) return 4;
  return 5;
}
