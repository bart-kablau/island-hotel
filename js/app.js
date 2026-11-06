// Island Hotel bookings: the app. Screens: Today, Planning, Bookings, Changes, Reports, Admin, plus the
// booking sheet (detail, new, edit). Data: Firestore with offline cache; see ../../ontwerp.
import * as L from './logic.js';
import { saveBooking, explainError } from './ops.js';
import { firebaseConfig, USE_EMULATOR, SDK, TIMEZONE, DAYS_BACK } from './config.js';

const [{ initializeApp }, A, F] = await Promise.all([
  import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js')
]);

const fbApp = initializeApp(USE_EMULATOR ? { apiKey: 'emulator', projectId: 'demo-ih', authDomain: 'localhost' } : firebaseConfig);
const auth = A.getAuth(fbApp);
const db = F.initializeFirestore(fbApp, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
if (USE_EMULATOR) {
  A.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  F.connectFirestoreEmulator(db, '127.0.0.1', 8181);
}

// ---------------------------------------------------------------- state

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SESSION = Math.random().toString(36).slice(2);
const S = {
  user: null, claims: {}, tab: 'today', day: null, zoom: load('ih.zoom', null), today: L.todayIn(TIMEZONE),
  rooms: [], roomsById: new Map(), users: new Map(), bookings: new Map(), older: null,
  loaded: false, online: navigator.onLine, feed: null, filter: 'upcoming', q: '', backup: null,
  sortBy: 'checkin', sortDir: null,
  rep: { year: null, rooms: '', source: '', withOptions: false, metric: 'nights', month: null, open: '' },
  bcom: { standard: 2, deluxe: 2, withOptions: true, ...load('ih.bcom', {}) },
  pending: load('ih.pending', []), rejected: load('ih.rejected', []), unsubs: [], feedUnsub: null
};
function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function keepBcom() { try { localStorage.setItem('ih.bcom', JSON.stringify(S.bcom)); } catch { /* private mode */ } }
function keep() {
  try { localStorage.setItem('ih.pending', JSON.stringify(S.pending)); localStorage.setItem('ih.rejected', JSON.stringify(S.rejected)); } catch { /* private mode */ }
}

const roomName = id => S.roomsById.get(id)?.name || String(id || '').replace(/-/g, ' ');
const userName = email => S.users.get(email)?.name || String(email || '').split('@')[0];
const allBookings = () => S.older ? new Map([...S.older, ...S.bookings]) : S.bookings;
function nightIndex(skipId) {
  const idx = new Map();
  for (const b of allBookings().values()) {
    if (b.id === skipId) continue;
    for (const n of L.nightDocs(b)) idx.set(n.id, { bookingId: b.id });
  }
  return idx;
}

let frame = 0;
function render() { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); }
function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}
const ICON = {
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>'
};

// ---------------------------------------------------------------- sign in

A.onAuthStateChanged(auth, async user => {
  S.unsubs.forEach(u => u()); S.unsubs = [];
  S.user = user; S.claims = {}; S.loaded = false;
  if (user) S.claims = (await user.getIdTokenResult()).claims;
  if (user && S.claims.staff) startData();
  draw();
});

async function signIn() {
  const p = new A.GoogleAuthProvider();
  p.setCustomParameters({ prompt: 'select_account' });
  try { await A.signInWithPopup(auth, p); }
  catch (e) {
    if (String(e.code).includes('popup-blocked')) return A.signInWithRedirect(auth, p);
    if (!String(e.code).includes('popup-closed')) toast('Sign in failed: ' + (e.code || e.message));
  }
}
async function checkAgain() {
  await S.user.getIdToken(true);
  S.claims = (await S.user.getIdTokenResult()).claims;
  if (S.claims.staff) startData(); else toast('No access yet. Ask Fun, it can take up to 10 minutes.');
  draw();
}

// ---------------------------------------------------------------- live data

function startData() {
  const since = L.addDays(S.today, -DAYS_BACK);
  S.unsubs.push(F.onSnapshot(F.collection(db, 'rooms'), snap => {
    S.rooms = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || a.name.localeCompare(b.name));
    S.roomsById = new Map(S.rooms.map(r => [r.id, r]));
    render();
  }));
  S.unsubs.push(F.onSnapshot(F.collection(db, 'users'), snap => {
    S.users = new Map(snap.docs.map(d => [d.id, { email: d.id, ...d.data() }]));
    render();
  }));
  S.unsubs.push(F.onSnapshot(F.query(F.collection(db, 'bookings'), F.where('checkOut', '>=', since)),
    { includeMetadataChanges: true }, snap => {
      S.bookings = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data(), _pending: d.metadata.hasPendingWrites }]));
      S.loaded = true;
      if (!snap.metadata.fromCache) checkOldPending();
      render();
    }, err => toast('Could not load bookings: ' + err.code)));
  if (S.claims.admin) {
    S.unsubs.push(F.onSnapshot(F.doc(db, 'meta', 'backup'), d => { S.backup = d.exists() ? d.data() : null; render(); }, () => {}));
  }
}

// A save made in an earlier session (phone closed while offline) has no promise any more:
// once the server has answered, see whether the booking reached the version we sent.
function checkOldPending() {
  let changed = false;
  for (const p of [...S.pending]) {
    if (p.session === SESSION) continue;
    const b = S.bookings.get(p.id);
    if (b && b._pending) continue;
    if (b && (b.version || 0) >= p.expect) { S.pending = S.pending.filter(x => x !== p); changed = true; continue; }
    S.pending = S.pending.filter(x => x !== p);
    S.rejected.push({ id: p.id, guestName: p.guestName, msg: 'Not saved after the phone came back online: a room was taken or someone else changed it.', attempt: p.attempt, at: Date.now() });
    changed = true;
  }
  if (changed) { keep(); render(); }
}

window.addEventListener('online', () => { S.online = true; render(); });
window.addEventListener('offline', () => { S.online = false; render(); });

// ---------------------------------------------------------------- saving

function save(before, after, { action, done } = {}) {
  const errors = L.validate(after);
  const clash = L.conflicts(nightIndex(after.id), before, after);
  if (clash.length) {
    const c = clash[0];
    const other = allBookings().get(c.bookingId);
    errors.push(roomName(c.roomId) + ' is taken on ' + L.fmtDate(c.date) + (other ? ' by ' + other.guestName : '') + (clash.length > 1 ? ' (and ' + (clash.length - 1) + ' more nights)' : '') + '.');
  }
  const live = before && S.bookings.get(before.id);
  if (live && (live.version || 0) > (before.version || 0)) {
    errors.push('Changed by ' + userName(live.updatedBy) + ' a moment ago. Close and open the booking again to see the new version.');
  }
  if (errors.length) return errors;

  const me = S.user.email;
  const p = { id: after.id, guestName: after.guestName, expect: (before?.version || 0) + 1, session: SESSION, attempt: after, at: Date.now() };
  S.pending.push(p); keep();
  S.rejected = S.rejected.filter(r => r.id !== after.id); keep();
  saveBooking(F, db, { before, after, me, action })
    .then(() => { S.pending = S.pending.filter(x => x !== p); keep(); toast(done || 'Saved'); render(); })
    .catch(err => {
      S.pending = S.pending.filter(x => x !== p);
      S.rejected.push({ id: after.id, guestName: after.guestName, msg: explainError(err, before), attempt: after, at: Date.now() });
      keep(); render();
    });
  if (!S.online) toast('Saved on this phone. It is sent when there is internet.', 4500);
  render();
  return [];
}

// ---------------------------------------------------------------- frame

function draw() {
  const signedIn = S.user && S.claims.staff;
  $('#tabs').hidden = !signedIn;
  $('#tabs [data-tab="admin"]').hidden = !S.claims.admin;
  $('#tabs [data-tab="reports"]').hidden = !S.claims.admin;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  const conn = $('#conn');
  if (!S.user) conn.hidden = true;
  else {
    conn.hidden = false;
    const waiting = S.pending.length;
    conn.className = 'conn' + (!S.online ? ' off' : waiting ? ' wait' : '');
    conn.textContent = !S.online ? 'Offline' + (waiting ? ' · ' + waiting + ' waiting' : '') : waiting ? waiting + ' sending…' : '● Online';
  }
  $('#title').textContent = signedIn ? { today: 'Today', planning: 'Planning', bookings: 'Bookings', changes: 'Recent changes', reports: 'Reports', admin: 'Admin' }[S.tab] : 'Island Hotel';
  drawBanners(signedIn);
  // An open booking follows live changes (someone else saves, or our own save comes back).
  if (SHEET?.kind === 'detail') {
    const live = allBookings().get(SHEET.id);
    if (live && (live.version !== SHEET.b.version || live._pending !== SHEET.b._pending)) {
      const reload = live.version !== SHEET.b.version;
      SHEET.b = live; drawSheet();
      if (reload) F.getDocs(F.query(F.collection(db, 'bookings', SHEET.id, 'history'), F.orderBy('at', 'desc'))).then(s => { if (SHEET?.kind === 'detail') { SHEET.history = s.docs.map(d => d.data()); drawSheet(); } }).catch(() => {});
    }
  }
  const main = $('#main');
  if (!S.user) main.innerHTML = loginHtml();
  else if (!S.claims.staff) main.innerHTML = waitingHtml();
  else if (!S.loaded) main.innerHTML = '<div class="center muted">Loading bookings…</div>';
  else ({ today: drawToday, planning: drawPlanning, bookings: drawBookings, changes: drawChanges, reports: drawReports, admin: drawAdmin }[S.tab] || drawToday)(main);
}

function drawBanners(signedIn) {
  const el = $('#banners');
  if (!signedIn) { el.innerHTML = ''; return; }
  let h = '';
  S.rejected.forEach((r, i) => {
    h += `<div class="banner red"><div><b>${esc(r.guestName)}:</b> ${esc(r.msg)}</div><button type="button" data-fix="${i}">Fix</button></div>`;
  });
  const waiting = S.pending.length;
  if (waiting && !S.online) h += `<div class="banner yel"><div>${waiting} change${waiting > 1 ? 's' : ''} waiting for internet. Keep the app open or open it again later.</div></div>`;
  el.innerHTML = h;
}

