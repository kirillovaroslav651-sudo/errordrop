import { useCallback, useEffect, useState } from "react";
import { api, getTgUser, MeData } from "./lib/api";
import BuyModal from "./components/BuyModal";
import History from "./components/History";
import InviteCard from "./components/InviteCard";

type Tab = "cases" | "pass" | "friends" | "inventory" | "admin";
const odds = [
  { icon: "⭐", title: "Обычный", chance: "50%", multiplier: "×1", rarity: "common" },
  { icon: "💫", title: "Редкий", chance: "25%", multiplier: "×2", rarity: "rare" },
  { icon: "💎", title: "Эпический", chance: "18%", multiplier: "×4", rarity: "epic" },
  { icon: "👑", title: "Легендарный", chance: "7%", multiplier: "×10", rarity: "legendary" },
];
const cases = [
  { name: "Искра", icon: "🔥", price: 25, className: "spark", detail: "Разожги удачу" },
  { name: "Красный шум", icon: "🎁", price: 50, className: "noise", detail: "Время удивляться" },
  { name: "Баг системы", icon: "⚡", price: 100, className: "glitch", detail: "Редкий дроп" },
  { name: "Легенда", icon: "👑", price: 250, className: "legend", detail: "Для смелых" },
];

export default function App() {
  const [me, setMe] = useState<MeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("cases");
  const [buyOpen, setBuyOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const [reward, setReward] = useState("");
  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState("100");
  const [selectedCase, setSelectedCase] = useState<(typeof cases)[number] | null>(null);
  const user = getTgUser();

  const reload = useCallback(async () => {
    try { setMe(await api.me()); setError(""); }
    catch (e: any) { setError(e.message || "Ошибка загрузки"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  async function openCase(price: number, name: string) {
    if (opening) return;
    if (!me || me.user.balance < price) { setBuyOpen(true); return; }
    setOpening(true); setReward(""); setError("");
    try {
      const betId = crypto.randomUUID();
      const result = await api.bet(price, betId, "case");
      await reload();
      setReward(`${name}: ${result.delta >= 0 ? "+" : ""}${result.delta} ⭐ · ${result.outcome || "награда"}`);
    } catch (e: any) { setError(e.message || "Не удалось открыть кейс"); }
    finally { setOpening(false); }
  }

  async function claimDaily() {
    try { const result = await api.dailyBonus(); await reload(); setReward(result.granted ? `Ежедневный бонус: +${result.bonus} ⭐` : "Бонус уже получен сегодня"); }
    catch (e: any) { setError(e.message || "Ошибка"); }
  }

  async function grant() {
    const n = Number(amount), id = target ? Number(target) : undefined;
    if (!Number.isSafeInteger(n) || n <= 0 || n > 100000 || (target && (!Number.isSafeInteger(id) || !id || id <= 0))) { setError("Проверь ID и количество"); return; }
    try { await api.adminCredit(n, id); await reload(); setReward(`Начислено ${n} игровых ⭐`); }
    catch (e: any) { setError(e.message || "Ошибка начисления"); }
  }

  if (loading) return <main className="app loading">Загрузка ErrorDrop…</main>;
  if (!me) return <main className="app loading"><img width="92" src="/errordrop-avatar.png" alt="ErrorDrop" /><h2>ErrorDrop</h2><p>Открой приложение через кнопку «Играть» в @ErrorDrop_Bot.</p><p className="error-banner">{error}</p></main>;

  return <div className="app">
    <header className="header"><div className="brand"><img src="/errordrop-avatar.png" alt="Логотип ErrorDrop" /><div><strong>ERROR<span>DROP</span></strong><small>THE RED SIDE OF LUCK</small></div></div><span className="online-dot">LIVE</span></header>
    <div className="profile"><div className="profile-avatar">{(user?.first_name || user?.username || "E")[0].toUpperCase()}</div><div className="profile-name"><b>{user?.username ? `@${user.username}` : user?.first_name || "Игрок"}</b><small>ID {me.user.telegramId}</small></div><div className="balance"><b>{me.user.balance.toLocaleString("ru-RU")} ⭐</b><button aria-label="Пополнить" onClick={() => setBuyOpen(true)}>＋</button></div></div>
    <main>
      {tab === "cases" && <><div className="section-intro"><div className="eyebrow">ДРОП ДНЯ · 01</div><h1>ТВОЯ УДАЧА<br /><em>НА ГРАНИ.</em></h1><p>Выбирай кейс. Сначала посмотри все возможные награды и шансы.</p></div><div className="section-line"><h2>КЕЙСЫ</h2><span>01 / 04</span></div><div className="case-grid">{cases.map(c => <article className="case-tile" key={c.name}><div className={`case-visual ${c.className}`}><div className="case-halo"/><span>{c.icon}</span><i>ED / 0{cases.indexOf(c)+1}</i></div><div className="case-info"><h3>{c.name}</h3><small>{c.detail}</small><button onClick={() => setSelectedCase(c)}>НАГРАДЫ · {c.price} ⭐ →</button></div></article>)}</div><div className="notice">✦ Награды здесь — игровые звёзды на балансе приложения. Telegram NFT-подарки и вывод звёзд пока не подключены.</div></>}
      {tab === "pass" && <><div className="section-intro"><div className="eyebrow">ЕЖЕДНЕВНЫЙ БОНУС</div><h1>ТВОЙ<br /><em>ПРОПУСК.</em></h1><p>Заглядывай каждый день — прогресс сохраняется в аккаунте.</p></div><div className="daily-card"><div className="daily-icon">🎁</div><small>НАГРАДА 01</small><h2>+5 ⭐</h2><p>Бесплатный ежедневный бонус</p><button className="primary" disabled={!me.user.dailyBonusReady} onClick={claimDaily}>{me.user.dailyBonusReady ? "ЗАБРАТЬ НАГРАДУ" : "СЕГОДНЯ УЖЕ ПОЛУЧЕНО"}</button></div><History transactions={me.transactions}/></>}
      {tab === "friends" && <><div className="section-intro"><div className="eyebrow">ERRORDROP / КОМАНДА</div><h1>ДРУЗЬЯ<br /><em>И НАГРАДЫ.</em></h1><p>Приглашай друзей и получай бонус за их пополнения.</p></div><div className="friend-stats"><div><b>{me.user.referralCount}</b><small>ДРУЗЕЙ</small></div><div><b>10%</b><small>БОНУС</small></div><div><b>∞</b><small>ПОТЕНЦИАЛ</small></div></div><InviteCard refCode={me.user.refCode} referralCount={me.user.referralCount} bonusPerInvite={10}/></>}
      {tab === "inventory" && <><div className="section-intro"><div className="eyebrow">ТВОЯ КОЛЛЕКЦИЯ</div><h1>ИНВЕНТАРЬ<span className="red-dot">.</span></h1><p>Здесь будут появляться предметы из кейсов.</p></div><div className="empty"><div>◇</div><h2>ПОКА ПУСТО</h2><p>Открой первый кейс — игровые звёзды появятся на балансе.</p><button onClick={() => setTab("cases")}>К КЕЙСАМ →</button></div><History transactions={me.transactions}/></>}
      {tab === "admin" && me.user.isAdmin && <section className="admin admin-page"><div className="eyebrow">ДОСТУП ВЛАДЕЛЬЦА · ID {me.user.telegramId}</div><h1>АДМИН<span className="red-dot">.</span></h1><p>Выдача игровых звёзд — не настоящих Telegram Stars. Пустой ID начисляет тебе; для другого пользователя укажи его цифровой Telegram ID.</p><div className="admin-fields"><label>Telegram ID<input inputMode="numeric" placeholder="Пусто — себе" value={target} onChange={e=>setTarget(e.target.value)}/></label><label>Количество<input inputMode="numeric" placeholder="До 100 000" value={amount} onChange={e=>setAmount(e.target.value)}/></label></div><button className="primary" onClick={grant}>НАЧИСЛИТЬ ⭐</button><div className="admin-hint">Проверка прав выполняется на сервере. Пользователю не нужно заранее запускать бота для начисления.</div></section>}
      {error && <div className="error-banner" role="alert">{error}</div>}
      {reward && <div className="reward" role="status" onClick={()=>setReward("")}>✦ {reward} <span>×</span></div>}
    </main>
    <nav className="bottom-nav" aria-label="Разделы">{([ ["pass","▤","Пропуск"],["cases","⬡","Кейсы"],["friends","♧","Друзья"],["inventory","▣","Инвентарь"],...(me.user.isAdmin ? [["admin","✦","Админ"]] : [])] as [Tab,string,string][]).map(([id,icon,label]) => <button key={id} className={tab===id?"active":""} onClick={()=>{setTab(id);window.scrollTo(0,0)}}><span>{icon}</span><small>{label}</small></button>)}</nav>
    {selectedCase && <div className="case-overlay" onClick={() => setSelectedCase(null)}><div className="case-sheet" role="dialog" aria-modal="true" aria-label={`Награды кейса ${selectedCase.name}`} onClick={e=>e.stopPropagation()}><div className="sheet-top"><span>ERRORDROP / DROP TABLE</span><button onClick={()=>setSelectedCase(null)} aria-label="Закрыть">×</button></div><div className={`sheet-hero ${selectedCase.className}`}><span>{selectedCase.icon}</span></div><h2>{selectedCase.name}</h2><p>ВОЗМОЖНЫЕ НАГРАДЫ</p><div className="odds-grid">{odds.map(o=><div className={`odds-card ${o.rarity}`} key={o.title}><span>{o.icon}</span><strong>{o.title}</strong><small>{o.multiplier} · {Math.round(selectedCase.price*Number(o.multiplier.slice(1)))} игровых ⭐</small><b>{o.chance}</b></div>)}</div><div className="odds-note">Шансы фиксированы на сервере: 50% / 25% / 18% / 7%. ×1 возвращает стоимость кейса. Это игровые звёзды, не Telegram NFT.</div><button className="primary" disabled={opening} onClick={async()=>{await openCase(selectedCase.price,selectedCase.name);setSelectedCase(null)}}>{opening ? "ОТКРЫВАЕМ…" : `ОТКРЫТЬ ЗА ${selectedCase.price} ⭐`}</button></div></div>}
    {buyOpen && <BuyModal onClose={()=>setBuyOpen(false)} onPurchased={async()=>{setBuyOpen(false);await reload()}}/>}
  </div>;
}
