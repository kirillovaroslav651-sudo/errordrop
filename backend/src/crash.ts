import crypto from "crypto";
import { pool } from "./db";
import type { PoolClient } from "pg";

export const CRASH_EDGE = 0.07;
const SCALE_MS = 6000 / Math.log(2); // 2x after six seconds
const MAX_X = 1000;

// For any target x in [1.01, 1000], P(crash >= x) ~= (1 - edge) / x.
// Floor to cents rather than round; rounding to nearest changes the odds.
export function generateCrashPoint(): number {
  const u = crypto.randomInt(1, 1_000_000_001) / 1_000_000_001;
  return Math.max(1, Math.min(MAX_X, Math.floor((1 - CRASH_EDGE) / u * 100) / 100));
}
export function multiplierAt(elapsedMs: number): number {
  return Math.min(MAX_X, Math.floor(Math.exp(Math.max(0, elapsedMs) / SCALE_MS) * 100) / 100);
}
function msAt(multiplier:number) { return SCALE_MS * Math.log(multiplier); }

type Row = { id:string; user_id:string; bet:number; crash_point:string; auto_cashout:string|null;
  started_ms:string; status:string; cashout_multiplier:string|null; payout:number; resolved_ms:string|null };
function publicRound(row:Row, serverNow=Date.now()) {
  const active=row.status==='active';
  return { id:row.id,bet:Number(row.bet),autoCashout:row.auto_cashout?Number(row.auto_cashout):null,
    startedAt:Number(row.started_ms),serverNow,status:row.status,
    multiplier:active?multiplierAt(serverNow-Number(row.started_ms)):Number(row.cashout_multiplier)||Number(row.crash_point),
    payout:Number(row.payout), cashoutMultiplier:row.cashout_multiplier?Number(row.cashout_multiplier):null,
    crashPoint:active?null:Number(row.crash_point),resolvedAt:row.resolved_ms?Number(row.resolved_ms):null };
}
const cols=`id,user_id,bet,crash_point,auto_cashout,status,cashout_multiplier,payout,
  extract(epoch from started_at)*1000 AS started_ms,
  extract(epoch from resolved_at)*1000 AS resolved_ms`;

async function finish(client:PoolClient,row:Row,now:number,manual=false) {
  if(row.status!=='active') return row;
  const crash=Number(row.crash_point), auto=row.auto_cashout?Number(row.auto_cashout):null;
  const elapsed=now-Number(row.started_ms);
  const current=multiplierAt(elapsed);
  const autoReached=auto!==null && elapsed>=msAt(auto) && auto<=crash;
  // Auto cashout is settled at its server timestamp even if the client comes
  // back after the crash; an equal crash point is a winning threshold.
  const crashed=crash===1 || current>crash || elapsed>=msAt(MAX_X)+1000;
  if(!autoReached && !crashed && !manual) return row;
  if(manual && !autoReached && !crashed && current<1.01) return row;
  const cashout=autoReached?auto:manual && !crashed?current:null;
  // Unbiased rounding keeps the advertised edge close to 7% even at the
  // minimum 10-star stake (ordinary integer rounding skews 1.01x badly).
  const raw=cashout?Number(row.bet)*cashout:0;
  const payout=Math.floor(raw)+(crypto.randomInt(1_000_000)<Math.round((raw%1)*1_000_000)?1:0);
  const resolvedAt=autoReached?Number(row.started_ms)+msAt(auto!):now;
  await client.query(`UPDATE crash_rounds SET status=$1,cashout_multiplier=$2,payout=$3,resolved_at=to_timestamp($4/1000.0) WHERE id=$5 AND status='active'`,
    [cashout?'cashed':'crashed',cashout,payout,resolvedAt,row.id]);
  if(payout) await client.query('UPDATE users SET balance=balance+$1 WHERE telegram_id=$2',[payout,row.user_id]);
  if(payout) await client.query(`INSERT INTO transactions(user_id,type,amount,game,choice,ref) VALUES($1,'bet_win',$2,'crash',$3,$4)`,
    [row.user_id,payout,String(cashout),`crash-result:${row.id}`]);
  const updated=await client.query<Row>(`SELECT ${cols} FROM crash_rounds WHERE id=$1`,[row.id]);
  return updated.rows[0];
}

