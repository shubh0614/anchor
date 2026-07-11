// app.js
// All ANCHOR logic. The app knows nothing about exercises: everything comes
// from plan.json. History is keyed by exercise id so a plan swap keeps it.

import { Store, e1rmOf } from "./storage.js";

// ---------- constants ----------

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const TRAINING_ORDER = ["TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const SKIP_REASONS = ["machine busy", "short on time", "not feeling it", "injury"];
const FIRST_TIME_WEIGHT = 20; // sensible starting load before any history exists
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// ---------- module state ----------

let plan = null;
let exIndex = {};        // id -> exercise definition (first occurrence in plan)
let activeSession = null; // the session being logged in memory (mirrors storage)
let activeDay = null;     // the plan day object being shown
const drafts = new Map(); // "exId::setIndex" -> { weight, reps } for uncommitted pills

const state = {
  view: "today",         // today | history | body | week | summary
  historyExerciseId: null,
  chartMode: "e1rm",     // e1rm | volume
};

const rest = { raf: 0, endsAt: 0, duration: 0, running: false, hideTimer: 0 };

// ---------- boot ----------

async function boot() {
  wireStaticUi();
  Store.onEvent((e) => {
    if (e.type === "restored") toast("Restored from backup.");
  });

  const [planRes] = await Promise.all([
    fetch("plan.json", { cache: "no-store" }).then((r) => r.json()),
    Store.load(),
  ]);
  plan = planRes;
  buildExerciseIndex();

  activeDay = defaultDayForToday();
  render();
  updateNag();
  maybeBodyweightPrompt();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

function buildExerciseIndex() {
  exIndex = {};
  for (const day of plan.days) {
    for (const block of day.blocks) {
      for (const ex of block.exercises) {
        if (!exIndex[ex.id]) exIndex[ex.id] = ex;
      }
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
function weekdayCode(d = new Date()) { return DOW[d.getDay()]; }

function planDayForWeekday(code) {
  return plan.days.find((d) => d.weekday === code) || null;
}
function planDayById(id) {
  return plan.days.find((d) => d.dayId === id) || null;
}
function defaultDayForToday() {
  return planDayForWeekday(weekdayCode()); // null on the rest day
}

function fmtDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${String(d).padStart(2, "0")} ${months[m - 1]}`;
}
function fmtTime(totalSec) {
  const s = Math.max(0, totalSec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
function fmtWeight(w) {
  return Number.isInteger(w) ? String(w) : String(Number(w.toFixed(2)));
}

// ---------- history + progression ----------

// Most recent prior session with data for this exercise, excluding the active
// session. This is what we prefill from and what progression reads.
function lastSessionFor(exerciseId) {
  const hist = Store.getExerciseHistory(exerciseId).filter(
    (h) => !activeSession || h.sessionId !== activeSession.sessionId
  );
  return hist.length ? hist[hist.length - 1] : null;
}

function topWeight(sets) {
  return sets.reduce((m, s) => Math.max(m, s.weight), 0);
}

// The app decides when to add weight: every logged set of the last session
// reached repMax.
function shouldProgress(ex, last) {
  if (!last || !last.sets.length) return false;
  return last.sets.every((s) => s.reps >= ex.repMax);
}

// The entry for an exercise in the active session (committed sets so far).
function entryFor(exerciseId) {
  if (!activeSession) return null;
  return activeSession.entries.find((e) => e.exerciseId === exerciseId) || null;
}

// Working values for an uncommitted pill. Follows committed sets within the
// session, then progression, then last session, then first-time defaults.
function draftFor(ex, setIndex, last, progress) {
  const key = ex.id + "::" + setIndex;
  if (drafts.has(key)) return drafts.get(key);

  const entry = entryFor(ex.id);
  const committed = entry ? entry.sets : [];
  let weight, reps;

  if (committed.length > 0) {
    weight = committed[committed.length - 1].weight;
    reps = progress ? ex.repMin : (last && last.sets[setIndex] ? last.sets[setIndex].reps : committed[committed.length - 1].reps);
  } else if (progress && last) {
    weight = topWeight(last.sets) + ex.increment;
    reps = ex.repMin;
  } else if (last) {
    const ls = last.sets[setIndex] || last.sets[last.sets.length - 1];
    weight = ls.weight;
    reps = ls.reps;
  } else {
    weight = ex.increment > 0 ? FIRST_TIME_WEIGHT : 0;
    reps = ex.repMin;
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
  if (existing) {
    activeSession = existing;
  } else {
    activeSession = {
      sessionId: id,
      date: dateIso,
      dayId,
      planVersion: plan.planVersion,
      startedAt: Date.now(),
      endedAt: null,
      entries: [],
    };
  }
  return activeSession;
}

function ensureEntry(exerciseId) {
  let entry = activeSession.entries.find((e) => e.exerciseId === exerciseId);
  if (!entry) {
    entry = { exerciseId, skipped: false, sets: [] };
    activeSession.entries.push(entry);
  }
  return entry;
}

async function commitSet(ex, setIndex) {
  const key = ex.id + "::" + setIndex;
  const d = drafts.get(key) || draftFor(ex, setIndex, lastSessionFor(ex.id), false);
  ensureSession(activeDay.dayId);
  const entry = ensureEntry(ex.id);
  entry.skipped = false;
  // Set the value at its index (supports re-logging if needed).
  entry.sets[setIndex] = { weight: d.weight, reps: d.reps, loggedAt: Date.now() };
  activeSession.endedAt = Date.now();
  drafts.delete(key);

  // Durability: write to both stores before the sweep finishes.
  await Store.saveSession(activeSession);

  // Start rest using this block's restSeconds.
  const block = blockForExercise(ex.id);
  startRest(block ? block.restSeconds : 90);

  render();
}

function blockForExercise(exerciseId) {
  for (const block of activeDay.blocks) {
    if (block.exercises.some((e) => e.id === exerciseId)) return block;
  }
  return null;
}

async function toggleSkip(exerciseId, reason) {
  ensureSession(activeDay.dayId);
  const entry = ensureEntry(exerciseId);
  if (entry.skipped) {
    entry.skipped = false;
    delete entry.skipReason;
  } else {
    entry.skipped = true;
    if (reason) entry.skipReason = reason;
    entry.sets = [];
  }
  await Store.saveSession(activeSession);
  render();
}

async function endSession() {
  if (activeSession) {
    activeSession.endedAt = Date.now();
    await Store.saveSession(activeSession);
  }
  state.view = "summary";
  render();
}

// ---------- rendering ----------

const app = document.getElementById("app");

function render() {
  syncNav();
  if (state.view === "history") return renderHistory(state.historyExerciseId);
  if (state.view === "body") return renderBody();
  if (state.view === "week") return renderWeek();
  if (state.view === "summary") return renderSummary();
  return renderToday();
}

function syncNav() {
  document.querySelectorAll(".nav-btn").forEach((b) => {
    const on = (b.dataset.view === state.view) ||
      (state.view === "history" && b.dataset.view === "today");
    b.setAttribute("aria-current", on ? "true" : "false");
  });
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function renderToday() {
  app.innerHTML = "";

  // Rest day: no plan day matches today's weekday, and no override in effect.
  if (!activeDay) {
    app.appendChild(el(`
      <section class="rest-day">
        <div class="big">Rest day. Eat.</div>
        <div class="sub">Monday. Nothing to log.</div>
      </section>
    `));
    app.appendChild(weekSummaryStrip());
    app.appendChild(overrideControl());
    return;
  }

  ensureSession(activeDay.dayId);

  const head = el(`
    <div class="day-head">
      <h1 class="day-title">${esc(activeDay.title)}</h1>
      <p class="day-sub">${esc(activeDay.subtitle)} &middot; ${esc(activeDay.weekday)}</p>
      <div class="day-meta">${plan.planName} &middot; ${plan.planVersion}</div>
    </div>
  `);
  app.appendChild(head);

  const firstEver = Store.getSessions().length === 0 &&
    activeSession.entries.every((e) => e.sets.length === 0);
  if (firstEver) {
    app.appendChild(el(`
      <p class="ex-last" style="margin: -8px 4px 16px;">No history yet. Enter your working weights and the app takes over from here.</p>
    `));
  }

  for (const block of activeDay.blocks) {
    app.appendChild(renderBlock(block));
  }

  app.appendChild(overrideControl());

  const end = el(`<div class="btn-row"><button class="btn" id="endBtn">End session</button></div>`);
  end.querySelector("#endBtn").onclick = endSession;
  app.appendChild(end);
}

function renderBlock(block) {
  const grouped = block.type === "superset" || block.type === "triset";
  const card = el(`
    <section class="block ${block.type === "anchor" ? "anchor" : ""} ${grouped ? "grouped" : ""}">
      <div class="block-tag">${esc(block.type)} &middot; rest ${block.restSeconds}s</div>
      <div class="exercises"></div>
    </section>
  `);
  const host = card.querySelector(".exercises");
  for (const ex of block.exercises) host.appendChild(renderExercise(ex, block));
  return card;
}

function renderExercise(ex, block) {
  const entry = entryFor(ex.id);
  const last = lastSessionFor(ex.id);
  const progress = shouldProgress(ex, last);
  const skipped = entry && entry.skipped;

  const wrap = el(`<div class="exercise ${progress ? "progress" : ""} ${skipped ? "skipped" : ""}"></div>`);

  const lastLine = last
    ? `Last: ${fmtWeight(topWeight(last.sets))} kg x ${last.sets.map((s) => s.reps).join(", ")}`
    : "Last: none yet";

  const head = el(`
    <div>
      <div class="ex-head">
        <button class="ex-name" type="button">${esc(ex.name)}</button>
        <span class="ex-target mono">${ex.sets} x ${ex.repMin}-${ex.repMax}</span>
        ${progress ? `<span class="badge-add">ADD WEIGHT</span>` : ""}
        <button class="ex-skip" type="button">${skipped ? "Skipped" : "Skip"}</button>
      </div>
      ${ex.note ? `<p class="ex-note">${esc(ex.note)}</p>` : ""}
      <p class="ex-last mono">${esc(lastLine)}</p>
    </div>
  `);
  head.querySelector(".ex-name").onclick = () => openHistory(ex.id);
  head.querySelector(".ex-skip").onclick = () => {
    if (skipped) return toggleSkip(ex.id);
    openSkipModal(ex.id);
  };
  wrap.appendChild(head);

  if (!skipped) {
    const pills = el(`<div class="pills"></div>`);
    for (let i = 0; i < ex.sets; i++) {
      pills.appendChild(renderPill(ex, i, last, progress));
    }
    wrap.appendChild(pills);
  }
  return wrap;
}

function renderPill(ex, setIndex, last, progress) {
  const entry = entryFor(ex.id);
  const committedSet = entry && entry.sets[setIndex];
  const repsOnly = ex.increment === 0;

  if (committedSet) {
    // Locked, filled pill. Amber tick if this set hit repMax (earned).
    const up = committedSet.reps >= ex.repMax;
    const pill = el(`
      <div class="pill committed ${up ? "up" : ""} ${repsOnly ? "reps-only" : ""}">
        <span class="pill-set-no">${setIndex + 1}</span>
        <span class="sweep"></span>
        ${repsOnly ? "" : `<div class="field"><span class="val mono">${fmtWeight(committedSet.weight)}</span><span class="unit">kg</span><span class="lbl">weight</span></div>`}
        <div class="field"><span class="val mono">${committedSet.reps}</span><span class="lbl">reps</span></div>
        <div class="commit">${up ? "&#9650;" : "&#10003;"}</div>
      </div>
    `);
    return pill;
  }

  const d = draftFor(ex, setIndex, last, progress);
  const pill = el(`
    <div class="pill ${repsOnly ? "reps-only" : ""}">
      <span class="pill-set-no">${setIndex + 1}</span>
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
      <button class="commit" aria-label="commit set ${setIndex + 1}">&#10003;</button>
    </div>
  `);

  const wVal = pill.querySelector(".w-val");
  const rVal = pill.querySelector(".r-val");
  pill.querySelectorAll('.stepper[data-axis="weight"] .step-btn').forEach((btn) => {
    btn.onclick = () => {
      d.weight = Math.max(0, +(d.weight + Number(btn.dataset.dir) * ex.increment).toFixed(2));
      wVal.textContent = fmtWeight(d.weight);
    };
  });
  pill.querySelectorAll('.stepper[data-axis="reps"] .step-btn').forEach((btn) => {
    btn.onclick = () => {
      d.reps = Math.max(0, d.reps + Number(btn.dataset.dir));
      rVal.textContent = d.reps;
    };
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

  let setsLogged = 0, setsSkipped = 0;
  const up = [], stalled = [];
  for (const entry of s.entries) {
    if (entry.skipped) { setsSkipped++; continue; }
    setsLogged += entry.sets.length;
    if (!entry.sets.length) continue;
    const ex = exIndex[entry.exerciseId];
    const allMax = entry.sets.every((set) => set.reps >= ex.repMax);
    if (allMax) up.push(ex.name);
    else stalled.push(ex.name);
  }
  const mins = s.endedAt && s.startedAt ? Math.round((s.endedAt - s.startedAt) / 60000) : 0;

  const section = el(`
    <section class="summary">
      <div class="day-head">
        <h1 class="day-title">Session done</h1>
        <p class="day-sub">${esc(activeDay.title)} &middot; ${fmtDate(s.date)}</p>
      </div>
      <div class="stat-row">
        <div class="stat"><div class="n mono">${mins}</div><div class="k">minutes</div></div>
        <div class="stat"><div class="n mono">${setsLogged}</div><div class="k">sets logged</div></div>
        <div class="stat"><div class="n mono">${setsSkipped}</div><div class="k">skipped</div></div>
      </div>
      ${up.length ? `<div class="section-title">What went up</div><ul class="up-list">${up.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      ${stalled.length ? `<div class="section-title">What stalled</div><ul class="stall-list">${stalled.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      <div class="btn-row">
        <button class="btn" id="toWeek">Week view</button>
        <button class="btn" id="backToday">Back to session</button>
      </div>
    </section>
  `);
  section.querySelector("#toWeek").onclick = () => { state.view = "week"; render(); };
  section.querySelector("#backToday").onclick = () => { state.view = "today"; render(); };
  app.appendChild(section);
}

// ---------- history + charts ----------

function openHistory(exerciseId) {
  state.view = "history";
  state.historyExerciseId = exerciseId;
  render();
}

function renderHistory(exerciseId) {
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
  head.querySelector("#back").onclick = () => { state.view = "today"; render(); };
  app.appendChild(head);

  if (!hist.length) {
    app.appendChild(el(`<section class="empty"><div class="sub">No history yet.</div></section>`));
    return;
  }

  // Series: best e1RM per session, and volume load per session.
  let bestSoFar = 0;
  const series = hist.map((h) => {
    const bestE1rm = h.sets.reduce((m, s) => Math.max(m, e1rmOf(s.weight, s.reps)), 0);
    const volume = h.sets.reduce((v, s) => v + s.weight * s.reps, 0);
    const pb = bestE1rm > bestSoFar + 1e-9;
    if (pb) bestSoFar = bestE1rm;
    return { date: h.date, e1rm: bestE1rm, volume, pb, sets: h.sets };
  });

  const toggle = el(`
    <div class="toggle-row">
      <button class="toggle" data-mode="e1rm" aria-pressed="${state.chartMode === "e1rm"}">e1RM</button>
      <button class="toggle" data-mode="volume" aria-pressed="${state.chartMode === "volume"}">Volume load</button>
    </div>
  `);
  toggle.querySelectorAll(".toggle").forEach((b) => {
    b.onclick = () => { state.chartMode = b.dataset.mode; render(); };
  });
  app.appendChild(toggle);

  const cols = el(`<div class="history-cols"></div>`);
  const values = series.map((p) => state.chartMode === "e1rm" ? p.e1rm : p.volume);
  const pbs = series.map((p) => state.chartMode === "e1rm" ? p.pb : false);
  const chart = el(`<div class="chart-wrap">${lineChartSvg(values, pbs, series.map((p) => p.date))}</div>`);
  cols.appendChild(chart);

  const rows = series.slice().reverse().map((p) => {
    const reps = p.sets.map((s) => s.reps).join(", ");
    const w = fmtWeight(topWeight(p.sets));
    return `<tr>
      <td>${fmtDate(p.date)}</td>
      <td>${w}</td>
      <td>${reps}</td>
      <td class="${p.pb ? "up" : ""}">${p.e1rm.toFixed(1)}</td>
    </tr>`;
  }).join("");
  const table = el(`
    <table class="htable">
      <thead><tr><th>Date</th><th>Weight</th><th>Reps</th><th>e1RM</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `);
  cols.appendChild(table);
  app.appendChild(cols);
}

// Hand rolled inline SVG line chart. Amber dot marks a personal best.
function lineChartSvg(values, pbs, dates) {
  const W = 320, H = 160, padL = 34, padR = 10, padT = 12, padB = 22;
  const n = values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const lo = min - span * 0.1;
  const hi = max + span * 0.1;
  const x = (i) => padL + (n === 1 ? (W - padL - padR) / 2 : (i * (W - padL - padR)) / (n - 1));
  const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));

  const linePts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const dots = values.map((v, i) =>
    `<circle class="chart-dot ${pbs[i] ? "pb" : ""}" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${pbs[i] ? 4 : 3}" />`
  ).join("");

  // three horizontal gridlines with labels
  const grid = [0, 0.5, 1].map((f) => {
    const val = lo + (hi - lo) * f;
    const yy = y(val);
    return `<line class="chart-grid" x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" />
            <text class="chart-axis" x="4" y="${(yy + 3).toFixed(1)}">${val.toFixed(0)}</text>`;
  }).join("");

  const firstLabel = `<text class="chart-axis" x="${padL}" y="${H - 6}">${fmtDate(dates[0])}</text>`;
  const lastLabel = n > 1
    ? `<text class="chart-axis" x="${W - padR}" y="${H - 6}" text-anchor="end">${fmtDate(dates[n - 1])}</text>`
    : "";

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="chart">
    ${grid}
    <polyline class="chart-line" points="${linePts}" />
    ${dots}
    ${firstLabel}${lastLabel}
  </svg>`;
}

// ---------- week view ----------

function weekDates(today = new Date()) {
  const d = new Date(today);
  const sinceTue = (d.getDay() - 2 + 7) % 7;
  const tue = new Date(d);
  tue.setDate(d.getDate() - sinceTue);
  const out = {};
  TRAINING_ORDER.forEach((c, i) => {
    const dd = new Date(tue);
    dd.setDate(tue.getDate() + i);
    out[c] = todayISO(dd);
  });
  return out;
}

function renderWeek() {
  app.innerHTML = "";
  app.appendChild(el(`<div class="day-head"><h1 class="day-title">This week</h1><p class="day-sub">Tue to Sun</p></div>`));

  const dates = weekDates();
  const grid = el(`<div class="week-grid"></div>`);
  for (const code of TRAINING_ORDER) {
    const day = planDayForWeekday(code);
    const date = dates[code];
    const session = day ? Store.getSession(sessionIdFor(day.dayId, date)) : null;
    const logged = session && session.entries.some((e) => e.sets.length);
    const ups = [];
    if (logged) {
      for (const entry of session.entries) {
        if (entry.skipped || !entry.sets.length) continue;
        const ex = exIndex[entry.exerciseId];
        if (ex && entry.sets.every((s) => s.reps >= ex.repMax)) ups.push(ex.name);
      }
    }
    grid.appendChild(el(`
      <div class="week-cell ${logged ? "logged" : ""} ${ups.length ? "up" : ""}">
        <div class="wd">${code}</div>
        <div class="dot"></div>
        <div class="ttl">${day ? esc(day.title) : ""}</div>
        ${ups.length ? `<div class="up-names">${ups.map((n) => esc(shortName(n))).join("<br>")}</div>` : ""}
      </div>
    `));
  }
  app.appendChild(grid);
}

function weekSummaryStrip() {
  const dates = weekDates();
  let logged = 0;
  for (const code of TRAINING_ORDER) {
    const day = planDayForWeekday(code);
    const session = day ? Store.getSession(sessionIdFor(day.dayId, dates[code])) : null;
    if (session && session.entries.some((e) => e.sets.length)) logged++;
  }
  return el(`<p class="ex-last mono" style="text-align:center;">This week: ${logged} of 6 logged</p>`);
}

function shortName(name) {
  return name.length > 14 ? name.slice(0, 13) + "…" : name;
}

// ---------- body view ----------

function renderBody() {
  app.innerHTML = "";
  app.appendChild(el(`<div class="day-head"><h1 class="day-title">Body</h1><p class="day-sub">Bodyweight and measurements</p></div>`));

  const db = Store.exportJson();
  const bw = db.bodyweight || [];
  const bwCard = el(`<div class="chart-wrap"></div>`);
  if (bw.length) {
    const vals = bw.map((b) => b.kg);
    bwCard.innerHTML = `<div class="ex-last mono">Bodyweight &middot; ${fmtWeight(bw[bw.length - 1].kg)} kg</div>`
      + bodyChartSvg(vals, bw.map((b) => b.date));
  } else {
    bwCard.innerHTML = `<div class="sub" style="color:var(--steel)">No bodyweight logged yet.</div>`;
  }
  app.appendChild(bwCard);

  const addBw = el(`<div class="btn-row"><button class="btn" id="addBw">Log bodyweight</button></div>`);
  addBw.querySelector("#addBw").onclick = openBodyweightModal;
  app.appendChild(addBw);

  // measurement sparklines
  const meas = db.measurements || [];
  const fields = [["waistCm", "Waist"], ["armCm", "Arm"], ["chestCm", "Chest"], ["shoulderCm", "Shoulder"]];
  const sparks = el(`<div class="spark-set"></div>`);
  for (const [key, label] of fields) {
    const pts = meas.filter((m) => m[key] != null).map((m) => m[key]);
    const cur = pts.length ? fmtWeight(pts[pts.length - 1]) : "–";
    sparks.appendChild(el(`
      <div class="spark">
        <div class="lbl">${label}</div>
        <div class="cur mono">${cur}<span class="unit" style="font-size:11px;color:var(--steel)"> cm</span></div>
        ${pts.length > 1 ? sparkSvg(pts) : ""}
      </div>
    `));
  }
  app.appendChild(el(`<div class="section-title">Measurements</div>`));
  app.appendChild(sparks);
  const addM = el(`<div class="btn-row"><button class="btn" id="addM">Log measurements</button></div>`);
  addM.querySelector("#addM").onclick = openMeasureModal;
  app.appendChild(addM);

  // Data and settings. Import lives here as a discoverable path (also on a
  // long press of the brand). Sound is opt in, vibrate defaults on.
  const s = Store.getSettings();
  app.appendChild(el(`<div class="section-title">Data</div>`));
  const data = el(`
    <div>
      <div class="toggle-row">
        <button class="toggle" id="tSound" aria-pressed="${!!s.sound}">Sound at zero</button>
        <button class="toggle" id="tVibrate" aria-pressed="${s.vibrate !== false}">Vibrate at zero</button>
      </div>
      <div class="btn-row">
        <button class="btn" id="exp2">Export backup</button>
        <button class="btn" id="imp2">Import backup</button>
      </div>
    </div>
  `);
  data.querySelector("#tSound").onclick = async (e) => {
    const on = e.currentTarget.getAttribute("aria-pressed") !== "true";
    e.currentTarget.setAttribute("aria-pressed", String(on));
    await Store.updateSettings({ sound: on });
  };
  data.querySelector("#tVibrate").onclick = async (e) => {
    const on = e.currentTarget.getAttribute("aria-pressed") !== "true";
    e.currentTarget.setAttribute("aria-pressed", String(on));
    await Store.updateSettings({ vibrate: on });
  };
  data.querySelector("#exp2").onclick = doExport;
  data.querySelector("#imp2").onclick = openImport;
  app.appendChild(data);
}

function bodyChartSvg(values, dates) {
  const W = 320, H = 120, padL = 30, padR = 10, padT = 10, padB = 20;
  const n = values.length;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const lo = min - span * 0.2, hi = max + span * 0.2;
  const x = (i) => padL + (n === 1 ? (W - padL - padR) / 2 : (i * (W - padL - padR)) / (n - 1));
  const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const dots = values.map((v, i) => `<circle class="chart-dot" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" />`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="bodyweight">
    <polyline class="chart-line" points="${pts}" />${dots}
    <text class="chart-axis" x="4" y="${y(max).toFixed(1)}">${fmtWeight(max)}</text>
    <text class="chart-axis" x="4" y="${y(min).toFixed(1)}">${fmtWeight(min)}</text>
  </svg>`;
}

function sparkSvg(values) {
  const W = 140, H = 32;
  const n = values.length;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const x = (i) => (i * W) / (n - 1);
  const y = (v) => H - 2 - (H - 4) * ((v - min) / span);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${W} ${H}"><polyline class="chart-line" points="${pts}" /></svg>`;
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
  const m = el(`
    <div class="modal">
      <h2>Skip. Why?</h2>
      <div class="choices">
        ${SKIP_REASONS.map((r) => `<button data-r="${r}">${r}</button>`).join("")}
        <button data-r="">No reason</button>
      </div>
    </div>
  `);
  const back = openModal(m);
  m.querySelectorAll("button").forEach((b) => {
    b.onclick = () => { back.remove(); toggleSkip(exerciseId, b.dataset.r || undefined); };
  });
}

function openDayPicker() {
  const m = el(`
    <div class="modal">
      <h2>Log a different day</h2>
      <div class="choices">
        ${plan.days.map((d) => `<button data-id="${d.dayId}">${esc(d.weekday)} &middot; ${esc(d.title)} (${esc(d.subtitle)})</button>`).join("")}
      </div>
    </div>
  `);
  const back = openModal(m);
  m.querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      back.remove();
      activeDay = planDayById(Number(b.dataset.id));
      drafts.clear();
      state.view = "today";
      render();
    };
  });
}

// A generic no-keyboard stepper modal used for body metrics.
function openStepperModal(title, initial, step, unit, onSave) {
  let val = initial;
  const m = el(`
    <div class="modal">
      <h2>${esc(title)}</h2>
      <div class="stepper-big">
        <button data-dir="-1">&minus;</button>
        <div class="val mono">${fmtWeight(val)}<span style="font-size:14px;color:var(--steel)"> ${unit}</span></div>
        <button data-dir="1">+</button>
      </div>
      <div class="btn-row"><button class="btn" id="save">Save</button><button class="btn" id="cancel">Cancel</button></div>
    </div>
  `);
  const back = openModal(m);
  const valEl = m.querySelector(".val");
  m.querySelectorAll("[data-dir]").forEach((b) => {
    b.onclick = () => {
      val = Math.max(0, +(val + Number(b.dataset.dir) * step).toFixed(2));
      valEl.innerHTML = `${fmtWeight(val)}<span style="font-size:14px;color:var(--steel)"> ${unit}</span>`;
    };
  });
  m.querySelector("#cancel").onclick = () => back.remove();
  m.querySelector("#save").onclick = async () => { back.remove(); await onSave(val); };
}

function openBodyweightModal() {
  const bw = Store.exportJson().bodyweight || [];
  const initial = bw.length ? bw[bw.length - 1].kg : 70;
  openStepperModal("Bodyweight", initial, 0.1, "kg", async (kg) => {
    await Store.addBodyweight(todayISO(), kg);
    render();
  });
}

function openMeasureModal() {
  const meas = Store.exportJson().measurements || [];
  const last = meas[meas.length - 1] || {};
  const fields = [["waistCm", "Waist", 76], ["armCm", "Arm", 35], ["chestCm", "Chest", 98], ["shoulderCm", "Shoulder", 115]];
  const result = {};
  let i = 0;
  const next = () => {
    if (i >= fields.length) {
      Store.addMeasurement(Object.assign({ date: todayISO() }, result)).then(render);
      return;
    }
    const [key, label, def] = fields[i];
    const initial = last[key] != null ? last[key] : def;
    openStepperModal(label + " (cm)", initial, 0.5, "cm", async (v) => {
      result[key] = v;
      i++;
      next();
    });
  };
  next();
}

// ---------- backup nag ----------

function updateNag() {
  const nag = document.getElementById("nag");
  const last = Store.getLastExportAt();
  const hasData = Store.getSessions().length > 0;
  const age = last ? Date.now() - last : Infinity;

  if (!hasData || age <= WEEK_MS) {
    nag.hidden = true;
    nag.innerHTML = "";
    return;
  }
  const days = last ? Math.floor(age / (24 * 60 * 60 * 1000)) : null;
  const msg = last ? `Last backup: ${days} days ago. Export now.` : "No backup yet. Export now.";
  nag.hidden = false;
  nag.innerHTML = `${esc(msg)} <button type="button">Export</button>`;
  nag.querySelector("button").onclick = doExport;
}

function maybeBodyweightPrompt() {
  const bw = Store.exportJson().bodyweight || [];
  if (!Store.getSessions().length) return;
  const last = bw.length ? bw[bw.length - 1].date : null;
  const stale = !last || (Date.now() - new Date(last).getTime()) > WEEK_MS;
  // A quiet, dismissible one tap prompt. Not a nag.
  if (stale && state.view === "today") {
    // handled inline could be added; kept minimal to avoid extra taps.
  }
}

// ---------- export / import ----------

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
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

function openImport() {
  document.getElementById("importFile").click();
}

async function handleImportFile(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const summary = Store.importJson(data, false);
    const m = el(`
      <div class="modal">
        <h2>Import backup</h2>
        <p class="ex-last mono">This will add ${summary.added} sessions and update ${summary.updated}. Continue?</p>
        <div class="btn-row">
          <button class="btn" id="go">Continue</button>
          <button class="btn" id="no">Cancel</button>
        </div>
      </div>
    `);
    const back = openModal(m);
    m.querySelector("#no").onclick = () => back.remove();
    m.querySelector("#go").onclick = async () => {
      back.remove();
      await Store.importJson(data, true);
      drafts.clear();
      activeSession = null;
      updateNag();
      render();
      toast("Import complete.");
    };
  } catch (err) {
    toast("Could not read that file.");
  }
}

// ---------- rest timer ----------

const restBar = document.getElementById("rest");
const restFillEl = document.getElementById("restFill");
const restTimeEl = document.getElementById("restTime");
const restLabelEl = document.getElementById("restLabel");

function startRest(seconds) {
  clearTimeout(rest.hideTimer);
  cancelAnimationFrame(rest.raf);
  rest.duration = seconds;
  rest.endsAt = Date.now() + seconds * 1000;
  rest.running = true;
  restBar.hidden = false;
  restBar.classList.remove("done");
  restLabelEl.textContent = "Rest";
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
  restBar.classList.add("done");
  restLabelEl.textContent = "Rest done";
  const settings = Store.getSettings();
  if (settings.vibrate !== false && navigator.vibrate) navigator.vibrate(200);
  if (settings.sound) beep();
  rest.hideTimer = setTimeout(() => { restBar.hidden = true; }, 5000);
}

// A short, quiet tone. Only used when sound is explicitly enabled.
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 660;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
    osc.onended = () => ctx.close();
  } catch (e) { /* ignore */ }
}

