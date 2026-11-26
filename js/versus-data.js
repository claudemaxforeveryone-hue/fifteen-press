// What 1v1 remembers on this device: two ratings, the race log, the friends list and a few options.
// One localStorage entry. Nothing here leaves the device except the name, friend code and rating a friend is shown.

const KEY = "fifteen.versus.v2";
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0 O 1 I L
export const FRIEND_CODE_LEN = 8;
export const START_ELO = 1000;
export const ELO_K = 32;
export const MAX_FRIENDS = 30;
const MAX_LOG = 600;

export const SIZES = [3, 4, 5];
export const TARGETS = [0, 2, 3, 5, 7]; // first to this many rounds, 0 = single rounds
export const LEADS = [3, 5, 10, 15]; // countdown seconds
export const LEADS_OLD = [3, 5]; // all that 5.8.0 knows

function blank() {
  return {
    fc: "",
    elo: { friends: START_ELO, engine: START_ELO },
    peak: { friends: START_ELO, engine: START_ELO },
    log: [],
    matches: { w: 0, l: 0 },
    friends: [],
    prefs: { sounds: true, fx: true, online: true },
    room: { N: 4, to: 0, lead: 3, peek: true, rated: true },
    rev: 1, // 1 = 5.8.1: the board is on show during the countdown unless it was turned off since
  };
}

let data = null;

export function randomCode(len) {
  let out = "";
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) out += CODE_CHARS[buf[i] % CODE_CHARS.length];
  return out;
}

export function isFriendCode(text) {
  return typeof text === "string" && text.length === FRIEND_CODE_LEN && [...text].every((ch) => CODE_CHARS.includes(ch));
}

// a pasted friend link works as well as the bare code
export function cleanFriendCode(text) {
  const raw = String(text || "");
  const m = /versus\/add\/([A-Za-z0-9]+)/.exec(raw);
  const code = (m ? m[1] : raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return isFriendCode(code) ? code : "";
}

export function cleanName(text) {
  return String(text || "")
    .replace(/[\u0000-\u001f<>]/g, "")
    .trim()
    .slice(0, 20);
}

export function cleanElo(x) {
  const n = Math.round(Number(x));
  return Number.isFinite(n) ? Math.max(0, Math.min(4000, n)) : START_ELO;
}

export function cleanRoom(room, base) {
  const out = Object.assign({}, base || blank().room);
  if (!room || typeof room !== "object") return out;
  if (SIZES.includes(room.N)) out.N = room.N;
  if (TARGETS.includes(room.to)) out.to = room.to;
  if (LEADS.includes(room.lead)) out.lead = room.lead;
  if (typeof room.peek === "boolean") out.peek = room.peek;
  if (typeof room.rated === "boolean") out.rated = room.rated;
  return out;
}

export function load() {
  if (data) return data;
  const d = blank();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === "object") {
      if (isFriendCode(raw.fc)) d.fc = raw.fc;
      for (const k of ["friends", "engine"]) {
        if (raw.elo && raw.elo[k] != null) d.elo[k] = cleanElo(raw.elo[k]);
        d.peak[k] = Math.max(d.elo[k], raw.peak && raw.peak[k] != null ? cleanElo(raw.peak[k]) : 0);
      }
      if (Array.isArray(raw.log)) d.log = raw.log.filter((x) => x && typeof x === "object").slice(-MAX_LOG);
      if (raw.matches) d.matches = { w: raw.matches.w | 0, l: raw.matches.l | 0 };
      if (Array.isArray(raw.friends))
        d.friends = raw.friends
          .filter((f) => f && isFriendCode(f.fc))
          .slice(0, MAX_FRIENDS)
          .map((f) => ({ fc: f.fc, name: cleanName(f.name), elo: f.elo != null ? cleanElo(f.elo) : null, added: Number(f.added) || 0, told: !!f.told }));
      if (raw.prefs) for (const k of Object.keys(d.prefs)) if (typeof raw.prefs[k] === "boolean") d.prefs[k] = raw.prefs[k];
      d.room = cleanRoom(raw.room, d.room);
      if ((raw.rev | 0) < 1) d.room.peek = true; // saved by 5.8.0, where hidden was only the default
    }
  } catch (e) {
    /* nothing saved yet, or a private window */
  }
  if (!d.fc) {
    d.fc = randomCode(FRIEND_CODE_LEN);
    data = d;
    save();
  }
  data = d;
  return data;
}

export function save() {
  if (!data) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch (e) {
    /* private window: this sitting still works */
  }
}

/* ---------- rating ---------- */