async function locked(client:PoolClient,userId:number,id?:string) {
  const user=await client.query('SELECT telegram_id FROM users WHERE telegram_id=$1 FOR UPDATE',[userId]);
  if(!user.rows[0])throw new Error('user_not_found');
  const result=await client.query<Row>(`SELECT ${cols} FROM crash_rounds WHERE user_id=$1 ${id?'AND id=$2':"AND status='active'"} ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,id?[userId,id]:[userId]);
  return result.rows[0]||null;
}
export async function startCrash(userId:number,id:string,bet:number,auto:number|null) {
  if(!/^[a-zA-Z0-9_-]{8,80}$/.test(id)||!Number.isInteger(bet)||bet<10||bet>10000||
    (auto!==null && (Math.abs(auto*100-Math.round(auto*100))>1e-8||auto<1.01||auto>MAX_X))) throw new Error('invalid_bet');
  const client=await pool.connect();
  try{await client.query('BEGIN');
    await client.query('SELECT telegram_id FROM users WHERE telegram_id=$1 FOR UPDATE',[userId]);
    const duplicate=await client.query<Row>(`SELECT ${cols} FROM crash_rounds WHERE id=$1`,[id]);
    if(duplicate.rows[0]){
      if(Number(duplicate.rows[0].user_id)!==userId||Number(duplicate.rows[0].bet)!==bet||
        Number(duplicate.rows[0].auto_cashout??0)!==(auto??0))throw new Error('duplicate_bet_id');
      const own=await locked(client,userId,id);
      const result=await finish(client,own!,Date.now());
      await client.query('COMMIT');return {round:publicRound(result),existing:true};
    }
    const previous=await locked(client,userId);
    if(previous){const settled=await finish(client,previous,Date.now());
      if(settled.status==='active'){await client.query('COMMIT');return {round:publicRound(settled),existing:true};}}
    const debit=await client.query('UPDATE users SET balance=balance-$1 WHERE telegram_id=$2 AND balance >= $1 RETURNING balance',[bet,userId]);
    if(!debit.rows[0]) throw new Error('insufficient_balance');
    const created=await client.query<Row>(`INSERT INTO crash_rounds(id,user_id,bet,crash_point,auto_cashout) VALUES($1,$2,$3,$4,$5) RETURNING ${cols}`,
      [id,userId,bet,generateCrashPoint(),auto]);
    await client.query(`INSERT INTO transactions(user_id,type,amount,bet_id,game) VALUES($1,'bet_lose',$2,$3,'crash')`,[userId,-bet,id]);
    await client.query('COMMIT');return {round:publicRound(created.rows[0]),existing:false,balance:Number(debit.rows[0].balance)};
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
export async function getCrash(userId:number,id:string) {
  const client=await pool.connect();try{await client.query('BEGIN');
    const row=await locked(client,userId,id);if(!row)throw new Error('round_not_found');
    const result=await finish(client,row,Date.now());await client.query('COMMIT');
    return publicRound(result);
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
export async function cashoutCrash(userId:number,id:string) {
  const client=await pool.connect();try{await client.query('BEGIN');
    const row=await locked(client,userId,id);if(!row)throw new Error('round_not_found');
    const result=await finish(client,row,Date.now(),true);await client.query('COMMIT');
    return publicRound(result);
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
export async function crashHistory() {
  const result=await pool.query(`SELECT crash_point AS "crashPoint" FROM crash_rounds WHERE status <> 'active' ORDER BY resolved_at DESC LIMIT 10`);
  return result.rows.map(row=>Number(row.crashPoint));
}
export async function activeCrash(userId:number) {
  const client=await pool.connect();try{await client.query('BEGIN');
    const row=await locked(client,userId);const result=row?publicRound(await finish(client,row,Date.now())):null;
    await client.query('COMMIT');return result;
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}

/** Settle finished rounds even when the Mini App was closed. Safe on multiple workers:
 * getCrash serializes settlement on the user's DB row and rechecks status. */
export function startCrashSettler() {
  let running=false;
  const timer=setInterval(async()=>{
    if(running)return;
    running=true;
    try {
      const result=await pool.query(`SELECT id,user_id FROM crash_rounds WHERE status='active' AND (
        crash_point=1 OR
        (auto_cashout IS NOT NULL AND auto_cashout<=crash_point AND
          extract(epoch from (clock_timestamp()-started_at))*1000 >=
          (6000.0/ln(2.0))*ln(auto_cashout::float8)) OR
        extract(epoch from (clock_timestamp()-started_at))*1000 >=
          (6000.0/ln(2.0))*ln(least((crash_point+0.01)::float8,1000.0)) +
          CASE WHEN crash_point=1000 THEN 1000 ELSE 100 END
      ) ORDER BY started_at LIMIT 100`);
      await Promise.allSettled(result.rows.map(row=>getCrash(Number(row.user_id),row.id)));
    } catch(e) {console.error('crash settlement failed',e);}
    finally {running=false;}
  },2000);
  timer.unref();
}
