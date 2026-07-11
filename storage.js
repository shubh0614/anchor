// storage.js
// ANCHOR data durability layer. Law number one: do not lose data.
//
// Every write goes to BOTH localStorage AND IndexedDB. On load, both stores
// are read, and the fresher one heals the stale one. Clearing either store
// and reloading restores everything from the other.
//
// The whole database is a single JSON blob. localStorage and IndexedDB each
// hold one copy under the same key. This keeps the two stores trivially
// comparable and keeps every write atomic from the app's point of view.

const LS_KEY = "anchor_db_v1";
const IDB_NAME = "anchor";
const IDB_STORE = "kv";
const IDB_KEY = "db";

// The shape of an empty database. updatedAt is the healing clock: the store
// with the larger updatedAt wins on load.
function emptyDb() {
  return {
    schema: 1,
    sessions: {},        // keyed by sessionId
    bodyweight: [],      // [{ date, kg }]
    measurements: [],    // [{ date, waistCm, armCm, chestCm, shoulderCm }]
    settings: { sound: false, vibrate: true, units: "kg" },
    lastExportAt: 0,
    updatedAt: 0,
  };
}

// A deep-ish clone that is good enough for our plain-JSON data.
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// --- IndexedDB helpers (promise wrapped) ---------------------------------

let idbPromise = null;

function openIdb() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbPromise;
}

async function idbRead() {
  try {
    const db = await openIdb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn("idbRead failed", err);
    return null;
  }
}