export function expected(mine, theirs) {
  return 1 / (1 + 10 ** ((theirs - mine) / 400));
}
// score: 1 win, 0.5 draw, 0 loss
export function eloDelta(mine, theirs, score) {
  return Math.round(ELO_K * (score - expected(mine, theirs)));
}

/**
 * Log one finished round.
 * race: { kind: "friends"|"engine", opp, id, N, result: "w"|"l"|"d", ms, oppMs, moves, oppElo, rated }
 * Returns { delta, rating } (delta 0 when the round was not rated).
 */
export function recordRace(race) {
  const d = load();
  const kind = race.kind === "engine" ? "engine" : "friends";
  let delta = 0;
  if (race.rated && race.oppElo != null) {
    const score = race.result === "w" ? 1 : race.result === "l" ? 0 : 0.5;
    delta = eloDelta(d.elo[kind], race.oppElo, score);
    d.elo[kind] = cleanElo(d.elo[kind] + delta);
    d.peak[kind] = Math.max(d.peak[kind], d.elo[kind]);
  }
  d.log.push({
    t: Date.now(),
    k: kind === "engine" ? "e" : "f",
    o: cleanName(race.opp) || "Friend",
    id: race.id || "",
    N: race.N,
    r: race.result,
    ms: race.ms > 0 ? Math.round(race.ms) : 0,
    oms: race.oppMs > 0 ? Math.round(race.oppMs) : 0,
    m: race.moves | 0,
    d: delta,
    e: race.rated ? d.elo[kind] : null,
  });
  if (d.log.length > MAX_LOG) d.log.splice(0, d.log.length - MAX_LOG);
  save();
  return { delta, rating: d.elo[kind] };
}

export function recordMatch(won) {
  const d = load();
  if (won) d.matches.w++;
  else d.matches.l++;
  save();
}

export function clearStats() {
  const d = load();
  d.log = [];
  d.matches = { w: 0, l: 0 };
  d.elo = { friends: START_ELO, engine: START_ELO };
  d.peak = { friends: START_ELO, engine: START_ELO };
  save();
}

/* ---------- friends ---------- */

export function friend(fc) {
  return load().friends.find((f) => f.fc === fc) || null;
}
export function addFriend(fc, name) {
  const d = load();
  if (!isFriendCode(fc) || fc === d.fc) return null;
  let f = friend(fc);
  if (f) {
    if (name) f.name = cleanName(name);
  } else {
    if (d.friends.length >= MAX_FRIENDS) return null;
    f = { fc, name: cleanName(name), elo: null, added: Date.now(), told: false };
    d.friends.push(f);
  }
  save();
  return f;
}
export function removeFriend(fc) {
  const d = load();
  d.friends = d.friends.filter((f) => f.fc !== fc);
  save();
}

/* ---------- reading the log ---------- */

const median = (xs) => {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Totals for a set of log rows. */
export function tally(rows) {
  const out = { n: rows.length, w: 0, l: 0, d: 0, best: 0, mean: 0, median: 0, tps: 0, streak: 0, bestStreak: 0 };
  const times = [];
  let moves = 0,
    moveMs = 0,
    run = 0;
  for (const x of rows) {
    if (x.r === "w") {
      out.w++;
      run++;
      if (run > out.bestStreak) out.bestStreak = run;
    } else {
      if (x.r === "l") out.l++;
      else out.d++;
      run = 0;
    }
    if (x.ms > 0) {
      times.push(x.ms);
      if (x.m > 0) {
        moves += x.m;
        moveMs += x.ms;
      }
    }
  }
  out.streak = run;
  if (times.length) {
    out.best = Math.min(...times);
    out.mean = times.reduce((a, b) => a + b, 0) / times.length;
    out.median = median(times);
  }
  if (moveMs) out.tps = moves / (moveMs / 1000);
  out.rate = out.n ? out.w / out.n : 0;
  return out;
}

/** Head to head, newest opponent first. Rows: { key, name, kind, n, w, l, d, best, last } */
export function rivals(rows) {
  const map = new Map();
  for (const x of rows) {
    const key = x.k + ":" + (x.id || x.o);
    let r = map.get(key);
    if (!r) map.set(key, (r = { key, id: x.id || "", name: x.o, kind: x.k, n: 0, w: 0, l: 0, d: 0, best: 0, last: 0 }));
    r.n++;
    r.name = x.o;
    r.last = x.t;
    if (x.r === "w") r.w++;
    else if (x.r === "l") r.l++;
    else r.d++;
    if (x.ms > 0 && (!r.best || x.ms < r.best)) r.best = x.ms;
  }
  return [...map.values()].sort((a, b) => b.last - a.last);
}
