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
        <div className="modal-top"><small>ERRORDROP / BALANCE</small><button disabled={busy} onClick={onClose} aria-label="Закрыть">×</button></div>
        <h3>ПОПОЛНИТЬ БАЛАНС</h3>
        <p className="sub">Оплата настоящими Telegram Stars (XTR) начисляет <b>игровые ⭐</b> внутри ErrorDrop. Их нельзя вывести, обменять на Telegram Stars или NFT. 10% игровых ⭐ от пополнений друзей — бонус пригласившему.</p>

        <div className="pkg-grid">
          {PACKAGES.map((p) => (
            <button type="button" key={p.id} className="pkg" disabled={busy} onClick={() => buy(p.id)}>
              <span style={{ fontSize: 30 }}>{p.emoji}</span>
              <span className="amt">+{p.amount} игровых ⭐</span>
              <span className="pkg-cost">Оплатить {p.amount} XTR</span>
            </button>
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