function loginHtml() {
  return `<div class="login"><img src="img/logo-512.png" alt="Island Hotel Janjanbureh"><h2 style="margin:12px 0 4px">Bookings</h2>
    <p>Sign in with the Google account that Fun gave access.</p>
    <button class="btn primary big" type="button" data-act="signin">Sign in with Google</button>
    ${USE_EMULATOR ? '<p style="margin-top:20px">Test sign-in (only on this laptop)</p><div class="row"><input class="in" id="devmail" value="yama@test.gm" aria-label="Test e-mail"><button class="btn" type="button" data-act="devsignin">Sign in</button></div>' : ''}
  </div>`;
}
function waitingHtml() {
  return `<div class="login"><img src="img/logo-512.png" alt=""><h2 style="margin:12px 0 4px">Waiting for access</h2>
    <p>You are signed in as <b>${esc(S.user.email)}</b>. Ask Fun to add this address. After that it can take up to 10 minutes.</p>
    <button class="btn primary big" type="button" data-act="checkagain">Check again</button>
    <p><button class="link" type="button" data-act="signout">Use another account</button></p></div>`;
}

// ---------------------------------------------------------------- planning

function barClass(b, l) {
  if (l.status === 'Option') return 'o';
  if (l.status === 'Request') return 'q';
  return l.paid === 'Yes' ? 'c' : 'n';
}

// ---------------------------------------------------------------- today (the front desk view)

// What matters right now: who arrives, who leaves, who sleeps where tonight, and what is free.
function drawToday(main) {
  if (!S.day) S.day = S.today;
  const day = S.day;
  const list = [...allBookings().values()].filter(b => L.activeLines(b).length);
  const arriving = list.filter(b => b.checkIn === day).sort((a, b) => a.guestName.localeCompare(b.guestName));
  const leaving = list.filter(b => b.checkOut === day).sort((a, b) => a.guestName.localeCompare(b.guestName));
  const tonight = new Map(); // roomId -> {b, l}
  for (const b of list) if (b.checkIn <= day && b.checkOut > day) for (const l of L.activeLines(b)) tonight.set(l.roomId, { b, l });
  const leavingRooms = new Set(leaving.flatMap(b => L.activeLines(b).map(l => l.roomId)));
  const rooms = S.rooms.filter(r => r.active !== false);
  const free = rooms.filter(r => !tonight.has(r.id));

  let tiles = '', building = null;
  for (const r of rooms) {
    if (r.building !== building) {
      if (building !== null) tiles += '</div>';
      building = r.building;
      tiles += `<div class="dayhead">${esc(building || 'Other')}</div><div class="tiles">`;
    }
    const t = tonight.get(r.id);
    const name = r.name.replace(/APARTMENT/i, 'Apt.').replace(new RegExp('^' + (r.building || '#') + '\\s*', 'i'), '') || r.name;
    if (t) {
      const cls = barClass(t.b, t.l);
      const arr = t.b.checkIn === day ? '<em>arrives</em>' : '';
      tiles += `<button type="button" class="tile ${cls}" data-open="${esc(t.b.id)}"><b>${esc(name)}</b><span>${esc(t.b.guestName)}</span>${arr}</button>`;
    } else {
      const out = leavingRooms.has(r.id) ? '<em>left today</em>' : '';
      tiles += `<button type="button" class="tile free" data-new="${esc(r.id)}|${day}"><b>${esc(name)}</b><span>Free</span>${out}</button>`;
    }
  }
  if (building !== null) tiles += '</div>';

  const card = b => {
    const n = L.activeLines(b).length;
    const rooms = n === 1 ? roomName(L.activeLines(b)[0].roomId) : n + ' rooms: ' + L.activeLines(b).map(l => roomName(l.roomId)).join(', ');
    return `<button type="button" class="card" data-open="${esc(b.id)}"><div class="t"><span>${esc(b.guestName)}</span>${statusPill(b)}</div>
      <div class="s">${esc(rooms)} · ${L.fmtRange(b.checkIn, b.checkOut)}${b.phone ? ' · ' + esc(b.phone) : ''}</div></button>`;
  };
  const isToday = day === S.today;
  main.innerHTML = `
    <div class="nav">
      <button class="btn" type="button" data-act="dayprev" aria-label="Day before">‹</button>
      <div class="range">${isToday ? 'Today, ' : ''}${L.fmtDate(day, true)} · week ${L.isoWeek(day)}</div>
      <button class="btn" type="button" data-act="daynext" aria-label="Next day">›</button>
      ${isToday ? '' : '<button class="btn" type="button" data-act="daytoday">Today</button>'}
    </div>
    <div class="stats">
      <div><b>${tonight.size}</b><span>taken tonight</span></div>
      <div><b>${free.length}</b><span>free tonight</span></div>
      <div><b>${arriving.length}</b><span>arriving</span></div>
      <div><b>${leaving.length}</b><span>leaving</span></div>
    </div>
    <div class="today-grid">
      <section><h3>Rooms tonight</h3>${tiles || '<div class="muted">No rooms yet.</div>'}</section>
      <section><h3>Arriving${isToday ? ' today' : ''}</h3>${arriving.map(card).join('') || '<div class="muted card">Nobody arrives.</div>'}
        <h3 style="margin-top:16px">Leaving${isToday ? ' today' : ''}</h3>${leaving.map(card).join('') || '<div class="muted card">Nobody leaves.</div>'}</section>
    </div>
    <button class="fab" type="button" data-act="new">+ New booking</button>`;
}

// The planning is one long strip: rooms stay on the left, months, weeks and days stay on top,
// and you swipe left and right. More days are added when you get near either end.
const PLAN = { from: null, to: null, x: null, y: 0, busy: false };
const ZOOMS = { week: 7, '2w': 14, month: 31 };
function planZoom() { return S.zoom || (window.innerWidth < 600 ? 'week' : '2w'); }
function planGeom() {
  const narrow = window.innerWidth < 600, roomW = narrow ? 64 : 150;
  const avail = Math.min(($('#main')?.clientWidth || window.innerWidth) - 2, 1400) - roomW;
  const z = planZoom();
  const dayW = Math.max(z === 'month' ? 9 : 30, Math.floor(avail / ZOOMS[z]));
  return { narrow, roomW, dayW, tiny: dayW < 30, zoom: z };
}
function setZoom(z) {
  const wrap = $('#planwrap');
  const first = wrap ? visibleDays(wrap)[0] : null;
  S.zoom = z; try { localStorage.setItem('ih.zoom', JSON.stringify(z)); } catch { /* private mode */ }
  if (first) PLAN.x = L.nightsBetween(PLAN.from, first) * planGeom().dayW;
  draw();
}

function groupRuns(days, keyOf) {
  const runs = [];
  for (const d of days) {
    const k = keyOf(d), last = runs[runs.length - 1];
    if (last && last.key === k) last.n++; else runs.push({ key: k, first: d, n: 1 });
  }
  return runs;
}

function drawPlanning(main) {
  const { narrow, roomW, dayW, tiny, zoom } = planGeom();
  if (!PLAN.from) { PLAN.from = L.addDays(S.today, -28); PLAN.to = L.addDays(S.today, 180); }
  const n = L.nightsBetween(PLAN.from, PLAN.to);
  const days = Array.from({ length: n }, (_, i) => L.addDays(PLAN.from, i));

  const occ = new Map();
  for (const b of allBookings().values()) {
    if (b.checkOut <= PLAN.from || b.checkIn >= PLAN.to) continue;
    for (const l of L.activeLines(b)) {
      if (!occ.has(l.roomId)) occ.set(l.roomId, []);
      occ.get(l.roomId).push({ b, l });
    }
  }
  const pendingIds = new Set(S.pending.map(p => p.id));
  const mon = d => (L.isMonday(d) ? ' mon' : '');
  let rows = '', building = null;
  for (const r of S.rooms.filter(r => r.active !== false)) {
    if (r.building !== building) { building = r.building; rows += `<tr><td class="bld" colspan="${n + 1}"><span>${esc(building || '').toUpperCase()}</span></td></tr>`; }
    let tds = '';
    const items = occ.get(r.id) || [];
    for (let i = 0; i < n;) {
      const d = days[i];
      const here = items.filter(x => x.b.checkIn <= d && x.b.checkOut > d);
      if (!here.length) { tds += `<td class="cell${mon(d)}" data-new="${esc(r.id)}|${d}"></td>`; i++; continue; }
      const { b, l } = here[0];
      const span = Math.max(1, Math.min(L.nightsBetween(d, b.checkOut), n - i));
      const count = L.activeLines(b).length;
      const cls = (here.length > 1 ? 'x' : barClass(b, l)) + (b._pending || pendingIds.has(b.id) ? ' pend' : '');
      const full = here.length > 1 ? '⚠ ' + here.map(x => x.b.guestName).join(' / ') : b.guestName + (count > 1 ? ' (' + count + ')' : '');
      const label = tiny && span < 3 ? '' : span === 1 && (narrow || dayW < 50) ? full.split(' ')[0] : full;
      tds += `<td colspan="${span}" class="${mon(d).trim()}"><button type="button" class="bar ${cls}" data-open="${esc(b.id)}" title="${esc(full)}"><span>${esc(label)}</span></button></td>`;
      i += span;
    }
    const short = r.name.replace(/APARTMENT/i, 'APT.');
    const shown = narrow && r.building && short.toUpperCase().startsWith(r.building.toUpperCase() + ' ') ? short.slice(r.building.length + 1) : short;
    rows += `<tr><td class="room" title="${esc(r.name)}">${esc(shown)}</td>${tds}</tr>`;
  }
  const months = groupRuns(days, d => d.slice(0, 7)).map(g =>
    `<th class="mh${mon(g.first)}" colspan="${g.n}"><span>${g.n * dayW < 90 ? L.MONTH_NAMES[+g.first.slice(5, 7) - 1].slice(0, 3) : L.MONTH_NAMES[+g.first.slice(5, 7) - 1] + ' ' + g.first.slice(0, 4)}</span></th>`).join('');
  const weeks = groupRuns(days, d => L.mondayOf(d)).map(g =>
    `<th class="wh${mon(g.first)}" colspan="${g.n}"><span>${narrow || tiny ? 'Wk' : 'Week'} ${L.isoWeek(g.first)}</span></th>`).join('');
  const dayHead = days.map(d => { const [wd, num] = L.fmtDate(d, true).split(' ');
    return `<th class="dh${d === S.today ? ' today' : ''}${mon(d)}">${num}${dayW >= 36 ? '<small>' + wd + '</small>' : ''}</th>`; }).join('');

  main.innerHTML = `
    <div class="nav">
      <button class="btn" type="button" data-act="prev" aria-label="One week earlier">‹</button>
      <div class="range" id="plan-range"></div>
      <button class="btn" type="button" data-act="next" aria-label="One week later">›</button>
      <button class="btn" type="button" data-act="today">Today</button>
    </div>
    <div class="seg zoom" role="group" aria-label="Zoom">${Object.entries({ week: 'Week', '2w': '2 weeks', month: 'Month' }).map(([k, t]) => `<button type="button" class="${k === zoom ? 'on' : ''}" data-zoom="${k}">${t}</button>`).join('')}</div>
    ${S.rooms.length ? `<div class="plan-wrap${tiny ? ' tiny' : ''}" id="planwrap" style="--roomw:${roomW}px">
      <table class="plan" style="width:${roomW + n * dayW}px"><colgroup><col style="width:${roomW}px">${('<col style="width:' + dayW + 'px">').repeat(n)}</colgroup>
      <thead><tr class="mrow"><th class="corner" rowspan="3"></th>${months}</tr><tr class="wrow">${weeks}</tr><tr class="drow">${dayHead}</tr></thead>
      <tbody>${rows}</tbody></table></div>` : '<div class="center muted">No rooms yet. An admin adds them under Admin.</div>'}
    <div class="legend"><span><i style="background:var(--teal);border-color:var(--teal)"></i>Confirmed, paid</span>
      <span><i style="background:var(--teal-l);border-color:var(--teal)"></i>Confirmed, not paid</span>
      <span><i style="background:var(--opt-bg);border-color:var(--opt-bd)"></i>Option</span>
      <span><i style="background:#fff;border-color:var(--muted);border-style:dashed"></i>Request</span></div>
    <button class="fab" type="button" data-act="new">+ New booking</button>`;

  const wrap = $('#planwrap');
  if (!wrap) return;
  if (PLAN.x === null) PLAN.x = Math.max(0, L.nightsBetween(PLAN.from, S.today) - 1) * dayW;
  wrap.scrollLeft = PLAN.x; wrap.scrollTop = PLAN.y;
  showRange(wrap);
  wrap.addEventListener('scroll', onPlanScroll, { passive: true });
}

