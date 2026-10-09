export type GameId = "roulette" | "coin" | "case";

export const GAMES: { id: GameId; name: string; emoji: string; desc: string }[] = [
  { id: "roulette", name: "Рулетка", emoji: "🎰", desc: "50/50 ×2" },
  { id: "coin", name: "Монетка", emoji: "🪙", desc: "Орёл/Решка ×2" },
  { id: "case", name: "Кейсы", emoji: "📦", desc: "Награды ×10" },
];

type Props = {
  game: GameId;
  onSelect: (g: GameId) => void;
};

export default function GamePicker({ game, onSelect }: Props) {
  return (
    <div className="game-picker">
      {GAMES.map((g) => (
        <button
          key={g.id}
          className={`game-tab ${game === g.id ? "game-tab--active" : ""}`}
          onClick={() => onSelect(g.id)}
        >
          <span className="game-tab-emoji">{g.emoji}</span>
          <span>{g.name}</span>
        </button>
      ))}
    </div>
  );
}