function skipRest() {
  cancelAnimationFrame(rest.raf);
  rest.running = false;
  restBar.hidden = true;
}

// tap to skip, long press to add 30s
let pressTimer = 0;
let pressHandled = false;
restBar.addEventListener("pointerdown", () => {
  pressHandled = false;
  pressTimer = setTimeout(() => {
    pressHandled = true;
    rest.endsAt += 30000;
    rest.duration += 30;
    if (!rest.running) { rest.running = true; restBar.classList.remove("done"); restLabelEl.textContent = "Rest"; tickRest(); }
  }, 500);
});
restBar.addEventListener("pointerup", () => {
  clearTimeout(pressTimer);
  if (!pressHandled) skipRest();
});
restBar.addEventListener("pointerleave", () => clearTimeout(pressTimer));

// ---------- toast ----------

let toastTimer = 0;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------- static wiring ----------

function wireStaticUi() {
  document.getElementById("export").onclick = doExport;
  document.getElementById("brand").onclick = () => { state.view = "today"; render(); };
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.onclick = () => { state.view = b.dataset.view; render(); };
  });
  const importFile = document.getElementById("importFile");
  importFile.onchange = () => {
    if (importFile.files[0]) handleImportFile(importFile.files[0]);
    importFile.value = "";
  };
  // Long press the brand opens import (a quiet, secondary path).
  let brandTimer = 0;
  const brand = document.getElementById("brand");
  brand.addEventListener("pointerdown", () => {
    brandTimer = setTimeout(openImport, 600);
  });
  brand.addEventListener("pointerup", () => clearTimeout(brandTimer));
  brand.addEventListener("pointerleave", () => clearTimeout(brandTimer));
}

boot();