function visibleDays(wrap) {
  const { roomW, dayW } = planGeom();
  const first = Math.round(wrap.scrollLeft / dayW);
  const count = Math.max(1, Math.floor((wrap.clientWidth - roomW) / dayW));
  return [L.addDays(PLAN.from, first), L.addDays(PLAN.from, first + count - 1)];
}
function showRange(wrap) {
  const [a, b] = visibleDays(wrap);
  const el = $('#plan-range');
  if (el) el.textContent = planGeom().narrow ? L.fmtRange(a, b) : L.fmtDate(a, true) + ' – ' + L.fmtDate(b, true);
}
function onPlanScroll(e) {
  const wrap = e.currentTarget;
  PLAN.x = wrap.scrollLeft; PLAN.y = wrap.scrollTop;
  showRange(wrap);
  if (PLAN.busy) return;
  const { dayW } = planGeom();
  const [first] = visibleDays(wrap);
  if (!S.older && first < L.addDays(S.today, -DAYS_BACK)) loadOlder(true);
  if (wrap.scrollLeft + wrap.clientWidth > wrap.scrollWidth - 10 * dayW) {
    PLAN.busy = true; PLAN.to = L.addDays(PLAN.to, 120); draw(); PLAN.busy = false;
  } else if (wrap.scrollLeft < 5 * dayW && PLAN.from > '2024-01-01') {
    PLAN.busy = true; PLAN.from = L.addDays(PLAN.from, -90); PLAN.x += 90 * dayW; draw(); PLAN.busy = false;
  }
}
function planScroll(days) {
  const wrap = $('#planwrap');
  if (wrap) wrap.scrollBy({ left: days * planGeom().dayW, behavior: 'smooth' });
}
function planToday() {
  const wrap = $('#planwrap');
  if (wrap) wrap.scrollTo({ left: Math.max(0, L.nightsBetween(PLAN.from, S.today) - 1) * planGeom().dayW, behavior: 'smooth' });
}

// ---------------------------------------------------------------- bookings list

function statusPill(b) {
  if (S.pending.some(p => p.id === b.id) || b._pending) return '<span class="pill p-wait">⏳ not sent</span>';
  const st = L.bookingStatus(b);
  if (st === 'Cancelled') return '<span class="pill p-off">Cancelled</span>';
  if (st === 'Option') return '<span class="pill p-opt">Option</span>';
  if (st === 'Request') return '<span class="pill p-req">Request</span>';
  const pd = L.bookingPaid(b);
  return pd === 'Yes' ? '<span class="pill p-paid">Paid</span>' : pd === 'Deposit' ? '<span class="pill p-due">Deposit</span>' : '<span class="pill p-due">Not paid</span>';
}
function bookingCard(b) {
  const extra = S.sortBy === 'checkin' ? '' : `<div class="s muted">${esc(L.bookingNo(b))} · ${b.bookingDate ? 'booked ' + L.fmtDate(b.bookingDate) + ' ' + b.bookingDate.slice(0, 4) : 'no booking date'}</div>`;
  const lines = L.activeLines(b), all = L.lineList(b);
  const rooms = (lines.length || all.length) === 1 ? roomName((lines[0] || all[0]).roomId) : (lines.length || all.length) + ' rooms';
  const off = L.bookingStatus(b) === 'Cancelled';
  return `<button type="button" class="card${off ? ' off' : ''}" data-open="${esc(b.id)}"><div class="t"><span>${esc(b.guestName)}</span>${statusPill(b)}</div>
    <div class="s">${L.fmtRange(b.checkIn, b.checkOut)} ${b.checkIn.slice(0, 4) !== S.today.slice(0, 4) ? b.checkIn.slice(0, 4) : ''} · ${esc(rooms)}${b.source !== 'Direct' ? ' · ' + esc(L.SOURCE_LABEL[b.source]) : ''}${off ? '' : ' · ' + L.fmtGmd(L.bookingTotal(b))}</div>${extra}</button>`;
}

function drawBookings(main) {
  const q = S.q.trim().toLowerCase();
  let list = [...allBookings().values()];
  if (q) list = list.filter(b => (b.search || (b.guestName + ' ' + b.phone + ' ' + b.id).toLowerCase()).includes(q));
  else if (S.filter === 'upcoming') list = list.filter(b => b.checkOut >= S.today && L.bookingStatus(b) !== 'Cancelled');
  else if (S.filter === 'unpaid') list = list.filter(b => L.bookingStatus(b) !== 'Cancelled' && L.bookingPaid(b) !== 'Yes');
  else if (S.filter === 'cancelled') list = list.filter(b => L.bookingStatus(b) === 'Cancelled');
  // Without a choice: upcoming soonest first, the rest newest first (as before 04-11-2026).
  const dir = S.sortDir || (S.sortBy === 'checkin' && (S.filter !== 'upcoming' || q) ? 'desc' : 'asc');
  list = L.sortBookings(list, S.sortBy, dir);
  const chip = (k, t) => `<button type="button" class="chip${S.filter === k && !q ? ' on' : ''}" data-filter="${k}">${t}</button>`;
  const sortChip = (k, t) => `<button type="button" class="chip${S.sortBy === k ? ' on' : ''}" data-sort="${k}" data-dir="${dir}">${t}${S.sortBy === k ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}</button>`;
  main.innerHTML = `
    <input class="search" id="q" type="search" placeholder="Search name, phone or number" value="${esc(S.q)}" aria-label="Search">
    <div class="chips" style="margin-bottom:10px">${chip('upcoming', 'Upcoming')}${chip('unpaid', 'Not paid')}${chip('cancelled', 'Cancelled')}${chip('all', 'All')}</div>
    <div class="chips sort" style="margin-bottom:10px"><span class="muted">Sort</span>${sortChip('checkin', 'Check-in')}${sortChip('booked', 'Booked on')}${sortChip('number', 'Number')}</div>
    ${list.length ? list.slice(0, 300).map(bookingCard).join('') : '<div class="center muted">Nothing found.</div>'}
    ${S.older ? '' : `<div style="text-align:center"><button class="link" type="button" data-act="older">Search older bookings too</button></div>`}
    <button class="fab" type="button" data-act="new">+ New booking</button>`;
}

async function loadOlder(quiet) {
  if (loadOlder.busy) return;
  loadOlder.busy = true;
  if (!quiet) toast('Loading older bookings…');
  const since = L.addDays(S.today, -DAYS_BACK);
  const snap = await F.getDocs(F.query(F.collection(db, 'bookings'), F.where('checkOut', '<', since)));
  S.older = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
  if (!quiet) S.filter = 'all';
  render();
}

// ---------------------------------------------------------------- recent changes

function startFeed() {
  if (S.feedUnsub) return;
  S.feedUnsub = F.onSnapshot(F.query(F.collectionGroup(db, 'history'), F.orderBy('savedAt', 'desc'), F.limit(60)),
    snap => { S.feed = snap.docs.map(d => ({ id: d.id, ...d.data() })); render(); },
    err => { S.feed = []; toast('Could not load changes: ' + err.code); });
}
function stopFeed() { if (S.feedUnsub) { S.feedUnsub(); S.feedUnsub = null; } }

function dayLabel(ms) {
  const d = L.todayIn(TIMEZONE, new Date(ms));
  if (d === S.today) return 'Today';
  if (d === L.addDays(S.today, -1)) return 'Yesterday';
  return L.fmtDate(d, true);
}
function entryTime(e) { return e.savedAt?.toMillis ? e.savedAt.toMillis() : e.at; }

function drawChanges(main) {
  if (!S.feed) { main.innerHTML = '<div class="center muted">Loading changes…</div>'; return; }
  let h = '', last = '';
  for (const e of S.feed.filter(e => e.action !== 'imported')) {
    const t = entryTime(e), lbl = dayLabel(t);
    if (lbl !== last) { h += `<div class="dayhead">${esc(lbl)}</div>`; last = lbl; }
    const late = e.savedAt?.toMillis && e.savedAt.toMillis() - e.at > 5 * 60000;
    const lines = L.sentences(e, roomName).slice(0, 3).join(' · ');
    h += `<button type="button" class="card" data-open="${esc(e.bookingId)}"><div class="t"><span>${esc(L.headline(e, userName(e.by)))}</span><span class="muted" style="font-weight:500;font-size:14px">${L.fmtTime(e.at)}</span></div>
      <div class="s">${esc(lines)}${late ? ' · offline, arrived ' + L.fmtTime(e.savedAt.toMillis()) : ''}</div></button>`;
  }
  main.innerHTML = h || '<div class="center muted">No changes yet.</div>';
}

