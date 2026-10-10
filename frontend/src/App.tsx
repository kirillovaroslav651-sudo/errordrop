import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import WebApp from "@twa-dev/sdk";
import { api, AdminPlayer, CaseResult, getTgUser, InventoryItem, MeData, Withdrawal } from "./lib/api";
import { giftStarValue, giftTier } from "./lib/pricing";
import BuyModal from "./components/BuyModal";
import History from "./components/History";
import giftCatalog from "./giftCatalog.json";
import caseConfig from "./caseConfig.json";

type Tab = "cases" | "pass" | "inventory" | "catalog" | "profile" | "admin";
type Gift = { id: string; name: string; image: string; url: string; price: string; currency: string; supply: string };
type WheelItem = { giftId?: string; stars?: number };
type Wheel = { items: WheelItem[]; result: CaseResult; done: boolean };
const gifts: Gift[] = giftCatalog;
const cases = caseConfig;
const findGift = (id?: string) => gifts.find(g => g.id === id);
const caseCover = (id: string) => findGift(id)?.image || "/errordrop-avatar.png";
const starValue = (g: Gift) => giftStarValue(g.price, g.currency);
const priceText = (g: Gift) => { const n=starValue(g); return n === null ? "Цена не определена" : `≈ ${n.toLocaleString("ru-RU")} игровых ⭐`; };
const poolFor = (code: string) => gifts.filter(g => { const v=starValue(g); return v !== null && giftTier(v) === Number(code); });
const demo = import.meta.env.DEV && new URLSearchParams(location.search).has("preview");
const demoMe: MeData = { user: { telegramId:5009533742,username:"errordrop",balance:2460,refCode:"f00dbabe",isAdmin:true,referralCount:8,dailyBonusReady:true }, transactions:[],gallery:[],inventory:[] };
const delay = (ms:number) => new Promise<void>(resolve=>setTimeout(resolve,ms));

