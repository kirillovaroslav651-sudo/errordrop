import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import WebApp from "@twa-dev/sdk";
import { api, AdminAction, AdminPlayer, CaseResult, getTgUser, InventoryItem, MeData, UpgradeResult, Withdrawal, LiveGift } from "./lib/api";
import { giftStarValue, giftTier } from "./lib/pricing";
import BuyModal from "./components/BuyModal";
import History from "./components/History";
import giftCatalog from "./giftCatalog.json";
import caseConfig from "./caseConfig.json";

type Tab = "cases" | "pass" | "inventory" | "games" | "crash" | "upgrade" | "catalog" | "profile" | "admin";
type Gift = { id: string; name: string; image: string; url: string; price: string; currency: string; supply: string };
type WheelItem = { giftId?: string; stars?: number };
type Wheel = { items: WheelItem[]; result: CaseResult; done: boolean };
const gifts: Gift[] = giftCatalog;
const cases = caseConfig;
const findGift = (id?: string) => gifts.find(g => g.id === id);
let telegramPriceOverrides: Record<string, number> = {};
const starValue = (g: Gift) => telegramPriceOverrides[g.id] ?? giftStarValue(g.price, g.currency);
const priceText = (g: Gift) => { const n=starValue(g); return n === null ? "Цена не определена" : `${telegramPriceOverrides[g.id]?"Telegram минимум":"≈ оценка"} ${n.toLocaleString("ru-RU")} ⭐`; };
const demo = import.meta.env.DEV && new URLSearchParams(location.search).has("preview");
const demoMe: MeData = { user: { telegramId:5009533742,username:"errordrop",balance:2460,refCode:"f00dbabe",isAdmin:true,referralCount:8,dailyBonusReady:true }, transactions:[],gallery:[],inventory:[],starInventory:[],withdrawalAccess:{paid:500,committed:0,availableXtr:500,referralCount:0,friendPayments:[],openedCases:0,level:1,requiredLevel:1} };
const delay = (ms:number) => new Promise<void>(resolve=>setTimeout(resolve,ms));