// ---------------------------------------------------------------- reports
// Overzichten v2 (ontwerp 04 en 06): filters, tiles, bar chart with a month to tap, table, coming up, not paid.

const BAR = '#083935', BAR_DIM = '#5E8C86'; // 12.8:1 and 3.8:1 on white; yellow is no bar colour (1.7:1)
const METRICS = { nights: ['Nights', r => r.nights, v => fmtN(v)], occupancy: ['Occupancy', r => r.occupancy, v => fmtPct(v)], revenue: ['GMD', r => r.revenue, v => fmtN(v)] };
const fmtN = v => Math.round(v).toLocaleString('en-US');
const fmtPct = v => Math.round(v * 100) + '%';
const fmtBig = v => v >= 1e6 ? (v / 1e6).toFixed(2) + ' m' : fmtN(v);

function repFilter() {
  const all = [...allBookings().values()];
  const years = [...new Set(all.map(b => b.checkIn.slice(0, 4)).filter(y => /^\d{4}$/.test(y)))].sort();
  const year = S.rep.year || (years.includes(S.today.slice(0, 4)) ? S.today.slice(0, 4) : years[years.length - 1] || S.today.slice(0, 4));
  return { all, years, f: { year, rooms: S.rep.rooms, source: S.rep.source, withOptions: S.rep.withOptions } };
}

function barChart(rows, metric, sel, width) {
  const [, get, fmt] = METRICS[metric];
  const H = 150, top = 18, bottom = 24, left = 2, plotH = H - top - bottom;
  const slot = (width - left) / 12, bw = Math.min(24, slot * 0.62);
  const max = Math.max(...rows.map(get), metric === 'occupancy' ? 0.05 : 1);
  let g = `<line x1="${left}" x2="${width}" y1="${top}" y2="${top}" stroke="#E6E4DE"/><text x="${left}" y="${top - 6}" font-size="11" fill="#4F5B59">${esc(fmt(max))}</text>`;
  rows.forEach((r, m) => {
    const v = get(r), h = v > 0 ? Math.max(2, v / max * plotH) : 0, x = left + slot * m + (slot - bw) / 2, y = top + plotH - h, rad = Math.min(4, h, bw / 2);
    const fill = sel === null || sel === m ? BAR : BAR_DIM;
    if (h) g += `<path d="M${x},${top + plotH} V${y + rad} Q${x},${y} ${x + rad},${y} H${x + bw - rad} Q${x + bw},${y} ${x + bw},${y + rad} V${top + plotH} Z" fill="${fill}"/>`;
    if (sel === m && h) g += `<text x="${x + bw / 2}" y="${y - 4}" font-size="11" font-weight="700" text-anchor="middle" fill="#15201F">${esc(fmt(v))}</text>`;
    const lx = left + slot * m + slot / 2;
    g += `<text x="${lx}" y="${H - 8}" font-size="12" text-anchor="middle" fill="${sel === m ? '#15201F' : '#4F5B59'}" font-weight="${sel === m ? 700 : 400}">${r.month[0]}</text>`;
    if (sel === m) g += `<rect x="${lx - 7}" y="${H - 4}" width="14" height="3" rx="1.5" fill="#FDB602"/>`;
    g += `<rect class="hit" data-month="${m}" x="${left + slot * m}" y="0" width="${slot}" height="${H}" fill="transparent"><title>${esc(r.month)}: ${esc(fmt(v))}</title></rect>`;
  });
  g += `<line x1="${left}" x2="${width}" y1="${top + plotH}" y2="${top + plotH}" stroke="#C9C6BD"/>`;
  return `<svg class="chart" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" role="img" aria-label="${esc(METRICS[metric][0])} per month; the table below has the numbers">${g}</svg>`;
}

function drawReports(main) {
  if (!S.claims.admin) { main.innerHTML = ''; return; }
  if (!S.older) { loadOlder(true); main.innerHTML = '<div class="center muted">Loading all bookings…</div>'; return; }
  const { all, years, f } = repFilter();
  const rep = L.monthReport(all, S.rooms, f), { rows, total } = rep;
  const R = S.rep;

  // filters: one row, they scope everything below
  const blds = [...new Set(S.rooms.filter(r => r.active !== false).map(r => r.building || 'Other'))];
  const opt = (v, t) => `<option value="${esc(v)}"${R.rooms === v || R.source === v ? ' selected' : ''}>${esc(t)}</option>`;
  const roomSel = `<select class="in" data-rf="rooms" aria-label="Rooms">${opt('', 'All rooms')}<optgroup label="Building">${blds.map(b => opt('b:' + b, b)).join('')}</optgroup>
    <optgroup label="Room">${S.rooms.filter(r => r.active !== false).map(r => opt('r:' + r.id, r.name)).join('')}</optgroup></select>`;
  const srcSel = `<select class="in" data-rf="source" aria-label="Source"><option value="">All sources</option>${L.SOURCES.map(k => `<option value="${k}"${R.source === k ? ' selected' : ''}>${esc(L.SOURCE_LABEL[k])}</option>`).join('')}</select>`;
  const filters = `<div class="chips" style="margin-bottom:8px">${years.map(y => `<button type="button" class="chip${y === f.year ? ' on' : ''}" data-year="${y}">${y}</button>`).join('')}</div>
    <div class="rep-f">${roomSel}${srcSel}<button type="button" class="chip${R.withOptions ? ' on' : ''}" data-act="repopt">+ options</button></div>`;

  // data quality
  const zeroPct = total.nights ? total.zeroNights / total.nights : 0;
  const zero = total.zeroNights ? `<div class="banner yel"><div><b>${fmtN(total.zeroNights)} room nights have no rate</b> (${fmtPct(zeroPct)} of nights in ${f.year}, ${rep.zeroIds.length} bookings): GMD figures are too low.</div>
    <button type="button" data-act="repzero">${R.open === 'zero' ? 'Hide' : 'Show'}</button></div>
    ${R.open === 'zero' ? rep.zeroIds.map(id => allBookings().get(id)).filter(Boolean).sort((a, b) => a.checkIn.localeCompare(b.checkIn)).map(bookingCard).join('') : ''}` : '';

  const tile = (k, v, s) => `<div class="kpi"><span>${k}</span><b>${v}</b>${s ? `<small>${s}</small>` : ''}</div>`;
  const tiles = `<div class="kpis">${tile('Occupancy', fmtPct(total.occupancy), fmtN(total.nights) + ' room nights')}${tile('Revenue', 'GMD ' + fmtBig(total.revenue), total.eur ? '+ EUR ' + fmtN(total.eur) + ' Booking.com' : '')}
    ${tile('Avg rate per night', 'GMD ' + fmtN(total.adr), 'nights with a rate')}${tile('Per room per night', 'GMD ' + fmtN(total.revpar), rep.roomCount + ' rooms in use')}</div>`;

  // chart + month detail
  const width = Math.max(260, Math.min(main.clientWidth - 24, 720) - 30);
  const mchip = k => `<button type="button" class="chip${R.metric === k ? ' on' : ''}" data-metric="${k}">${METRICS[k][0]}</button>`;
  let detail = '';
  if (R.month !== null) {
    const r = rows[R.month], list = L.monthBookings(all, S.rooms, f, R.month);
    detail = `<div class="card"><div class="t"><span>${esc(r.month)} ${f.year}</span><button type="button" class="link" data-act="repclose">Close</button></div>
      <div class="s">${fmtN(r.nights)} nights · ${fmtPct(r.occupancy)} · GMD ${fmtN(r.revenue)} · avg GMD ${fmtN(r.adr)} per night · ${r.bookings} check-ins${r.zeroNights ? ' · ' + r.zeroNights + ' nights without a rate' : ''}</div></div>
      ${list.slice(0, 80).map(bookingCard).join('')}${list.length > 80 ? `<div class="s muted">and ${list.length - 80} more</div>` : ''}`;
  }
  const chart = `<div class="card"><div class="chips" style="margin-bottom:8px">${mchip('nights')}${mchip('occupancy')}${mchip('revenue')}</div>
    ${barChart(rows, R.metric, R.month, width)}<div class="s muted">Tap a month for the details and its bookings.</div></div>${detail}`;

  // table
  const tr = (r, tag = 'td') => `<tr><${tag} class="m">${esc(r.month === 'Total' ? 'Total' : r.month.slice(0, 3))}</${tag}><${tag}>${fmtN(r.bookings)}</${tag}><${tag}>${fmtN(r.rooms)}</${tag}><${tag}>${fmtN(r.guests)}</${tag}><${tag}>${fmtN(r.nights)}</${tag}><${tag}>${fmtPct(r.occupancy)}</${tag}><${tag}>${fmtN(r.revenue)}</${tag}></tr>`;
  const table = `<div class="card rep-w"><table class="rep-t">
      <thead><tr><th class="m"></th><th>Book.</th><th>Rooms</th><th>Guests</th><th>Nights</th><th>Occ.</th><th>GMD</th></tr></thead>
      <tbody>${rows.map(r => tr(r)).join('')}</tbody><tfoot>${tr(total, 'th')}</tfoot></table></div>
    <div class="s muted" style="margin:8px 2px">${R.withOptions ? 'Confirmed rooms, options and requests' : 'Only confirmed rooms'} count. Bookings, rooms and guests in the month of check-in; nights, occupancy and GMD per night.
      Booking.com amounts in EUR are not in GMD.</div>
    <button class="btn outline" type="button" data-act="repxlsx">Download Excel (${f.year})</button>`;

  // coming up: year and status do not count here
  const fw = [30, 60, 90].map(d => L.forward(all, S.rooms, f, S.today, d));
  const coming = fw.map(x => `<div class="card fw"><div class="t"><span>Next ${x.days} days</span><span>${fmtPct(x.confPct)}${x.other ? ` <small class="muted">+ ${fmtPct(x.otherPct)} options</small>` : ''}</span></div>
    <div class="seg-bar" role="img" aria-label="${fmtPct(x.confPct)} confirmed, ${fmtPct(x.otherPct)} options and requests"><i style="width:${Math.min(100, x.confPct * 100)}%"></i><i class="o" style="width:${Math.min(100, x.otherPct * 100)}%"></i></div>
    <div class="s">${fmtN(x.confirmed)} confirmed room nights${x.other ? ', ' + fmtN(x.other) + ' option or request' : ''}</div></div>`).join('');

  // Booking.com check: the filters above do not count here
  const bc = S.bcom, check = L.bookingComCheck(all, S.rooms, S.today, 90, bc, bc.withOptions), tight = check.filter(d => d.tight);
  const KIND = { standard: 'Standard', deluxe: 'Deluxe' };
  const step = k => `<div class="bc-step"><span>${KIND[k]}</span><button type="button" class="chip" data-act="bcstep" data-bc="${k}" data-d="-1" aria-label="One ${KIND[k]} room less on Booking.com">−</button>
    <b aria-label="${KIND[k]} rooms on Booking.com">${bc[k]}</b><button type="button" class="chip" data-act="bcstep" data-bc="${k}" data-d="1" aria-label="One ${KIND[k]} room more on Booking.com">+</button></div>`;
  const kindLine = (d, k) => { const x = d[k]; return `<span${x.tight ? ' class="bad"' : ''}>${KIND[k]}: ${x.free} of ${x.rooms} free${x.tight ? ' · Booking.com max ' + x.free : ''}</span>`; };
  const bcRow = d => `<div class="card bc-row${d.tight ? ' tight' : ''}"><b>${esc(L.fmtDate(d.date, true))}</b><div class="s">${['standard', 'deluxe'].filter(k => d[k].rooms).map(k => kindLine(d, k)).join('<br>')}</div></div>`;
  const bcom = `<div class="card"><div class="s" style="margin-bottom:8px">Rooms you offer on Booking.com per day:</div>
      <div class="bc-set">${step('standard')}${step('deluxe')}</div>
      <button type="button" class="chip${bc.withOptions ? ' on' : ''}" style="margin-top:8px" data-act="bcopt" aria-pressed="${bc.withOptions}">${bc.withOptions ? '✓ ' : ''}Options count as booked</button>
      <div style="margin-top:10px"><b>${tight.length ? `${tight.length} day${tight.length > 1 ? 's' : ''} to lower on Booking.com` : 'Next 90 days: all fine'}</b>
      <div class="s">${tight.length ? 'Booking.com sells more rooms than are free. Set it to the max shown.' : 'Booking.com never sells more rooms than are free.'} Rooms booked through Booking.com are already taken off.</div></div></div>
    ${(R.open === 'bcall' ? check : tight).map(bcRow).join('')}
    <button class="link" type="button" data-act="bcall">${R.open === 'bcall' ? 'Only the days to lower' : 'Show all 90 days'}</button>`;

  // not paid yet
  const out = L.outstanding(all, S.rooms, f, S.today);
  const outRow = i => `<button type="button" class="card" data-open="${esc(i.b.id)}"><div class="t"><span>${esc(i.b.guestName)}</span><span class="money">GMD ${fmtN(i.amount)}</span></div>
    <div class="s">${L.fmtRange(i.b.checkIn, i.b.checkOut)} ${i.b.checkOut.slice(0, 4)} · ${i.rooms} room${i.rooms > 1 ? 's' : ''}${i.deposit ? ' · deposit paid' : ''}${i.amount ? '' : ' · no rate'}</div></button>`;
  const outList = out.items.slice(0, R.open === 'out' ? 500 : 5).map(outRow).join('');

  main.innerHTML = `<div class="rep">${filters}${zero}${tiles}${chart}
    <div class="bh"><h3>Per month</h3></div>${table}
    <div class="bh"><h3>Coming up</h3><span class="muted" style="font-weight:400;font-size:13px">from today, any year</span></div>${coming}
    <div class="bh"><h3>Booking.com check</h3><span class="muted" style="font-weight:400;font-size:13px">from today, filters do not count</span></div>${bcom}
    <div class="bh"><h3>Not paid yet</h3><span class="muted" style="font-weight:400;font-size:13px">stay is over</span></div>
    <div class="card"><b>${fmtN(out.rooms)} rooms · GMD ${fmtN(out.amount)}</b><div class="s">Oldest first. Paid already? Open the booking and mark it paid.</div></div>
    ${outList}${out.items.length > 5 ? `<button class="link" type="button" data-act="repout">${R.open === 'out' ? 'Show less' : 'Show all ' + out.items.length}</button>` : ''}
  </div>`;
}

