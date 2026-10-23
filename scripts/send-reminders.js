/* Sends Yommy reminders via FCM. Runs hourly from GitHub Actions. */
const pad=n=>String(n).padStart(2,'0');
function wall(tz,d){const p={};new Intl.DateTimeFormat('en-US',{timeZone:tz,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric'}).formatToParts(d).forEach(x=>p[x.type]=+x.value);return p}
/* Same rules as the app: personal day starts 2:00 AM, window 12:00-24:00, every 1 or 2 hours. */
function evaluate(state,tz,now){
  if(!state||!state.hourly||!Array.isArray(state.tasks))return null;
  const w=wall(tz,now),h=w.hour,off=(h-12+24)%24;
  if(off>12)return null;if(Number(state.every)===2&&off%2)return null;
  const dt=new Date(Date.UTC(w.year,w.month-1,w.day-(w.hour<2?1:0)));
  const day=`${dt.getUTCFullYear()}-${pad(dt.getUTCMonth()+1)}-${pad(dt.getUTCDate())}`,dow=dt.getUTCDay();
  const fresh=state.lastDay===day; // done flags of daily/weekly tasks are only valid for lastDay
  const pending=state.tasks.filter(t=>t.type==='daily'||(t.type==='weekly'&&Number(t.weekday)===dow)||(t.type==='once'&&t.date===day))
    .filter(t=>!(t.done&&(t.type==='once'||fresh)));
  if(!pending.length)return null;
  pending.sort((a,b)=>(a.time||'99:99').localeCompare(b.time||'99:99'));
  return {key:day+'-'+h,pending};
}
function message(ev,lang){const n=ev.pending.length,en=lang==='en';
  return {title:en?`Yommy — ${n} tasks left`:`يومي — لسه ${n} مهام`,body:ev.pending.slice(0,4).map(x=>(x.time?x.time+' ':'')+x.name).join(en?', ':'، ')}}
module.exports={evaluate,message};
if(require.main===module){(async()=>{
  const admin=require('firebase-admin');
  admin.initializeApp({credential:admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))});
  const db=admin.firestore(),snap=await db.collection('users').get();let sent=0;
  for(const doc of snap.docs){
    const d=doc.data(),tokens=d.tokens||[];if(!tokens.length||!d.json)continue;
    let state;try{state=JSON.parse(d.json)}catch(e){continue}
    const ev=evaluate(state,d.tz||'Africa/Cairo',new Date());if(!ev||d.lastPush===ev.key)continue;
    const m=message(ev,d.lang);let ok=0;
    for(const token of tokens){
      try{await admin.messaging().send({token,data:{title:m.title,body:m.body,tag:ev.key},webpush:{headers:{Urgency:'high',TTL:'3600'}}});ok++}
      catch(e){if(/registration-token-not-registered|invalid-argument|invalid-registration/.test(e.code||''))await doc.ref.update({tokens:admin.firestore.FieldValue.arrayRemove(token)});else console.error(e.code)}
    }
    if(ok){await doc.ref.update({lastPush:ev.key});sent++}
  }
  console.log('users notified:',sent);process.exit(0)})().catch(e=>{console.error(e);process.exit(1)})}
