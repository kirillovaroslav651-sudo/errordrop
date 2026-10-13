import { useState } from "react";
import WebApp from "@twa-dev/sdk";
import { api } from "../lib/api";

type Props = {
  onClose: () => void;
  onPurchased: () => void;
};

const STARS_LINK = "https://split.tg/?ref=UQClU3l3SZfzm9htQyg7CqiIjhG2hpXJ7aT4EpY2Sxoq-EJ-";

export default function BuyModal({ onClose, onPurchased }: Props) {
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState("300");
  const [error, setError] = useState<string | null>(null);

  const buy = async () => {
    if (busy) return;
    const stars = Number(amount);
    if (!Number.isSafeInteger(stars) || stars < 50 || stars > 100000) { setError("Введите целое число от 50 до 100 000 ⭐"); return; }
    setBusy(true);
    setError(null);
    try {
      // 1. Создаём invoice на бэке
      const { invoiceLink } = await api.invoice(stars);

      // Telegram SDK uses a callback; openInvoice itself does not return a Promise.
      try {
        const status = await new Promise<string>((resolve) => WebApp.openInvoice(invoiceLink, resolve));
        if (status === "paid") {
          // The payment webhook can arrive just after the Telegram client callback.
          await new Promise((resolve) => setTimeout(resolve, 700));
          await onPurchased();
        } else {
          setError(status === "pending"
            ? "Платёж обрабатывается. Проверь баланс через несколько секунд."
            : "Оплата не завершена. Игровой баланс не пополнен.");
          setBusy(false);
        }
      } catch (invErr: any) {
        setError("Не удалось открыть счёт в Telegram. Попробуй снова.");
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

        <p className="topup-bonus">ПЕРВОЕ ПОПОЛНЕНИЕ <b>+50%</b></p>
        <label className="custom-topup">СКОЛЬКО ЗВЁЗД ПОПОЛНИТЬ?<input type="number" inputMode="numeric" min="50" max="100000" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="От 50" aria-label="Количество Telegram Stars для оплаты" /></label>
        <p className="topup-summary">При первом пополнении начисляется <b>+50% игровых ⭐</b>.</p>
        <button className="btn topup-submit" disabled={busy} onClick={() => void buy()}>{busy ? "ОТКРЫВАЕМ ОПЛАТУ…" : "ПОПОЛНИТЬ →"}</button>

        <div className="external-stars">
          <span>КУПИТЬ ЗВЁЗДЫ TELEGRAM ДЁШЕВО</span>
          <button type="button" onClick={() => { try { WebApp.openLink(STARS_LINK); } catch { window.open(STARS_LINK, "_blank", "noopener,noreferrer"); } }}>ТУТ ↗</button>
          <small>Покупка по этой ссылке не пополняет игровой баланс ErrorDrop. Для пополнения игры используй кнопку выше.</small>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <button className="btn btn--ghost" disabled={busy} onClick={onClose}>
          {busy ? "Обработка..." : "Закрыть"}
        </button>
      </div>
    </div>
  );
}