async function downloadReport() {
  const XLSX = await import(XLSX_URL);
  const { all, f } = repFilter();
  const { rows, total } = L.monthReport(all, S.rooms, f);
  const out = [...rows, total].map(r => ({
    Month: r.month, Bookings: r.bookings, Rooms: r.rooms, Guests: r.guests, Nights: r.nights,
    'Occupancy %': Math.round(r.occupancy * 1000) / 10, 'Revenue GMD': r.revenue, 'Avg rate GMD': Math.round(r.adr),
    'Per room per night GMD': Math.round(r.revpar), 'Nights without rate': r.zeroNights, 'Booking.com EUR': r.eur
  }));
  const label = [f.rooms ? f.rooms.slice(2) : '', f.source ? L.SOURCE_LABEL[f.source] : '', f.withOptions ? 'with options' : ''].filter(Boolean).join(', ');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(out), 'Report ' + f.year);
  XLSX.writeFile(wb, 'Island Hotel report ' + f.year + (label ? ' (' + label + ')' : '') + '.xlsx');
}

// ---------------------------------------------------------------- admin

function drawAdmin(main) {
  if (!S.claims.admin) { main.innerHTML = ''; return; }
  const me = S.user.email;
  const users = [...S.users.values()].sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  const opt = (v, cur) => `<option${v === cur ? ' selected' : ''}>${v}</option>`;
  const people = users.map(u => `<div class="card ln"><span title="${esc(u.email)}">${esc(u.name || u.email)}<br><small class="muted" style="font-weight:400">${esc(u.email)}</small></span>
    ${u.email === me ? `<span class="pill p-paid">${esc(u.role)} · you</span>` :
      `<select class="in" data-urole="${esc(u.email)}" aria-label="Role">${opt('Staff', u.role)}${opt('Admin', u.role)}</select>
       <select class="in" data-ustate="${esc(u.email)}" aria-label="Access">${u.state === 'Invited' ? opt('Invited', u.state) : ''}${opt('Active', u.state)}${opt('Blocked', u.state)}</select>`}</div>`).join('');
  let building = null, rooms = '';
  for (const r of S.rooms) {
    if (r.building !== building) { building = r.building; rooms += `<div class="dayhead">${esc(building || 'Other')}</div>`; }
    rooms += `<div class="card ln room${r.active === false ? ' off' : ''}"><span>${esc(r.name)}</span>
      <input class="in" style="width:84px" inputmode="numeric" data-rrate="${esc(r.id)}" data-rkind="Single" value="${esc(L.defaultRate(r, 1) || '')}" aria-label="Single rate for ${esc(r.name)}" placeholder="Single" title="Single (1 guest)">
      <input class="in" style="width:84px" inputmode="numeric" data-rrate="${esc(r.id)}" data-rkind="Double" value="${esc(L.defaultRate(r, 2) || '')}" aria-label="Double rate for ${esc(r.name)}" placeholder="Double" title="Double (2 or more guests)">
      <button class="btn" type="button" data-ractive="${esc(r.id)}">${r.active === false ? 'Use again' : 'Not in use'}</button></div>`;
  }
  const bk = S.backup;
  main.innerHTML = `<div class="adm">
    <div class="bh"><h3>People</h3></div>
    ${people || '<div class="muted">Nobody yet.</div>'}
    <div class="card"><div class="row"><input class="in" id="nu-email" type="email" placeholder="name@gmail.com" aria-label="E-mail of new person">
      <input class="in" id="nu-name" placeholder="Name" aria-label="Name"></div>
      <div class="row" style="margin-top:8px"><select class="in" id="nu-role" aria-label="Role"><option>Staff</option><option>Admin</option></select>
      <button class="btn primary" type="button" data-act="adduser">Add person</button></div>
      <div class="s muted" style="margin-top:6px">They can sign in within 10 minutes.</div></div>
    <div class="bh"><h3>Rooms</h3></div>
    <div class="s muted" style="margin:-4px 0 8px">Standard rate per night in GMD: first single (1 guest), then double (2 or more).</div>
    ${rooms}
    <div class="card"><div class="row"><input class="in" id="nr-name" placeholder="Room name, e.g. FULADU 7" aria-label="New room name">
      <input class="in" id="nr-bld" placeholder="Building" aria-label="Building"></div>
      <button class="btn primary" type="button" style="margin-top:8px" data-act="addroom">Add room</button></div>
    <div class="bh"><h3>Data</h3></div>
    <div class="card"><button class="btn outline" type="button" data-act="excel">Download Excel (all bookings)</button>
      <div class="s" style="margin-top:8px">${bk ? 'Last backup to Drive: ' + esc(bk.when || '') + ' · ' + esc(bk.count ?? '') + ' bookings' : 'No backup to Drive yet.'}</div></div>
    <div class="card"><b>Import from the old sheet</b><div class="s">Only once, at the start. Choose the .xlsx download of the Google Sheet.</div>
      <input type="file" id="imp" accept=".xlsx" style="margin-top:8px" aria-label="Sheet file"><div id="impout" class="s">${S.importMsg || ''}</div></div>
  </div>`;
}

async function addUser() {
  const email = $('#nu-email').value.trim().toLowerCase(), name = $('#nu-name').value.trim(), role = $('#nu-role').value;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('Enter an e-mail address.');
  await F.setDoc(F.doc(db, 'users', email), { name: name || email.split('@')[0], role, state: 'Invited', addedBy: S.user.email, addedAt: F.serverTimestamp() })
    .then(() => toast('Added. ' + (name || email) + ' can sign in within 10 minutes.'))
    .catch(e => toast('Not saved: ' + e.code));
}
function setUser(email, field, value) {
  F.setDoc(F.doc(db, 'users', email), { [field]: value }, { merge: true }).then(() => toast('Saved')).catch(e => toast('Not saved: ' + e.code));
}
function addRoom() {
  const name = $('#nr-name').value.trim(), building = $('#nr-bld').value.trim();
  if (!name) return toast('Enter a room name.');
  const id = L.roomIdOf(name);
  if (S.roomsById.has(id)) return toast('That room exists already.');
  F.setDoc(F.doc(db, 'rooms', id), { name, building: building || 'Other', active: true, sortOrder: S.rooms.length, ...L.ratesFor(building || 'Other'), isApartment: /APARTMENT/i.test(name) })
    .then(() => toast('Room added')).catch(e => toast('Not saved: ' + e.code));
}

// ---------------------------------------------------------------- excel

