// Local persistence: settings, accounts, solve history, and what still has to reach the cloud.
import { MODS } from "./mods.js";

const KEY = "fifteenpress.v1";

export const DEFAULT_SETTINGS = {
  theme: "lamp",
  numeralFace: "maple",
  backdrop: true, // the night picture behind the Play screen (lamp theme only)
  coloring: "correct",
  arrowMode: "tile", // 'tile': the tile moves the way the arrow points. 'blank': the gap does.
  wasd: true,
  mouseMode: "click", // 'click' | 'hover'
  animMs: 45,
  sound: true,
  volume: 0.5,
  showTimer: true,
  showTPS: true,
  size: 4,
  // mods (runs with any of these on are flagged and kept off the leaderboard)
  modLiveDistance: false,
  modGhostHint: false,
  modUndo: false,
  modHeatmap: false,
  modBigBoards: false,
  modBlind: false,
  modFog: false,
  modVanish: false,
  modDistNums: false,
  modMirror: false,
  modFlip: false,
  modBudget: false,
  modTimeAttack: false,
  modNoWrong: false,
  modMarathon: false,
  soundPack: "wood",
  speedMode: false,
  speedPrev: null,
  homePing: true,
  // motion (see motion.js)
  slideStyle: "slide",
  slideStagger: 0,
  pressFeedback: true,
  landEffect: "none",
  solveEffect: "wave",
  scrambleEffect: "none",
  viewFade: true,
  timerPulse: false,
  motionPref: "system", // 'system' | 'full' | 'reduced'
  // stats
  autoGrade: true,
  liveStat: "tps", // third figure on the ticket: 'tps' | 'mspm' | 'gap'
  squareCorners: true,
  // coach (see coach.js). Coached solves are kept apart from clean stats.
  coachOn: false,
  practiceOn: false, // practice mode: solves are kept but never count toward averages, records or stats
  coachTarget: "method", // 'method' | 'engine'
  coachMethod: "rows", // the order you place tiles in: 'rows' | 'fringe' | 'cols'
  coachLevel: "mistakes", // 'mistakes' | 'guide'
  coachAutoBack: false, // take a move that did not help straight back
  // speedrun mode extras (see speed.js)
  speedAutoNext: 0, // ms after a solve before the next scramble is dealt; 0 waits for Space
  speedSplits: true,
  speedFocus: true,
  speedSound: true,
  // training
  trainTarget: {}, // target average per board size, in ms
};

export const MOD_KEYS = MODS.filter((m) => !m.free).map((m) => m.key);

const newId = () => "p" + Math.random().toString(36).slice(2, 8);

function blank() {
  const id = newId();
  return {
    version: 1,
    v2: true,
    v3: true,
    settings: { ...DEFAULT_SETTINGS },
    profiles: { [id]: { id, name: "Player 1", created: Date.now() } },
    activeProfile: id,
    solves: [],
    counters: {},
    sync: {},
    locked: false,
    seenIntro: false,
    training: {},
    lamp: true,
  };
}

let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    const s = JSON.parse(raw);
    return upgrade(s);
  } catch (e) {
    console.warn("Saved data unreadable, starting fresh", e);
    return blank();
  }
}

function upgrade(s) {
  s.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  if (!s.profiles || !Object.keys(s.profiles).length)
    Object.assign(s, { profiles: blank().profiles, activeProfile: null });
  if (!s.profiles[s.activeProfile]) s.activeProfile = Object.keys(s.profiles)[0];
  s.solves = Array.isArray(s.solves) ? s.solves : [];
  // v2: home tiles light up and slides got quicker; move old defaults along once
  if (!s.v2) {
    if (s.settings.coloring === "single") s.settings.coloring = "correct";
    if (s.settings.animMs === 70) s.settings.animMs = 45;
    s.v2 = true;
  }
  // v3: accounts, attempt counters, cloud bookkeeping
  if (!s.v3) {
    s.counters = {};
    s.sync = {};
    s.locked = false;
    s.v3 = true;
  }
  s.counters = s.counters || {};
  s.sync = s.sync || {};
  // v5: drill results per player
  s.training = s.training || {};
  // the lamplight restyle: everyone moves to the new theme once. The tile digits stay the player's own pick.
  // The older themes are still in Settings, and what was picked before is kept here in case it is wanted back.
  if (!s.lamp) {
    const own = (s.settings.speedPrev && s.settings.speedPrev.prev) || {};
    s.lookBefore = {
      theme: own.theme || s.settings.theme,
      numeralFace: own.numeralFace || s.settings.numeralFace,
    };
    s.settings.theme = "lamp";
    s.lamp = true;
  }
  return s;
}

let saveTimer = 0;
function writeNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("Could not save", e);
  }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 120);
}
// a pending write must land before the window goes away
addEventListener("pagehide", () => saveTimer && writeNow());
addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && saveTimer) writeNow();
});

function emit(what) {
  for (const fn of listeners) fn(what);
}