async function idbWrite(dbObj) {
  const db = await openIdb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(dbObj, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function idbClear() {
  const db = await openIdb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- localStorage helpers ------------------------------------------------

function lsRead() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn("lsRead failed", err);
    return null;
  }
}

function lsWrite(dbObj) {
  localStorage.setItem(LS_KEY, JSON.stringify(dbObj));
}

// --- The store -----------------------------------------------------------

// A tiny event target so the UI can react to "Restored from backup" and
// other durability events without importing anything extra.
const listeners = new Set();
function emit(event) {
  for (const fn of listeners) {
    try { fn(event); } catch (e) { console.warn(e); }
  }
}

const Store = {
  db: emptyDb(),
  ready: false,

  onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  // Load on boot: read both stores, heal the stale one from the fresh one.
  async load() {
    const ls = lsRead();
    const idb = await idbRead();

    const lsHas = ls && hasData(ls);
    const idbHas = idb && hasData(idb);

    let chosen;
    let healed = null;      // which store we wrote back to
    let restored = false;   // true when one store was empty and rebuilt

    if (!lsHas && !idbHas) {
      // Fresh install, or both wiped with nothing to recover.
      chosen = (ls || idb) ? mergeDefaults(ls || idb) : emptyDb();
    } else if (lsHas && !idbHas) {
      chosen = mergeDefaults(ls);
      await idbWrite(clone(chosen));
      healed = "indexeddb";
      restored = true;
    } else if (!lsHas && idbHas) {
      chosen = mergeDefaults(idb);
      lsWrite(chosen);
      healed = "localstorage";
      restored = true;
    } else {
      // Both have data. Newer updatedAt wins, then heal the other.
      const lsNewer = (ls.updatedAt || 0) >= (idb.updatedAt || 0);
      chosen = mergeDefaults(lsNewer ? ls : idb);
      if ((ls.updatedAt || 0) !== (idb.updatedAt || 0)) {
        if (lsNewer) {
          await idbWrite(clone(chosen));
          healed = "indexeddb";
        } else {
          lsWrite(chosen);
          healed = "localstorage";
        }
      }
    }

    this.db = chosen;
    this.ready = true;

    if (restored) {
      emit({ type: "restored", from: healed === "indexeddb" ? "localstorage" : "indexeddb" });
    } else if (healed) {
      emit({ type: "healed", store: healed });
    }
    return this.db;
  },

  // The one write path. Mutates via a callback, stamps updatedAt, then writes
  // both stores. localStorage lands synchronously; IndexedDB is kicked off in
  // the same tick and awaited by callers that care.
  async commit(mutator) {
    mutator(this.db);
    this.db.updatedAt = Date.now();
    // localStorage first and synchronous: this is the write that survives a
    // browser kill in the very next millisecond.
    lsWrite(this.db);
    // IndexedDB in the same tick. Awaiting is optional for correctness of the
    // durability guarantee, but callers may await to know it landed.
    await idbWrite(clone(this.db));
    emit({ type: "changed" });
    return this.db;
  },

  // Synchronous read accessors -------------------------------------------

  getSessions() {
    return Object.values(this.db.sessions).sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0
    );
  },

  getSession(sessionId) {
    return this.db.sessions[sessionId] || null;
  },

  // All logged sets for one exercise id across all sessions, oldest first.
  // Returns [{ sessionId, date, dayId, sets: [...] }].
  getExerciseHistory(exerciseId) {
    const out = [];
    for (const s of this.getSessions()) {
      const entry = (s.entries || []).find((e) => e.exerciseId === exerciseId);
      if (entry && !entry.skipped && entry.sets && entry.sets.length) {
        out.push({ sessionId: s.sessionId, date: s.date, dayId: s.dayId, sets: entry.sets });
      }
    }
    return out;
  },

  getSettings() {
    return this.db.settings;
  },

  getLastExportAt() {
    return this.db.lastExportAt || 0;
  },

  // Write helpers --------------------------------------------------------

  async saveSession(session) {
    return this.commit((db) => {
      db.sessions[session.sessionId] = session;
    });
  },

  async updateSettings(patch) {
    return this.commit((db) => {
      db.settings = Object.assign({}, db.settings, patch);
    });
  },

  async addBodyweight(date, kg) {
    return this.commit((db) => {
      db.bodyweight = db.bodyweight.filter((b) => b.date !== date);
      db.bodyweight.push({ date, kg });
      db.bodyweight.sort((a, b) => (a.date < b.date ? -1 : 1));
    });
  },

  async addMeasurement(m) {
    return this.commit((db) => {
      db.measurements = db.measurements.filter((x) => x.date !== m.date);
      db.measurements.push(m);
      db.measurements.sort((a, b) => (a.date < b.date ? -1 : 1));
    });
  },

  async markExported() {
    return this.commit((db) => {
      db.lastExportAt = Date.now();
    });
  },

  // Export ---------------------------------------------------------------

  exportJson() {
    // A complete, re-importable dump.
    return clone(this.db);
  },

  exportCsv(planIndex) {
    // Flat rows: date, dayId, exerciseId, exerciseName, setNumber, weight, reps, e1rm
    // planIndex is an optional { exerciseId: name } map for readable names.
    const rows = [["date", "dayId", "exerciseId", "exerciseName", "setNumber", "weight", "reps", "e1rm"]];
    for (const s of this.getSessions()) {
      for (const entry of s.entries || []) {
        if (entry.skipped) continue;
        const name = (planIndex && planIndex[entry.exerciseId]) || entry.exerciseId;
        entry.sets.forEach((set, i) => {
          const e1rm = e1rmOf(set.weight, set.reps);
          rows.push([
            s.date,
            s.dayId,
            entry.exerciseId,
            csvCell(name),
            i + 1,
            set.weight,
            set.reps,
            e1rm.toFixed(1),
          ]);
        });
      }
    }
    return rows.map((r) => r.join(",")).join("\n");
  },

  // Import: merge by sessionId. Returns a summary without committing, unless
  // apply is true.
  importJson(incoming, apply) {
    if (!incoming || typeof incoming !== "object") {
      throw new Error("Not a valid backup file");
    }
    const inSessions = incoming.sessions || {};
    let added = 0;
    let updated = 0;
    for (const id of Object.keys(inSessions)) {
      if (this.db.sessions[id]) updated++;
      else added++;
    }
    const summary = {
      added,
      updated,
      bodyweight: (incoming.bodyweight || []).length,
      measurements: (incoming.measurements || []).length,
    };
    if (!apply) return summary;

    return this.commit((db) => {
      // Sessions: incoming wins on conflict (it is an explicit restore).
      for (const id of Object.keys(inSessions)) {
        db.sessions[id] = inSessions[id];
      }
      // Bodyweight and measurements: merge by date.
      mergeByDate(db.bodyweight, incoming.bodyweight || []);
      mergeByDate(db.measurements, incoming.measurements || []);
      db.bodyweight.sort((a, b) => (a.date < b.date ? -1 : 1));
      db.measurements.sort((a, b) => (a.date < b.date ? -1 : 1));
      if (incoming.settings) db.settings = Object.assign({}, db.settings, incoming.settings);
      if (incoming.lastExportAt) db.lastExportAt = Math.max(db.lastExportAt || 0, incoming.lastExportAt);
    }).then(() => summary);
  },

  // Test / recovery hooks. Used by the storage harness to prove healing.
  async _clearLocalStorage() {
    localStorage.removeItem(LS_KEY);
  },
  async _clearIndexedDb() {
    await idbClear();
  },
  _peekLocalStorage() {
    return lsRead();
  },
  async _peekIndexedDb() {
    return await idbRead();
  },
};

// --- pure helpers --------------------------------------------------------

function hasData(db) {
  if (!db) return false;
  const hasSessions = db.sessions && Object.keys(db.sessions).length > 0;
  const hasBody = db.bodyweight && db.bodyweight.length > 0;
  const hasMeas = db.measurements && db.measurements.length > 0;
  return Boolean(hasSessions || hasBody || hasMeas);
}

// Fill in any missing top-level fields so older or partial blobs load clean.
function mergeDefaults(db) {
  const base = emptyDb();
  const out = Object.assign(base, db);
  out.settings = Object.assign(base.settings, db.settings || {});
  return out;
}

function mergeByDate(target, incoming) {
  const seen = new Set(target.map((x) => x.date));
  for (const item of incoming) {
    if (!seen.has(item.date)) {
      target.push(item);
      seen.add(item.date);
    }
  }
}

function e1rmOf(weight, reps) {
  return weight * (1 + reps / 30);
}

function csvCell(value) {
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export { Store, emptyDb, e1rmOf };