const XLSX_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
async function downloadExcel() {
  toast('Preparing Excel…');
  const XLSX = await import(XLSX_URL);
  const snap = await F.getDocs(F.collection(db, 'bookings'));
  const rows = [];
  for (const d of snap.docs) {
    const b = { id: d.id, ...d.data() };
    for (const l of L.lineList(b)) {
      rows.push({
        Booking: b.id, Line: l.lineId, Guest: b.guestName, Phone: b.phone, Email: b.email, Room: roomName(l.roomId),
        'Check-in': b.checkIn, 'Check-out': b.checkOut, Nights: L.nights(b), Guests: l.guests, Status: l.status,
        'Rate GMD': l.rateGmd, 'Total GMD': l.status === 'Cancelled' ? 0 : L.lineTotal(b, l), Paid: l.paid, Invoice: l.invoiceNo,
        Source: L.SOURCE_LABEL[b.source] || b.source, 'Booking.com nr': b.bookingComRef, 'Amount EUR': b.bookingComAmountEur ?? '',
        Notes: [b.notes, l.notes].filter(Boolean).join(' / '), 'Created by': b.createdBy, 'Updated by': b.updatedBy
      });
    }
  }
  rows.sort((a, b) => a['Check-in'].localeCompare(b['Check-in']));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Bookings');
  XLSX.writeFile(wb, 'Island Hotel bookings ' + S.today + '.xlsx');
}

// ---------------------------------------------------------------- import (once)

function cellDate(v) {
  if (v instanceof Date && !isNaN(v)) return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0');
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0];
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/); if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return '';
}
function importOut(html) { S.importMsg = html; const el = $('#impout'); if (el) el.innerHTML = html; }
async function importSheet(file) {
  const XLSX = await import(XLSX_URL);
  const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
  const res = wb.Sheets.Reservations || wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(res, { defval: '' });
  const pick = (r, ...names) => { for (const n of names) if (r[n] !== undefined && r[n] !== '') return r[n]; return ''; };
  const rows = raw.map(r => ({
    id: String(pick(r, 'Kolom 1', 'ID', 'Id')).trim(), guest: String(pick(r, 'Guest Name')), phone: String(pick(r, 'Phone')), email: String(pick(r, 'Email')),
    room: String(pick(r, 'Room')), checkIn: cellDate(pick(r, 'Check-in')), checkOut: cellDate(pick(r, 'Check-out')), guests: pick(r, 'Guests'),
    status: String(pick(r, 'Status')), rate: pick(r, 'Rate/Night'), paid: String(pick(r, 'Paid')), invoice: String(pick(r, 'Invoice#')),
    bookingDate: cellDate(pick(r, 'Booking Date')), notes: String(pick(r, 'Notes')), group: String(pick(r, 'Group')), source: String(pick(r, 'Source'))
  }));
  const bookings = L.groupSheetRows(rows).sort((a, b) => a.checkIn.localeCompare(b.checkIn));
  const skipped = rows.filter(r => r.guest.trim() && !(L.isDate(r.checkIn) && L.isDate(r.checkOut) && r.checkOut > r.checkIn));

  // rooms: the Rooms tab in sheet order, plus any room name only found in bookings
  const names = [];
  if (wb.Sheets.Rooms) XLSX.utils.sheet_to_json(wb.Sheets.Rooms, { header: 1 }).forEach(r => { if (String(r[0] || '').trim()) names.push(String(r[0]).trim()); });
  rows.forEach(r => { if (r.room.trim() && !names.some(n => L.roomIdOf(n) === L.roomIdOf(r.room))) names.push(r.room.trim()); });
  const seen = new Set();
  let order = 0;
  for (const n of names) {
    const id = L.roomIdOf(n);
    if (seen.has(id) || S.roomsById.has(id) || L.GROUP_NAMES.has(id)) continue;
    seen.add(id);
    await F.setDoc(F.doc(db, 'rooms', id), {
      name: n.replace(/([A-Za-z])(\d)/, '$1 $2').toUpperCase(), building: L.buildingOf(n),
      isApartment: /APARTMENT/i.test(n), ...L.ratesFor(L.buildingOf(n)), active: true, sortOrder: order++
    });
  }

  const idx = nightIndex();
  let ok = 0, failed = [];
  const clashes = [];
  for (const b of bookings) {
    // An old double booking from the sheet: the room that came second is imported as Cancelled
    // with a note, so nothing is lost and the night lock stays with the first booking.
    const c = L.conflicts(idx, null, b);
    if (c.length) {
      const lineIds = new Set(c.map(x => L.nightDocs(b).find(n => n.roomId === x.roomId && n.date === x.date).lineId));
      for (const lineId of lineIds) {
        const l = b.lines[lineId];
        b.lines[lineId] = { ...l, status: 'Cancelled', notes: ('DOUBLE in old sheet, was ' + l.status + '. ' + (l.notes || '')).trim() };
      }
      clashes.push(b.guestName + ' ' + L.fmtRange(b.checkIn, b.checkOut) + ' ' + b.checkIn.slice(0, 4) + ' (' + [...lineIds].map(id => roomName(b.lines[id].roomId)).join(', ') + ')');
    }
    try {
      await saveBooking(F, db, { before: null, after: b, me: S.user.email, action: 'imported' });
      for (const n of L.nightDocs(b)) idx.set(n.id, { bookingId: b.id });
      ok++;
    } catch (e) { failed.push(b.guestName + ' ' + b.checkIn + ': ' + e.code); }
    if (ok % 10 === 0) importOut('Importing… ' + ok + ' of ' + bookings.length);
  }
  importOut(`<b>Imported ${ok} of ${bookings.length} bookings</b> (${rows.length} rows in the sheet).` +
    (skipped.length ? `<br>${skipped.length} rows have no valid check-in or check-out and are not imported. Book them again by hand:<br>${skipped.map(r => esc((r.id || '') + ' ' + r.guest + ' ' + (r.checkIn || '?') + ' – ' + (r.checkOut || '?') + ' ' + r.room)).join('<br>')}` : '') +
    (clashes.length ? `<br>${clashes.length} double bookings in the old sheet. The second room is imported as Cancelled with the note "DOUBLE in old sheet":<br>${clashes.map(esc).join('<br>')}` : '') +
    (failed.length ? `<br>Not imported: ${failed.map(esc).join('<br>')}` : ''));
}

// ---------------------------------------------------------------- the sheet: booking detail

let SHEET = null; // {kind:'detail'|'form', ...}
function openSheet(state) { SHEET = state; drawSheet(); $('#sheet').hidden = false; document.body.style.overflow = 'hidden'; }
function closeSheet() { SHEET = null; $('#sheet').hidden = true; $('#sheet').innerHTML = ''; document.body.style.overflow = ''; render(); }

async function openBooking(id) {
  let b = allBookings().get(id);
  if (!b) {
    const d = await F.getDoc(F.doc(db, 'bookings', id));
    if (!d.exists()) return toast('Booking not found.');
    b = { id, ...d.data() };
  }
  openSheet({ kind: 'detail', id, b, history: null });
  F.getDocs(F.query(F.collection(db, 'bookings', id, 'history'), F.orderBy('at', 'desc'))).then(s => {
    if (SHEET?.id === id) { SHEET.history = s.docs.map(d => d.data()); drawSheet(); }
  }).catch(() => { if (SHEET?.id === id) { SHEET.history = []; drawSheet(); } });
}

function drawDetail() {
  const live = allBookings().get(SHEET.id);
  if (live) SHEET.b = live;
  const b = SHEET.b;
  const st = L.bookingStatus(b), cancelled = st === 'Cancelled';
  const lines = L.lineList(b).map(l => {
    const cx = l.status === 'Cancelled';
    const paid = L.PAID.map(p => `<option${p === l.paid ? ' selected' : ''}>${p}</option>`).join('');
    return `<div class="ln${cx ? ' cx' : ''}"><b>${esc(roomName(l.roomId))}<br><small class="muted" style="font-weight:500">${esc(l.status)}${l.guests ? ' · ' + l.guests + ' guests' : ''}${l.notes ? ' · ' + esc(l.notes) : ''}</small></b>
      <span class="money" style="font-size:15px">${Number(l.rateGmd || 0).toLocaleString('en-US')}</span>
      ${cx ? '<span style="width:96px"></span>' : `<select class="in" style="width:104px" data-linepaid="${esc(l.lineId)}" aria-label="Paid for ${esc(roomName(l.roomId))}">${paid}</select>`}</div>`;
  }).join('');
  const hist = SHEET.history === null ? '<div class="muted">Loading…</div>' : SHEET.history.map(e => {
    const late = e.savedAt?.toMillis && e.savedAt.toMillis() - e.at > 5 * 60000;
    return `<div class="e"><b>${L.fmtDate(L.todayIn(TIMEZONE, new Date(e.at)))} ${L.fmtTime(e.at)} · ${esc(userName(e.by))}</b>${late ? '<small>offline, arrived ' + L.fmtTime(e.savedAt.toMillis()) + '</small>' : ''}${L.sentences(e, roomName).map(esc).join('<br>')}</div>`;
  }).join('') || '<div class="muted">No history.</div>';
  const allPaid = L.activeLines(b).every(l => l.paid === 'Yes');
  return `<div class="panel"><header><button class="iconbtn" type="button" data-act="close" aria-label="Back">${ICON.back}</button>
      <h2>${esc(b.guestName)}</h2>${cancelled ? '' : '<button class="btn outline" type="button" data-act="edit" style="height:42px">Edit</button>'}</header>
    <div class="body">
      <div class="card" style="margin-top:12px"><div class="t"><span>${L.fmtRange(b.checkIn, b.checkOut)} ${b.checkIn.slice(0, 4)} · ${L.nights(b)} night${L.nights(b) > 1 ? 's' : ''}</span>${statusPill(b)}</div>
        <div class="s">${esc(b.id)} · ${esc(L.SOURCE_LABEL[b.source])}${b.bookingComRef ? ' ' + esc(b.bookingComRef) : ''}${b.bookingComAmountEur ? ' · ' + esc(b.bookingComAmountEur) + ' EUR' : ''}</div>
        ${b.phone ? `<div class="s"><a href="tel:${esc(b.phone)}">${esc(b.phone)}</a>${b.email ? ' · ' + esc(b.email) : ''}</div>` : ''}
        ${b.notes ? `<div class="s">${esc(b.notes)}</div>` : ''}</div>
      <div class="lines">${lines}<div class="tot"><b>Total</b><span class="money" style="color:var(--teal)">${L.fmtGmd(L.bookingTotal(b))}</span></div></div>
      ${cancelled ? `<button class="btn outline big" type="button" style="margin-top:12px" data-act="undo">Undo cancel</button>` :
        `<div class="row" style="margin-top:12px">${allPaid ? '' : '<button class="btn outline" type="button" data-act="markpaid">Mark all paid</button>'}<button class="btn danger" type="button" data-act="cancelbk">Cancel booking</button></div>`}
      <div id="detail-err"></div>
      <div class="bh"><h3>History</h3></div><div class="tl">${hist}</div>
    </div></div>`;
}

