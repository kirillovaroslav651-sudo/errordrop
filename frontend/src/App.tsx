import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import WebApp from "@twa-dev/sdk";
import { api, getTgUser, MeData } from "./lib/api";
import BuyModal from "./components/BuyModal";
import History from "./components/History";
import giftCatalog from "./giftCatalog.json";

type Tab = "cases" | "pass" | "catalog" | "profile" | "admin";
type Gift = { id: string; name: string; image: string; url: string; price: string; currency: string; supply: string };
const gifts: Gift[] = giftCatalog;
const cases = [
  { name: "Искра", price: 49, cover: "berry-box", code: "01", subtitle: "ПЕРВАЯ ОШИБКА", tone: "scarlet" },
  { name: "REDLINE", price: 149, cover: "astral-shard", code: "02", subtitle: "НА ПРЕДЕЛЕ", tone: "orange" },
  { name: "ГЛИТЧ", price: 249, cover: "bear-terrorist", code: "03", subtitle: "ВЫХОДА НЕТ", tone: "ruby" },
  { name: "Пульс", price: 499, cover: "bling-binky", code: "04", subtitle: "УЛЬТРА ДРОП", tone: "gold" },
  { name: "BLACKOUT", price: 999, cover: "bonded-ring", code: "05", subtitle: "ПОСЛЕДНИЙ УРОВЕНЬ", tone: "violet" },
];
const odds = [
  { name: "Обычный", chance: 50, mult: 1, color: "common", icon: "✦" },
  { name: "Редкий", chance: 25, mult: 2, color: "rare", icon: "✧" },
  { name: "Эпический", chance: 18, mult: 4, color: "epic", icon: "◆" },
  { name: "Легендарный", chance: 7, mult: 10, color: "legend", icon: "✺" },
];
const findGift = (id: string) => gifts.find(g => g.id === id);
const caseCover = (id: string) => findGift(id)?.image || "/errordrop-avatar.png";
const priceText = (g: Gift) => g.price === "Pre-market" ? "Pre-market" : `${g.price} ${g.currency || "TON"}`;
const demo = import.meta.env.DEV && new URLSearchParams(location.search).has("preview");
const demoMe: MeData = {
  user: { telegramId: 5009533742, username: "errordrop", balance: 2460, refCode: "f00dbabe", isAdmin: true, referralCount: 8, dailyBonusReady: true },
  transactions: [], gallery: [],
};

