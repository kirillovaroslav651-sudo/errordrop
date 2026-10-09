import { useState } from "react";
import { api } from "../lib/api";
import { GameId } from "./GamePicker";

const QUICK = [10, 25, 50, 100];

type Props = {
  balance: number;
  game: GameId;
  onBalanceChanged: (balance: number) => void;
};

// Награды кейса по редкости (для визуализации)
const RARITY_META: Record<string, { color: string; glow: string }> = {
  обычный: { color: "#94a3b8", glow: "none" },
  редкий: { color: "#38bdf8", glow: "0 0 20px rgba(56,189,248,.7)" },
  эпический: { color: "#a78bfa", glow: "0 0 28px rgba(167,139,250,.9)" },
  легендарный: { color: "#fbbf24", glow: "0 0 40px rgba(251,191,36,1)" },
};

export default function GameBoard({ balance, game, onBalanceChanged }: Props) {
  const [amount, setAmount] = useState<string>("25");
  const [choice, setChoice] = useState<string>("heads");
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<{ won: boolean; delta: number; outcome?: string; multiplier?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const num = parseInt(amount, 10) || 0;
  const isCase = game === "case";

  const play = async () => {
    if (spinning) return;
    if (game === "coin" && !choice) { setError("Выбери орёл или решку"); return; }

    if (num <= 0) { setError("Введи ставку больше 0"); return; }
    if (num > balance) { setError("Не хватает звёзд"); return; }

    setSpinning(true);
    setResult(null);
    setError(null);

    try {
      const betId = typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : "" + Date.now() + Math.random().toString(16).slice(2);
      const [res] = await Promise.all([
        api.bet(num, betId, game, isCase ? undefined : choice),
        new Promise((r) => setTimeout(r, isCase ? 900 : 1400)), // кейс быстрее, рулетка дольше крутится
      ]);

      setResult(res);
      onBalanceChanged(res.balance);
    } catch (e: any) {
      setError(e.message || "Ошибка ставки");
    } finally {
      setSpinning(false);
    }
  };

  const meta = result?.outcome ? RARITY_META[result.outcome] : null;

  return (
    <section className="roulette">
      {/* Игровое поле: колесо или кейс */}
      {isCase ? (
        <div className={`case ${spinning ? "case--shaking" : ""} ${result ? (result.delta > 0 ? "case--won" : "case--lost") : ""}`}>
          <div className="case-box">📦</div>
          {result && (
            <div
              className="case-reward"
              style={{
                color: meta?.color,
                textShadow: meta?.glow !== "none" ? meta?.glow : undefined,
              }}
            >
              ×{result.multiplier ?? 0}
            </div>
          )}
        </div>
      ) : (
        <div className={`wheel ${result ? (result.won ? "wheel--win" : "wheel--lose") : ""} ${spinning ? "wheel--spinning" : ""}`}>
          <div className="pointer">⬆️</div>
          <div className="label">{game === "roulette" ? "🎰 ×2" : "🪙"}</div>
        </div>
      )}

      {/* Результат */}
      <div className={`reveal ${result ? (result.delta > 0 ? "reveal--win" : "reveal--lose") : ""}`}>
        {result
          ? result.delta > 0
            ? `🎉 Выигрыш +${result.delta}${result.outcome ? ` (${result.outcome})` : ""}!`
            : result.delta === 0
              ? `😐 Ничего не выпало (${result.outcome})`
              : `💔 Проигрыш −${Math.abs(result.delta)}`
          : isCase ? "Открывай кейс и получай награду!" : "Сделай ставку!"}
      </div>

      {/* Выбор для монетки */}
      {game === "coin" && (
        <div className="quick-row">
          {[{ id: "heads", label: "🦅 Орёл" }, { id: "tails", label: "🪙 Решка" }].map((o) => (
            <button key={o.id} className={`quick ${choice === o.id ? "quick--active" : ""}`} onClick={() => setChoice(o.id)}>
              {o.label}
            </button>
          ))}
        </div>
      )}

      {/* Инфо о кейсе */}
      {isCase && (
        <p className="referral-note">
          Шансы: 50% обычный (×1) · 25% редкий (×2) · 18% эпический (×4) · 7% легендарный (×10)
        </p>
      )}

      {/* Быстрые ставки */}
      <div className="quick-row">
        {QUICK.map((q) => (
          <button key={q} className={`quick ${num === q ? "quick--active" : ""}`} onClick={() => { setAmount(String(q)); setError(null); }}>
            {q}
          </button>
        ))}
      </div>

      {/* Ввод ставки */}
      <div className="bet-input-wrap">
        <span className="star">⭐</span>
        <input className="bet-input" type="number" inputMode="numeric" min={1} max={balance} value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button className="btn btn--ghost" onClick={() => { setAmount(String(Math.max(0, balance))); setError(null); }}>
          All-in
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <button className="btn btn--block btn--r" onClick={play} disabled={spinning}>
        {spinning ? (isCase ? "Открываем..." : "Крутим...") : isCase ? "📦 Открыть кейс" : "▶ Играть"}
      </button>
    </section>
  );
}