function quickSave(mutate, done) {
  const before = SHEET.b;
  const after = JSON.parse(JSON.stringify({ ...before }));
  delete after._pending;
  mutate(after);
  const errs = save(before, after, { done });
  if (errs.length) $('#detail-err').innerHTML = `<div class="errbox">${errs.map(esc).join('<br>')}</div>`;
}

// ---------------------------------------------------------------- the sheet: new and edit

function openForm(before, preset = {}) {
  const b = before ? JSON.parse(JSON.stringify(before)) : {
    id: L.newBookingId(S.today), guestName: '', phone: '', email: '', checkIn: preset.date || S.today,
    checkOut: L.addDays(preset.date || S.today, 1), source: 'Direct', bookingComRef: '', bookingComAmountEur: null,
    bookingDate: S.today, notes: '', lines: {}
  };
  if (preset.attempt) Object.assign(b, JSON.parse(JSON.stringify(preset.attempt)), before ? { id: before.id } : {});
  delete b._pending;
  const form = { kind: 'form', before: before || null, b, status: before ? L.bookingStatus(before) : 'Confirmed', paid: before ? L.bookingPaid(before) : 'No', errors: preset.error ? [preset.error] : [] };
  if (form.status === 'Cancelled') form.status = 'Confirmed';
  openSheet(form);
  if (preset.room) toggleRoom(preset.room);
}

function nextLineId(f) {
  let i = Object.keys(f.b.lines).length + 1;
  while (f.b.lines[f.b.id + '-' + i]) i++;
  return f.b.id + '-' + i;
}
function toggleRoom(roomId) {
  const f = SHEET, lines = f.b.lines;
  const mine = Object.entries(lines).find(([, l]) => l.roomId === roomId);
  if (mine && mine[1].status !== 'Cancelled') {
    if (f.before?.lines?.[mine[0]]) lines[mine[0]] = { ...mine[1], status: 'Cancelled' };
    else delete lines[mine[0]];
  } else if (mine) {
    lines[mine[0]] = { ...mine[1], status: f.status };
  } else {
    const r = S.roomsById.get(roomId);
    const guests = r?.isApartment ? 4 : 2;
    lines[nextLineId(f)] = { roomId, guests, rateGmd: L.defaultRate(r, guests), status: f.status, paid: f.paid, invoiceNo: '', notes: '', order: Object.keys(lines).length };
  }
  drawFormParts();
}

function drawForm() {
  const f = SHEET, b = f.b;
  const seg = (name, opts, cur) => `<div class="seg" role="group" aria-label="${name}">${opts.map(o => `<button type="button" class="${o === cur ? 'on' : ''}" data-seg="${name}" data-val="${o}">${o}</button>`).join('')}</div>`;
  const src = L.SOURCES.map(s => `<button type="button" class="chip${b.source === s ? ' on' : ''}" data-src="${s}">${L.SOURCE_LABEL[s]}</button>`).join('');
  return `<div class="panel"><header><button class="iconbtn" type="button" data-act="close" aria-label="Close">${ICON.close}</button>
      <h2>${f.before ? 'Edit booking' : 'New booking'}</h2></header>
    <div class="body">
      <label class="f" for="f-guest">Guest name</label><input class="in" id="f-guest" data-fld="guestName" value="${esc(b.guestName)}" autocomplete="off">
      <div class="row"><div><label class="f" for="f-phone">Phone</label><input class="in" id="f-phone" data-fld="phone" type="tel" value="${esc(b.phone)}"></div>
        <div><label class="f" for="f-email">Email</label><input class="in" id="f-email" data-fld="email" type="email" value="${esc(b.email)}"></div></div>
      <div class="row"><div><label class="f" for="f-in">Check-in</label><input class="in" id="f-in" data-date="checkIn" type="date" value="${esc(b.checkIn)}"></div>
        <div><label class="f" for="f-out">Check-out</label><input class="in" id="f-out" data-date="checkOut" type="date" value="${esc(b.checkOut)}"></div></div>
      <div class="f" style="font-size:14px;font-weight:600;margin:12px 0 4px">Source</div><div class="chips">${src}</div>
      <div id="f-bc"></div>
      <div id="f-rooms"></div>
      <div id="f-lines"></div>
      <div class="f" style="font-size:14px;font-weight:600;margin:12px 0 4px">Status${f.before ? ' (all rooms)' : ''}</div>${seg('status', ['Confirmed', 'Option', 'Request'], f.status)}
      <div class="f" style="font-size:14px;font-weight:600;margin:12px 0 4px">Paid${f.before ? ' (all rooms)' : ''}</div>${seg('paid', L.PAID, f.paid)}
      <label class="f" for="f-notes">Notes</label><textarea class="in" id="f-notes" data-fld="notes">${esc(b.notes)}</textarea>
      <div id="f-err"></div>
    </div>
    <footer><button class="btn primary big" type="button" data-act="savebk" id="f-save">Save</button></footer></div>`;
}

function drawFormParts() {
  const f = SHEET, b = f.b;
  if (!f || f.kind !== 'form') return;
  $('#f-bc').innerHTML = b.source === 'BookingCom' ? `<div class="row"><div><label class="f" for="f-ref">Booking.com number</label><input class="in" id="f-ref" data-fld="bookingComRef" value="${esc(b.bookingComRef)}" inputmode="numeric"></div>
    <div><label class="f" for="f-eur">Amount (EUR)</label><input class="in" id="f-eur" data-fld="bookingComAmountEur" value="${esc(b.bookingComAmountEur ?? '')}" inputmode="decimal"></div></div>` : '';

  const validDates = L.isDate(b.checkIn) && L.isDate(b.checkOut) && b.checkOut > b.checkIn;
  const idx = nightIndex(b.id);
  const free = L.freeRooms(S.rooms, idx, b.checkIn, b.checkOut, b.id);
  const chosen = new Set(L.activeLines(b).map(l => l.roomId));
  let h = `<div class="bh"><span>Rooms${validDates ? ' · ' + L.nights(b) + ' night' + (L.nights(b) > 1 ? 's' : '') : ''}</span></div>`;
  if (!validDates) h += '<div class="muted">Choose check-in and check-out first.</div>';
  else {
    const byB = new Map();
    S.rooms.filter(r => r.active !== false || chosen.has(r.id)).forEach(r => { if (!byB.has(r.building)) byB.set(r.building, []); byB.get(r.building).push(r); });
    for (const [bld, rs] of byB) {
      const anyFree = rs.some(r => free.has(r.id) && !chosen.has(r.id));
      h += `<div class="bh" style="margin:10px 0 4px;font-size:13px;color:var(--muted)"><span>${esc(bld || 'Other').toUpperCase()}</span>${anyFree ? `<button class="link" type="button" data-allfree="${esc(bld)}">Select all free</button>` : ''}</div><div class="chips">`;
      for (const r of rs) {
        const on = chosen.has(r.id), ok = free.has(r.id);
        const cls = on ? (ok ? 'on' : 'bad') : ok ? '' : 'taken';
        h += `<button type="button" class="chip ${cls}" data-room="${esc(r.id)}" aria-pressed="${on}"${!on && !ok ? ' aria-disabled="true"' : ''}>${esc(r.name)}</button>`;
      }
      h += '</div>';
    }
  }
  $('#f-rooms').innerHTML = h;

  const lines = L.lineList(b);
  if (lines.length) {
    const n = validDates ? L.nights(b) : 0;
    $('#f-lines').innerHTML = `<div class="bh"><span>Per room</span><span class="muted" style="font-weight:500">guests · rate per night (GMD)</span></div><div class="lines">` +
      lines.map(l => {
        const cx = l.status === 'Cancelled';
        return `<div class="ln${cx ? ' cx' : ''}"><b>${esc(roomName(l.roomId))}${cx ? ' <small>(cancelled)</small>' : ''}</b>
          ${cx ? '' : `<input class="in" style="width:58px" inputmode="numeric" data-lg="${esc(l.lineId)}" value="${esc(l.guests || '')}" aria-label="Guests in ${esc(roomName(l.roomId))}">
          <input class="in" style="width:90px" inputmode="numeric" data-lr="${esc(l.lineId)}" value="${esc(l.rateGmd || '')}" aria-label="Rate for ${esc(roomName(l.roomId))}">`}</div>`;
      }).join('') +
      `<div class="tot"><b>Total${n ? ' · ' + n + ' night' + (n > 1 ? 's' : '') : ''}</b><span class="money" id="f-total" style="color:var(--teal)">${L.fmtGmd(n ? L.bookingTotal(b) : 0)}</span></div></div>`;
  } else $('#f-lines').innerHTML = '';
  const act = L.activeLines(b).length;
  $('#f-save').textContent = f.before ? 'Save changes' : act ? 'Book ' + act + ' room' + (act > 1 ? 's' : '') : 'Choose a room';
  $('#f-err').innerHTML = f.errors.length ? `<div class="errbox">${f.errors.map(esc).join('<br>')}</div>` : '';
}

function submitForm() {
  const f = SHEET, after = f.b;
  after.guestName = after.guestName.trim();
  if (after.bookingComAmountEur === '' || after.bookingComAmountEur == null) after.bookingComAmountEur = null;
  else after.bookingComAmountEur = Number(String(after.bookingComAmountEur).replace(',', '.')) || null;
  for (const l of Object.values(after.lines)) { l.guests = Number(l.guests) || 0; l.rateGmd = Number(l.rateGmd) || 0; }
  const errs = save(f.before, after, { done: f.before ? 'Changes saved' : 'Booking saved' });
  if (errs.length) { f.errors = errs; drawFormParts(); $('#f-err').scrollIntoView({ block: 'center' }); return; }
  closeSheet();
}

function drawSheet() {
  if (!SHEET) return;
  const el = $('#sheet');
  if (SHEET.kind === 'detail') { el.innerHTML = drawDetail(); return; }
  if (SHEET.kind === 'account') { el.innerHTML = drawAccount(); return; }
  el.innerHTML = drawForm(); drawFormParts();
}

