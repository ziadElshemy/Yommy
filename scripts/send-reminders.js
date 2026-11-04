'use strict';
/*
  Yommy — scheduled reminders (runs on GitHub Actions, free).
  For every signed-in user it reads the data the app already saves in Firestore (users/{uid}: json, tz, lang, tokens)
  and, when the user's LOCAL hour is a multiple of 3 (0,3,6,...,21) and they still have unfinished tasks today,
  sends one push message to their devices. The app's service worker (sw.js) shows it.
  Same rules as the in-page reminder: every 3 hours around the clock, only if the "reminder" switch is on,
  day starts at 02:00, same notification tag (so you never get two copies), no reminders on a rest day.
*/

const DEAD = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

/* the user's local date/hour for a given moment and IANA time zone */
function localParts(now, tz) {
  const mk = z => new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  let fmt;
  try { fmt = mk(tz || 'UTC'); } catch (e) { fmt = mk('UTC'); }
  const p = {};
  fmt.formatToParts(now).forEach(x => { p[x.type] = x.value; });
  return { y: +p.year, m: +p.month, d: +p.day, h: (+p.hour) % 24 };
}

/* same as the app's logicalDate(): before 02:00 still counts as the previous day */
function logicalDate(lp) {
  const t = Date.UTC(lp.y, lp.m - 1, lp.d) - (lp.h < 2 ? 86400000 : 0);
  return new Date(t).toISOString().slice(0, 10);
}

/* tasks scheduled for the Yommy day `today` and the ones still unfinished.
   Applies the same daily reset the app does when it was not opened since the day changed. */
function tasksForDay(st, today) {
  let tasks = Array.isArray(st.tasks) ? st.tasks.filter(t => t && typeof t.name === 'string' && t.name.trim()) : [];
  if (st.lastDay && st.lastDay < today) {
    tasks = tasks
      .filter(t => !(t.type === 'once' && t.done))
      .map(t => t.type === 'once' ? { ...t, date: t.date < today ? today : t.date, done: false } : { ...t, done: false });
  }
  const wd = new Date(today + 'T00:00:00Z').getUTCDay();
  const scheduled = tasks.filter(t => {
    if (Array.isArray(t.skip) && t.skip.includes(today)) return false;   /* "skip this day" */
    if (t.type === 'daily') return true;
    if (t.type === 'weekly') return Array.isArray(t.weekdays) && t.weekdays.length ? t.weekdays.map(Number).includes(wd) : wd === Number(t.weekday);
    return t.date === today;
  });
  return { scheduled, pending: scheduled.filter(t => !t.done) };
}
const pendingTasks = (st, today) => tasksForDay(st, today).pending;

/* wording: identical to the app (index.html: leftTitle / doneTexts / reminderContent) */
function leftTitle(n, en) {
  if (en) return `Yommy — ${n} ${n === 1 ? 'task' : 'tasks'} left`;
  return 'يومي — لسه ' + (n === 1 ? 'مهمة واحدة' : n === 2 ? 'مهمتين' : n <= 10 ? n + ' مهام' : n + ' مهمة');
}
function doneMessage(n, lang) {
  if (lang === 'en') return { title: 'Yommy — All tasks done for today 🎉', body: `You completed ${n} ${n === 1 ? 'task' : 'tasks'} today. Great job!` };
  return { title: 'يومي — خلصت كل مهام النهارده 🎉', body: n === 1 ? 'خلصت مهمتك النهارده. عاش!' : n === 2 ? 'خلصت مهمتين النهارده. عاش!' : `خلصت ${n} ${n <= 10 ? 'مهام' : 'مهمة'} النهارده. عاش!` };
}
function buildMessage(pending, lang) {
  const en = lang === 'en';
  const sorted = [...pending].sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
  const shown = sorted.slice(0, 4).map(x => (x.time ? x.time + ' ' : '') + x.name).join(en ? ', ' : '، ');
  const more = sorted.length > 4 ? (en ? `, +${sorted.length - 4} more` : `، و${sorted.length - 4} كمان`) : '';
  return { title: leftTitle(pending.length, en), body: shown + more };
}

