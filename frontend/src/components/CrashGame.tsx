import { useCallback, useEffect, useRef, useState } from "react";
import { api, CrashRound } from "../lib/api";

const SCALE_MS = 6000 / Math.log(2);
const format = (n:number) => n.toFixed(2);
type Props = { balance:number; reload:()=>Promise<void>; feel:(kind?:"light"|"medium"|"heavy")=>void; demo:boolean };

export default function CrashGame({balance,reload,feel,demo}:Props) {
  const [round,setRound]=useState<CrashRound|null>(null);
  const [history,setHistory]=useState<number[]>([]);
  const [bet,setBet]=useState("100");
  const [repeat,setRepeat]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [tick,setTick]=useState(Date.now());
  const offset=useRef(0);
  const pending=useRef(false);
  const submitting=useRef(false);
  const lastResult=useRef("");
  const plan=useRef<{bet:number;remaining:number}|null>(null);
  const latest=useRef<CrashRound|null>(null);

  const accept=useCallback((next:CrashRound|null)=>{
    const previous=latest.current;
    if(previous && (!next || (next.id===previous.id && previous.status!=="active" && next.status==="active") ||
      (next.id!==previous.id && next.startedAt<previous.startedAt)))return;
    if(next) offset.current=next.serverNow-Date.now();
    latest.current=next;
    setRound(next);
  },[]);
  useEffect(()=>{
    if(demo)return;
    let mounted=true;
    api.crashState().then(data=>{if(mounted){accept(data.round);setHistory(data.history)}})
      .catch(()=>{if(mounted)setMessage("Не удалось загрузить раунд. Попробуй открыть вкладку снова.")});
    return()=>{mounted=false;plan.current=null};
  },[accept,demo]);
  useEffect(()=>{
    if(!round || round.status!=="active" || demo)return;
    let cancelled=false;
    const poll=()=>{if(document.visibilityState!=="visible"||pending.current)return;
      pending.current=true;
      void api.crashRound(round.id).then(({round:next})=>{if(!cancelled)accept(next)})
        .catch(()=>{if(!cancelled)setMessage("Связь с сервером потеряна — результат определяет сервер.")})
        .finally(()=>{pending.current=false});
    };
    const id=window.setInterval(poll,500);
    const visibility=()=>{if(document.visibilityState==="visible")poll()};
    document.addEventListener("visibilitychange",visibility);
    return()=>{cancelled=true;window.clearInterval(id);document.removeEventListener("visibilitychange",visibility)};
  },[round?.id,round?.status,accept,demo]);
  useEffect(()=>{if(round?.status!=="active")return;
    const id=window.setInterval(()=>setTick(Date.now()),50);
    return()=>window.clearInterval(id);
  },[round?.id,round?.status]);

  const multiplier=round?.status==="active"
    ?Math.min(1000,Math.floor(Math.exp(Math.max(0,tick+offset.current-round.startedAt)/SCALE_MS)*100)/100)
    :round?.cashoutMultiplier??round?.crashPoint??1;
  const progress=Math.min(1,Math.log(Math.max(1,multiplier))/Math.log(10));
  const curve=Array.from({length:22},(_,i)=>{
    const x=i/21, y=84-65*Math.pow(x,2.15); return `${7+x*86},${y}`;
  }).join(" ");

  async function launch(amount:number) {
    if(submitting.current || latest.current?.status==="active")return;
    submitting.current=true;
    setBusy(true);setMessage("");feel("medium");
    try {
      const result=await api.crashStart(crypto.randomUUID(),amount,null);
      accept(result.round);
      if(result.existing) { plan.current=null; setRepeat(false);setMessage("Сначала заверши текущий раунд."); }
      await reload();
    } catch(e:any) {plan.current=null;setRepeat(false);setMessage(e?.message==="insufficient_balance"?"Недостаточно игровых ⭐ для ставки.":"Не удалось запустить раунд: "+(e?.message||"ошибка сети"));}
    finally {submitting.current=false;setBusy(false);}
  }
  function start() {
    if(demo)return setMessage("Для игры открой Mini App через Telegram.");
    const amount=Number(bet);
    if(!Number.isInteger(amount)||amount<10||amount>10000)return setMessage("Ставка — от 10 до 10 000 игровых ⭐.");
    if(amount>balance)return setMessage("Недостаточно игровых ⭐ для ставки.");
    plan.current=repeat?{bet:amount,remaining:4}:null;
    void launch(amount);
  }
  async function cashout() {
    const current=latest.current;
    if(!current||current.status!=="active"||submitting.current)return;
    submitting.current=true;
    setBusy(true);feel("medium");
    try {const {round:next}=await api.crashCashout(current.id);accept(next);
      if(next.status==="active")setMessage("Забрать можно начиная с 1.01x.");
    } catch {setMessage("Не удалось забрать. Проверь результат раунда.");}
    finally {submitting.current=false;setBusy(false);}
  }
  useEffect(()=>{
    if(!round||round.status==="active"||lastResult.current===round.id)return;
    lastResult.current=round.id;
    feel(round.status==="cashed"?"medium":"heavy");
    void reload();
    void api.crashState().then(data=>setHistory(data.history)).catch(()=>undefined);
    const next=plan.current;
    if(!next||next.remaining<=0){plan.current=null;setRepeat(false);return;}
    const timeout=window.setTimeout(()=>{
      if(!plan.current)return;
      plan.current.remaining--;
      void launch(next.bet);
    },1800);
    return()=>window.clearTimeout(timeout);
  },[round?.id,round?.status]);

  return <div className="crash-game">
    <div className="crash-heading"><span>ED // CORE_07</span><span className="crash-live"><i/> {round?.status==="active"?"РАУНД ИДЁТ":"СИСТЕМА ГОТОВА"}</span></div>
    <section className={`crash-stage ${round?.status==="crashed"?"crash-lost":round?.status==="cashed"?"crash-won":""} ${multiplier>=5&&round?.status==="active"?"overheat":""}`}>
      <div className="crash-grid"/><div className="crash-scan"/>
      <div className="crash-readout"><small>{round?.status==="crashed"?"КРИТИЧЕСКИЙ СБОЙ / ERROR 0x000000FF":round?.status==="cashed"?"ДАННЫЕ ЗАФИКСИРОВАНЫ":"ЗАГРУЗКА ЯДРА / LIVE MULTIPLIER"}</small>
        <strong className={multiplier<2?"low":multiplier<5?"mid":"high"}>{format(multiplier)}<span>×</span></strong>
        <p>{round?.status==="cashed"?`ВЫПЛАТА +${round.payout} ИГРОВЫХ ⭐`:round?.status==="crashed"?`СТАВКА СГОРЕЛА · ${round.crashPoint?.toFixed(2)}x`:round?.status==="active"?`СТАВКА ${round.bet} ⭐ · ЗАБЕРИ ВОВРЕМЯ`:"ЗАПУСТИ ЯДРО И ЗАБЕРИ ВЫИГРЫШ ДО СБОЯ"}</p></div>
      <svg className="crash-chart" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="crashLine" x1="0" x2="1"><stop stopColor="#8b0000"/><stop offset="1" stopColor="#ff5722"/></linearGradient></defs><path d="M 7 88 H 96 M 7 88 V 15" className="crash-axis"/><polyline points={curve} fill="none" stroke="url(#crashLine)" strokeWidth="1.8" strokeLinecap="round" strokeDasharray="160" strokeDashoffset={160*(1-progress)}/><circle cx={7+86*progress} cy={84-65*Math.pow(progress,2.15)} r="2.1" className="crash-orb"/></svg>
      <div className="crash-core-visual" style={{left:`${10+80*progress}%`,bottom:`${7+42*progress}%`}}>◆</div>
      <span className="crash-stage-foot">SECURE LINK // {round?.status==="active"?"UNSTABLE":"STANDBY"}</span>
    </section>
    <section className="crash-console panel"><div className="crash-console-top"><span>01 / УПРАВЛЕНИЕ</span><small>HOUSE EDGE 7% · ТОЛЬКО ИГРОВЫЕ ⭐</small></div>
      {round?.status==="active"?<button className="spin-cta crash-action cashout" disabled={busy||multiplier<1.01} onClick={()=>void cashout()}>{busy?"ПРОВЕРКА…":`ЗАБРАТЬ · ≈ ${Math.round(round.bet*multiplier)} ⭐`}</button>
        :<><div className="crash-fields"><label>СТАВКА <span>⭐</span><input inputMode="numeric" type="number" min="10" max="10000" value={bet} onChange={e=>setBet(e.target.value)}/></label></div>
          <div className="crash-quick">{[10,50].map(n=><button key={n} onClick={()=>setBet(String(Math.min(10000,(Number(bet)||0)+n)))}>+{n}</button>)}<button onClick={()=>setBet(String(Math.min(10000,(Number(bet)||0)*2)))}>×2</button><button onClick={()=>setBet(String(Math.min(10000,balance)))}>MAX</button></div>
          <label className="crash-repeat"><input type="checkbox" checked={repeat} onChange={e=>{setRepeat(e.target.checked);if(!e.target.checked)plan.current=null}}/> АВТО-СТАВКА <small>не больше 5 раундов; можно остановить</small></label>
          <button className="spin-cta crash-action" disabled={busy||demo} onClick={start}>{busy?"ЗАПУСК…":"ЗАПУСТИТЬ ЯДРО →"}</button></>}
      {plan.current&&<button className="crash-stop" onClick={()=>{plan.current=null;setRepeat(false);setMessage("Авто-ставка остановлена после текущего раунда.")}}>ОСТАНОВИТЬ АВТО-СТАВКУ</button>}
      {message&&<p className="crash-feedback" role="status">{message}</p>}
    </section>
    <section className="crash-history"><div><span>02 / ИСТОРИЯ СБОЕВ</span><small>ПОСЛЕДНИЕ 10 РАУНДОВ</small></div><div className="crash-history-list">{history.length?history.map((point,i)=><span key={i} className={point<2?"low":point<5?"mid":"high"}>{format(point)}×</span>):<p>Раундов пока нет</p>}</div></section>
  </div>;
}