function drawAccount() {
  return `<div class="panel"><header><button class="iconbtn" type="button" data-act="close" aria-label="Close">${ICON.close}</button><h2>Account</h2></header>
    <div class="body"><div class="card" style="margin-top:12px"><div class="t"><span>${esc(userName(S.user.email))}</span><span class="pill p-due">${S.claims.admin ? 'Admin' : 'Staff'}</span></div>
      <div class="s">${esc(S.user.email)}</div><div class="s">${S.online ? 'Online' : 'Offline'} · ${S.pending.length} change(s) waiting</div></div>
      <button class="btn big" type="button" style="margin-top:12px" data-act="signout">Sign out</button>
      <button class="btn danger big" type="button" style="margin-top:10px" data-act="wipe">Sign out and clear this phone</button>
      <p class="muted" style="font-size:14px">Use "clear this phone" on a phone that is not yours. Changes that are not sent yet will be lost.</p></div></div>`;
}

// ---------------------------------------------------------------- events

document.addEventListener('click', e => {
  const hit = e.target.closest('rect.hit');
  if (hit) { const m = +hit.dataset.month; S.rep.month = S.rep.month === m ? null : m; return draw(); }
  const t = e.target.closest('button, td.cell');
  if (!t) return;
  if (t.dataset.tab) {
    S.tab = t.dataset.tab;
    if (S.tab === 'changes') startFeed(); else stopFeed();
    window.scrollTo(0, 0); draw(); return;
  }
  if (t.dataset.new) { const [room, date] = t.dataset.new.split('|'); return openForm(null, { room, date }); }
  if (t.dataset.open) return openBooking(t.dataset.open);
  if (t.dataset.zoom) return setZoom(t.dataset.zoom);
  if (t.dataset.filter) { S.filter = t.dataset.filter; S.q = ''; S.sortDir = null; return draw(); }
  if (t.dataset.sort) {
    // the chosen sort again turns the order around
    if (S.sortBy === t.dataset.sort) S.sortDir = t.dataset.dir === 'asc' ? 'desc' : 'asc';
    else { S.sortBy = t.dataset.sort; S.sortDir = 'asc'; }
    return draw();
  }
  if (t.dataset.year) { S.rep.year = t.dataset.year; S.rep.month = null; return draw(); }
  if (t.dataset.metric) { S.rep.metric = t.dataset.metric; return draw(); }
  if (t.dataset.fix !== undefined) {
    const r = S.rejected[+t.dataset.fix];
    S.rejected.splice(+t.dataset.fix, 1); keep(); draw();
    // Open the attempt again, on top of what the server has now, with the reason on top.
    return openForm(allBookings().get(r.id) || null, { attempt: r.attempt, error: r.msg });
  }
  if (t.id === 'conn') return openSheet({ kind: 'account' });
  if (SHEET?.kind === 'form') {
    const f = SHEET;
    if (t.dataset.room) {
      const chosen = L.activeLines(f.b).some(l => l.roomId === t.dataset.room);
      if (!chosen && t.classList.contains('taken')) { toast(roomName(t.dataset.room) + ' is taken on these dates.'); return; }
      return toggleRoom(t.dataset.room);
    }
    if (t.dataset.allfree !== undefined) {
      const free = L.freeRooms(S.rooms, nightIndex(f.b.id), f.b.checkIn, f.b.checkOut, f.b.id);
      const chosen = new Set(L.activeLines(f.b).map(l => l.roomId));
      S.rooms.filter(r => r.building === t.dataset.allfree && r.active !== false && free.has(r.id) && !chosen.has(r.id)).forEach(r => toggleRoom(r.id));
      return;
    }
    if (t.dataset.src) {
      f.b.source = t.dataset.src;
      document.querySelectorAll('[data-src]').forEach(c => c.classList.toggle('on', c.dataset.src === f.b.source));
      return drawFormParts();
    }
    if (t.dataset.seg) {
      f[t.dataset.seg] = t.dataset.val;
      for (const l of Object.values(f.b.lines)) if (l.status !== 'Cancelled') l[t.dataset.seg] = t.dataset.val;
      document.querySelectorAll(`[data-seg="${t.dataset.seg}"]`).forEach(c => c.classList.toggle('on', c.dataset.val === t.dataset.val));
      return drawFormParts();
    }
  }
  const act = t.dataset.act;
  if (!act) return;
  ({
    signin: signIn,
    devsignin: () => A.signInWithEmailAndPassword(auth, $('#devmail').value.trim(), 'test1234').catch(err => toast(err.code)),
    checkagain: checkAgain,
    signout: () => { closeSheet(); A.signOut(auth); },
    wipe: async () => {
      if (S.pending.length && !confirm(S.pending.length + ' change(s) are not sent yet and will be lost. Continue?')) return;
      closeSheet(); await A.signOut(auth); await F.terminate(db); await F.clearIndexedDbPersistence(db).catch(() => {});
      try { localStorage.clear(); } catch { /* ignore */ }
      location.reload();
    },
    prev: () => planScroll(-ZOOMS[planZoom()]),
    dayprev: () => { S.day = L.addDays(S.day || S.today, -1); draw(); },
    daynext: () => { S.day = L.addDays(S.day || S.today, 1); draw(); },
    daytoday: () => { S.day = S.today; draw(); },
    next: () => planScroll(ZOOMS[planZoom()]),
    today: planToday,
    new: () => openForm(null),
    older: loadOlder,
    close: closeSheet,
    edit: () => openForm(SHEET.b),
    savebk: submitForm,
    markpaid: () => quickSave(b => { for (const l of Object.values(b.lines)) if (l.status !== 'Cancelled') l.paid = 'Yes'; }, 'Marked as paid'),
    cancelbk: () => { if (confirm('Cancel all rooms of this booking? It stays in the list as Cancelled.')) quickSave(b => { for (const l of Object.values(b.lines)) if (l.status !== 'Cancelled') { l.prevStatus = l.status; l.status = 'Cancelled'; } }, 'Booking cancelled'); },
    undo: () => quickSave(b => { for (const l of Object.values(b.lines)) if (l.prevStatus || !String(l.notes || '').startsWith('DOUBLE')) { l.status = l.prevStatus || 'Confirmed'; delete l.prevStatus; } }, 'Booking restored'),
    adduser: addUser,
    addroom: addRoom,
    excel: () => downloadExcel().catch(err => toast('Excel failed: ' + err.message)),
    repxlsx: () => downloadReport().catch(err => toast('Excel failed: ' + err.message)),
    repopt: () => { S.rep.withOptions = !S.rep.withOptions; draw(); },
    repzero: () => { S.rep.open = S.rep.open === 'zero' ? '' : 'zero'; draw(); },
    repout: () => { S.rep.open = S.rep.open === 'out' ? '' : 'out'; draw(); },
    repclose: () => { S.rep.month = null; draw(); },
    bcstep: () => { const k = t.dataset.bc; S.bcom[k] = Math.min(10, Math.max(0, S.bcom[k] + Number(t.dataset.d))); keepBcom(); draw(); },
    bcopt: () => { S.bcom.withOptions = !S.bcom.withOptions; keepBcom(); draw(); },
    bcall: () => { S.rep.open = S.rep.open === 'bcall' ? '' : 'bcall'; draw(); }
  }[act] || (() => {}))();
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'q') { S.q = t.value; const pos = t.selectionStart; draw(); const q = $('#q'); q.focus(); q.setSelectionRange(pos, pos); return; }
  if (SHEET?.kind !== 'form') return;
  const b = SHEET.b;
  if (t.dataset.fld) b[t.dataset.fld] = t.value;
  if (t.dataset.lg) {
    const l = b.lines[t.dataset.lg], rate = L.rateAfterGuests(S.roomsById.get(l.roomId), l.rateGmd, l.guests, t.value);
    l.guests = t.value;
    if (rate !== (Number(l.rateGmd) || 0)) { l.rateGmd = rate; const inp = document.querySelector(`[data-lr="${CSS.escape(t.dataset.lg)}"]`); if (inp) inp.value = rate || ''; }
  }
  if (t.dataset.lr) b.lines[t.dataset.lr].rateGmd = t.value;
  if (t.dataset.lg || t.dataset.lr) { const tot = $('#f-total'); if (tot) tot.textContent = L.fmtGmd(L.bookingTotal(b)); }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.rf) { S.rep[t.dataset.rf] = t.value; S.rep.month = null; return draw(); }
  if (SHEET?.kind === 'form' && t.dataset.date) {
    SHEET.b[t.dataset.date] = t.value;
    if (t.dataset.date === 'checkIn' && L.isDate(t.value) && !(SHEET.b.checkOut > t.value)) { SHEET.b.checkOut = L.addDays(t.value, 1); $('#f-out').value = SHEET.b.checkOut; }
    SHEET.errors = [];
    return drawFormParts();
  }
  if (SHEET?.kind === 'detail' && t.dataset.linepaid) {
    return quickSave(b => { b.lines[t.dataset.linepaid].paid = t.value; }, 'Payment saved');
  }
  if (t.dataset.urole) return setUser(t.dataset.urole, 'role', t.value);
  if (t.dataset.ustate) return setUser(t.dataset.ustate, 'state', t.value);
  if (t.dataset.rrate) return F.setDoc(F.doc(db, 'rooms', t.dataset.rrate), { ['defaultRate' + t.dataset.rkind + 'Gmd']: Number(t.value) || 0 }, { merge: true }).then(() => toast(t.dataset.rkind + ' rate saved'));
  if (t.id === 'imp' && t.files[0]) {
    if (!confirm('Import all bookings from this file? Do this only once.')) return;
    importSheet(t.files[0]).catch(err => importOut('Import failed: ' + esc(err.message)));
  }
});
document.addEventListener('click', e => {
  const t = e.target.closest('[data-ractive]');
  if (!t) return;
  const r = S.roomsById.get(t.dataset.ractive);
  F.setDoc(F.doc(db, 'rooms', r.id), { active: r.active === false }, { merge: true }).then(() => toast('Saved'));
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && SHEET) closeSheet(); });
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

let resizeT = 0;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (S.tab === 'planning' || S.tab === 'today' || S.tab === 'reports') draw(); }, 150); });
// A new day at midnight in Gambia.
setInterval(() => { const t = L.todayIn(TIMEZONE); if (t !== S.today) { S.today = t; render(); } }, 60000);

if ('serviceWorker' in navigator && !USE_EMULATOR) navigator.serviceWorker.register('sw.js').catch(() => {});
