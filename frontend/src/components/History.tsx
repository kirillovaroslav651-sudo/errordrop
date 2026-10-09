import { Tx } from "../lib/api";

const TYPE_LABEL: Record<Tx["type"], string> = {
  purchase: "💎 Покупка",
  bet_win: "🎰 Выигрыш",
  bet_lose: "🎰 Ставка",
  referral_bonus: "🤝 Реферал",
  admin_credit: "🪄 Бонус админа",
  daily_bonus: "🎁 Дневной бонус",
};

const GAME_LABEL: Record<string, string> = {
  roulette: "🎰",
  coin: "🪙",
  case: "📦",
};

function fmtDate(ts: number): string {
  try {
    return new Date(ts * 1000).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function History({ transactions }: { transactions: Tx[] }) {
  if (!transactions.length) {
    return (
      <section>
        <div className="section-title">История</div>
        <div style={{ color: "var(--text-dim)", fontSize: 14 }}>Пока пусто. Сделай первую ставку!</div>
      </section>
    );
  }
  return (
    <section>
      <div className="section-title">История</div>
      <ul className="history">
        {transactions.map((t) => (
          <li key={t.id}>
            <span className="type">
              {TYPE_LABEL[t.type] ?? t.type} {t.game ? GAME_LABEL[t.game] ?? t.game : ""} · {fmtDate(t.created_at)}
            </span>
            <span className={t.amount >= 0 ? "pos" : "neg"}>
              {t.amount >= 0 ? "+" : ""}
              {t.amount} ⭐
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}