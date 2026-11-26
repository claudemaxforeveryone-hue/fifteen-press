// Shared leaderboard, only where the host provides a shared store (the published web version).
// Each player owns one document at scores/<their id>. Everyone reads, each writes their own.
let ready = null;

export function getGlobal() {
  if (ready) return ready;
  ready = (async () => {
    if (!window.claude || typeof window.claude.use !== "function") return null;
    const [db, user] = await Promise.all([
      window.claude.use("db"),
      window.claude.use("user"),
    ]);
    if (!db || !user) return null;
    const id = await user.id();
    if (!id) return null;
    return { db, user, id };
  })().catch(() => null);
  return ready;
}

function better(a, b, key) {
  return !a || b[key] < a[key];
}

export async function submit(solve, tag) {
  const g = await getGlobal();
  if (!g) return false;
  if (solve.assisted || solve.modded) return false;
  const ref = g.db.doc("scores/" + g.id);
  const snap = await ref.get();
  const cur = snap.exists ? JSON.parse(JSON.stringify(snap.data())) : {};
  const next = {
    tag: String(tag || "Player").slice(0, 24),
    updated: Date.now(),
    best: cur.best || {},
    fewest: cur.fewest || {},
    daily: cur.daily || {},
    solves: (cur.solves || 0) + 1,
  };
  const entry = {
    time: Math.round(solve.duration),
    moves: solve.moveCount,
    optimal: solve.optimal || null,
    seed: solve.seed || null,
    at: solve.date,
  };
  const k = String(solve.N);
  if (better(next.best[k], entry, "time")) next.best[k] = entry;
  if (better(next.fewest[k], entry, "moves")) next.fewest[k] = entry;
  if (solve.mode === "daily" && solve.daily) {
    const dk = solve.daily + "_" + k;
    if (better(next.daily[dk], entry, "time")) next.daily[dk] = entry;
    // keep the document small: last 21 daily results
    const keys = Object.keys(next.daily).sort();
    for (const old of keys.slice(0, Math.max(0, keys.length - 21)))
      delete next.daily[old];
  }
  await ref.set(next);
  return true;
}

function clean(e) {
  if (!e || typeof e !== "object") return null;
  const time = Number(e.time),
    moves = Number(e.moves);
  if (!isFinite(time) || !isFinite(moves) || time < 200 || moves < 1)
    return null;
  return {
    time,
    moves,
    optimal: Number(e.optimal) || null,
    seed: typeof e.seed === "string" ? e.seed.slice(0, 40) : null,
    at: Number(e.at) || 0,
  };
}

export async function fetchAll() {
  const g = await getGlobal();
  if (!g) return null;
  const snap = await g.db.collection("scores").limit(500).get();
  const rows = [];
  for (const doc of snap.docs) {
    const d = doc.data() || {};
    const row = {
      id: doc.id,
      tag: typeof d.tag === "string" ? d.tag.slice(0, 24) : "Player",
      best: {},
      fewest: {},
      daily: {},
      me: doc.id === g.id,
    };
    for (const key of ["best", "fewest", "daily"]) {
      const src = d[key] && typeof d[key] === "object" ? d[key] : {};
      for (const [k, v] of Object.entries(src)) {
        const c = clean(v);
        if (c) row[key][k] = c;
      }
    }
    rows.push(row);
  }
  let names = {};
  try {
    names = await g.user.profiles(rows.map((r) => r.id));
  } catch (e) {
    names = {};
  }
  for (const r of rows)
    r.name = (names[r.id] && names[r.id].name) || r.tag || "Someone";
  return rows;
}
