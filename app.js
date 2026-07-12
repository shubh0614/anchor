// app.js
// All ANCHOR logic. The app knows nothing about exercises, days, rep ranges, or
// training rules: everything comes from plan.json. History is keyed by exercise
// id so a plan swap preserves it.

import { Store, e1rmOf } from "./storage.js";

// ---------- constants ----------

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const TRAINING_ORDER = ["TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const SKIP_REASONS = ["machine busy", "short on time", "not feeling it", "injury"];
const FIRST_TIME_WEIGHT = 20;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MON_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// ---------- module state ----------

let plan = null;
let exIndex = {};
let activeSession = null;
let activeDay = null;
const drafts = new Map();

const now = new Date();
const state = {
  view: "today",
  detailExerciseId: null,
  chartMode: "e1rm",
  calYear: now.getFullYear(),
  calMonth: now.getMonth(),
  sessionDetailId: null,
};

const rest = { raf: 0, endsAt: 0, duration: 0, running: false, hideTimer: 0 };

// ---------- boot ----------

async function boot() {
  wireStaticUi();
  Store.onEvent((e) => { if (e.type === "restored") toast("Restored from backup."); });

  const [planRes] = await Promise.all([
    fetch("plan.json", { cache: "no-store" }).then((r) => r.json()),
    Store.load(),
  ]);
  plan = planRes;
  buildExerciseIndex();
  activeDay = defaultDayForToday();
  render();
  updateNag();

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  requestPersistentStorage();
}

// Ask the browser to mark storage durable so it is not auto-evicted under
// storage pressure or the iOS "not opened in a week" rule. Installed home
// screen apps are usually granted this. It does not stop a manual wipe.
async function requestPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      if (!already) await navigator.storage.persist();
    }
  } catch (e) { /* best effort */ }
}

function buildExerciseIndex() {
  exIndex = {};
  for (const day of plan.days) {
    for (const block of day.blocks) {
      for (const ex of block.exercises) if (!exIndex[ex.id]) exIndex[ex.id] = ex;
    }
  }
}

// ---------- date helpers ----------