export default function App() {
  const [me,setMe] = useState<MeData|null>(demo ? demoMe : null);
  const [loading,setLoading] = useState(!demo);
  const [error,setError] = useState("");
  const [toast,setToast] = useState("");
  const [tab,setTab] = useState<Tab>("cases");
  const [caseIndex,setCaseIndex] = useState(0);
  const [opening,setOpening] = useState(false);
  const [wheel,setWheel] = useState<Wheel|null>(null);
  const wheelTrack = useRef<HTMLDivElement|null>(null);
  const wheelWindow = useRef<HTMLDivElement|null>(null);
  const swipeY = useRef<number|null>(null);
  const [prizesOpen,setPrizesOpen] = useState(false);
  const [settingsOpen,setSettingsOpen] = useState(false);
  const [buyOpen,setBuyOpen] = useState(false);
  const [haptics,setHaptics] = useState(localStorage.getItem("ed-haptics")!=="off");
  const [lessMotion,setLessMotion] = useState(localStorage.getItem("ed-motion")==="less");
  const [query,setQuery] = useState("");
  const [limit,setLimit] = useState(36);
  const [filter,setFilter] = useState("Все");
  const [target,setTarget] = useState("");
  const [amount,setAmount] = useState("100");
  const [adminQuery,setAdminQuery] = useState("");
  const [players,setPlayers] = useState<AdminPlayer[]>([]);
  const [requests,setRequests] = useState<Withdrawal[]>([]);
  const user = getTgUser();
  const selected = cases[caseIndex];
  const inventory = me?.inventory || [];
  const eligible = useMemo(()=>poolFor(selected.code),[selected.code]);
  const currentGifts = useMemo(()=>gifts.filter(g=>{
    const v=starValue(g);
    const matches=`${g.name} ${v ?? ""}`.toLowerCase().includes(query.trim().toLowerCase());
    if(filter==="Без цены") return matches && v===null;
    if(filter==="До 1 500 ⭐") return matches && v!==null && v<=1500;
    if(filter==="Дорогие") return matches && v!==null && v>15000;
    return matches;
  }),[query,filter]);
  const notify=(message:string)=>{setToast(message);window.setTimeout(()=>setToast(""),3600)};
  const feel=(kind:"light"|"medium"|"heavy"="light")=>{
    if(!haptics)return;
    try{WebApp.HapticFeedback.impactOccurred(kind)}catch{/* browser preview */}
  };
  const reload=useCallback(async()=>{
    if(demo)return;
    try{setMe(await api.me());setError("")}catch(e:any){setError(e.message||"Не удалось загрузить профиль")}
    finally{setLoading(false)}
  },[]);
  useEffect(()=>{void reload()},[reload]);
  useEffect(()=>{
    const close=(e:KeyboardEvent)=>{if(e.key==="Escape"&&!opening){setSettingsOpen(false);setPrizesOpen(false);setBuyOpen(false);setWheel(null)}};
    window.addEventListener("keydown",close);return()=>window.removeEventListener("keydown",close);
  },[opening]);
  const navigate=(next:Tab)=>{feel();setTab(next);window.scrollTo({top:0,behavior:lessMotion?"instant":"smooth"})};
  const shiftCase=(step:number)=>{if(opening)return;feel();setCaseIndex(i=>(i+step+cases.length)%cases.length)};

  async function openCase(){
    if(!me||opening)return;
    if(selected.price===0&&!me.user.dailyBonusReady){notify("Бесплатный кейс уже открыт сегодня");return}
    if(me.user.balance<selected.price){setBuyOpen(true);return}
    const current=selected;
    feel("heavy");setOpening(true);setError("");
    try{
      let data:CaseResult;
      if(demo){
        const pool=poolFor(current.code);
        const gift=current.price>0 && Math.random()<current.giftChance/100 ? pool[Math.floor(Math.random()*pool.length)] : undefined;
        data={caseId:current.id,price:current.price,reward:gift?{type:"gift",stars:0,giftId:gift.id,inventoryId:Date.now(),value:starValue(gift)??0}:{type:"stars",stars:current.price===0?5:Math.max(1,Math.floor(current.price*.3))},balance:me.user.balance};
        setMe(m=>m?{...m,user:{...m.user,balance:m.user.balance-current.price+data.reward.stars,dailyBonusReady:current.id==="daily"?false:m.user.dailyBonusReady},inventory:data.reward.giftId?[{id:data.reward.inventoryId!,giftId:data.reward.giftId,caseId:current.id,value:data.reward.value!,sellValue:Math.round(data.reward.value!*.1),status:"owned",createdAt:Date.now()/1000},...m.inventory]:m.inventory}:m);
      }else data=await api.openCase(current.id,crypto.randomUUID());
      const pool=poolFor(current.code);
      // The scrolling strip is a visual preview, never the source of the outcome.
      // Shuffle each cycle so adjacent gift cards are different and the animation
      // shows the variety in this case, while the server odds remain untouched.
      let visualGifts:Gift[]=[];
      let visualIndex=0;
      const nextVisualGift=()=>{
        if(visualIndex>=visualGifts.length){
          visualGifts=[...pool];
          for(let i=visualGifts.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[visualGifts[i],visualGifts[j]]=[visualGifts[j],visualGifts[i]]}
          visualIndex=0;
        }
        return visualGifts[visualIndex++];
      };
      const items:WheelItem[]=Array.from({length:38},(_,i)=>{
        if(current.id==="daily")return{stars:5};
        // Four out of five *visual* slots are gifts; this is not their drop rate.
        if(i%5!==0&&pool.length)return{giftId:nextVisualGift().id};
        return{stars:Math.max(1,Math.round(current.price*(.1+Math.random()*.85)))};
      });
      items[33]=data.reward.type==="gift"?{giftId:data.reward.giftId}:{stars:data.reward.stars};
      setWheel({items,result:data,done:false});
      await delay(80);
      if(!lessMotion&&wheelTrack.current&&wheelWindow.current){
        const center=(wheelWindow.current.clientWidth-92)/2;
        const x=(i:number)=>`translateX(${center-i*104}px)`;
        const animation=wheelTrack.current.animate([
          {transform:x(0),offset:0,easing:"cubic-bezier(.45,0,.9,.55)"},
          {transform:x(7),offset:.14,easing:"linear"},
          {transform:x(24),offset:.61,easing:"cubic-bezier(.12,.6,.24,1)"},
          {transform:x(33),offset:1}
        ],{duration:5100,fill:"forwards"});
        await animation.finished.catch(()=>undefined);
      }else await delay(100);
      setWheel(w=>w?{...w,done:true}:w);
      if(!demo)await reload();
      try{if(haptics)WebApp.HapticFeedback.notificationOccurred("success")}catch{/* browser preview */}
    }catch(e:any){setWheel(null);setError(e.message||"Не удалось открыть кейс")}
    finally{setOpening(false)}
  }
  async function claimDaily(){
    try{if(demo){setMe(m=>m?{...m,user:{...m.user,balance:m.user.balance+5,dailyBonusReady:false}}:m);notify("+5 игровых ⭐");return}
      const data=await api.dailyBonus();await reload();notify(data.granted?"+5 игровых ⭐":"Бонус уже получен сегодня")
    }catch(e:any){setError(e.message||"Ошибка бонуса")}
  }
  async function sell(item:InventoryItem){
    try{if(demo){setMe(m=>m?{...m,user:{...m.user,balance:m.user.balance+item.sellValue},inventory:m.inventory.map(i=>i.id===item.id?{...i,status:"sold"}:i)}:m)}
      else{await api.sellGift(item.id);await reload()}
      notify(`Продано за ${item.sellValue} игровых ⭐`);feel("medium")
    }catch(e:any){setError(e.message||"Не удалось продать")}
  }
  async function withdraw(item:InventoryItem){
    if(!window.confirm("Создать заявку на РУЧНОЙ вывод? Это не мгновенная передача NFT. Администратор проверит наличие реального подарка; при отказе он вернётся в игровой инвентарь."))return;
    try{if(demo)setMe(m=>m?{...m,inventory:m.inventory.map(i=>i.id===item.id?{...i,status:"pending"}:i)}:m);
      else{await api.withdrawGift(item.id);await reload()}
      notify("Заявка создана — ожидает ручной проверки")
    }catch(e:any){setError(e.message||"Не удалось отправить заявку")}
  }
  async function grant(){
    const n=Number(amount),id=target.trim()?Number(target.trim()):undefined;
    if(!Number.isSafeInteger(n)||n<=0||n>100000||(target.trim()&&(!Number.isSafeInteger(id)||!id||id<=0))){setError("Проверь ID и количество (1–100 000)");return}
    try{if(demo){if(!id||id===me?.user.telegramId)setMe(m=>m?{...m,user:{...m.user,balance:m.user.balance+n}}:m)}
      else{await api.adminCredit(n,id);await reload()}
      notify(`Начислено ${n} игровых ⭐ · ID ${id||me?.user.telegramId}`)
    }catch(e:any){setError(e.message||"Ошибка начисления")}
  }
  async function searchPlayer(){
    try{const data=demo?{players:[{telegramId:5009533742,username:"errordrop",balance:me?.user.balance??0,inventory}]}:await api.adminPlayer(adminQuery);
      setPlayers(data.players);if(!data.players.length)notify("Игрок не найден. Он должен сначала открыть бота.")
    }catch(e:any){setError(e.message||"Ошибка поиска")}
  }
  async function loadRequests(){try{setRequests(demo?[]:(await api.adminWithdrawals()).requests)}catch(e:any){setError(e.message||"Ошибка заявок")}}
  async function review(id:number,action:"reject"|"fulfilled"){
    if(action==="fulfilled"&&!window.confirm("Подтверди только ПОСЛЕ реальной ручной передачи подарка в Telegram. Приложение само ничего не отправляет."))return;
    try{if(!demo){await api.adminReview(id,action);await loadRequests()}notify(action==="reject"?"Заявка отклонена, подарок возвращён":"Отмечено как выполненное")}
    catch(e:any){setError(e.message||"Ошибка обработки")}
  }
  async function invite(){if(!me)return;const link=`https://t.me/ErrorDrop_Bot?start=ref_${me.user.refCode}`;
    try{WebApp.openTelegramLink(link)}catch{try{await navigator.clipboard.writeText(link);notify("Ссылка скопирована")}catch{notify(link)}}
  }
  if(loading)return <div className="boot"><img src="/errordrop-avatar.png" alt=""/><b>ERROR<span>DROP</span></b><p>Загрузка...</p></div>;
  if(!me)return <div className="boot"><img src="/errordrop-avatar.png" alt=""/><b>ERROR<span>DROP</span></b><p>Открой игру через @ErrorDrop_Bot → «Играть».</p><p className="notice-error">{error}</p></div>;
  return <div className={`app ${lessMotion?"reduce-effects":""}`}>
    <div className="ambient ambient-one"/><div className="ambient ambient-two"/>
    <header className="topbar"><button className="logo-button" onClick={()=>navigate("cases")} aria-label="ErrorDrop, на главную"><img src="/errordrop-avatar.png" alt=""/><span><b>ERROR<i>DROP</i></b><small>THE RED SIDE OF LUCK</small></span></button><button className="top-profile" onClick={()=>navigate("profile")}>{user?.username?`@${user.username}`:user?.first_name||"Профиль"}<span>↗</span></button></header>
    <div className="wallet-bar"><div className="avatar">{(user?.first_name||user?.username||"E")[0].toUpperCase()}</div><div className="wallet-person"><b>{user?.first_name||user?.username||"Игрок"}</b><small>ID {me.user.telegramId}</small></div><div className="wallet-balance"><b>{me.user.balance.toLocaleString("ru-RU")}</b><span>⭐</span></div><button className="wallet-plus" onClick={()=>{feel();setBuyOpen(true)}} aria-label="Пополнить баланс">+</button></div>
    <main className="screen" key={tab}>
      {tab==="cases"&&<><div className="screen-kicker"><span className="red-line"/> ERRORDROP / CASE ROOM <span className="season">СЕЗОН 01</span></div><h1 className="main-title">ТВОЙ ДРОП.<br/><em>ТВОИ ПРАВИЛА.</em></h1>
        <div className="live-heading"><span className="live-pill"><i/>GIFTS</span><span>ВОЗМОЖНЫЕ ПОДАРКИ</span><small>игровая витрина</small></div><div className="live-strip">{gifts.filter(g=>starValue(g)!==null).slice(0,18).map(g=><button className="live-item" key={g.id} onClick={()=>{setQuery(g.name);navigate("catalog")}}><img src={g.image} loading="lazy" alt=""/><span>{g.name}</span></button>)}</div>
        <div className="carousel-heading"><div><small>ВЫБЕРИ КЕЙС</small><b>{selected.code} <span>/ 0{cases.length-1}</span></b></div><span className="carousel-rule"/><span className="carousel-mark">◈</span></div>
        <section className="carousel" aria-label="Карусель кейсов" onTouchStart={e=>swipeY.current=e.touches[0].clientY} onTouchEnd={e=>{if(swipeY.current!==null){const delta=e.changedTouches[0].clientY-swipeY.current;if(Math.abs(delta)>45)shiftCase(delta<0?1:-1);swipeY.current=null}}}>
          <button className="carousel-arrow arrow-top" onClick={()=>shiftCase(-1)} aria-label="Предыдущий кейс">⌃</button><div className="carousel-stage">{[-1,0,1].map(offset=>{const c=cases[(caseIndex+offset+cases.length)%cases.length];return <button key={`${c.id}-${offset}`} className={`carousel-card position-${offset===-1?"left":offset===1?"right":"center"} ${c.tone}`} onClick={()=>offset&&shiftCase(offset)} aria-label={`${c.name}, ${c.price} игровых звёзд`} aria-current={offset===0?"true":undefined}><div className="card-top"><span>ERRORDROP</span><span>ED—{c.code}</span></div><div className="case-glow"/><img src={caseCover(c.cover)} alt=""/><div className="case-title"><small>{c.subtitle}</small><b>{c.name}</b></div><div className="case-bottom"><span>✦</span><span>DROP / 2026</span></div></button>})}</div><button className="carousel-arrow arrow-bottom" onClick={()=>shiftCase(1)} aria-label="Следующий кейс">⌄</button>
        </section><div className="case-meta"><span>{selected.subtitle}</span><h2>{selected.name}</h2><div><span className="gold-star">★</span> {selected.price||"БЕСПЛАТНО"} <small>{selected.price?"игровых ⭐":"1 раз в сутки"}</small></div></div>
        <div className="case-actions"><button onClick={()=>{feel();setSettingsOpen(true)}}>⚙ <span>Настройки</span></button><button onClick={()=>{feel();setPrizesOpen(true)}}>◇ <span>Призы</span></button></div>
        <button className="spin-cta" onClick={openCase} disabled={opening||(!selected.price&&!me.user.dailyBonusReady)}>{opening?"КРУТИМ…":selected.price?<>КРУТИТЬ ЗА <span>★ {selected.price}</span></>:me.user.dailyBonusReady?"ОТКРЫТЬ БЕСПЛАТНО →":"УЖЕ ОТКРЫТО СЕГОДНЯ"}<i>→</i></button>
        <p className="fineprint">{selected.price?`Звёзды ниже цены выпадают в ${100-selected.giftChance}% случаев. Подарок — ${selected.giftChance}%. Результат определяется сервером.`:"Только 5 игровых ⭐, один раз за московские сутки."} Реальные Telegram NFT не передаются автоматически.</p>
      </>}
      {tab==="pass"&&<><div className="screen-kicker"><span className="red-line"/> DAILY / 01</div><h1 className="main-title">ВОЗВРАЩАЙСЯ.<br/><em>ЗАБИРАЙ СВОЁ.</em></h1><div className="pass-hero"><span>01 / ЕЖЕДНЕВНЫЙ КЕЙС</span><div className="pass-gift">✦</div><b>+5 <i>★</i></b><p>Ровно 5 игровых звёзд раз в сутки. Этот бонус общий с бесплатным кейсом.</p><button className="spin-cta" disabled={!me.user.dailyBonusReady} onClick={claimDaily}>{me.user.dailyBonusReady?"ЗАБРАТЬ НАГРАДУ →":"УЖЕ ПОЛУЧЕНО СЕГОДНЯ"}</button></div><section className="panel history-panel"><h2>ИСТОРИЯ</h2><History transactions={me.transactions}/></section></>}
      {tab==="inventory"&&<><div className="screen-kicker"><span className="red-line"/> INVENTORY / {inventory.length}</div><h1 className="main-title">ТВОЙ<br/><em>ИНВЕНТАРЬ.</em></h1><p className="catalog-intro">Звёздные призы сразу попадают на игровой баланс и отражаются в истории. Выпавшие подарки сохраняются здесь в базе по твоему Telegram ID. Это игровые записи, а не подтверждение владения Telegram NFT.</p>
        {!inventory.length?<div className="gift-empty"><span>◇</span><strong>ПОКА НЕТ ПОДАРКОВ</strong><p>Подарки выпадают редко. Открой платный кейс — чаще выпадут игровые звёзды.</p><button onClick={()=>navigate("cases")}>К КЕЙСАМ →</button></div>:<div className="inventory-list">{inventory.map(item=>{const g=findGift(item.giftId);return <article className="inventory-card" key={item.id}><div className="inventory-art"><img src={g?.image||"/errordrop-avatar.png"} alt={g?.name||"Подарок"}/></div><div className="inventory-detail"><small>#{item.id} · {cases.find(c=>c.id===item.caseId)?.name||item.caseId}</small><h3>{g?.name||item.giftId}</h3><p>Оценка: ≈ {item.value.toLocaleString("ru-RU")} игровых ⭐</p><span className={`inventory-status ${item.status}`}>{item.status==="owned"?"В инвентаре":item.status==="pending"?"Заявка на вывод":item.status==="sold"?"Продано":"Передано вручную"}</span>{item.status==="owned"&&<div className="inventory-actions"><button onClick={()=>void sell(item)}>ПРОДАТЬ · +{item.sellValue} ⭐</button><button onClick={()=>void withdraw(item)}>ЗАЯВКА НА ВЫВОД ↗</button></div>}</div></article>})}</div>}
        <p className="source-note">Продажа обменивает игровую запись на внутренние ⭐. Вывод — только заявка администратору; передача настоящего Telegram-подарка не происходит автоматически и зависит от наличия подарка.</p>
      </>}
      {tab==="catalog"&&<><div className="screen-kicker"><span className="red-line"/> GIFT INDEX / {gifts.length}</div><h1 className="main-title">МИР ПОДАРКОВ.<br/><em>ОДИН КАТАЛОГ.</em></h1><p className="catalog-intro">Игровая оценка: 1 TON = 125 ₽, для расчёта принято 1 игровая ⭐ = 1 ₽. Это условный курс внутри приложения, не цена настоящих Telegram Stars и не обещание выкупа.</p><div className="catalog-tools"><input type="search" placeholder="Поиск подарка..." aria-label="Поиск подарка" value={query} onChange={e=>{setQuery(e.target.value);setLimit(36)}}/><span>{currentGifts.length} шт.</span></div><div className="chips">{["Все","До 1 500 ⭐","Дорогие","Без цены"].map(f=><button key={f} className={filter===f?"active":""} onClick={()=>{feel();setFilter(f);setLimit(36)}}>{f}</button>)}</div><div className="gift-grid">{currentGifts.slice(0,limit).map(g=><article className="gift-tile" key={g.id}><div className="gift-art"><img src={g.image} loading="lazy" alt={g.name}/><span>GIFT / {g.id.slice(0,3).toUpperCase()}</span></div><div className="gift-details"><b>{g.name}</b><small>{priceText(g)}</small><div><span className="catalog-label">{starValue(g)===null?"Нет в кейсах":`Кейс ${cases[giftTier(starValue(g)!)].name}`}</span><a href={g.url} target="_blank" rel="noopener noreferrer" aria-label={`Источник ${g.name}`}>↗</a></div></div></article>)}</div>{currentGifts.length>limit&&<button className="load-more" onClick={()=>setLimit(n=>n+36)}>ПОКАЗАТЬ ЕЩЁ ↓</button>}<p className="source-note">Каталог Telegifter, снимок 10 октября 2026. Цена в ⭐ — внутренняя расчётная оценка; данные могут устареть. Pre-market без числовой цены исключены из кейсов.</p></>}
      {tab==="profile"&&<><div className="screen-kicker"><span className="red-line"/> МОЙ ПРОФИЛЬ / {me.user.telegramId}</div><h1 className="main-title">ТВОЯ ТЕРРИТОРИЯ<span className="red-dot">.</span></h1><section className="profile-banner panel"><div className="large-avatar">{(user?.first_name||user?.username||"E")[0].toUpperCase()}</div><div><small>ИГРОК ERRORDROP</small><h2>{user?.first_name||user?.username||"Игрок"}</h2><span>ID {me.user.telegramId}</span></div><div className="profile-balance">★ {me.user.balance.toLocaleString("ru-RU")}</div></section><section className="invite-panel panel"><span className="panel-label">01 / КОМАНДА</span><div className="invite-art">♧</div><h2>ПРИГЛАШАЙ <em>ДРУЗЕЙ.</em></h2><p>Делись ссылкой и получай 10% игровых ⭐ от пополнений друзей.</p><div className="profile-stats"><span><b>{me.user.referralCount}</b> друзей</span><span><b>10%</b> бонус</span></div><button className="invite-btn" onClick={invite}>＋ ПРИГЛАСИТЬ ДРУГА <span>↗</span></button></section><section className="owned-panel panel"><div className="panel-title"><div><small>02 / НАГРАДЫ</small><h2>ИНВЕНТАРЬ</h2></div><b>{inventory.filter(i=>i.status==="owned").length} подарков</b></div><p className="ownership-note">Выпавшие подарки и заявки хранятся на сервере, а не в витрине избранного.</p><button className="outline-btn" onClick={()=>navigate("inventory")}>ОТКРЫТЬ ИНВЕНТАРЬ →</button></section><section className="panel history-panel"><h2>ИСТОРИЯ ИГР</h2><History transactions={me.transactions}/></section></>}
      {tab==="admin"&&me.user.isAdmin&&<><div className="screen-kicker"><span className="red-line"/> ACCESS LEVEL / OWNER</div><h1 className="main-title">ПАНЕЛЬ<br/><em>ВЛАДЕЛЬЦА.</em></h1><section className="admin-panel panel"><span className="panel-label">ID {me.user.telegramId}</span><h2>НАЧИСЛЕНИЕ</h2><p>Игровые ⭐ на внутреннем балансе, не настоящие Telegram Stars. Пустой ID — себе.</p><label>TELEGRAM ID ПОЛУЧАТЕЛЯ<input inputMode="numeric" placeholder="Пусто — себе" value={target} onChange={e=>setTarget(e.target.value)}/></label><label>КОЛИЧЕСТВО ИГРОВЫХ ⭐<input inputMode="numeric" value={amount} onChange={e=>setAmount(e.target.value)}/></label><button className="spin-cta" onClick={grant}>НАЧИСЛИТЬ →</button></section><section className="admin-panel panel"><span className="panel-label">ИНВЕНТАРЬ ИГРОКОВ</span><h2>ПОИСК ПО USERNAME</h2><p>Введи точный @username или Telegram ID. Игрок должен хотя бы раз открыть бот.</p><div className="admin-search"><input placeholder="@username или ID" value={adminQuery} onChange={e=>setAdminQuery(e.target.value)} onKeyDown={e=>e.key==="Enter"&&void searchPlayer()}/><button onClick={searchPlayer}>НАЙТИ →</button></div>{players.map(p=><div className="admin-player" key={p.telegramId}><b>@{p.username||"без username"} · ID {p.telegramId}</b><small>Баланс: {p.balance} игровых ⭐ · подарков: {p.inventory.length}</small>{p.inventory.length? p.inventory.map(i=><div className="admin-item" key={i.id}><img src={findGift(i.giftId)?.image} alt=""/><span>#{i.id} {findGift(i.giftId)?.name||i.giftId}<small>{i.status} · ≈ {i.value} ⭐</small></span></div>):<p>Инвентарь пуст</p>}</div>)}</section><section className="admin-panel panel"><span className="panel-label">РУЧНОЙ ВЫВОД</span><h2>ЗАЯВКИ</h2><p>Приложение не отправляет Telegram NFT. Отмечай выполненной только после передачи настоящего подарка вручную.</p><button className="outline-btn" onClick={loadRequests}>ОБНОВИТЬ ЗАЯВКИ ↻</button>{requests.map(r=><div className="withdraw-request" key={r.id}><b>#{r.id} · {findGift(r.giftId)?.name||r.giftId}</b><small>@{r.username||"без username"} · ID {r.userId} · {r.status}</small>{r.status==="pending"&&<div><button onClick={()=>review(r.id,"reject")}>ОТКЛОНИТЬ</button><button onClick={()=>review(r.id,"fulfilled")}>ПЕРЕДАНО ВРУЧНУЮ</button></div>}</div>)}</section></>}
    </main>
    <nav className="bottom-nav" aria-label="Разделы">{([ ["cases","⬡","Кейсы"],["pass","▤","Бонус"],["inventory","▣","Инвентарь"],["catalog","◈","Подарки"],["profile","♧","Профиль"],...(me.user.isAdmin?[["admin","✦","Админ"]]:[]) ] as [Tab,string,string][]).map(([id,icon,label])=><button key={id} className={tab===id?"active":""} onClick={()=>navigate(id)}><span>{icon}</span><small>{label}</small><i/></button>)}</nav>
    {error&&<div className="toast error-toast" role="alert" onClick={()=>setError("")}>{error} <span>×</span></div>}{toast&&<div className="toast" role="status" onClick={()=>setToast("")}>{toast} <span>×</span></div>}
    {settingsOpen&&<div className="modal-scrim" onClick={()=>setSettingsOpen(false)}><section className="modal-sheet" role="dialog" aria-modal="true" aria-label="Настройки" onClick={e=>e.stopPropagation()}><div className="modal-top"><small>ERRORDROP / SETTINGS</small><button onClick={()=>setSettingsOpen(false)}>×</button></div><h2>НАСТРОЙКИ</h2><label className="toggle-row">Тактильный отклик<input type="checkbox" checked={haptics} onChange={e=>{setHaptics(e.target.checked);localStorage.setItem("ed-haptics",e.target.checked?"on":"off")}}/></label><label className="toggle-row">Меньше анимаций<input type="checkbox" checked={lessMotion} onChange={e=>{setLessMotion(e.target.checked);localStorage.setItem("ed-motion",e.target.checked?"less":"full")}}/></label></section></div>}
    {prizesOpen&&<div className="modal-scrim" onClick={()=>setPrizesOpen(false)}><section className="modal-sheet prizes-sheet" role="dialog" aria-modal="true" aria-label="Призы кейса" onClick={e=>e.stopPropagation()}><div className="modal-top"><small>ERRORDROP / CASE {selected.code}</small><button onClick={()=>setPrizesOpen(false)}>×</button></div><h2>ЧТО ВЫПАДАЕТ?</h2>{selected.price===0?<p className="modal-note">Ровно 5 игровых ⭐ · 100% · один раз в сутки. Подарков в бесплатном кейсе нет.</p>:<><p className="modal-note">Награды определяет сервер. Чаще выпадают ⭐ меньше цены кейса. Подарки — редкая игровая запись в инвентаре; не скриншоты.</p><div className="odds-list"><div className="odds-row common"><span className="odds-icon">★</span><div><b>Неокуп · игровые ⭐</b><small>10–55% цены кейса</small></div><strong>{75-selected.giftChance}%</strong></div><div className="odds-row rare"><span className="odds-icon">✦</span><div><b>Почти окуп · игровые ⭐</b><small>56–95% цены кейса</small></div><strong>25%</strong></div><div className="odds-row legend"><span className="odds-icon">◇</span><div><b>Подарок в инвентарь</b><small>Редкость зависит от кейса</small></div><strong>{selected.giftChance}%</strong></div></div><div className="showcase-line"><span>ВОЗМОЖНЫЕ ПОДАРКИ · {eligible.length}</span><small>цены в игровых ⭐</small></div><div className="prize-grid">{eligible.map(g=><div key={g.id}><img src={g.image} alt=""/><b>{g.name}</b><small>{priceText(g)}</small></div>)}</div></>}</section></div>}
    {wheel&&<div className="wheel-overlay" role="dialog" aria-modal="true" aria-label="Рулетка кейса"><div className="wheel-header"><span>ERRORDROP / РУЛЕТКА</span><button disabled={!wheel.done} onClick={()=>setWheel(null)} aria-label="Закрыть">×</button></div><h2>{wheel.done?"ТВОЙ ДРОП!":"КРУТИМ КЕЙС…"}</h2><p>{cases.find(c=>c.id===wheel.result.caseId)?.name}</p><div className={`wheel-window ${wheel.done?"wheel-finished":""}`} ref={wheelWindow}><div className="wheel-marker"/><div className="wheel-track" ref={wheelTrack}>{wheel.items.map((item,i)=>{const g=findGift(item.giftId);return <div className={`wheel-card ${item.giftId?"wheel-gift":"wheel-stars"}`} key={i}>{g?<img src={g.image} alt=""/>:<span>★</span>}<b>{g?.name||`${item.stars} ⭐`}</b></div>})}</div></div><p className="wheel-disclaimer">Лента — визуальная анимация, а не отображение шансов. Результат определяет сервер; точные шансы — в «Призы».</p>{wheel.done&&<div className="wheel-result"><div className="result-symbol">✺</div>{wheel.result.reward.type==="gift"?<><h3>{findGift(wheel.result.reward.giftId)?.name}</h3><p>Подарок сохранён в игровом инвентаре.</p><button className="spin-cta" onClick={()=>{setWheel(null);navigate("inventory")}}>В ИНВЕНТАРЬ →</button></>:<><h3>+{wheel.result.reward.stars} игровых ⭐</h3><p>{wheel.result.price?`Цена кейса ${wheel.result.price} ⭐ · итог ${wheel.result.reward.stars-wheel.result.price} ⭐`:"Бесплатный подарок дня"}</p><button className="spin-cta" onClick={()=>setWheel(null)}>ПРОДОЛЖИТЬ →</button></>}</div>}</div>}
    {buyOpen&&<BuyModal onClose={()=>setBuyOpen(false)} onPurchased={async()=>{setBuyOpen(false);await reload()}}/>}
  </div>;
}