function syncOf(profileId) {
  return state.sync[profileId] || (state.sync[profileId] = { pending: [], deleted: [] });
}
function touch(solve) {
  const p = state.profiles[solve.profileId];
  if (!p || !p.cloud) return;
  const q = syncOf(p.id);
  if (!q.pending.includes(solve.id)) q.pending.push(solve.id);
}

export const store = {
  get state() {
    return state;
  },
  get settings() {
    return state.settings;
  },
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Tell every view something changed that no single setter covers. */
  flush(evt) {
    save();
    emit(evt || { type: "all" });
  },

  set(key, value) {
    state.settings[key] = value;
    save();
    emit({ type: "settings", key });
  },

  /* ---------- accounts ---------- */

  profile() {
    return state.profiles[state.activeProfile];
  },
  profiles() {
    return Object.values(state.profiles);
  },
  findHandle(handle) {
    const hnd = String(handle || "").trim().toLowerCase();
    return this.profiles().find((p) => p.handle === hnd) || null;
  },
  addProfile(name, extra = {}) {
    const id = newId();
    state.profiles[id] = {
      id,
      name: name || "Player " + (Object.keys(state.profiles).length + 1),
      created: Date.now(),
      ...extra,
    };
    state.activeProfile = id;
    state.locked = false;
    save();
    emit({ type: "profile" });
    return id;
  },
  patchProfile(id, patch) {
    if (!state.profiles[id]) return;
    Object.assign(state.profiles[id], patch);
    save();
    emit({ type: "profile" });
  },
  renameProfile(id, name) {
    if (!state.profiles[id]) return;
    state.profiles[id].name = String(name).slice(0, 24) || state.profiles[id].name;
    state.profiles[id].nameDirty = true;
    save();
    emit({ type: "profile" });
  },
  switchProfile(id) {
    if (!state.profiles[id]) return;
    state.activeProfile = id;
    state.locked = false;
    save();
    emit({ type: "profile" });
  },
  setLocked(on) {
    state.locked = !!on;
    writeNow();
    emit({ type: "profile" });
  },
  deleteProfile(id) {
    if (Object.keys(state.profiles).length < 2) return;
    delete state.profiles[id];
    delete state.counters[id];
    delete state.sync[id];
    state.solves = state.solves.filter((s) => s.profileId !== id);
    if (state.activeProfile === id) state.activeProfile = Object.keys(state.profiles)[0];
    save();
    emit({ type: "profile" });
  },

  /* ---------- attempts: started, solved, given up ---------- */

  bump(N, key, profileId = state.activeProfile) {
    const byProfile = state.counters[profileId] || (state.counters[profileId] = {});
    const c = byProfile[N] || (byProfile[N] = { started: 0, solved: 0, abandoned: 0, failed: 0 });
    c[key] = (c[key] || 0) + 1;
    save();
  },
  counters(N, profileId = state.activeProfile) {
    return (state.counters[profileId] || {})[N] || { started: 0, solved: 0, abandoned: 0, failed: 0 };
  },

  /* ---------- solves ---------- */

  addSolve(solve) {
    state.solves.push(solve);
    touch(solve);
    save();
    emit({ type: "solves" });
  },
  updateSolve(id, patch, { quiet = false } = {}) {
    const s = state.solves.find((x) => x.id === id);
    if (!s) return;
    Object.assign(s, patch);
    touch(s);
    save();
    if (!quiet) emit({ type: "solve-updated", id });
  },
  deleteSolve(id) {
    const s = state.solves.find((x) => x.id === id);
    if (s) {
      const p = state.profiles[s.profileId];
      if (p && p.cloud) {
        const q = syncOf(p.id);
        q.pending = q.pending.filter((x) => x !== id);
        q.deleted.push({ id, N: s.N, date: s.date });
      }
    }
    state.solves = state.solves.filter((x) => x.id !== id);
    save();
    emit({ type: "solves" });
  },
  solves(filter = {}) {
    return state.solves.filter(
      (s) =>
        (filter.profileId == null || s.profileId === filter.profileId) &&
        (filter.N == null || s.N === filter.N) &&
        (filter.mode == null || s.mode === filter.mode) &&
        (filter.clean == null || (filter.clean ? !s.assisted && !s.modded : true)),
    );
  },
  getSolve(id) {
    return state.solves.find((s) => s.id === id);
  },

  /* ---------- cloud bookkeeping (see sync.js) ---------- */

  syncQueue(profileId) {
    return syncOf(profileId);
  },
  markAllPending(profileId) {
    const q = syncOf(profileId);
    q.pending = state.solves.filter((s) => s.profileId === profileId).map((s) => s.id);
    save();
  },
  clearPending(profileId, ids, deletedIds) {
    const q = syncOf(profileId);
    const gone = new Set(ids);
    q.pending = q.pending.filter((x) => !gone.has(x));
    const goneDel = new Set(deletedIds || []);
    q.deleted = q.deleted.filter((x) => !goneDel.has(x.id));
    save();
  },
  /** Apply rows pulled from the cloud. Local edits that have not been pushed yet win. */
  mergeRemote(profileId, rows) {
    const q = syncOf(profileId);
    const pending = new Set(q.pending);
    const byId = new Map(state.solves.map((s, i) => [s.id, i]));
    let added = 0,
      changed = 0,
      removed = 0;
    const drop = new Set();
    for (const row of rows) {
      if (row.deleted) {
        if (byId.has(row.id) && state.solves[byId.get(row.id)].profileId === profileId) {
          drop.add(row.id);
          removed++;
        }
        continue;
      }
      if (!row.data || typeof row.data !== "object" || pending.has(row.id)) continue;
      const solve = { ...row.data, id: row.id, profileId };
      if (byId.has(row.id)) {
        const had = state.solves[byId.get(row.id)];
        if (had.profileId !== profileId) continue;
        // an echo of what this device just pushed changes nothing
        if (sameSolve(had, solve)) continue;
        state.solves[byId.get(row.id)] = solve;
        changed++;
      } else {
        state.solves.push(solve);
        byId.set(row.id, state.solves.length - 1);
        added++;
      }
    }
    if (drop.size) state.solves = state.solves.filter((s) => !drop.has(s.id));
    if (added) state.solves.sort((a, b) => a.date - b.date);
    save();
    if (added || changed || removed) emit({ type: "solves" });
    return { added, changed, removed };
  },

  setCloudCursor(profileId, since, after) {
    const p = state.profiles[profileId];
    if (!p || !p.cloud) return;
    p.cloud.since = since;
    p.cloud.after = after;
    save();
  },
  setCloudMeta(profileId, { summary, nameDirty }) {
    const p = state.profiles[profileId];
    if (!p || !p.cloud) return;
    if (summary !== undefined) p.cloud.summary = summary;
    if (nameDirty !== undefined) p.nameDirty = nameDirty;
    save();
  },
  dropCloudToken(profileId) {
    const p = state.profiles[profileId];
    if (!p || !p.cloud) return;
    delete p.cloud.token;
    save();
    emit({ type: "profile" });
  },

  /* ---------- training ---------- */

  /** Save one drill repetition. Each drill keeps its newest 400. */
  addRep(key, rep, profileId = state.activeProfile) {
    const mine = state.training[profileId] || (state.training[profileId] = {});
    const list = mine[key] || (mine[key] = []);
    list.push(rep);
    if (list.length > 400) list.splice(0, list.length - 400);
    save();
    emit({ type: "training", key });
  },
  reps(key, profileId = state.activeProfile) {
    return ((state.training[profileId] || {})[key] || []).slice();
  },
  allReps(profileId = state.activeProfile) {
    return state.training[profileId] || {};
  },

  markIntroSeen() {
    state.seenIntro = true;
    save();
  },

  /* ---------- backup ---------- */

  exportJSON() {
    // session tokens never leave the device in a backup file
    const copy = JSON.parse(JSON.stringify(state));
    for (const p of Object.values(copy.profiles)) if (p.cloud) delete p.cloud.token;
    return JSON.stringify(copy, null, 1);
  },
  importJSON(text) {
    const s = JSON.parse(text);
    if (!s || !Array.isArray(s.solves) || !s.profiles)
      throw new Error("That file is not a Fifteen Press backup.");
    // a backup made before the lamplight restyle has no flag of its own, so it must not borrow blank()'s
    state = upgrade({ ...blank(), lamp: false, ...s });
    if (!Object.keys(state.profiles).length) state.profiles = blank().profiles;
    if (!state.profiles[state.activeProfile])
      state.activeProfile = Object.keys(state.profiles)[0];
    writeNow();
    emit({ type: "all" });
  },
  reset() {
    state = blank();
    save();
    emit({ type: "all" });
  },
};

function sameSolve(a, b) {
  const ka = Object.keys(a),
    kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const x = a[k],
      y = b[k];
    if (x === y) continue;
    if (x == null && y == null) continue;
    if (typeof x === "object" && typeof y === "object" && JSON.stringify(x) === JSON.stringify(y)) continue;
    return false;
  }
  return true;
}

// Moves are kept as "UDLR" (blank direction) and per-move times as base-36 deltas.
export function encodeMoves(moves) {
  return moves.map((m) => "UDLR"[m]).join("");
}
export function decodeMoves(str) {
  return Array.from(str || "", (c) => "UDLR".indexOf(c));
}
export function encodeTimes(times) {
  let prev = 0;
  return times
    .map((t) => {
      const d = Math.max(0, Math.round(t - prev));
      prev = t;
      return d.toString(36);
    })
    .join(",");
}
export function decodeTimes(str) {
  if (!str) return [];
  let acc = 0;
  return str.split(",").map((d) => (acc += parseInt(d, 36)));
}