function todayISO(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function dateFromIso(iso) { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); }
function weekdayCode(d) { return DOW[d.getDay()]; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function fmtDate(iso) { const [, m, d] = iso.split("-").map(Number); return `${String(d).padStart(2, "0")} ${MON_SHORT[m - 1]}`; }
function fmtTime(sec) { const s = Math.max(0, sec); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
function fmtWeight(w) { return Number.isInteger(w) ? String(w) : String(Number(w.toFixed(2))); }

// ---------- plan helpers ----------

function planDayForWeekday(code) { return plan.days.find((d) => d.weekday === code) || null; }
function planDayById(id) { return plan.days.find((d) => d.dayId === id) || null; }
function defaultDayForToday() { return planDayForWeekday(weekdayCode(new Date())); }

// ---------- schedule / block week ----------

function currentBlockWeek() { return Store.getBlockWeek(todayISO()); }

function scheduleRuleForWeek(week) {
  if (week == null || !plan.rules || !plan.rules.schedule) return null;
  return plan.rules.schedule.find((r) => r.weeks.includes(week)) || null;
}
function isDeloadWeek(week) {
  const r = scheduleRuleForWeek(week);
  return Boolean(r && r.kind === "deload");
}
function effectiveSets(ex, deload) { return deload ? Math.max(1, Math.floor(ex.sets / 2)) : ex.sets; }

// ---------- history + progression ----------

function lastSessionFor(exerciseId) {
  const hist = Store.getExerciseHistory(exerciseId).filter((h) => !activeSession || h.sessionId !== activeSession.sessionId);
  return hist.length ? hist[hist.length - 1] : null;
}
function topWeight(sets) { return sets.reduce((m, s) => Math.max(m, s.weight), 0); }
function shouldProgress(ex, last) { return last && last.sets.length ? last.sets.every((s) => s.reps >= ex.repMax) : false; }
function entryFor(exerciseId) { return activeSession ? activeSession.entries.find((e) => e.exerciseId === exerciseId) || null : null; }

function draftFor(ex, setIndex, last, progress) {
  const key = ex.id + "::" + setIndex;
  if (drafts.has(key)) return drafts.get(key);
  const entry = entryFor(ex.id);
  const committed = entry ? entry.sets.filter(Boolean) : [];
  let weight, reps;
  if (committed.length > 0) {
    weight = committed[committed.length - 1].weight;
    reps = progress ? ex.repMin : (last && last.sets[setIndex] ? last.sets[setIndex].reps : committed[committed.length - 1].reps);
  } else if (progress && last) {
    weight = topWeight(last.sets) + ex.increment;
    reps = ex.repMin;
  } else if (last) {
    const ls = last.sets[setIndex] || last.sets[last.sets.length - 1];
    weight = ls.weight; reps = ls.reps;
  } else {
    weight = ex.increment > 0 ? FIRST_TIME_WEIGHT : 0; reps = ex.repMin;
  }
  const d = { weight, reps };
  drafts.set(key, d);
  return d;
}

// ---------- session lifecycle ----------

function sessionIdFor(dayId, dateIso) { return `${dateIso}_day${dayId}`; }

function ensureSession(dayId) {
  const dateIso = todayISO();
  const id = sessionIdFor(dayId, dateIso);
  const existing = Store.getSession(id);
  if (existing) activeSession = existing;
  else activeSession = { sessionId: id, date: dateIso, dayId, planVersion: plan.planVersion, startedAt: Date.now(), endedAt: null, entries: [] };
  return activeSession;
}
function ensureEntry(exerciseId) {
  let entry = activeSession.entries.find((e) => e.exerciseId === exerciseId);
  if (!entry) { entry = { exerciseId, skipped: false, sets: [] }; activeSession.entries.push(entry); }
  return entry;
}

async function commitSet(ex, setIndex) {
  const key = ex.id + "::" + setIndex;
  const d = drafts.get(key) || draftFor(ex, setIndex, lastSessionFor(ex.id), false);
  ensureSession(activeDay.dayId);
  const entry = ensureEntry(ex.id);
  entry.skipped = false;
  entry.sets[setIndex] = { weight: d.weight, reps: d.reps, loggedAt: Date.now() };
  activeSession.endedAt = Date.now();
  drafts.delete(key);
  await Store.saveSession(activeSession);
  const block = blockForExercise(ex.id);
  startRest(block ? block.restSeconds : 90);
  render();
}

function blockForExercise(exerciseId) {
  for (const block of activeDay.blocks) if (block.exercises.some((e) => e.id === exerciseId)) return block;
  return null;
}

async function toggleSkip(exerciseId, reason) {
  ensureSession(activeDay.dayId);
  const entry = ensureEntry(exerciseId);
  if (entry.skipped) { entry.skipped = false; delete entry.skipReason; }
  else { entry.skipped = true; if (reason) entry.skipReason = reason; entry.sets = []; }
  await Store.saveSession(activeSession);
  render();
}

async function endSession() {
  if (activeSession) { activeSession.endedAt = Date.now(); await Store.saveSession(activeSession); }
  state.view = "summary";
  render();
}

// ---------- rendering core ----------

const app = document.getElementById("app");

function render() {
  syncNav();
  switch (state.view) {
    case "calendar": return renderCalendar();
    case "history": return renderHistory();
    case "plan": return renderPlan();
    case "detail": return renderDetail(state.detailExerciseId);
    case "summary": return renderSummary();
    case "session-detail": return renderSessionDetail(state.sessionDetailId);
    default: return renderToday();
  }
}

function syncNav() {
  const map = { today: "today", summary: "today", calendar: "calendar", "session-detail": "calendar", history: "history", detail: "history", plan: "plan" };
  const active = map[state.view] || "today";
  document.querySelectorAll(".botnav button").forEach((b) => b.setAttribute("aria-current", b.dataset.view === active ? "true" : "false"));
}

function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---------- Today ----------

function renderToday() {
  app.innerHTML = "";
  if (!activeDay) {
    app.appendChild(el(`<section class="rest-day"><div class="big">Rest day. Eat.</div><div class="sub">Monday. Nothing to log.</div></section>`));
    app.appendChild(weekSummaryStrip());
    app.appendChild(overrideControl());
    return;
  }

  ensureSession(activeDay.dayId);
  const week = currentBlockWeek();
  const deload = isDeloadWeek(week);

  const dt = activeDay.dayType;
  const head = el(`
    <div class="day-head">
      <span class="daytype-tag ${dt}">${dt} day</span>
      <h1 class="day-title">${esc(activeDay.title)}</h1>
      <p class="day-sub">${esc(activeDay.subtitle)} &middot; ${esc(activeDay.weekday)}</p>
      ${week ? `<div class="day-meta">week ${week}</div>` : ""}
    </div>
  `);
  app.appendChild(head);

  const banner = renderBanner(week);
  if (banner) app.appendChild(banner);

  const firstEver = Store.getSessions().length === 0 && activeSession.entries.every((e) => e.sets.length === 0);
  if (firstEver) app.appendChild(el(`<p class="ex-last" style="margin:-8px 4px 16px;">No history yet. Enter your working weights and the app takes over from here.</p>`));

  for (const block of activeDay.blocks) app.appendChild(renderBlock(block, deload));

  app.appendChild(overrideControl());
  const end = el(`<div class="btn-row"><button class="btn" id="endBtn">End session</button></div>`);
  end.querySelector("#endBtn").onclick = endSession;
  app.appendChild(end);
}

// Scheduled rule banner. Ramp and deload persist; review is dismissible per block.
function renderBanner(week) {
  const rule = scheduleRuleForWeek(week);
  if (!rule) return null;

  if (rule.kind === "review") {
    if (Store.isReviewed(rule.reviewKey)) return null;
    const b = el(`
      <div class="banner review">
        <div class="b-tag">week ${week} . ${esc(rule.title)}</div>
        <div class="b-body">${esc(rule.body)}</div>
        <div class="b-actions"><button id="rvOpen">Open logs</button><button id="rvDone">Done</button></div>
      </div>
    `);
    b.querySelector("#rvOpen").onclick = () => openDetail(rule.reviewExerciseId);
    b.querySelector("#rvDone").onclick = async () => { await Store.markReviewed(rule.reviewKey); render(); };
    return b;
  }

  let tag;
  if (rule.kind === "ramp") {
    const pos = rule.weeks.indexOf(week) + 1;
    tag = `week ${pos} of ${rule.weeks.length} . ramp`;
  } else {
    tag = `week ${week} . deload`;
  }
  return el(`<div class="banner ${rule.kind}"><div class="b-tag">${tag}</div><div class="b-body">${esc(rule.body)}</div></div>`);
}

function renderBlock(block, deload) {
  const grouped = block.type === "superset" || block.type === "triset";
  const card = el(`
    <section class="block ${block.type === "anchor" ? "anchor" : ""} ${grouped ? "grouped" : ""}">
      <div class="block-tag">${esc(block.type)} &middot; rest ${block.restSeconds}s</div>
      <div class="exercises"></div>
    </section>
  `);
  const host = card.querySelector(".exercises");
  for (const ex of block.exercises) host.appendChild(renderExercise(ex, block, deload));
  return card;
}

function renderExercise(ex, block, deload) {
  const entry = entryFor(ex.id);
  const last = lastSessionFor(ex.id);
  const progress = shouldProgress(ex, last);
  const skipped = entry && entry.skipped;
  const nSets = effectiveSets(ex, deload);

  const wrap = el(`<div class="exercise ${progress ? "progress" : ""} ${skipped ? "skipped" : ""}"></div>`);
  const lastLine = last ? `Last: ${fmtWeight(topWeight(last.sets))} kg x ${last.sets.map((s) => s.reps).join(", ")}` : "Last: none yet";

  const head = el(`
    <div>
      <div class="ex-head">
        <button class="ex-name" type="button">${esc(ex.name)}</button>
        <span class="ex-target mono">${nSets} x ${ex.repMin}-${ex.repMax}${deload ? `<span class="deload-tag">deload</span>` : ""}</span>
        ${progress ? `<span class="badge-add">ADD WEIGHT</span>` : ""}
        <button class="ex-skip" type="button">${skipped ? "Skipped" : "Skip"}</button>
      </div>
      ${ex.note ? `<p class="ex-note">${esc(ex.note)}</p>` : ""}
      <p class="ex-last mono">${esc(lastLine)}</p>
    </div>
  `);
  head.querySelector(".ex-name").onclick = () => openDetail(ex.id);
  head.querySelector(".ex-skip").onclick = () => { if (skipped) return toggleSkip(ex.id); openSkipModal(ex.id); };
  wrap.appendChild(head);

  if (!skipped) {
    const pills = el(`<div class="pills"></div>`);
    for (let i = 0; i < nSets; i++) pills.appendChild(renderPill(ex, i, last, progress));
    wrap.appendChild(pills);
  }
  return wrap;
}

function renderPill(ex, setIndex, last, progress) {
  const entry = entryFor(ex.id);
  const committedSet = entry && entry.sets[setIndex];
  const repsOnly = ex.increment === 0;

  if (committedSet) {
    const up = committedSet.reps >= ex.repMax;
    return el(`
      <div class="pill committed ${up ? "up" : ""}">
        <span class="pill-set-no">${setIndex + 1}</span><span class="sweep"></span>
        <div class="pill-fields">
          ${repsOnly ? "" : `<div class="cfield"><span class="val">${fmtWeight(committedSet.weight)}</span><span class="unit">kg</span></div>`}
          <div class="cfield"><span class="val">${committedSet.reps}</span><span class="lbl">reps</span></div>
        </div>
        <div class="commit">${up ? "&#9650;" : "&#10003;"}</div>
      </div>
    `);
  }

  const d = draftFor(ex, setIndex, last, progress);
  const pill = el(`
    <div class="pill">
      <span class="pill-set-no">${setIndex + 1}</span>
      <div class="pill-fields">
        ${repsOnly ? "" : `
        <div class="stepper" data-axis="weight">
          <button class="step-btn" data-dir="-1" aria-label="decrease weight">&minus;</button>
          <div class="field"><span class="val mono w-val">${fmtWeight(d.weight)}</span><span class="unit">kg</span></div>
          <button class="step-btn" data-dir="1" aria-label="increase weight">+</button>
        </div>`}
        <div class="stepper" data-axis="reps">
          <button class="step-btn" data-dir="-1" aria-label="decrease reps">&minus;</button>
          <div class="field"><span class="val mono r-val">${d.reps}</span><span class="lbl">reps</span></div>
          <button class="step-btn" data-dir="1" aria-label="increase reps">+</button>
        </div>
      </div>
      <button class="commit" aria-label="commit set ${setIndex + 1}">&#10003;</button>
    </div>
  `);
  const wVal = pill.querySelector(".w-val"), rVal = pill.querySelector(".r-val");
  pill.querySelectorAll('.stepper[data-axis="weight"] .step-btn').forEach((btn) => {
    btn.onclick = () => { d.weight = Math.max(0, +(d.weight + Number(btn.dataset.dir) * ex.increment).toFixed(2)); wVal.textContent = fmtWeight(d.weight); };
  });
  pill.querySelectorAll('.stepper[data-axis="reps"] .step-btn').forEach((btn) => {
    btn.onclick = () => { d.reps = Math.max(0, d.reps + Number(btn.dataset.dir)); rVal.textContent = d.reps; };
  });
  pill.querySelector(".commit").onclick = () => commitSet(ex, setIndex);
  return pill;
}

function overrideControl() {
  const wrap = el(`<div class="btn-row"><button class="link" type="button">Not ${activeDay ? activeDay.weekday : "training"} today? Change day</button></div>`);
  wrap.querySelector("button").onclick = openDayPicker;
  return wrap;
}

// ---------- summary ----------

function renderSummary() {
  app.innerHTML = "";
  const s = activeSession;
  if (!s) { state.view = "today"; return render(); }
  let setsLogged = 0, setsSkipped = 0; const up = [], stalled = [];
  for (const entry of s.entries) {
    if (entry.skipped) { setsSkipped++; continue; }
    setsLogged += entry.sets.length;
    if (!entry.sets.length) continue;
    const ex = exIndex[entry.exerciseId];
    if (entry.sets.every((set) => set.reps >= ex.repMax)) up.push(ex.name); else stalled.push(ex.name);
  }
  const mins = s.endedAt && s.startedAt ? Math.round((s.endedAt - s.startedAt) / 60000) : 0;
  const section = el(`
    <section class="summary">
      <div class="day-head"><h1 class="day-title">Session done</h1><p class="day-sub">${esc(activeDay.title)} &middot; ${fmtDate(s.date)}</p></div>
      <div class="stat-row">
        <div class="stat"><div class="n mono">${mins}</div><div class="k">minutes</div></div>
        <div class="stat"><div class="n mono">${setsLogged}</div><div class="k">sets logged</div></div>
        <div class="stat"><div class="n mono">${setsSkipped}</div><div class="k">skipped</div></div>
      </div>
      ${up.length ? `<div class="section-title">What went up</div><ul class="up-list">${up.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      ${stalled.length ? `<div class="section-title">What stalled</div><ul class="stall-list">${stalled.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      <div class="btn-row"><button class="btn" id="toCal">Calendar</button><button class="btn" id="back">Back to session</button></div>
    </section>
  `);
  section.querySelector("#toCal").onclick = () => { state.view = "calendar"; render(); };
  section.querySelector("#back").onclick = () => { state.view = "today"; render(); };
  app.appendChild(section);
}

// ---------- exercise detail (cues, video, chart, table) ----------

function openDetail(exerciseId) { state.view = "detail"; state.detailExerciseId = exerciseId; render(); }

function renderDetail(exerciseId) {
  app.innerHTML = "";
  const ex = exIndex[exerciseId];
  const hist = Store.getExerciseHistory(exerciseId);

  const head = el(`
    <div class="day-head">
      <button class="link" id="back" type="button">&larr; Back</button>
      <h1 class="day-title" style="margin-top:6px;">${esc(ex ? ex.name : exerciseId)}</h1>
      ${ex ? `<p class="day-sub">${ex.sets} x ${ex.repMin}-${ex.repMax} &middot; +${fmtWeight(ex.increment)} kg</p>` : ""}
    </div>
  `);
  head.querySelector("#back").onclick = () => { state.view = "history"; render(); };
  app.appendChild(head);

  // 1. Cues (form reference). Plain text, no player.
  if (ex && ex.cues && ex.cues.length) {
    app.appendChild(el(`<ul class="cues">${ex.cues.slice(0, 3).map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`));
  }
  // 2. Watch form: only if a link exists. Opens in a new tab, no embed.
  if (ex && ex.video) {
    const btn = el(`<div><a class="watch-btn" href="${esc(ex.video)}" target="_blank" rel="noopener">Watch form</a></div>`);
    app.appendChild(btn);
  }

  if (!hist.length) { app.appendChild(el(`<section class="empty"><div class="sub">No history yet.</div></section>`)); return; }

  let bestSoFar = 0;
  const series = hist.map((h) => {
    const bestE1rm = h.sets.reduce((m, s) => Math.max(m, e1rmOf(s.weight, s.reps)), 0);
    const volume = h.sets.reduce((v, s) => v + s.weight * s.reps, 0);
    const pb = bestE1rm > bestSoFar + 1e-9; if (pb) bestSoFar = bestE1rm;
    return { date: h.date, e1rm: bestE1rm, volume, pb, sets: h.sets };
  });

  const toggle = el(`
    <div class="toggle-row">
      <button class="toggle" data-mode="e1rm" aria-pressed="${state.chartMode === "e1rm"}">e1RM</button>
      <button class="toggle" data-mode="volume" aria-pressed="${state.chartMode === "volume"}">Volume load</button>
    </div>
  `);
  toggle.querySelectorAll(".toggle").forEach((b) => { b.onclick = () => { state.chartMode = b.dataset.mode; render(); }; });
  app.appendChild(toggle);

  const cols = el(`<div class="history-cols"></div>`);
  const values = series.map((p) => state.chartMode === "e1rm" ? p.e1rm : p.volume);
  const pbs = series.map((p) => state.chartMode === "e1rm" ? p.pb : false);
  cols.appendChild(el(`<div class="chart-wrap">${lineChartSvg(values, pbs, series.map((p) => p.date))}</div>`));

  const rows = series.slice().reverse().map((p) =>
    `<tr><td>${fmtDate(p.date)}</td><td>${fmtWeight(topWeight(p.sets))}</td><td>${p.sets.map((s) => s.reps).join(", ")}</td><td class="${p.pb ? "up" : ""}">${p.e1rm.toFixed(1)}</td></tr>`
  ).join("");
  cols.appendChild(el(`<table class="htable"><thead><tr><th>Date</th><th>Weight</th><th>Reps</th><th>e1RM</th></tr></thead><tbody>${rows}</tbody></table>`));
  app.appendChild(cols);
}

function lineChartSvg(values, pbs, dates) {
  const W = 320, H = 160, padL = 34, padR = 10, padT = 12, padB = 22;
  const n = values.length;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const lo = min - span * 0.1, hi = max + span * 0.1;
  const x = (i) => padL + (n === 1 ? (W - padL - padR) / 2 : (i * (W - padL - padR)) / (n - 1));
  const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
  const linePts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const dots = values.map((v, i) => `<circle class="chart-dot ${pbs[i] ? "pb" : ""}" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${pbs[i] ? 4 : 3}" />`).join("");
  const grid = [0, 0.5, 1].map((f) => { const val = lo + (hi - lo) * f, yy = y(val); return `<line class="chart-grid" x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" /><text class="chart-axis" x="4" y="${(yy + 3).toFixed(1)}">${val.toFixed(0)}</text>`; }).join("");
  const firstLabel = `<text class="chart-axis" x="${padL}" y="${H - 6}">${fmtDate(dates[0])}</text>`;
  const lastLabel = n > 1 ? `<text class="chart-axis" x="${W - padR}" y="${H - 6}" text-anchor="end">${fmtDate(dates[n - 1])}</text>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="chart">${grid}<polyline class="chart-line" points="${linePts}" />${dots}${firstLabel}${lastLabel}</svg>`;
}

// ---------- calendar ----------

// Any session actually logged on a date, regardless of which dayId it used
// (the day can be overridden, so we do not assume weekday maps to dayId).
function sessionOnDate(iso) {
  const all = Store.db.sessions;
  for (const k in all) if (all[k].date === iso) return all[k];
  return null;
}
function planInfoForDate(iso) {
  const session = sessionOnDate(iso);
  const scheduledDay = planDayForWeekday(weekdayCode(dateFromIso(iso)));
  const dayForType = session ? planDayById(session.dayId) : scheduledDay;
  return { scheduledDay, session, dayType: dayForType ? dayForType.dayType : null };
}
function isLogged(session) { return Boolean(session && session.entries.some((e) => e.sets && e.sets.length > 0)); }
function sessionCompleted(session, planDay) {
  if (!session || !planDay) return false;
  const total = planDay.blocks.reduce((n, b) => n + b.exercises.length, 0);
  const logged = session.entries.filter((e) => !e.skipped && e.sets && e.sets.length > 0).length;
  return logged * 2 >= total;
}
// Completed judged against the session's own day (its dayId), not the weekday.
function completedOn(iso) {
  const s = sessionOnDate(iso);
  return s ? sessionCompleted(s, planDayById(s.dayId)) : false;
}
function dayWentUp(session) {
  if (!session) return false;
  for (const e of session.entries) {
    if (e.skipped || !e.sets || !e.sets.length) continue;
    const ex = exIndex[e.exerciseId];
    if (ex && e.sets.every((s) => s.reps >= ex.repMax)) return true;
  }
  return false;
}
function earliestSessionDate() { const s = Store.getSessions(); return s.length ? s[0].date : null; }

function currentStreak() {
  let streak = 0, cursor = dateFromIso(todayISO());
  for (let i = 0; i < 400; i++) {
    const iso = todayISO(cursor);
    if (!planDayForWeekday(weekdayCode(cursor))) { cursor = addDays(cursor, -1); continue; } // Monday never breaks
    if (completedOn(iso)) { streak++; }
    else if (iso === todayISO()) { cursor = addDays(cursor, -1); continue; } // today not done yet
    else break;
    cursor = addDays(cursor, -1);
  }
  return streak;
}
function longestStreak() {
  const start = earliestSessionDate(); if (!start) return 0;
  let cur = 0, best = 0, d = dateFromIso(start); const end = dateFromIso(todayISO());
  while (d <= end) {
    const iso = todayISO(d);
    if (planDayForWeekday(weekdayCode(d))) {
      if (completedOn(iso)) { cur++; best = Math.max(best, cur); }
      else if (iso !== todayISO()) cur = 0;
    }
    d = addDays(d, 1);
  }
  return best;
}
function ratioSince(startIso) {
  let scheduled = 0, completed = 0;
  let d = dateFromIso(startIso); const end = dateFromIso(todayISO());
  while (d <= end) {
    const iso = todayISO(d);
    if (planDayForWeekday(weekdayCode(d))) { scheduled++; if (completedOn(iso)) completed++; }
    d = addDays(d, 1);
  }
  return { scheduled, completed };
}

function renderCalendar() {
  app.innerHTML = "";
  app.appendChild(el(`<div class="day-head"><h1 class="day-title">Calendar</h1></div>`));

  // records
  const streak = currentStreak(), longest = longestStreak();
  const monthStart = `${state.calYear}-${String(state.calMonth + 1).padStart(2, "0")}-01`;
  const thisMonth = ratioSince(todayISO(new Date(now.getFullYear(), now.getMonth(), 1)));
  const blockStart = Store.getBlockStartDate();
  const adherence = blockStart ? ratioSince(blockStart) : { scheduled: 0, completed: 0 };
  const pct = adherence.scheduled ? Math.round((adherence.completed / adherence.scheduled) * 100) : 0;
  app.appendChild(el(`
    <div class="records">
      <div class="record"><div class="rn mono">${streak}</div><div class="rk">Current</div></div>
      <div class="record"><div class="rn mono">${longest}</div><div class="rk">Longest</div></div>
      <div class="record"><div class="rn mono">${thisMonth.completed}/${thisMonth.scheduled}</div><div class="rk">This month</div></div>
      <div class="record"><div class="rn mono">${pct}%</div><div class="rk">Adherence</div></div>
    </div>
  `));

  // month header + nav
  const chead = el(`
    <div class="cal-head">
      <button id="prev" aria-label="previous month">&lsaquo;</button>
      <div class="mlabel">${MONTHS[state.calMonth]} ${state.calYear}</div>
      <button id="next" aria-label="next month">&rsaquo;</button>
    </div>
  `);
  chead.querySelector("#prev").onclick = () => { state.calMonth--; if (state.calMonth < 0) { state.calMonth = 11; state.calYear--; } render(); };
  chead.querySelector("#next").onclick = () => { state.calMonth++; if (state.calMonth > 11) { state.calMonth = 0; state.calYear++; } render(); };
  app.appendChild(chead);

  app.appendChild(el(`<div class="cal-dow">${["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d) => `<span>${d}</span>`).join("")}</div>`));

  // grid: weeks Monday to Sunday
  const first = new Date(state.calYear, state.calMonth, 1);
  const firstDow = (first.getDay() + 6) % 7; // 0 = Monday
  const gridStart = addDays(first, -firstDow);
  const grid = el(`<div class="cal-grid"></div>`);
  const todayStr = todayISO();

  for (let w = 0; w < 6; w++) {
    // deload band: check block week for this row's Thursday
    const rowThu = addDays(gridStart, w * 7 + 3);
    const rowWeek = Store.getBlockWeek(todayISO(rowThu));
    const rowDeload = rowWeek != null && isDeloadWeek(rowWeek);
    let anyInMonth = false;
    const cells = [];
    for (let di = 0; di < 7; di++) {
      const cur = addDays(gridStart, w * 7 + di);
      const iso = todayISO(cur);
      const inMonth = cur.getMonth() === state.calMonth;
      if (inMonth) anyInMonth = true;
      cells.push(buildCalCell(cur, iso, inMonth, todayStr));
    }
    if (w >= 4 && !anyInMonth) break;
    if (rowDeload) grid.appendChild(el(`<div class="deload-label">deload</div>`));
    const week = el(`<div class="cal-week ${rowDeload ? "deload" : ""}"></div>`);
    cells.forEach((c) => week.appendChild(c));
    grid.appendChild(week);
  }
  app.appendChild(grid);

  // 12 month heat strip
  app.appendChild(el(`<div class="section-title">Last 12 months</div>`));
  app.appendChild(heatStrip());
}

function buildCalCell(cur, iso, inMonth, todayStr) {
  const dayNum = cur.getDate();
  if (!inMonth) return el(`<div class="cal-cell blank"></div>`);
  const info = planInfoForDate(iso);
  let cls = "cal-cell";
  const past = iso < todayStr;
  if (isLogged(info.session)) { cls += info.dayType === "push" ? " push-logged" : " pull-logged"; }
  else if (!info.scheduledDay) { cls += " restday"; }
  else if (past) { cls += " missed"; }
  else { cls += info.scheduledDay.dayType === "push" ? " scheduled-push" : " scheduled-pull"; }
  if (iso === todayStr) cls += " today";
  const up = dayWentUp(info.session);
  const tappable = isLogged(info.session);
  if (tappable) cls += " tappable";
  const cell = el(`<div class="${cls}">${dayNum}${up ? `<span class="pr-dot"></span>` : ""}</div>`);
  if (tappable) cell.onclick = () => { state.view = "session-detail"; state.sessionDetailId = info.session.sessionId; render(); };
  return cell;
}

function heatStrip() {
  const wrap = el(`<div class="heatstrip"></div>`);
  const weeks = 52;
  // find this week's Monday
  const t = dateFromIso(todayISO());
  const monday = addDays(t, -((t.getDay() + 6) % 7));
  for (let i = weeks - 1; i >= 0; i--) {
    const wkStart = addDays(monday, -i * 7);
    let count = 0;
    for (let d = 0; d < 7; d++) {
      const cur = addDays(wkStart, d);
      if (planDayForWeekday(weekdayCode(cur)) && completedOn(todayISO(cur))) count++;
    }
    const opacity = count === 0 ? 0.08 : 0.2 + (count / 6) * 0.8;
    wrap.appendChild(el(`<div class="col" style="opacity:${opacity.toFixed(2)};height:100%"></div>`));
  }
  return wrap;
}

// ---------- read only session detail (calendar tap) ----------

function renderSessionDetail(sessionId) {
  app.innerHTML = "";
  const s = Store.getSession(sessionId);
  const day = s ? planDayById(s.dayId) : null;
  const head = el(`<div class="day-head"><button class="link" id="back" type="button">&larr; Back</button><h1 class="day-title" style="margin-top:6px;">${day ? esc(day.title) : "Session"}</h1><p class="day-sub">${s ? fmtDate(s.date) : ""}</p></div>`);
  head.querySelector("#back").onclick = () => { state.view = "calendar"; render(); };
  app.appendChild(head);
  if (!s) { app.appendChild(el(`<section class="empty"><div class="sub">Nothing logged.</div></section>`)); return; }

  for (const entry of s.entries) {
    const ex = exIndex[entry.exerciseId];
    const name = ex ? ex.name : entry.exerciseId;
    const up = ex && !entry.skipped && entry.sets.length && entry.sets.every((set) => set.reps >= ex.repMax);
    const detail = entry.skipped
      ? `<span class="ex-last">Skipped${entry.skipReason ? " (" + esc(entry.skipReason) + ")" : ""}</span>`
      : `<span class="ex-last mono">${entry.sets.map((s2) => `${fmtWeight(s2.weight)}x${s2.reps}`).join(", ") || "no sets"}</span>`;
    app.appendChild(el(`<div class="block"><div class="ex-head"><span class="ex-name">${esc(name)}</span>${up ? `<span class="badge-add">ADD WEIGHT</span>` : ""}</div>${detail}</div>`));
  }
}

// ---------- History tab (body metrics + exercise list) ----------

function renderHistory() {
  app.innerHTML = "";
  app.appendChild(el(`<div class="day-head"><h1 class="day-title">History</h1></div>`));

  renderBodySection();

  app.appendChild(el(`<div class="section-title">Exercises</div>`));
  const list = el(`<div class="ex-list"></div>`);
  const seen = new Set();
  for (const day of plan.days) {
    for (const block of day.blocks) {
      for (const ex of block.exercises) {
        if (seen.has(ex.id)) continue;
        seen.add(ex.id);
        const hist = Store.getExerciseHistory(ex.id);
        let metaText = "no data";
        if (hist.length) {
          const last = hist[hist.length - 1];
          const best = last.sets.reduce((m, s) => Math.max(m, e1rmOf(s.weight, s.reps)), 0);
          metaText = `e1RM ${best.toFixed(1)}`;
        }
        const b = el(`<button type="button"><span>${esc(ex.name)}</span><span class="meta mono">${metaText}</span></button>`);
        b.onclick = () => openDetail(ex.id);
        list.appendChild(b);
      }
    }
  }
  app.appendChild(list);

  // data + settings
  const s = Store.getSettings();
  app.appendChild(el(`<div class="section-title">Data</div>`));
  const data = el(`
    <div>
      <div class="toggle-row">
        <button class="toggle" id="tSound" aria-pressed="${!!s.sound}">Sound at zero</button>
        <button class="toggle" id="tVibrate" aria-pressed="${s.vibrate !== false}">Vibrate at zero</button>
      </div>
      <div class="btn-row"><button class="btn" id="exp2">Export backup</button><button class="btn" id="imp2">Import backup</button></div>
    </div>
  `);
  data.querySelector("#tSound").onclick = async (e) => { const on = e.currentTarget.getAttribute("aria-pressed") !== "true"; e.currentTarget.setAttribute("aria-pressed", String(on)); await Store.updateSettings({ sound: on }); };
  data.querySelector("#tVibrate").onclick = async (e) => { const on = e.currentTarget.getAttribute("aria-pressed") !== "true"; e.currentTarget.setAttribute("aria-pressed", String(on)); await Store.updateSettings({ vibrate: on }); };
  data.querySelector("#exp2").onclick = doExport;
  data.querySelector("#imp2").onclick = openImport;
  app.appendChild(data);
}

function renderBodySection() {
  const db = Store.exportJson();
  const bw = db.bodyweight || [];
  app.appendChild(el(`<div class="section-title">Body</div>`));
  const bwCard = el(`<div class="chart-wrap"></div>`);
  if (bw.length) {
    bwCard.innerHTML = `<div class="ex-last mono" style="color:var(--violet)">Bodyweight &middot; ${fmtWeight(bw[bw.length - 1].kg)} kg</div>` + bodyChartSvg(bw.map((b) => b.kg), bw.map((b) => b.date));
  } else {
    bwCard.innerHTML = `<div class="sub" style="color:var(--steel)">No bodyweight logged yet.</div>`;
  }
  app.appendChild(bwCard);
  const addBw = el(`<div class="btn-row"><button class="btn" id="addBw">Log bodyweight</button><button class="btn" id="addM">Log measurements</button></div>`);
  addBw.querySelector("#addBw").onclick = openBodyweightModal;
  addBw.querySelector("#addM").onclick = openMeasureModal;
  app.appendChild(addBw);

  const meas = db.measurements || [];
  const fields = [["waistCm", "Waist"], ["armCm", "Arm"], ["chestCm", "Chest"], ["shoulderCm", "Shoulder"]];
  const sparks = el(`<div class="spark-set"></div>`);
  for (const [key, label] of fields) {
    const pts = meas.filter((m) => m[key] != null).map((m) => m[key]);
    const cur = pts.length ? fmtWeight(pts[pts.length - 1]) : "-";
    sparks.appendChild(el(`<div class="spark"><div class="lbl">${label}</div><div class="cur mono">${cur}<span class="unit" style="font-size:11px;color:var(--steel)"> cm</span></div>${pts.length > 1 ? sparkSvg(pts) : ""}</div>`));
  }
  app.appendChild(sparks);
}

function bodyChartSvg(values, dates) {
  const W = 320, H = 120, padL = 30, padR = 10, padT = 10, padB = 20;
  const n = values.length;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const lo = min - span * 0.3, hi = max + span * 0.3;
  const x = (i) => padL + (n === 1 ? (W - padL - padR) / 2 : (i * (W - padL - padR)) / (n - 1));
  const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
  // target band: 0.25 kg/week down from the first point
  let band = "";
  if (n > 1) {
    const firstV = values[0];
    const weeksSpan = n - 1;
    const target = firstV - 0.25 * weeksSpan;
    const yTop = y(firstV), yBot = y(target);
    band = `<rect class="chart-band" x="${padL}" y="${Math.min(yTop, yBot).toFixed(1)}" width="${W - padL - padR}" height="${Math.abs(yBot - yTop).toFixed(1)}" />`;
  }
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const dots = values.map((v, i) => `<circle class="chart-dot violet" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" />`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="bodyweight">${band}<polyline class="chart-line violet" points="${pts}" />${dots}<text class="chart-axis" x="4" y="${y(max).toFixed(1)}">${fmtWeight(max)}</text><text class="chart-axis" x="4" y="${y(min).toFixed(1)}">${fmtWeight(min)}</text></svg>`;
}
function sparkSvg(values) {
  const W = 140, H = 32, n = values.length;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const x = (i) => (i * W) / (n - 1), y = (v) => H - 2 - (H - 4) * ((v - min) / span);
  return `<svg viewBox="0 0 ${W} ${H}"><polyline class="chart-line violet" points="${values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}" /></svg>`;
}

// ---------- Plan page ----------

function renderPlan() {
  app.innerHTML = "";
  const r = plan.rules || {};
  const week = currentBlockWeek();
  app.appendChild(el(`<div class="day-head"><h1 class="day-title">Plan</h1></div>`));

  // 1. this week
  const rule = scheduleRuleForWeek(week);
  const weekCard = el(`<div class="plan-week"><div class="wk">${week ? "Week " + week + " of the block." : "No sessions logged yet. Week 1 begins on your first log."}</div></div>`);
  if (rule) {
    const tag = rule.kind === "ramp" ? `week ${rule.weeks.indexOf(week) + 1} of ${rule.weeks.length} . ramp` : `week ${week} . ${rule.kind}`;
    weekCard.appendChild(el(`<div class="banner ${rule.kind}" style="margin-top:10px;margin-bottom:0;"><div class="b-tag">${tag}</div><div class="b-body">${esc(rule.body)}</div></div>`));
  }
  app.appendChild(weekCard);

  // 2. how to run
  if (r.howToRun) {
    app.appendChild(el(`<div class="section-title">How to run it</div>`));
    for (const c of r.howToRun) app.appendChild(el(`<div class="plan-card"><div class="t">${esc(c.title)}</div><div class="b">${esc(c.body)}</div></div>`));
  }

  // 3. priorities
  if (r.priorities) {
    app.appendChild(el(`<div class="section-title">Priorities</div>`));
    for (const [tier, label] of [["priority", "Priority"], ["secondary", "Secondary"], ["maintenance", "Maintenance"]]) {
      const rows = (r.priorities[tier] || []).map((row) => `<tr><td>${esc(row[0])}</td><td>${esc(row[1])} sets</td><td>${esc(row[2])}</td></tr>`).join("");
      if (rows) app.appendChild(el(`<div><div class="tier-label">${label}</div><table class="ptable tier-${tier}"><tbody>${rows}</tbody></table></div>`));
    }
  }

  // 4. pressure valves
  if (r.pressureValves) {
    app.appendChild(el(`<div class="section-title">Pressure valves</div>`));
    app.appendChild(el(`<ol class="valve-list">${r.pressureValves.map((v) => `<li>${esc(v)}</li>`).join("")}</ol>`));
  }

  // 5. schedule
  if (r.schedule) {
    app.appendChild(el(`<div class="section-title">Schedule</div>`));
    const wrap = el(`<div></div>`);
    for (const ev of r.schedule) {
      const isCurrent = week != null && ev.weeks.includes(week);
      wrap.appendChild(el(`<div class="sched-item ${isCurrent ? "current" : ""}"><div class="wks">wk ${ev.weeks.join(", ")}</div><div><strong style="font-family:var(--display);font-size:14px;">${esc(ev.title)}</strong>${isCurrent ? `<span class="sched-now">now</span>` : ""}<div class="b" style="color:var(--steel);font-size:12px;margin-top:2px;">${esc(ev.body)}</div></div></div>`));
    }
    app.appendChild(wrap);
  }

  // 6. measurements
  if (r.measurements) {
    app.appendChild(el(`<div class="section-title">Measurements</div>`));
    const m = r.measurements;
    app.appendChild(el(`<div class="plan-card"><div class="b"><span class="mono">Bodyweight:</span> ${esc(m.bodyweight)}<br><span class="mono">Waist:</span> ${esc(m.waist)}<br><span class="mono">Arm, chest, shoulder:</span> ${esc(m.arm_chest_shoulder)}<br><span class="mono">Target:</span> ${esc(m.target)}</div></div>`));
  }

  // block reset
  app.appendChild(el(`<div class="section-title">Block</div>`));
  const reset = el(`<div class="btn-row"><button class="btn" id="reset">Start new block</button></div>`);
  reset.querySelector("#reset").onclick = openBlockReset;
  app.appendChild(reset);
}

// ---------- modals ----------

function openModal(node) {
  const back = el(`<div class="modal-back"></div>`);
  back.appendChild(node);
  back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
  document.body.appendChild(back);
  return back;
}
function openSkipModal(exerciseId) {
  const m = el(`<div class="modal"><h2>Skip. Why?</h2><div class="choices">${SKIP_REASONS.map((r) => `<button data-r="${r}">${r}</button>`).join("")}<button data-r="">No reason</button></div></div>`);
  const back = openModal(m);
  m.querySelectorAll("button").forEach((b) => { b.onclick = () => { back.remove(); toggleSkip(exerciseId, b.dataset.r || undefined); }; });
}
function openDayPicker() {
  const m = el(`<div class="modal"><h2>Log a different day</h2><div class="choices">${plan.days.map((d) => `<button data-id="${d.dayId}">${esc(d.weekday)} &middot; ${esc(d.title)} (${esc(d.subtitle)})</button>`).join("")}</div></div>`);
  const back = openModal(m);
  m.querySelectorAll("button").forEach((b) => { b.onclick = () => { back.remove(); activeDay = planDayById(Number(b.dataset.id)); drafts.clear(); state.view = "today"; render(); }; });
}
function openBlockReset() {
  const m = el(`<div class="modal"><h2>Start new block</h2><p class="ex-last mono">This resets the week counter to 1. No log data is touched.</p><div class="btn-row"><button class="btn" id="go">Start new block</button><button class="btn" id="no">Cancel</button></div></div>`);
  const back = openModal(m);
  m.querySelector("#no").onclick = () => back.remove();
  m.querySelector("#go").onclick = async () => { back.remove(); await Store.startNewBlock(todayISO()); render(); toast("New block started."); };
}
function openStepperModal(title, initial, step, unit, onSave) {
  let val = initial;
  const m = el(`<div class="modal"><h2>${esc(title)}</h2><div class="stepper-big"><button data-dir="-1">&minus;</button><div class="val mono">${fmtWeight(val)}<span style="font-size:14px;color:var(--steel)"> ${unit}</span></div><button data-dir="1">+</button></div><div class="btn-row"><button class="btn" id="save">Save</button><button class="btn" id="cancel">Cancel</button></div></div>`);
  const back = openModal(m);
  const valEl = m.querySelector(".val");
  m.querySelectorAll("[data-dir]").forEach((b) => { b.onclick = () => { val = Math.max(0, +(val + Number(b.dataset.dir) * step).toFixed(2)); valEl.innerHTML = `${fmtWeight(val)}<span style="font-size:14px;color:var(--steel)"> ${unit}</span>`; }; });
  m.querySelector("#cancel").onclick = () => back.remove();
  m.querySelector("#save").onclick = async () => { back.remove(); await onSave(val); };
}
function openBodyweightModal() {
  const bw = Store.exportJson().bodyweight || [];
  openStepperModal("Bodyweight", bw.length ? bw[bw.length - 1].kg : 70, 0.1, "kg", async (kg) => { await Store.addBodyweight(todayISO(), kg); render(); });
}
function openMeasureModal() {
  const meas = Store.exportJson().measurements || [];
  const last = meas[meas.length - 1] || {};
  const fields = [["waistCm", "Waist", 76], ["armCm", "Arm", 35], ["chestCm", "Chest", 98], ["shoulderCm", "Shoulder", 115]];
  const result = {}; let i = 0;
  const next = () => {
    if (i >= fields.length) { Store.addMeasurement(Object.assign({ date: todayISO() }, result)).then(render); return; }
    const [key, label, def] = fields[i];
    openStepperModal(label + " (cm)", last[key] != null ? last[key] : def, 0.5, "cm", async (v) => { result[key] = v; i++; next(); });
  };
  next();
}

// ---------- backup nag ----------

function updateNag() {
  const nag = document.getElementById("nag");
  const last = Store.getLastExportAt();
  const hasData = Store.getSessions().length > 0;
  const age = last ? Date.now() - last : Infinity;
  if (!hasData || age <= WEEK_MS) { nag.hidden = true; nag.innerHTML = ""; return; }
  const days = last ? Math.floor(age / (24 * 60 * 60 * 1000)) : null;
  const msg = last ? `Last backup: ${days} days ago. Export now.` : "No backup yet. Export now.";
  nag.hidden = false;
  nag.innerHTML = `${esc(msg)} <button type="button">Export</button>`;
  nag.querySelector("button").onclick = doExport;
}

// ---------- export / import ----------

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function doExport() {
  const date = todayISO();
  const nameIndex = {};
  for (const id of Object.keys(exIndex)) nameIndex[id] = exIndex[id].name;
  download(`anchor-backup-${date}.json`, JSON.stringify(Store.exportJson(), null, 2), "application/json");
  download(`anchor-history-${date}.csv`, Store.exportCsv(nameIndex), "text/csv");
  await Store.markExported();
  updateNag();
  toast("Exported backup and CSV.");
}
function openImport() { document.getElementById("importFile").click(); }
async function handleImportFile(file) {
  try {
    const data = JSON.parse(await file.text());
    const summary = Store.importJson(data, false);
    const m = el(`<div class="modal"><h2>Import backup</h2><p class="ex-last mono">This will add ${summary.added} sessions and update ${summary.updated}. Continue?</p><div class="btn-row"><button class="btn" id="go">Continue</button><button class="btn" id="no">Cancel</button></div></div>`);
    const back = openModal(m);
    m.querySelector("#no").onclick = () => back.remove();
    m.querySelector("#go").onclick = async () => { back.remove(); await Store.importJson(data, true); drafts.clear(); activeSession = null; updateNag(); render(); toast("Import complete."); };
  } catch (err) { toast("Could not read that file."); }
}

// ---------- rest timer ----------

const restBar = document.getElementById("rest");
const restFillEl = document.getElementById("restFill");
const restTimeEl = document.getElementById("restTime");
const restLabelEl = document.getElementById("restLabel");

function startRest(seconds) {
  clearTimeout(rest.hideTimer); cancelAnimationFrame(rest.raf);
  rest.duration = seconds; rest.endsAt = Date.now() + seconds * 1000; rest.running = true;
  restBar.hidden = false; restBar.classList.remove("done"); restLabelEl.textContent = "Rest";
  tickRest();
}
function tickRest() {
  const remainMs = rest.endsAt - Date.now();
  const frac = Math.max(0, Math.min(1, remainMs / (rest.duration * 1000)));
  restFillEl.style.transform = `scaleX(${frac})`;
  restTimeEl.textContent = fmtTime(Math.ceil(remainMs / 1000));
  if (remainMs <= 0) return finishRest();
  rest.raf = requestAnimationFrame(tickRest);
}
function finishRest() {
  rest.running = false;
  restFillEl.style.transform = "scaleX(0)";
  restTimeEl.textContent = "0:00";
  restBar.classList.add("done"); restLabelEl.textContent = "Rest done";
  const settings = Store.getSettings();
  if (settings.vibrate !== false && navigator.vibrate) navigator.vibrate(200);
  if (settings.sound) beep();
  rest.hideTimer = setTimeout(() => { restBar.hidden = true; }, 5000);
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.value = 660; gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.18);
    osc.onended = () => ctx.close();
  } catch (e) {}
}
function skipRest() { cancelAnimationFrame(rest.raf); rest.running = false; restBar.hidden = true; }

let pressTimer = 0, pressHandled = false;
restBar.addEventListener("pointerdown", () => {
  pressHandled = false;
  pressTimer = setTimeout(() => {
    pressHandled = true; rest.endsAt += 30000; rest.duration += 30;
    if (!rest.running) { rest.running = true; restBar.classList.remove("done"); restLabelEl.textContent = "Rest"; tickRest(); }
  }, 500);
});
restBar.addEventListener("pointerup", () => { clearTimeout(pressTimer); if (!pressHandled) skipRest(); });
restBar.addEventListener("pointerleave", () => clearTimeout(pressTimer));

// ---------- toast ----------

let toastTimer = 0;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------- week summary strip (rest day) ----------

function weekSummaryStrip() {
  let logged = 0;
  const t = dateFromIso(todayISO());
  const monday = addDays(t, -((t.getDay() + 6) % 7));
  for (let d = 1; d < 7; d++) {
    const cur = addDays(monday, d);
    if (planDayForWeekday(weekdayCode(cur)) && isLogged(sessionOnDate(todayISO(cur)))) logged++;
  }
  return el(`<p class="ex-last mono" style="text-align:center;">This week: ${logged} of 6 logged</p>`);
}

// ---------- static wiring ----------

function wireStaticUi() {
  document.getElementById("export").onclick = doExport;
  document.getElementById("brand").onclick = () => { state.view = "today"; render(); };
  document.querySelectorAll(".botnav button").forEach((b) => { b.onclick = () => { state.view = b.dataset.view; render(); }; });
  const importFile = document.getElementById("importFile");
  importFile.onchange = () => { if (importFile.files[0]) handleImportFile(importFile.files[0]); importFile.value = ""; };
  let brandTimer = 0;
  const brand = document.getElementById("brand");
  brand.addEventListener("pointerdown", () => { brandTimer = setTimeout(openImport, 600); });
  brand.addEventListener("pointerup", () => clearTimeout(brandTimer));
  brand.addEventListener("pointerleave", () => clearTimeout(brandTimer));
}

boot();
