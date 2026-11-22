'use strict';
/*
  Yommy — scheduled reminders (runs on GitHub Actions, free).
  For every signed-in user it reads the data the app already saves in Firestore (users/{uid}: json, tz, lang, tokens)
  and, once per 3-hour slot of the user's LOCAL time (0-2, 3-5, ..., 21-23; the first run inside the slot sends) when they still have unfinished tasks today,
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
      .map(t => t.type === 'once' ? { ...t } : { ...t, done: false });   /* unfinished one-time tasks of an ended day are POSTPONED by the app (not moved to today), so they are not scheduled today */
  }
  const wd = new Date(today + 'T00:00:00Z').getUTCDay();
  const scheduled = tasks.filter(t => {
    if (t.type === 'daily') return true;
    if (t.type === 'weekly') return Array.isArray(t.weekdays) && t.weekdays.length ? t.weekdays.map(Number).includes(wd) : wd === Number(t.weekday);
    return !t.postponed && t.date === today;
  });
  /* occurrences the user skipped today ("Skip today" is stored on today's history record) are neither pending nor counted */
  const hr = st.history && st.history[today] && Array.isArray(st.history[today].records) ? st.history[today].records : [];
  const skip = new Set(hr.filter(r => r && r.skipped && !r.done).map(r => r.id));
  const active = scheduled.filter(t => !skip.has(t.id));
  return { scheduled: active, pending: active.filter(t => !t.done) };
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
  log(`run at ${now.toISOString()} (UTC)${force ? ' [FORCED test run]' : ''}`);
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
    /* GitHub's scheduler is best-effort: hourly runs often start late or are dropped. So instead of requiring the run to land exactly on
       hour 0,3,6..., each user has one 3-hour SLOT (0-2, 3-5, ...). The first run inside the slot sends the reminder; later runs of the same slot do nothing. */
    const slotHour = lp.h - (lp.h % 3);
    checked++;
    const today = logicalDate(lp);
    const calDate = `${lp.y}-${String(lp.m).padStart(2, '0')}-${String(lp.d).padStart(2, '0')}`;   /* calendar date (not the 02:00 day) so slot 0-2 is one slot */
    const slot = `${calDate}-${slotHour}`;    /* one message per user per reminder slot */
    const tag = 'yommy-' + today;             /* one notification per Yommy day: a newer one replaces the older (same as the app) */
    if (!force && u.remindSent === slot) { log(who + `skipped - already notified in this 3-hour slot (${slotHour}:00, local hour ${lp.h}, time zone ${u.tz || 'UTC'})`); continue; }
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
    res.responses.forEach((r, i) => { if (!r.success && r.error) { if (DEAD.has(r.error.code)) dead.push(tokens[i]); else log(who + 'send failed: ' + (r.error.code || '') + ' ' + (r.error.message || '')); } });
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
