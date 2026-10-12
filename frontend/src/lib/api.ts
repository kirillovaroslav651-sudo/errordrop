// Единый API-клиент: все запросы шлём с заголовком x-init-data.

import WebApp from "@twa-dev/sdk";

/** Читаем initData в момент каждого запроса — SDK может быть не готов на импорте модуля. */
function getInitData(): string {
  try {
    return WebApp.initData ?? "";
  } catch {
    return "";
  }
}

export type Tx = {
  id: number;
  type: "purchase" | "first_purchase_bonus" | "bet_win" | "bet_lose" | "referral_bonus" | "admin_credit" | "daily_bonus" | "case_open" | "case_reward" | "gift_sale";
  amount: number;
  spin_result: "win" | "lose" | null;
  game: string | null;
  choice: string | null;
  created_at: number;
};

export type MeData = {
  user: {
    telegramId: number;
    username?: string;
    balance: number;
    refCode: string;
    isAdmin: boolean;
    referralCount: number;
    dailyBonusReady: boolean;
  };
  transactions: Tx[];
  gallery: string[];
  inventory: InventoryItem[];
};

export type InventoryItem = { id: number; giftId: string; caseId: string; value: number; sellValue: number; status: "owned" | "sold" | "pending" | "withdrawn"; createdAt: number };
export type CaseResult = { caseId: string; price: number; reward: { type: "stars" | "gift"; stars: number; giftId?: string; inventoryId?: number; value?: number }; balance: number };
export type AdminPlayer = { telegramId: number; username: string | null; balance: number; inventory: InventoryItem[] };
export type Withdrawal = { id: number; inventoryId: number; userId: number; status: string; giftId: string; username: string | null; createdAt: number };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-init-data": getInitData(),
      ...(init?.headers ?? {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    throw new Error(json?.error ?? `request failed: ${res.status}`);
  }
  return json.data as T;
}

export const api = {
  me: () => request<MeData>("/api/me"),
  giftPrices: () => request<{prices:{id:string;stars:number;updatedAt:string}[]}>("/api/gift-prices"),
  openCase: (caseId: string, betId: string) => request<CaseResult>(`/api/cases/${encodeURIComponent(caseId)}/open`, { method: "POST", body: JSON.stringify({betId}) }),
  sellGift: (id: number) => request<{credited:number; inventory:InventoryItem[]}>(`/api/inventory/${id}/sell`, {method:"POST"}),
  withdrawGift: (id: number) => request<{requestId:number; inventory:InventoryItem[]}>(`/api/inventory/${id}/withdraw`, {method:"POST"}),
  adminPlayer: (q: string) => request<{players:AdminPlayer[]}>(`/api/admin/player?q=${encodeURIComponent(q)}`),
  adminWithdrawals: () => request<{requests:Withdrawal[]}>("/api/admin/withdrawals"),
  adminReview: (id:number, action:"reject"|"fulfilled") => request<{status:string}>(`/api/admin/withdrawals/${id}/review`,{method:"POST",body:JSON.stringify({action})}),
  addGallery: (giftId: string) => request<{ gallery: string[] }>("/api/gallery", { method: "POST", body: JSON.stringify({ giftId }) }),
  removeGallery: (giftId: string) => request<{ gallery: string[] }>(`/api/gallery/${encodeURIComponent(giftId)}`, { method: "DELETE" }),
  referrals: () => request<{ refCode: string; referrals: { username?: string; created_at: number }[] }>("/api/referrals"),
  invoice: (packageId: string) =>
    request<{ invoiceLink: string; payload: string }>("/api/invoice", {
      method: "POST",
      body: JSON.stringify({ packageId }),
    }),
  bet: (amount: number, betId: string, game: string, choice?: string) =>
    request<{ won: boolean; delta: number; balance: number; outcome?: string; multiplier?: number }>("/api/bet", {
      method: "POST",
      body: JSON.stringify({ amount, betId, game, choice }),
    }),
  dailyBonus: () =>
    request<{ granted: boolean; bonus: number; balance: number }>("/api/daily-bonus", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  adminCredit: (amount: number, target?: number|string) =>
    request<{ target: number; credited: number; balance: number }>("/api/admin/credit", {
      method: "POST",
      body: JSON.stringify({ amount, target }),
    }),
};

export interface UserInfo {
  id: number;
  username?: string;
  first_name?: string;
}

export function getTgUser(): UserInfo | null {
  try {
    const raw = WebApp.initDataUnsafe?.user as unknown as UserInfo;
    return raw?.id ? raw : null;
  } catch {
    return null;
  }
}