export default function App() {
  const [me, setMe] = useState<MeData | null>(demo ? demoMe : null);
  const [loading, setLoading] = useState(!demo);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("cases");
  const [caseIndex, setCaseIndex] = useState(2);
  const [buyOpen, setBuyOpen] = useState(false);
  const [prizesOpen, setPrizesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [result, setResult] = useState<{ delta: number; outcome: string; name: string } | null>(null);
  const [opening, setOpening] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(36);
  const [filter, setFilter] = useState("Все");
  const [addMode, setAddMode] = useState(false);
  const [haptics, setHaptics] = useState(localStorage.getItem("ed-haptics") !== "off");
  const [lessMotion, setLessMotion] = useState(localStorage.getItem("ed-motion") === "less");
  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState("100");
  const [toast, setToast] = useState("");
  const swipeY = useRef<number | null>(null);
  const user = getTgUser();
  const selected = cases[caseIndex];
  const currentGifts = useMemo(() => gifts.filter(g => {
    const matches = `${g.name} ${g.price}`.toLowerCase().includes(query.trim().toLowerCase());
    if (filter === "Все") return matches;
    if (filter === "Pre-market") return matches && g.price === "Pre-market";
    if (filter === "TON") return matches && g.currency === "TON" && g.price !== "Pre-market";
    return matches && g.currency === "⭐";
  }), [query, filter]);
  const gallery = me?.gallery || [];
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 3600); };
  const feel = (kind: "light" | "medium" | "heavy" = "light") => {
    if (!haptics) return;
    try { WebApp.HapticFeedback.impactOccurred(kind); } catch { /* browser preview */ }
  };
  const reload = useCallback(async () => {
    if (demo) return;
    try { setMe(await api.me()); setError(""); }
    catch (e: any) { setError(e.message || "Не удалось загрузить профиль"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") { setSettingsOpen(false); setPrizesOpen(false); setBuyOpen(false); setResult(null); } };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  const navigate = (next: Tab) => { feel(); setTab(next); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const shiftCase = (step: number) => { feel(); setCaseIndex(i => (i + step + cases.length) % cases.length); };

  async function openCase() {
    if (!me || opening) return;
    if (me.user.balance < selected.price) { setBuyOpen(true); return; }
    feel("heavy"); setOpening(true); setError("");
    try {
      if (demo) {
        await new Promise(r => setTimeout(r, 1100));
        const delta = selected.price;
        setMe(m => m ? { ...m, user: { ...m.user, balance: m.user.balance + delta } } : m);
        setResult({ delta, outcome: "редкий", name: selected.name });
      } else {
        const data = await api.bet(selected.price, crypto.randomUUID(), "case");
        await new Promise(r => setTimeout(r, 850));
        await reload();
        setResult({ delta: data.delta, outcome: data.outcome || "обычный", name: selected.name });
      }
      try { WebApp.HapticFeedback.notificationOccurred("success"); } catch { /* browser preview */ }
    } catch (e: any) { setError(e.message || "Не удалось открыть кейс"); feel("medium"); }
    finally { setOpening(false); }
  }
  async function claimDaily() {
    feel("medium");
    try {
      if (demo) { setMe(m => m ? { ...m, user: { ...m.user, balance: m.user.balance + 5, dailyBonusReady: false } } : m); notify("+5 игровых ⭐ на балансе"); return; }
      const data = await api.dailyBonus(); await reload(); notify(data.granted ? `+${data.bonus} игровых ⭐` : "Бонус уже получен сегодня");
    } catch (e: any) { setError(e.message || "Не удалось получить бонус"); }
  }
  async function saveGift(gift: Gift) {
    feel();
    try {
      const already = gallery.includes(gift.id);
      if (demo) setMe(m => m ? { ...m, gallery: already ? m.gallery.filter(id => id !== gift.id) : [...m.gallery, gift.id] } : m);
      else { const data = already ? await api.removeGallery(gift.id) : await api.addGallery(gift.id); setMe(m => m ? { ...m, gallery: data.gallery } : m); }
      notify(already ? "Убрано из витрины" : "Добавлено в вашу витрину");
    } catch (e: any) { setError(e.message || "Не удалось сохранить подарок"); }
  }
  async function grant() {
    const n = Number(amount), id = target.trim() ? Number(target.trim()) : undefined;
    if (!Number.isSafeInteger(n) || n <= 0 || n > 100000 || (target.trim() && (!Number.isSafeInteger(id) || !id || id <= 0))) { setError("Проверь ID и количество (1–100 000)"); return; }
    try {
      if (demo) { if (!id || id === me?.user.telegramId) setMe(m => m ? { ...m, user: { ...m.user, balance: m.user.balance + n } } : m); }
      else { await api.adminCredit(n, id); await reload(); }
      feel("medium"); notify(`Начислено ${n} игровых ⭐ · ID ${id || me?.user.telegramId}`);
    } catch (e: any) { setError(e.message || "Ошибка начисления"); }
  }
  async function invite() {
    if (!me) return;
    const link = `https://t.me/ErrorDrop_Bot?start=ref_${me.user.refCode}`;
    feel();
    try { WebApp.openTelegramLink(link); }
    catch { try { await navigator.clipboard.writeText(link); notify("Ссылка скопирована"); } catch { notify(link); } }
  }

  if (loading) return <div className="boot"><img src="/errordrop-avatar.png" alt=""/><b>ERROR<span>DROP</span></b><p>Загрузка...</p></div>;
  if (!me) return <div className="boot"><img src="/errordrop-avatar.png" alt=""/><b>ERROR<span>DROP</span></b><p>Открой игру через @ErrorDrop_Bot → «Играть».</p><p className="notice-error">{error}</p></div>;

  return <div className={`app ${lessMotion ? "reduce-effects" : ""}`}>
    <div className="ambient ambient-one"/><div className="ambient ambient-two"/>
    <header className="topbar">
      <button className="logo-button" onClick={() => navigate("cases")} aria-label="ErrorDrop, на главную"><img src="/errordrop-avatar.png" alt=""/><span><b>ERROR<i>DROP</i></b><small>THE RED SIDE OF LUCK</small></span></button>
      <button className="top-profile" onClick={() => navigate("profile")}>{user?.username ? `@${user.username}` : user?.first_name || "Профиль"}<span>↗</span></button>
    </header>
    <div className="wallet-bar"><div className="avatar" onClick={() => navigate("profile")}>{(user?.first_name || user?.username || "E")[0].toUpperCase()}</div><div className="wallet-person"><b>{user?.first_name || user?.username || "Игрок"}</b><small>ID {me.user.telegramId}</small></div><div className="wallet-balance"><b>{me.user.balance.toLocaleString("ru-RU")}</b><span>⭐</span></div><button className="wallet-plus" onClick={() => { feel(); setBuyOpen(true); }} aria-label="Пополнить баланс">+</button></div>
    <main className="screen" key={tab}>
      {tab === "cases" && <>
        <div className="screen-kicker"><span className="red-line"/> ERRORDROP / CASE ROOM <span className="season">СЕЗОН 01</span></div>
        <h1 className="main-title">ТВОЙ ДРОП.<br/><em>ТВОИ ПРАВИЛА.</em></h1>
        <div className="live-heading"><span className="live-pill"><i/>LIVE</span><span>ВИТРИНА ПОДАРКОВ</span><small>не трансляция выигрышей</small></div>
        <div className="live-strip" aria-label="Горизонтальная витрина подарков">{gifts.slice(0,18).map(g => <button className="live-item" key={g.id} onClick={() => { setQuery(g.name); navigate("catalog"); }}><img src={g.image} loading="lazy" alt=""/><span>{g.name}</span></button>)}</div>
        <div className="carousel-heading"><div><small>ВЫБЕРИ КЕЙС</small><b>{selected.code} <span>/ 0{cases.length}</span></b></div><span className="carousel-rule"/><span className="carousel-mark">◈</span></div>
        <section className="carousel" aria-label="Карусель кейсов" onTouchStart={e => swipeY.current = e.touches[0].clientY} onTouchEnd={e => { if (swipeY.current !== null) { const delta=e.changedTouches[0].clientY-swipeY.current; if (Math.abs(delta)>45) shiftCase(delta<0?1:-1); swipeY.current=null; } }}>
          <button className="carousel-arrow arrow-top" onClick={() => shiftCase(-1)} aria-label="Предыдущий кейс">⌃</button>
          <div className="carousel-stage">
            {[-1,0,1].map(offset => { const c=cases[(caseIndex+offset+cases.length)%cases.length]; return <button key={`${c.code}-${offset}`} className={`carousel-card position-${offset === -1 ? "left" : offset === 1 ? "right" : "center"} ${c.tone} ${opening && offset===0 ? "is-opening" : ""}`} onClick={() => offset && shiftCase(offset)} aria-label={`${c.name}, ${c.price} игровых звёзд`} aria-current={offset===0 ? "true" : undefined}><div className="card-top"><span>ERRORDROP</span><span>ED—{c.code}</span></div><div className="case-glow"/><img src={caseCover(c.cover)} alt=""/><div className="case-title"><small>{c.subtitle}</small><b>{c.name}</b></div><div className="case-bottom"><span>✦</span><span>DROP / 2026</span></div></button>; })}
          </div>
          <button className="carousel-arrow arrow-bottom" onClick={() => shiftCase(1)} aria-label="Следующий кейс">⌄</button>
        </section>
        <div className="case-meta"><span>{selected.subtitle}</span><h2>{selected.name}</h2><div><span className="gold-star">★</span> {selected.price} <small>игровых ⭐</small></div></div>
        <div className="case-actions"><button onClick={() => { feel(); setSettingsOpen(true); }}>⚙ <span>Настройки</span></button><button onClick={() => { feel(); setPrizesOpen(true); }}>◇ <span>Призы</span></button></div>
        <button className="spin-cta" onClick={openCase} disabled={opening}>{opening ? "ОТКРЫВАЕМ КЕЙС…" : <>КРУТИТЬ ЗА <span>★ {selected.price}</span></>}<i>→</i></button>
        <p className="fineprint">Результат определяется сервером. Награда — игровые ⭐; изображения подарков — витрина, не NFT-призы.</p>
      </>}
      {tab === "pass" && <><div className="screen-kicker"><span className="red-line"/> DAILY / 01</div><h1 className="main-title">ВОЗВРАЩАЙСЯ.<br/><em>ЗАБИРАЙ СВОЁ.</em></h1><div className="pass-hero"><span>01 / ЕЖЕДНЕВНЫЙ БОНУС</span><div className="pass-gift">✦</div><b>+5 <i>★</i></b><p>Бесплатные игровые звёзды каждый день. Прогресс хранится в твоём аккаунте.</p><button className="spin-cta" disabled={!me.user.dailyBonusReady} onClick={claimDaily}>{me.user.dailyBonusReady ? "ЗАБРАТЬ НАГРАДУ →" : "УЖЕ ПОЛУЧЕНО СЕГОДНЯ"}</button></div><section className="panel history-panel"><h2>ИСТОРИЯ</h2><History transactions={me.transactions}/></section></>}
      {tab === "catalog" && <><div className="screen-kicker"><span className="red-line"/> GIFT INDEX / {gifts.length}</div><h1 className="main-title">МИР ПОДАРКОВ.<br/><em>ОДИН КАТАЛОГ.</em></h1><p className="catalog-intro">Все {gifts.length} коллекций, найденных в каталоге Telegifter. Иллюстрации и цены — справочная витрина, не призы и не подтверждение владения.</p><div className="catalog-tools"><input type="search" placeholder="Поиск подарка..." aria-label="Поиск подарка" value={query} onChange={e=>{setQuery(e.target.value);setLimit(36)}}/><span>{currentGifts.length} шт.</span></div><div className="chips">{["Все","TON","⭐","Pre-market"].map(f=><button key={f} className={filter===f?"active":""} onClick={()=>{feel();setFilter(f);setLimit(36)}}>{f}</button>)}</div><div className="gift-grid">{currentGifts.slice(0,limit).map(g=><article className="gift-tile" key={g.id}><div className="gift-art"><img src={g.image} loading="lazy" alt={g.name}/><span>GIFT / {g.id.slice(0,3).toUpperCase()}</span></div><div className="gift-details"><b>{g.name}</b><small>{priceText(g)}</small><div><button onClick={()=>void saveGift(g)} aria-label={gallery.includes(g.id)?`Убрать ${g.name} из витрины`:`Добавить ${g.name} в витрину`}>{gallery.includes(g.id)?"♥ В витрине":"＋ В витрину"}</button><a href={g.url} target="_blank" rel="noopener noreferrer" aria-label={`Источник цены ${g.name}`}>↗</a></div></div></article>)}</div>{currentGifts.length>limit && <button className="load-more" onClick={()=>setLimit(n=>n+36)}>ПОКАЗАТЬ ЕЩЁ ↓</button>}<p className="source-note">Источник изображений и справочных цен: Telegifter. Снимок каталога: 10 октября 2026. Цены могут измениться; уточняй их у источника.</p></>}
      {tab === "profile" && <><div className="screen-kicker"><span className="red-line"/> МОЙ ПРОФИЛЬ / {me.user.telegramId}</div><h1 className="main-title">ТВОЯ ТЕРРИТОРИЯ<span className="red-dot">.</span></h1><section className="profile-banner panel"><div className="large-avatar">{(user?.first_name || user?.username || "E")[0].toUpperCase()}</div><div><small>ИГРОК ERRORDROP</small><h2>{user?.first_name || user?.username || "Игрок"}</h2><span>ID {me.user.telegramId}</span></div><div className="profile-balance">★ {me.user.balance.toLocaleString("ru-RU")}</div></section><section className="invite-panel panel"><span className="panel-label">01 / КОМАНДА</span><div className="invite-art">♧</div><h2>ПРИГЛАШАЙ <em>ДРУЗЕЙ.</em></h2><p>Делись ссылкой и получай 10% игровых ⭐ от пополнений друзей.</p><div className="profile-stats"><span><b>{me.user.referralCount}</b> друзей</span><span><b>10%</b> бонус</span></div><button className="invite-btn" onClick={invite}>＋ ПРИГЛАСИТЬ ДРУГА <span>↗</span></button></section><section className="owned-panel panel"><div className="panel-title"><div><small>02 / МОЯ ВИТРИНА</small><h2>ВАШИ ПОДАРКИ</h2></div><b>{gallery.length}/24</b></div>{!gallery.length ? <div className="gift-empty"><span>◇</span><strong>ЗДЕСЬ ПОКА ПУСТО</strong><p>Добавь понравившиеся изображения в свою личную витрину. Это не реальное владение NFT.</p><button onClick={()=>{setAddMode(true);navigate("catalog")}}>＋ Добавить подарок</button></div> : <><div className="saved-grid">{gallery.map(id=>findGift(id)).filter((g):g is Gift=>Boolean(g)).map(g=><div className="saved-item" key={g.id}><img src={g.image} alt={g.name}/><b>{g.name}</b><button onClick={()=>void saveGift(g)} aria-label={`Убрать ${g.name}`}>×</button></div>)}</div><button className="outline-btn" onClick={()=>{setAddMode(true);navigate("catalog")}}>＋ ДОБАВИТЬ ЕЩЁ</button></>}<p className="ownership-note">Личная подборка для просмотра. Она не подтверждает наличие Telegram NFT.</p></section><section className="panel history-panel"><h2>ИСТОРИЯ ИГР</h2><History transactions={me.transactions}/></section></>}
      {tab === "admin" && me.user.isAdmin && <><div className="screen-kicker"><span className="red-line"/> ACCESS LEVEL / OWNER</div><h1 className="main-title">ПАНЕЛЬ<br/><em>ВЛАДЕЛЬЦА.</em></h1><section className="admin-panel panel"><span className="panel-label">ID {me.user.telegramId}</span><h2>НАЧИСЛЕНИЕ</h2><p>Выдаются игровые ⭐ на внутреннем балансе, не настоящие Telegram Stars. Пустой ID — начислить себе.</p><label>TELEGRAM ID ПОЛУЧАТЕЛЯ<input inputMode="numeric" placeholder="Пусто — себе" value={target} onChange={e=>setTarget(e.target.value)}/></label><label>КОЛИЧЕСТВО ИГРОВЫХ ⭐<input inputMode="numeric" placeholder="От 1 до 100 000" value={amount} onChange={e=>setAmount(e.target.value)}/></label><button className="spin-cta" onClick={grant}>НАЧИСЛИТЬ ЗВЁЗДЫ →</button><small>Доступ проверяется сервером по Telegram ID владельца.</small></section></>}
    </main>
    <nav className="bottom-nav" aria-label="Разделы">{([ ["cases","⬡","Кейсы"],["pass","▤","Пропуск"],["catalog","◈","Подарки"],["profile","♧","Профиль"],...(me.user.isAdmin ? [["admin","✦","Админ"]] : [])] as [Tab,string,string][]).map(([id,icon,label])=><button key={id} className={tab===id?"active":""} onClick={()=>navigate(id)}><span>{icon}</span><small>{label}</small><i/></button>)}</nav>
    {tab==="catalog" && addMode && <div className="floating-back"><button onClick={()=>{setAddMode(false);navigate("profile")}}>← Вернуться в профиль</button></div>}
    {error && <div className="toast error-toast" role="alert" onClick={()=>setError("")}>{error} <span>×</span></div>}{toast && <div className="toast" role="status" onClick={()=>setToast("")}>{toast} <span>×</span></div>}
    {settingsOpen && <div className="modal-scrim" onClick={()=>setSettingsOpen(false)}><section className="modal-sheet" role="dialog" aria-modal="true" aria-label="Настройки" onClick={e=>e.stopPropagation()}><div className="modal-top"><small>ERRORDROP / SETTINGS</small><button onClick={()=>setSettingsOpen(false)}>×</button></div><h2>НАСТРОЙКИ</h2><label className="toggle-row">Тактильный отклик<input type="checkbox" checked={haptics} onChange={e=>{setHaptics(e.target.checked);localStorage.setItem("ed-haptics",e.target.checked?"on":"off")}}/></label><label className="toggle-row">Меньше анимаций<input type="checkbox" checked={lessMotion} onChange={e=>{setLessMotion(e.target.checked);localStorage.setItem("ed-motion",e.target.checked?"less":"full")}}/></label><p className="modal-note">Haptic работает в поддерживаемых клиентах Telegram.</p></section></div>}
    {prizesOpen && <div className="modal-scrim" onClick={()=>setPrizesOpen(false)}><section className="modal-sheet prizes-sheet" role="dialog" aria-modal="true" aria-label="Призы кейса" onClick={e=>e.stopPropagation()}><div className="modal-top"><small>ERRORDROP / CASE {selected.code}</small><button onClick={()=>setPrizesOpen(false)}>×</button></div><h2>ЧТО ВЫПАДАЕТ?</h2><p className="modal-note">Из кейса «{selected.name}» выпадают только игровые ⭐. Показаны шансы и начисление после списания цены кейса.</p><div className="odds-list">{odds.map(o=><div className={`odds-row ${o.color}`} key={o.name}><span className="odds-icon">{o.icon}</span><div><b>{o.name}</b><small>×{o.mult} · {selected.price*o.mult} игровых ⭐ · баланс {o.mult===1?"не изменится":`+${selected.price*(o.mult-1)}`}</small></div><strong>{o.chance}%</strong></div>)}</div><div className="showcase-line"><span>ВИТРИНА TELEGRAM GIFTS</span><small>изображения, не дроп</small></div><div className="showcase-scroll">{gifts.slice(4,12).map(g=><div key={g.id}><img src={g.image} alt=""/><b>{g.name}</b><small>{priceText(g)}</small></div>)}</div><button className="outline-btn" onClick={()=>{setPrizesOpen(false);navigate("catalog")}}>СМОТРЕТЬ ВСЕ {gifts.length} ПОДАРКОВ →</button></section></div>}
    {result && <div className="modal-scrim" onClick={()=>setResult(null)}><section className="modal-sheet result-sheet" role="dialog" aria-modal="true" aria-label="Результат кейса" onClick={e=>e.stopPropagation()}><div className="result-symbol">✺</div><small>ERRORDROP / CASE OPENED</small><h2>{result.outcome.toUpperCase()}</h2><p>Кейс «{result.name}»</p><div className="result-amount">{result.delta>=0?"+":""}{result.delta} <span>★</span></div><p className="modal-note">Изменение игрового баланса после открытия. Telegram NFT не выдавался.</p><button className="spin-cta" onClick={()=>setResult(null)}>ПРОДОЛЖИТЬ →</button></section></div>}
    {buyOpen && <BuyModal onClose={()=>setBuyOpen(false)} onPurchased={async()=>{setBuyOpen(false);await reload()}}/>}
  </div>;
}