export default function App() {
  const [me,setMe] = useState<MeData|null>(demo ? demoMe : null);
  const [loading,setLoading] = useState(!demo);
  const [error,setError] = useState("");
  const [toast,setToast] = useState("");
  const [tab,setTab] = useState<Tab>("cases");
  const [gameChoice,setGameChoice] = useState<"crash"|"upgrade">("crash");
  const [caseIndex,setCaseIndex] = useState(0);
  const [opening,setOpening] = useState(false);
  const [wheel,setWheel] = useState<Wheel|null>(null);
  const wheelTrack = useRef<HTMLDivElement|null>(null);
  const wheelWindow = useRef<HTMLDivElement|null>(null);
  const [settingsOpen,setSettingsOpen] = useState(false);
  const [buyOpen,setBuyOpen] = useState(false);
  const [haptics,setHaptics] = useState(localStorage.getItem("ed-haptics")!=="off");
  const [lessMotion,setLessMotion] = useState(localStorage.getItem("ed-motion")==="less");
  const [query,setQuery] = useState("");
  const [limit,setLimit] = useState(36);
  const [filter,setFilter] = useState("Все");
  const [priceVersion,setPriceVersion] = useState(0);
  const [liveCount,setLiveCount] = useState(0);
  const [liveGifts,setLiveGifts]=useState<LiveGift[]>([]);
  const [inventoryBusy,setInventoryBusy]=useState(false);
  const [subscribePrompt,setSubscribePrompt]=useState(false);
  const [onlineCount,setOnlineCount] = useState<number|null>(null);
  const [inventoryFilter,setInventoryFilter] = useState("Все");
  const [upgradeSource,setUpgradeSource] = useState<number|null>(null);
  const [upgradeTarget,setUpgradeTarget] = useState("");
  const [upgradeBusy,setUpgradeBusy] = useState(false);
  const [upgradeResult,setUpgradeResult] = useState<UpgradeResult|null>(null);
  const [upgradeStop,setUpgradeStop] = useState(0);
  const [hackStep,setHackStep] = useState(0);
  const [dailyBusy,setDailyBusy] = useState(false);
  const [target,setTarget] = useState("");
  const [amount,setAmount] = useState("100");
  const [adminQuery,setAdminQuery] = useState("");
  const [players,setPlayers] = useState<AdminPlayer[]>([]);
  const [adminActions,setAdminActions] = useState<AdminAction[]>([]);
  const [correctionReason,setCorrectionReason] = useState("");
  const [removeAmount,setRemoveAmount] = useState("");
  const [requests,setRequests] = useState<Withdrawal[]>([]);
  const user = getTgUser();
  const selected = cases[caseIndex];
  const inventory = me?.inventory || [];
  const starInventory = me?.starInventory || [];
  const sourceItem=inventory.find(i=>i.id===upgradeSource);
  const upgradeTargets=sourceItem?gifts.filter(g=>{const value=starValue(g);return value!==null&&value>sourceItem.value&&Math.floor(sourceItem.value/value*9000)<=6000}).sort((a,b)=>(starValue(a)??0)-(starValue(b)??0)):[];
  const targetGift=gifts.find(g=>g.id===upgradeTarget);
  const targetValue=targetGift?starValue(targetGift)??0:0;
  const upgradeChance=sourceItem&&targetValue?Math.floor(sourceItem.value/targetValue*9000)/100:0;
  const visibleInventory = useMemo(()=>{
    const items = [...inventory];
    if(inventoryFilter==="На продажу") return items.filter(i=>i.status==="owned");
    if(inventoryFilter==="Редкие") return items.filter(i=>i.value>=1500);
    if(inventoryFilter==="Недавние") return items.sort((a,b)=>b.createdAt-a.createdAt);
    return items;
  },[inventory,inventoryFilter]);
  const openedCases = me?.withdrawalAccess.openedCases ?? 0;
  const inventoryValue = inventory.filter(i=>i.status==="owned").reduce((sum,i)=>sum+i.value,0);
  const level = me?.withdrawalAccess.level ?? 1;
  const currentGifts = useMemo(()=>gifts.filter(g=>{
    const v=starValue(g);
    const matches=`${g.name} ${v ?? ""}`.toLowerCase().includes(query.trim().toLowerCase());
    if(filter==="Без цены") return matches && v===null;
    if(filter==="До 1 500 ⭐") return matches && v!==null && v<=1500;
    if(filter==="Дорогие") return matches && v!==null && v>15000;
    return matches;
  }),[query,filter,priceVersion]);
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
    if(demo){setOnlineCount(1);return}
    if(!me)return;
    let active=true;
    const beat=()=>{if(document.visibilityState!=="visible")return;
      void api.presence().then(({online})=>{if(active)setOnlineCount(online)}).catch(()=>undefined)};
    beat();
    const timer=window.setInterval(beat,25000);
    document.addEventListener("visibilitychange",beat);
    return()=>{active=false;window.clearInterval(timer);document.removeEventListener("visibilitychange",beat)};
  },[me?.user.telegramId]);
  useEffect(()=>{if(demo)return;let active=true;const fetchLive=()=>{if(document.visibilityState==='visible')void api.liveGifts().then(r=>{if(active)setLiveGifts(r.items)}).catch(()=>undefined)};fetchLive();const timer=window.setInterval(fetchLive,20000);return()=>{active=false;window.clearInterval(timer)}},[]);
  useEffect(()=>{
    if(demo)return;
    let mounted=true;
    api.giftPrices().then(({prices})=>{
      if(!mounted)return;
      telegramPriceOverrides=Object.fromEntries(prices.filter(p=>Number.isSafeInteger(p.stars)&&p.stars>0).map(p=>[p.id,p.stars]));
      setLiveCount(Object.keys(telegramPriceOverrides).length);
      setPriceVersion(n=>n+1);
    }).catch(()=>undefined);
    return()=>{mounted=false};
  },[]);
  useEffect(()=>{
    const close=(e:KeyboardEvent)=>{if(e.key==="Escape"&&!opening){setSettingsOpen(false);setBuyOpen(false);setWheel(null)}};
    window.addEventListener("keydown",close);return()=>window.removeEventListener("keydown",close);
  },[opening]);
  const navigate=(next:Tab)=>{feel();setTab(next);window.scrollTo({top:0,behavior:lessMotion?"instant":"smooth"})};

  async function openCase(){
    if(!me||opening)return;
    if(selected.price===0){
      if(!me.user.dailyBonusReady){notify("Бесплатный кейс уже открыт сегодня");return}
      if(!demo){try{const status=await api.subscriptionStatus();if(!status.subscribed){setSubscribePrompt(true);return}}catch{setSubscribePrompt(true);notify("Проверка подписки временно недоступна. Убедись, что бот добавлен администратором канала.");return}}
    }
    if(me.user.balance<selected.price){setBuyOpen(true);return}
    const current=selected;
    feel("heavy");setOpening(true);setError("");
    try{
      let data:CaseResult;
      if(demo){
        const pool=gifts.filter(g=>starValue(g)!==null);
        if(current.id==="daily"){
          data={caseId:current.id,price:0,reward:{type:"stars",stars:5},balance:me.user.balance+5};
          setMe(m=>m?{...m,user:{...m.user,balance:m.user.balance+5,dailyBonusReady:false}}:m);
        }else{
          const roll=Math.random()*100; const bonus=roll<current.giftChance;
          let n=Math.random()*(current.outcomes||[]).reduce((a,o)=>a+o.chance,0); const picked=(current.outcomes||[]).find(o=>(n-=o.chance)<0);
          const target=bonus?current.price+Math.floor(Math.random()*Math.max(1,(current.bonusMax??current.price)-current.price+1)):(picked?.stars??current.price);
          const highTierGift=current.id==="pulse"||current.id==="blackout"||current.id==="ultraviolet";
          const minGift=bonus?Math.max(current.price,target*.8):target*.8;
          const maxGift=bonus?Math.min(current.bonusMax??current.price,target*1.2):target*1.2;
          if((!bonus&&!highTierGift)||!pool.some(g=>{const v=starValue(g)??0;return v>=minGift&&v<=maxGift})){
            data={caseId:current.id,price:current.price,reward:{type:"stars",stars:target},balance:me.user.balance-current.price+target};
            setMe(m=>m?{...m,user:{...m.user,balance:m.user.balance-current.price+target}}:m);
          }else{
            const choices=pool.filter(g=>{const v=starValue(g)??0;return v>=minGift&&v<=maxGift}); const gift=choices[Math.floor(Math.random()*choices.length)];
            data={caseId:current.id,price:current.price,reward:{type:"gift",stars:0,giftId:gift.id,inventoryId:Date.now(),value:starValue(gift)??0},balance:me.user.balance-current.price};
            setMe(m=>m?{...m,user:{...m.user,balance:m.user.balance-current.price},inventory:[{id:data.reward.inventoryId!,giftId:data.reward.giftId!,caseId:current.id,value:data.reward.value!,sellValue:data.reward.value!,status:"owned",createdAt:Date.now()/1000},...m.inventory]}:m);
          }
        }
      }else data=await api.openCase(current.id,crypto.randomUUID());
      const pool=gifts.filter(g=>starValue(g)!==null);
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
    }catch(e:any){setWheel(null);if(e.message==="channel_required"){setSubscribePrompt(true);setError("Подписка на @ErrorDropNews не подтверждена")}else setError(e.message||"Не удалось открыть кейс")}
    finally{setOpening(false)}
  }
  async function claimDaily(){
    if(dailyBusy || !me?.user.dailyBonusReady)return;
    setDailyBusy(true);
    try{if(demo){setMe(m=>m?{...m,user:{...m.user,balance:m.user.balance+5,dailyBonusReady:false}}:m);notify("+5 игровых ⭐");return}
      const data=await api.dailyBonus();await reload();notify(data.granted?"+5 игровых ⭐":"Бонус уже получен сегодня")
    }catch(e:any){setError(e.message||"Ошибка бонуса")}
    finally{setDailyBusy(false);setHackStep(0)}
  }
  function tapHack(){
    if(!me?.user.dailyBonusReady || dailyBusy)return;
    feel("medium");
    if(hackStep>=2){setHackStep(3);void claimDaily()}else setHackStep(hackStep+1);
  }
  async function sellAll(){if(inventoryBusy||!window.confirm('Продать все доступные подарки и звёздные призы за игровые ⭐? Заявки на вывод не затрагиваются.'))return;setInventoryBusy(true);try{const result=await api.sellAll();await reload();notify(`Продано ${result.count} призов за ${result.credited} ⭐`)}catch(e:any){setError(e.message||'Ошибка продажи')}finally{setInventoryBusy(false)}}
  async function clearHistory(){if(inventoryBusy||!window.confirm('Очистить только проданные и недоступные записи? Доступные призы и заявки останутся.'))return;setInventoryBusy(true);try{const result=await api.clearInventoryHistory();await reload();notify(`Очищено записей: ${result.count}`)}catch(e:any){setError(e.message||'Ошибка очистки')}finally{setInventoryBusy(false)}}
  async function sellStars(id:number){try{const result=await api.sellStars(id);await reload();notify(`Продано за ${result.credited} игровых ⭐`)}catch(e:any){setError(e.message||'Ошибка продажи')}}
  async function sell(item:InventoryItem){
    try{if(demo){setMe(m=>m?{...m,user:{...m.user,balance:m.user.balance+item.sellValue},inventory:m.inventory.map(i=>i.id===item.id?{...i,status:"sold"}:i)}:m)}
      else{await api.sellGift(item.id);await reload()}
      notify(`Продано за ${item.sellValue} игровых ⭐`);feel("medium")
    }catch(e:any){setError(e.message||"Не удалось продать")}
  }
  async function runUpgrade(){
    if(!sourceItem||!targetGift||upgradeBusy)return;
    if(!window.confirm(`Рискнуть подарком ${findGift(sourceItem.giftId)?.name||sourceItem.giftId}? Шанс ${upgradeChance}% с комиссией 10%. При неудаче предмет сгорит. Дополнительные ⭐ не списываются.`))return;
    setUpgradeBusy(true);setUpgradeResult(null);feel("heavy");
    try{
      const result=demo?(()=>{const roll=Math.random()*100;return {success:roll<upgradeChance,chance:upgradeChance,targetGiftId:targetGift.id,targetValue,inventoryId:Date.now(),roll}})():await api.upgradeGift(sourceItem.id,targetGift.id);
      setUpgradeStop(1440+result.roll*3.6);
      await delay(2700);setUpgradeResult(result);feel(result.success?"heavy":"medium");
      if(demo)setMe(m=>m?{...m,inventory:[...m.inventory.map(i=>i.id===sourceItem.id?{...i,status:result.success?"upgraded":"burned"} as InventoryItem:i),...(result.success?[{id:result.inventoryId!,giftId:targetGift.id,caseId:"upgrade",value:targetValue,sellValue:targetValue,status:"owned" as const,createdAt:Date.now()/1000}]:[])]}:m);
      else await reload();
    }catch(e:any){setError(e.message||"Ошибка апгрейда")}
    finally{setUpgradeBusy(false)}
  }
  async function withdraw(item:InventoryItem){
    if(!me)return;
    if(me.withdrawalAccess.level<me.withdrawalAccess.requiredLevel){setError(`Для следующего вывода нужен уровень ${me.withdrawalAccess.requiredLevel}. Сейчас уровень ${me.withdrawalAccess.level}; открой ещё ${me.withdrawalAccess.requiredLevel*10-10-me.withdrawalAccess.openedCases} платных кейсов.`);return}
    if(me.withdrawalAccess.availableXtr<item.value && me.withdrawalAccess.friendPayments.filter(n=>n>=Math.ceil(item.value/5)).length<5){setError(`Для заявки на этот подарок нужно суммарно пополнить ещё ${Math.max(0,item.value-(me?.withdrawalAccess.availableXtr??0))} XTR или пригласить ${Math.max(0,5-(me?.withdrawalAccess.friendPayments.filter(n=>n>=Math.ceil(item.value/5)).length??0))} друзей с пополнением от ${Math.ceil(item.value/5)} XTR каждый.`);return}
    if(!window.confirm("Создать заявку на РУЧНОЙ вывод? Это не мгновенная передача NFT. Администратор проверит наличие реального подарка; при отказе он вернётся в игровой инвентарь."))return;
    try{if(demo)setMe(m=>m?{...m,inventory:m.inventory.map(i=>i.id===item.id?{...i,status:"pending"}:i)}:m);
      else{await api.withdrawGift(item.id);await reload()}
      notify("Заявка создана — ожидает ручной проверки")
    }catch(e:any){setError(e.message==="level_required"?"Нужно повысить уровень для следующего вывода. Проверь прогресс в инвентаре.":e.message==="withdrawal_locked"?"Условия вывода пока не выполнены. Проверь прогресс в инвентаре.":e.message||"Не удалось отправить заявку")}
  }
  async function grant(){
    const n=Number(amount), recipient=target.trim().replace(/^@/,"");
    const numeric=recipient && /^\d+$/.test(recipient)?Number(recipient):undefined;
    if(!Number.isSafeInteger(n)||n<=0||n>100000||(recipient&&(!numeric&&!/^[a-zA-Z0-9_]{5,32}$/.test(recipient)))){setError("Проверь username/ID и количество (1–100 000)");return}
    try{if(demo){if(!recipient||numeric===me?.user.telegramId||recipient.toLowerCase()==="errordrop")setMe(m=>m?{...m,user:{...m.user,balance:m.user.balance+n}}:m)}
      else{await api.adminCredit(n,recipient||undefined);await reload()}
      notify(`Начислено ${n} игровых ⭐ · ${recipient?`@${recipient}`:"себе"}`)
    }catch(e:any){setError(e.message||"Ошибка начисления")}
  }
  async function searchPlayer(){
    try{const data=demo?{players:[{telegramId:5009533742,username:"errordrop",balance:me?.user.balance??0,inventory}]}:await api.adminPlayer(adminQuery);
      setPlayers(data.players);if(!data.players.length)notify("Игрок не найден. Он должен сначала открыть бота.")
    }catch(e:any){setError(e.message||"Ошибка поиска")}
  }
  async function removeStars(player:AdminPlayer){
    const n=Number(removeAmount), reason=correctionReason.trim();
    if(!Number.isSafeInteger(n)||n<1||n>player.balance||reason.length<5){setError("Укажи сумму не больше баланса и причину от 5 символов");return}
    if(!window.confirm(`Списать ${n} игровых ⭐ у @${player.username||player.telegramId}? Причина: ${reason}`))return;
    try{if(!demo){await api.adminRemoveStars(player.telegramId,n,reason);await searchPlayer();await loadAdminActions();await reload()}
      notify("Игровые ⭐ списаны, действие записано в журнал");setRemoveAmount("")}
    catch(e:any){setError(e.message||"Не удалось списать ⭐")}
  }
  async function removeGift(player:AdminPlayer,item:InventoryItem){
    const reason=correctionReason.trim();
    if(reason.length<5){setError("Укажи причину удаления от 5 символов");return}
    if(!window.confirm(`Удалить подарок #${item.id} у @${player.username||player.telegramId}? Это не затронет реальные подарки Telegram. Причина: ${reason}`))return;
    try{if(!demo){await api.adminRemoveGift(player.telegramId,item.id,reason);await searchPlayer();await loadAdminActions();await reload()}
      notify("Подарок удалён из игрового инвентаря, действие записано")}
    catch(e:any){setError(e.message||"Не удалось удалить подарок")}
  }
  async function loadAdminActions(){try{setAdminActions(demo?[]:(await api.adminActions()).actions)}catch(e:any){setError(e.message||"Ошибка журнала")}}
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
    <div className="ambient ambient-one"/><div className="ambient ambient-two"/><div className="glitch-atmosphere" aria-hidden="true"/>
    <header className="topbar"><button className="logo-button" onClick={()=>navigate("cases")} aria-label="ErrorDrop, на главную"><img src="/errordrop-avatar.png" alt=""/><span><b>ERROR<i>DROP</i></b><small>THE RED SIDE OF LUCK</small></span></button><button className="top-profile" onClick={()=>navigate("profile")}>{user?.username?`@${user.username}`:user?.first_name||"Профиль"}<span>↗</span></button></header>
    <div className="wallet-bar"><div className="avatar">{(user?.first_name||user?.username||"E")[0].toUpperCase()}</div><div className="wallet-person"><b>{user?.first_name||user?.username||"Игрок"}</b><small>ID {me.user.telegramId}</small></div><div className="wallet-right"><div className="wallet-balance"><b>{me.user.balance.toLocaleString("ru-RU")}</b><span>⭐</span></div><div className="online-counter" title="Игроки, активные в Mini App за последнюю минуту"><i/>ОНЛАЙН {onlineCount===null?"—":onlineCount}</div></div><button className="wallet-plus" onClick={()=>{feel();setBuyOpen(true)}} aria-label="Пополнить баланс">+</button></div>
    <main className="screen" key={tab}>
      {tab==="cases"&&<><div className="screen-kicker"><span className="red-line"/> ERRORDROP / CASE ROOM <span className="season">СЕЗОН 01</span></div><h1 className="main-title">ТВОЙ ДРОП.<br/><em>ТВОИ ПРАВИЛА.</em></h1>
        <div className="live-heading"><span className="live-pill"><i/>LIVE</span> РЕАЛЬНЫЕ ДРОПЫ <small>{liveGifts.length?`${liveGifts.length} последних подарков`:'Пока нет дропов'}</small></div><div className="live-strip" aria-label="Последние выпавшие подарки">{liveGifts.map(item=>{const g=findGift(item.giftId);return <div className="live-item" key={item.id}><img src={g?.image||'/errordrop-avatar.png'} alt=""/><span>{g?.name||item.giftId}</span><small>{item.value} ⭐</small></div>})}</div>
        <div className="carousel-heading"><div><small>ВЫБЕРИ КЕЙС</small><b>{cases.length} <span>ДОСТУПНО</span></b></div><span className="carousel-rule"/><span className="carousel-mark">◈</span></div>
        <section className="case-grid" aria-label="Все кейсы">{cases.map((c,i)=><button key={c.id} className={`case-grid-card ${c.tone} ${i===caseIndex?"selected":""}`} onClick={()=>{feel();setCaseIndex(i)}} aria-pressed={i===caseIndex}>
          <div className="case-grid-art"><span className="case-grid-code">ED—{c.code}</span><span className="case-grid-icon-wrap"><img className="case-grid-symbol" src={`/cases/${c.id}.svg`} alt={`${c.name} icon`} /></span><span className="case-grid-badge">{c.price===0?"БЕСПЛАТНО":c.subtitle}</span></div>
          <div className="case-grid-info"><b>{c.name}</b><span>{c.price===0?<>★ 0 <small>1 раз в сутки</small></>:<>★ {c.price}</>}</span></div>
        </button>)}</section>
        <div className="case-meta"><span>{selected.subtitle}</span><h2>{selected.name}</h2><div><span className="gold-star">★</span> {selected.price||"БЕСПЛАТНО"} <small>{selected.price?"игровых ⭐":"1 раз в сутки"}</small></div></div>
        <div className="case-actions"><button onClick={()=>{feel();setSettingsOpen(true)}}>⚙ <span>Настройки</span></button></div>
        <button className="spin-cta" onClick={openCase} disabled={opening||(!selected.price&&!me.user.dailyBonusReady)}>{opening?"КРУТИМ…":selected.price?<>КРУТИТЬ ЗА <span>★ {selected.price}</span></>:me.user.dailyBonusReady?"ОТКРЫТЬ БЕСПЛАТНО →":"УЖЕ ОТКРЫТО СЕГОДНЯ"}<i>→</i></button>
        <p className="fineprint">{selected.price?`В кейсах 99, 249 и 499 ⭐ обычные исходы — игровые ⭐. В кейсах 999, 2499 и 4999 ⭐ обычные исходы — подарки около выпавшей стоимости. Бонусный исход может дать подарок; если в каталоге нет подходящего, начисляются игровые ⭐. Результат определяется сервером.`:"Только 5 игровых ⭐, один раз за московские сутки."} Реальные Telegram NFT не передаются автоматически.</p>
      </>}
      {tab==="pass"&&<><div className="screen-kicker"><span className="red-line"/> DAILY / 01</div><h1 className="main-title">ВОЗВРАЩАЙСЯ.<br/><em>ЗАБИРАЙ СВОЁ.</em></h1><div className="pass-hero"><span>01 / ЕЖЕДНЕВНЫЙ КЕЙС</span><div className="pass-gift">✦</div><b>+5 <i>★</i></b><p>Ровно 5 игровых звёзд раз в сутки. Этот бонус общий с бесплатным кейсом.</p><div className="hack-game"><small>ВЗЛОМ СИСТЕМЫ / {Math.min(hackStep,3)} из 3</small><div className="hack-field">{me.user.dailyBonusReady&&!dailyBusy?<button className={`hack-target step-${hackStep}`} onClick={tapHack} aria-label={`Найти квадрат ${hackStep+1} из 3`}>✕</button>:<span>{dailyBusy?"ПРОВЕРКА ДОСТУПА…":"ДОСТУП ЗАКРЫТ ДО ЗАВТРА"}</span>}</div></div><p>Найди и нажми три красных квадрата. Награда будет начислена сервером один раз за сутки.</p></div><section className="panel history-panel"><h2>ИСТОРИЯ</h2><History transactions={me.transactions}/></section></>}
      {tab==="inventory"&&<><div className="screen-kicker"><span className="red-line"/> INVENTORY / {inventory.length}</div><h1 className="main-title">ТВОЙ<br/><em>ИНВЕНТАРЬ.</em></h1><p className="catalog-intro">Звёздные призы и подарки сохраняются здесь до продажи. Они не начисляются на баланс автоматически. Призы хранятся в базе по твоему Telegram ID. Это игровые записи, а не подтверждение владения Telegram NFT.</p>
        <details className="withdraw-access panel"><summary>УСЛОВИЯ РУЧНОГО ВЫВОДА ПОДАРКА <span className="access-chevron" aria-hidden="true">⌄</span></summary><div className="withdraw-access-body"><p>Для каждого подарка отдельно: либо подтверждённые пополнения настоящими Telegram Stars (XTR) на сумму не меньше стоимости этого подарка, либо 5 приглашённых друзей, каждый из которых пополнил минимум 20% стоимости этого подарка в XTR (округляем вверх). Сумма пополнений или группа друзей, использованная для одной заявки, не засчитывается повторно для следующей. После первого вывода для каждой следующей заявки нужно поднять уровень ещё на один (+1 уровень за 10 открытых платных кейсов). Отыгрыш XTR не требуется. Бонусные игровые ⭐ не считаются пополнением. Вывод обрабатывается вручную, конкретный NFT заранее не зарезервирован.</p><small>Доступно подтверждённых пополнений: {me.withdrawalAccess.availableXtr} XTR · Доступно приглашённых друзей: {me.withdrawalAccess.friendPayments.length} (порог зависит от подарка) · Уровень: {me.withdrawalAccess.level}, следующий вывод: {me.withdrawalAccess.requiredLevel}</small></div></details>
        <div className="inventory-bulk"><button disabled={inventoryBusy||!inventory.some(i=>i.status==='owned')&&!starInventory.some(i=>i.status==='owned')} onClick={()=>void sellAll()}>ПРОДАТЬ ВСЁ</button><button disabled={inventoryBusy} onClick={()=>void clearHistory()}>ОЧИСТИТЬ ИСТОРИЮ</button></div>
        {starInventory.filter(i=>i.status==='owned').map(item=><article className="inventory-card star-prize" key={`star-${item.id}`}><div className="inventory-art">⭐</div><div className="inventory-detail"><small>#{item.id} · {cases.find(c=>c.id===item.caseId)?.name||item.caseId}</small><h3>{item.amount} игровых ⭐</h3><p>Звёздный приз в инвентаре</p><button className="outline-btn" onClick={()=>void sellStars(item.id)}>ПРОДАТЬ · +{item.amount} ⭐</button></div></article>)}
        {!inventory.length&&!starInventory.some(i=>i.status==='owned')?<div className="gift-empty"><span>◇</span><strong>ПОКА НЕТ ПОДАРКОВ</strong><p>Открой платный кейс, чтобы получить первый игровой подарок.</p><button onClick={()=>navigate("cases")}>К КЕЙСАМ →</button></div>:<><div className="inventory-filters" role="group" aria-label="Фильтр инвентаря">{["Все","На продажу","Редкие","Недавние"].map(f=><button key={f} className={inventoryFilter===f?"active":""} onClick={()=>{feel();setInventoryFilter(f)}}>{f}</button>)}</div><div className="inventory-list">{visibleInventory.map(item=>{const g=findGift(item.giftId);return <article className={`inventory-card rarity-${item.value>=15000?"legendary":item.value>=5000?"epic":item.value>=1500?"rare":"common"}`} key={item.id}><div className="inventory-art"><img src={g?.image||"/errordrop-avatar.png"} alt={g?.name||"Подарок"}/></div><div className="inventory-detail"><small>#{item.id} · {cases.find(c=>c.id===item.caseId)?.name||item.caseId}</small><h3>{g?.name||item.giftId}</h3><p>Оценка: ≈ {item.value.toLocaleString("ru-RU")} игровых ⭐</p>{item.status==="owned"&&<small>Для вывода: {item.value.toLocaleString("ru-RU")} XTR пополнений или 5 друзей × {Math.ceil(item.value/5)} XTR</small>}<span className={`inventory-status ${item.status}`}>{item.status==="owned"?"В инвентаре":item.status==="pending"?"Заявка на вывод":item.status==="sold"?"Продано":item.status==="removed"?"Удалено администратором":item.status==="upgraded"?"Улучшено":item.status==="burned"?"Сгорел":"Передано вручную"}</span>{item.status==="owned"&&<div className="inventory-actions"><button onClick={()=>void sell(item)}>ПРОДАТЬ · +{item.sellValue} ⭐</button><button onClick={()=>void withdraw(item)}>ЗАЯВКА НА ВЫВОД ↗</button></div>}</div></article>})}</div></>}
        <p className="source-note">Продажа обменивает игровую запись на внутренние ⭐. Вывод — только заявка администратору; передача настоящего Telegram-подарка не происходит автоматически и зависит от наличия подарка.</p>
      </>}
      {tab==="games"&&<><div className="screen-kicker"><span className="red-line"/> ERRORDROP / GAMES</div><h1 className="main-title">ИГРОВАЯ<br/><em>ЗОНА.</em></h1><p className="catalog-intro">Выбери режим и запускай игру. Все игровые ⭐ — внутренний баланс ErrorDrop.</p><section className="games-grid"><button className={`game-card ${gameChoice==="crash"?"selected":""}`} onClick={()=>{setGameChoice("crash");feel()}}><div className="game-card-art crash-art"><span>↗</span></div><div><b>КРАШ</b><small>Забери выплату до перегрева ядра</small></div><i>→</i></button><button className={`game-card ${gameChoice==="upgrade"?"selected":""}`} onClick={()=>{setGameChoice("upgrade");feel()}}><div className="game-card-art upgrade-art"><span>⟳</span></div><div><b>АПГРЕЙД</b><small>Рискни подарком ради более дорогого</small></div><i>→</i></button></section><button className="spin-cta games-open" onClick={()=>navigate(gameChoice)}>{gameChoice==="crash"?"ОТКРЫТЬ КРАШ →":"ОТКРЫТЬ АПГРЕЙД →"}</button></>}      {tab==="crash"&&<><div className="screen-kicker"><span className="red-line"/> SYSTEM / CRASH</div><h1 className="main-title">КРАШ<span className="red-dot">.</span></h1><section className="crash-coming panel"><div className="crash-core">↗</div><h2>ЯДРО ГОТОВИТСЯ К ЗАПУСКУ</h2><p>Серверный раунд, ручной и авто-забор уже подключаются. Следи за коэффициентом и забирай выплату до критического сбоя.</p><button className="spin-cta" onClick={()=>notify("Краш скоро будет доступен")}>ЗАПУСТИТЬ РАУНД</button></section></>}      {tab==="upgrade"&&<><div className="screen-kicker"><span className="red-line"/> SYSTEM / OVERCLOCK</div><h1 className="main-title">АПГРЕЙД<br/><em>ПРЕДМЕТОВ.</em></h1><p className="catalog-intro">Выберите свой подарок и более дорогую цель. Рискуете только своим предметом: при неудаче он сгорает. Дополнительные ⭐ не списываются. Комиссия системы — 10% в формуле шанса.</p>
        <section className={`upgrade-machine panel ${upgradeBusy?"is-spinning":""} ${upgradeResult?upgradeResult.success?"upgrade-success":"upgrade-failure":""}`}>
          <div className="upgrade-dial" style={{"--success-deg":`${upgradeChance*3.6}deg`,"--stop-angle":`${upgradeStop}deg`} as React.CSSProperties}>
            <div className="upgrade-ticks" aria-hidden="true"/><div className="upgrade-ring"/>
            <div className="upgrade-needle-track" key={upgradeStop}><div className="upgrade-pointer" aria-hidden="true">◆<i/></div></div>
            <span className="upgrade-zero">0%</span><span className="upgrade-fifty-left">50%</span><span className="upgrade-fifty-right">50%</span><span className="upgrade-hundred">100%</span>
            <div className="upgrade-rotor"><div className="upgrade-center"><strong>{upgradeChance.toFixed(2)}%</strong><small>ШАНС УСПЕХА</small>{sourceItem&&<><img src={findGift(sourceItem.giftId)?.image} alt=""/><b>{findGift(sourceItem.giftId)?.name}</b><small>{sourceItem.value} ⭐</small></>}</div></div>
          </div>
          {targetGift&&<div className="upgrade-target"><img src={targetGift.image} alt=""/><span><small>ЦЕЛЬ / {targetValue.toLocaleString("ru-RU")} ⭐ · КОМИССИЯ 10%</small><b>{targetGift.name}</b></span><strong>{upgradeChance.toFixed(2)}%</strong></div>}
          {upgradeResult&&<div className={`upgrade-outcome ${upgradeResult.success?"success":"failure"}`}>{upgradeResult.success?`УСПЕХ! ПОЛУЧЕН ${findGift(upgradeResult.targetGiftId)?.name||upgradeResult.targetGiftId}`:"КРИТИЧЕСКИЙ СБОЙ. ПРЕДМЕТ СГОРЕЛ"}</div>}
        </section>
        <h2 className="upgrade-list-heading">01 / ВЫБЕРИТЕ ПРЕДМЕТ</h2><div className="upgrade-picks">{inventory.filter(i=>i.status==="owned").map(i=><button key={i.id} className={upgradeSource===i.id?"selected":""} disabled={upgradeBusy} onClick={()=>{setUpgradeSource(i.id);setUpgradeTarget("");setUpgradeResult(null);feel()}}><img src={findGift(i.giftId)?.image} alt=""/><b>{findGift(i.giftId)?.name||i.giftId}</b><small>{i.value} ⭐</small></button>)}{!inventory.some(i=>i.status==="owned")&&<p>В инвентаре пока нет доступных подарков.</p>}</div>
        {sourceItem&&<><h2 className="upgrade-list-heading">02 / ВЫБЕРИТЕ ЦЕЛЬ</h2><div className="upgrade-picks upgrade-targets">{upgradeTargets.map(g=><button key={g.id} className={upgradeTarget===g.id?"selected":""} disabled={upgradeBusy} onClick={()=>{setUpgradeTarget(g.id);setUpgradeResult(null);feel()}}><img src={g.image} alt=""/><b>{g.name}</b><small>{starValue(g)?.toLocaleString("ru-RU")} ⭐</small></button>)}{!upgradeTargets.length&&<p>Нет более дорогих подарков в каталоге.</p>}</div></>}
        {targetGift&&<p className="upgrade-terms">Шанс = ({sourceItem?.value} / {targetValue}) × 90% = <b>{upgradeChance.toFixed(2)}%</b>. При проигрыше исходный предмет удаляется из инвентаря. Результат определяет сервер.</p>}
        <button className="spin-cta upgrade-submit" disabled={!sourceItem||sourceItem.status!=="owned"||!targetGift||upgradeBusy} onClick={()=>void runUpgrade()}>{upgradeBusy?"СИСТЕМА ПЕРЕГРУЖАЕТСЯ…":upgradeResult?"ВЫБЕРИТЕ НОВЫЙ ПРЕДМЕТ":"УЛУЧШИТЬ →"}</button>
      </>}
      {tab==="catalog"&&<><div className="screen-kicker"><span className="red-line"/> GIFT INDEX / {gifts.length}</div><h1 className="main-title">МИР ПОДАРКОВ.<br/><em>ОДИН КАТАЛОГ.</em></h1><p className="catalog-intro">Для сопоставленных коллекций показан минимум перепродажи из Telegram в Stars (обновление до 6 часов). Для остальных — старая внутренняя оценка по TON с надбавкой 20%, не рыночная цена в Stars.</p><div className="catalog-tools"><input type="search" placeholder="Поиск подарка..." aria-label="Поиск подарка" value={query} onChange={e=>{setQuery(e.target.value);setLimit(36)}}/><span>{currentGifts.length} шт.</span></div><div className="chips">{["Все","До 1 500 ⭐","Дорогие","Без цены"].map(f=><button key={f} className={filter===f?"active":""} onClick={()=>{feel();setFilter(f);setLimit(36)}}>{f}</button>)}</div><div className="gift-grid">{currentGifts.slice(0,limit).map(g=><article className="gift-tile" key={g.id}><div className="gift-art"><img src={g.image} loading="lazy" alt={g.name}/><span>GIFT / {g.id.slice(0,3).toUpperCase()}</span></div><div className="gift-details"><b>{g.name}</b><small>{priceText(g)}</small><div><span className="catalog-label">{starValue(g)===null?"Нет в кейсах":`Кейс ${cases[giftTier(starValue(g)!)].name}`}</span><a href={g.url} target="_blank" rel="noopener noreferrer" aria-label={`Источник ${g.name}`}>↗</a></div></div></article>)}</div>{currentGifts.length>limit&&<button className="load-more" onClick={()=>setLimit(n=>n+36)}>ПОКАЗАТЬ ЕЩЁ ↓</button>}<p className="source-note">Telegram: {liveCount} сопоставленных коллекций. Если синхронизация ещё не настроена или коллекция не найдена, показывается старая оценка по скриншотам MRKT/Telegifter с надбавкой 20%. Неиспользуемые цены не подменяются выдуманными данными.</p></>}
      {tab==="profile"&&<><div className="screen-kicker"><span className="red-line"/> МОЙ ПРОФИЛЬ / {me.user.telegramId}</div><h1 className="main-title">ТВОЯ ТЕРРИТОРИЯ<span className="red-dot">.</span></h1><section className="profile-banner panel"><div className="large-avatar">{(user?.first_name||user?.username||"E")[0].toUpperCase()}</div><div><small>ИГРОК ERRORDROP</small><h2>{user?.first_name||user?.username||"Игрок"}</h2><span>ID {me.user.telegramId}</span></div><div className="profile-balance profile-balance-hidden">★ {me.user.balance.toLocaleString("ru-RU")}</div></section><section className="player-stats panel"><h2>СТАТИСТИКА ИГРОКА</h2><div><span><b>{openedCases}</b>открыто кейсов</span><span><b>{inventoryValue.toLocaleString("ru-RU")} ⭐</b>инвентарь</span><span><b>LVL {level}</b>уровень</span></div><small>Уровень: +1 за каждые 10 открытых кейсов. История отображает последние операции.</small></section><section className="invite-panel panel"><span className="panel-label">01 / КОМАНДА</span><div className="invite-art">♧</div><h2>ПРИГЛАШАЙ <em>ДРУЗЕЙ.</em></h2><p>Делись ссылкой и получай 10% игровых ⭐ от пополнений друзей.</p><div className="profile-stats"><span><b>{me.user.referralCount}</b> друзей</span><span><b>10%</b> бонус</span></div><button className="invite-btn" onClick={invite}>＋ ПРИГЛАСИТЬ ДРУГА <span>↗</span></button></section><section className="owned-panel panel profile-inventory"><div className="panel-title"><div><small>02 / НАГРАДЫ</small><h2>ИНВЕНТАРЬ</h2></div><b>{inventory.filter(i=>i.status==="owned").length + starInventory.filter(i=>i.status==='owned').length} призов</b></div><div className="inventory-bulk"><button disabled={inventoryBusy||(!inventory.some(i=>i.status==='owned')&&!starInventory.some(i=>i.status==='owned'))} onClick={()=>void sellAll()}>ПРОДАТЬ ВСЁ</button><button disabled={inventoryBusy} onClick={()=>void clearHistory()}>ОЧИСТИТЬ</button></div><div className="profile-inventory-list">{starInventory.filter(i=>i.status==='owned').map(item=><div className="profile-item" key={`star-${item.id}`}><span>⭐</span><div><b>{item.amount} игровых ⭐</b><small>Звёздный приз · {cases.find(c=>c.id===item.caseId)?.name||item.caseId}</small></div><button onClick={()=>void sellStars(item.id)}>ПРОДАТЬ</button></div>)}{inventory.filter(i=>i.status==='owned').map(item=>{const g=findGift(item.giftId);return <div className="profile-item" key={item.id}><img src={g?.image||'/errordrop-avatar.png'} alt=""/><div><b>{g?.name||item.giftId}</b><small>{item.value} ⭐ · в инвентаре</small></div><button onClick={()=>void sell(item)}>ПРОДАТЬ</button></div>})}{!inventory.some(i=>i.status==='owned')&&!starInventory.some(i=>i.status==='owned')&&<p className="ownership-note">Инвентарь пока пуст. Открой кейс, чтобы получить первый приз.</p>}</div></section><section className="panel history-panel"><h2>ИСТОРИЯ ИГР</h2><History transactions={me.transactions}/></section></>}
      {tab==="admin"&&me.user.isAdmin&&<><div className="screen-kicker"><span className="red-line"/> ACCESS LEVEL / OWNER</div><h1 className="main-title">ПАНЕЛЬ<br/><em>ВЛАДЕЛЬЦА.</em></h1><section className="admin-panel panel admin-tools"><span className="panel-label">ИНСТРУМЕНТЫ ОПЕРАТОРА</span><h2>БЫСТРЫЕ ДЕЙСТВИЯ</h2><div className="admin-tool-grid"><button className="outline-btn" onClick={()=>void reload()}>↻ ОБНОВИТЬ ДАННЫЕ</button><button className="outline-btn" onClick={()=>navigate("inventory")}>▣ МОЙ ИНВЕНТАРЬ</button><button className="outline-btn" onClick={()=>loadRequests()}>✉ ЗАЯВКИ НА ВЫВОД</button><button className="outline-btn" onClick={()=>navigate("cases")}>⬡ ОТКРЫТЬ КЕЙСЫ</button></div><p className="ownership-note">Изменения балансов и удаление предметов записываются в журнал исправлений.</p></section><section className="admin-panel panel"><span className="panel-label">ID {me.user.telegramId}</span><h2>НАЧИСЛЕНИЕ</h2><p>Игровые ⭐ на внутреннем балансе, не настоящие Telegram Stars. Пустой ID — себе.</p><label>USERNAME ИЛИ TELEGRAM ID ПОЛУЧАТЕЛЯ<input placeholder="@username или ID, пусто — себе" value={target} onChange={e=>setTarget(e.target.value)}/></label><label>КОЛИЧЕСТВО ИГРОВЫХ ⭐<input inputMode="numeric" value={amount} onChange={e=>setAmount(e.target.value)}/></label><button className="spin-cta" onClick={grant}>НАЧИСЛИТЬ →</button></section><section className="admin-panel panel"><span className="panel-label">ИНВЕНТАРЬ ИГРОКОВ</span><h2>ПОИСК ПО USERNAME</h2><p>Введи точный @username или Telegram ID. Игрок должен хотя бы раз открыть бот.</p><div className="admin-search"><input placeholder="@username или ID" value={adminQuery} onChange={e=>setAdminQuery(e.target.value)} onKeyDown={e=>e.key==="Enter"&&void searchPlayer()}/><button onClick={searchPlayer}>НАЙТИ →</button></div>{players.length>0&&<details className="admin-corrections"><summary>ИСПРАВИТЬ БАЛАНС ИЛИ ИНВЕНТАРЬ ▾</summary><p>Исправления: удалить игровые ⭐ или игровой подарок можно только с указанием причины. Ожидающие вывода и переданные подарки не удаляются.</p><label>ПРИЧИНА ИСПРАВЛЕНИЯ<input value={correctionReason} maxLength={300} placeholder="Например: ошибочное начисление" onChange={e=>setCorrectionReason(e.target.value)}/></label><label>СКОЛЬКО ИГРОВЫХ ⭐ СПИСАТЬ<input inputMode="numeric" value={removeAmount} onChange={e=>setRemoveAmount(e.target.value)} placeholder="Количество"/></label></details>}{players.map(p=><div className="admin-player" key={p.telegramId}><b>@{p.username||"без username"} · ID {p.telegramId}</b><small>Баланс: {p.balance} игровых ⭐ · подарков: {p.inventory.filter(i=>i.status==="owned").length}</small><button className="outline-btn" onClick={()=>void removeStars(p)}>СПИСАТЬ ⭐ У ЭТОГО ИГРОКА</button>{p.inventory.length? p.inventory.map(i=><div className="admin-item" key={i.id}><img src={findGift(i.giftId)?.image} alt=""/><span>#{i.id} {findGift(i.giftId)?.name||i.giftId}<small>{i.status} · ≈ {i.value} ⭐</small></span>{i.status==="owned"&&<button className="outline-btn" onClick={()=>void removeGift(p,i)}>УДАЛИТЬ</button>}</div>):<p>Инвентарь пуст</p>}</div>)}</section><section className="admin-panel panel"><span className="panel-label">ЖУРНАЛ ИСПРАВЛЕНИЙ</span><button className="outline-btn" onClick={()=>void loadAdminActions()}>ПОКАЗАТЬ ПОСЛЕДНИЕ ДЕЙСТВИЯ</button>{adminActions.map(a=><p key={a.id}>#{a.id} · ID {a.targetId} · {a.action==="remove_stars"?`−${a.amount} игровых ⭐`:`удалён подарок #${a.inventoryId}`} · {a.reason}</p>)}</section><section className="admin-panel panel"><span className="panel-label">РУЧНОЙ ВЫВОД</span><h2>ЗАЯВКИ</h2><p>Приложение не отправляет Telegram NFT. Отмечай выполненной только после передачи настоящего подарка вручную.</p><button className="outline-btn" onClick={loadRequests}>ОБНОВИТЬ ЗАЯВКИ ↻</button>{requests.map(r=><div className="withdraw-request" key={r.id}><b>#{r.id} · {findGift(r.giftId)?.name||r.giftId}</b><small>@{r.username||"без username"} · ID {r.userId} · {r.status}</small>{r.status==="pending"&&<div><button onClick={()=>review(r.id,"reject")}>ОТКЛОНИТЬ</button><button onClick={()=>review(r.id,"fulfilled")}>ПЕРЕДАНО ВРУЧНУЮ</button></div>}</div>)}</section></>}
    </main>
    <nav className="bottom-nav" aria-label="Разделы">{([ ["cases","⬡","Кейсы"],["games","⌁","Игры"],["profile","♧","Профиль"],...(me.user.isAdmin?[["admin","✦","Админ"]]:[]) ] as [Tab,string,string][]).map(([id,icon,label])=><button key={id} className={tab===id?"active":""} onClick={()=>navigate(id)}><span>{icon}</span><small>{label}</small><i/></button>)}</nav>
    {error&&<div className="toast error-toast" role="alert" onClick={()=>setError("")}>{error} <span>×</span></div>}{toast&&<div className="toast" role="status" onClick={()=>setToast("")}>{toast} <span>×</span></div>}
    {settingsOpen&&<div className="modal-scrim" onClick={()=>setSettingsOpen(false)}><section className="modal-sheet" role="dialog" aria-modal="true" aria-label="Настройки" onClick={e=>e.stopPropagation()}><div className="modal-top"><small>ERRORDROP / SETTINGS</small><button onClick={()=>setSettingsOpen(false)}>×</button></div><h2>НАСТРОЙКИ</h2><label className="toggle-row">Тактильный отклик<input type="checkbox" checked={haptics} onChange={e=>{setHaptics(e.target.checked);localStorage.setItem("ed-haptics",e.target.checked?"on":"off")}}/></label><label className="toggle-row">Меньше анимаций<input type="checkbox" checked={lessMotion} onChange={e=>{setLessMotion(e.target.checked);localStorage.setItem("ed-motion",e.target.checked?"less":"full")}}/></label></section></div>}
    {wheel&&<div className="wheel-overlay" role="dialog" aria-modal="true" aria-label="Рулетка кейса"><div className="wheel-header"><span>ERRORDROP / РУЛЕТКА</span><button disabled={!wheel.done} onClick={()=>setWheel(null)} aria-label="Закрыть">×</button></div><h2>{wheel.done?"ТВОЙ ДРОП!":"КРУТИМ КЕЙС…"}</h2><p>{cases.find(c=>c.id===wheel.result.caseId)?.name}</p>{!wheel.done&&<div className="decrypt-status"><span>РАСШИФРОВКА ПРИЗА</span><i/></div>}<div className={`wheel-window ${wheel.done?"wheel-finished":""}`} ref={wheelWindow}><div className="wheel-marker"/><div className="wheel-track" ref={wheelTrack}>{wheel.items.map((item,i)=>{const g=findGift(item.giftId);return <div className={`wheel-card ${item.giftId?"wheel-gift":"wheel-stars"}`} key={i}>{g?<img src={g.image} alt=""/>:<span>★</span>}<b>{g?.name||`${item.stars} ⭐`}</b></div>})}</div></div><p className="wheel-disclaimer">Лента — визуальная анимация, а не отображение шансов. Результат определяет сервер; лента не показывает шансы.</p>{wheel.done&&<div className="wheel-result"><div className="result-symbol">✺</div>{wheel.result.reward.type==="gift"?<><h3>{findGift(wheel.result.reward.giftId)?.name}</h3><p>Подарок сохранён в игровом инвентаре.</p><button className="spin-cta" onClick={()=>{setWheel(null);navigate("inventory")}}>В ИНВЕНТАРЬ →</button></>:<><h3>+{wheel.result.reward.stars} игровых ⭐</h3><p>{wheel.result.price?`Цена кейса ${wheel.result.price} ⭐ · приз ждёт в инвентаре`:"Звёздный приз ждёт в инвентаре"}</p><button className="spin-cta" onClick={()=>{setWheel(null);navigate("inventory")}}>В ИНВЕНТАРЬ →</button></>}</div>}</div>}
    {subscribePrompt&&<div className="modal-scrim" onClick={()=>setSubscribePrompt(false)}><section className="modal-sheet subscribe-modal" onClick={e=>e.stopPropagation()}><div className="modal-top"><small>ERRORDROP / ACCESS</small><button onClick={()=>setSubscribePrompt(false)}>×</button></div><h2>ПОДПИШИСЬ НА КАНАЛ</h2><p>Чтобы открыть бесплатный кейс, подпишись на <b>@ErrorDropNews</b>.</p><button className="spin-cta" onClick={()=>{try{WebApp.openTelegramLink("https://t.me/ErrorDropNews")}catch{window.open("https://t.me/ErrorDropNews","_blank")}}}>ОТКРЫТЬ КАНАЛ ↗</button><button className="outline-btn" onClick={async()=>{try{const status=await api.subscriptionStatus();if(status.subscribed){setSubscribePrompt(false);notify("Подписка подтверждена")}else notify("Подписка ещё не найдена")}catch{notify("Не удалось проверить подписку: добавь @ErrorDrop_Bot администратором канала @ErrorDropNews") }}}>ПРОВЕРИТЬ ПОДПИСКУ</button></section></div>}
    {buyOpen&&<BuyModal onClose={()=>setBuyOpen(false)} onPurchased={async()=>{setBuyOpen(false);await reload()}}/>}
  </div>;
}