async function run({ db, messaging, FieldValue, now = new Date(), force = false, log = console.log }) {
  const snap = await db.collection('users').get();
  let checked = 0, sent = 0;
  for (const doc of snap.docs) {
    const u = doc.data();
    const who = 'user ' + doc.id.slice(0, 6) + '…: ';
    const tokens = Array.isArray(u.tokens) ? u.tokens.filter(t => typeof t === 'string' && t) : [];
    if (!tokens.length) { log(who + 'skipped - no device registered (sign in with Google and enable notifications in the app)'); continue; }
    if (typeof u.json !== 'string') { log(who + 'skipped - no saved data yet'); continue; }
    let st;
    try { st = JSON.parse(u.json); } catch (e) { log(who + 'skipped - saved data is unreadable'); continue; }
    if (!st || !st.hourly) { log(who + 'skipped - the reminder switch is off in the app'); continue; }
    const lp = localParts(now, u.tz);
    if (!force && lp.h % 3) { log(who + `skipped - not a reminder hour (local hour ${lp.h}, time zone ${u.tz || 'UTC'})`); continue; }   /* force = manual test run: ignore the 3-hour slot */
    checked++;
    const today = logicalDate(lp);
    const slot = `${today}-${lp.h}`;          /* one message per user per reminder slot */
    const tag = 'yommy-' + today;             /* one notification per Yommy day: a newer one replaces the older (same as the app) */
    if (!force && u.remindSent === slot) { log(who + 'skipped - already notified this hour'); continue; }
    if (st.history && st.history[today] && st.history[today].rest) { log(who + 'skipped - today is marked as a rest day'); continue; }
    const { scheduled, pending } = tasksForDay(st, today);
    const lang = u.lang === 'en' ? 'en' : 'ar';
    let msg, isDone = false;
    if (!scheduled.length) { log(who + `skipped - no tasks scheduled today (${Array.isArray(st.tasks) ? st.tasks.length : 0} tasks saved; app last synced day ${st.lastDay || '?'}, server day ${today})`); continue; }
    if (!pending.length) {
      if (!force && u.completeSent === today) { log(who + 'skipped - all tasks done, congratulations already sent today'); continue; }
      msg = doneMessage(scheduled.length, lang); isDone = true;
    } else msg = buildMessage(pending, lang);
    const res = await messaging.sendEachForMulticast({
      tokens,
      data: { title: msg.title, body: msg.body, tag },
      webpush: { headers: { TTL: '7200', Urgency: 'high' } }
    });
    const dead = [];
    res.responses.forEach((r, i) => { if (!r.success && r.error && DEAD.has(r.error.code)) dead.push(tokens[i]); });
    const upd = {};
    if (res.successCount > 0) { upd.remindSent = slot; if (isDone) upd.completeSent = today; sent++; }
    if (dead.length) upd.tokens = FieldValue.arrayRemove(...dead);
    if (Object.keys(upd).length) await doc.ref.update(upd);
    log(`user ${doc.id.slice(0, 6)}…: ${isDone ? 'all ' + scheduled.length + ' done (congrats)' : pending.length + ' of ' + scheduled.length + ' pending'}, ${res.successCount} sent, ${dead.length} dead tokens removed`);
  }
  log(`done: ${snap.size} users, ${checked} in a reminder hour, ${sent} notified`);
  return { sent, checked };
}

async function main() {
  const admin = require('firebase-admin');
  let sa;
  try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || ''); } catch (e) { throw new Error('FIREBASE_SERVICE_ACCOUNT secret is missing or is not valid JSON'); }
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  await run({ db: admin.firestore(), messaging: admin.messaging(), FieldValue: admin.firestore.FieldValue, force: process.env.FORCE === 'true' });
}

if (require.main === module) main().catch(e => { console.error('Reminder run failed:', e.message); process.exit(1); });
module.exports = { run, pendingTasks, tasksForDay, buildMessage, doneMessage, leftTitle, localParts, logicalDate };
