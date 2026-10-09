import { useState } from "react";
import WebApp from "@twa-dev/sdk";
import { api } from "../lib/api";

const PACKAGES = [
  { id: "pkg-50", amount: 50, emoji: "💎" },
  { id: "pkg-100", amount: 100, emoji: "💠" },
  { id: "pkg-250", amount: 250, emoji: "🔮" },
  { id: "pkg-500", amount: 500, emoji: "👑" },
];

type Props = {
  onClose: () => void;
  onPurchased: () => void;
};

export default function BuyModal({ onClose, onPurchased }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buy = async (packageId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // 1. Создаём invoice на бэке
      const { invoiceLink } = await api.invoice(packageId);
      console.log("invoice link:", invoiceLink);

      // 2. Открываем платёж в Telegram через sdk
      try {
        await WebApp.openInvoice(invoiceLink);
        // Если openInvoice не кинул ошибку и пользователь закрыл — это не значит, что оплатил.
        // Точный сигнал — вебхук successful_payment на бэке (он сам обновит баланс при следующем /me).
        // Здесь просто перезагружаем юзера, чтобы подхватить возможное пополнение.
        await onPurchased();
      } catch (invErr: any) {
        // Пользователь закрыл платёж не оплатив → Telegram кидает "invoice_closed".
        console.warn("invoice closed:", invErr);
        setError("Оплата не завершена. Если баланс не обновился не мгновенно — обнови приложение.");
        setBusy(false);
      }
    } catch (e: any) {
      setError(e.message || "Ошибка создания счёта");
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={() => !busy && onClose()}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h3>💎 Купить звёзды</h3>
        <p className="sub">Оплата через Telegram Stars (XTR). 10% от пополнения приглашённых — тебе на баланс!</p>

        <div className="pkg-grid">
          {PACKAGES.map((p) => (
            <div key={p.id} className="pkg" onClick={() => buy(p.id)}>
              <span style={{ fontSize: 30 }}>{p.emoji}</span>
              <span className="amt">{p.amount} ⭐</span>
              <span style={{ color: "var(--text-dim)", fontSize: 12 }}>оплатить</span>
            </div>
          ))}
        </div>

        {error && <div className="error-banner">{error}</div>}

        <button className="btn btn--ghost" disabled={busy} onClick={onClose}>
          {busy ? "Обработка..." : "Закрыть"}
        </button>
      </div>
    </div>
  );
}