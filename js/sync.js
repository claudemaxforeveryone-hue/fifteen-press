// Keeps a signed-in player's solves in step with the cloud: push what changed here, then pull
// what changed anywhere else. Safe to call often; one run at a time.
import { store } from "./store.js";
import { cloud, cloudConfigured } from "./cloud.js";
import { rolling } from "./deep.js";

const listeners = new Set();
let state = { state: cloudConfigured() ? "idle" : "off", last: 0, message: "" };
let running = null;
let timer = 0;
let again = false;

function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}

export function onSync(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function syncStatus() {
  const p = store.profile();
  if (!cloudConfigured()) return { ...state, state: "off" };
  if (!p || !p.cloud || !p.cloud.token) return { ...state, state: p && p.handle ? "local" : "guest" };
  const q = store.syncQueue(p.id);
  return { ...state, waiting: q.pending.length + q.deleted.length };
}

/** Sync a little later. Calls made while waiting collapse into one. */
export function syncSoon(delay = 1500) {
  if (!cloudConfigured()) return;
  clearTimeout(timer);
  timer = setTimeout(() => syncNow().catch(() => {}), delay);
}

export function syncNow() {
  if (running) {
    again = true;
    return running;
  }
  running = run().finally(() => {
    running = null;
    if (again) {
      again = false;
      syncSoon(400);
    }
  });
  return running;
}

function row(solve) {
  const { profileId, ...data } = solve;
  return {
    id: solve.id,
    N: solve.N,
    mode: solve.mode || "random",
    duration: Math.round(solve.duration),
    moveCount: solve.moveCount,
    optimal: solve.optimal == null ? "" : solve.optimal,
    date: solve.date,
    clean: !solve.assisted && !solve.modded && solve.mode !== "custom" && solve.duration >= 200 && solve.moveCount > 0,
    daily: solve.daily || null,
    deleted: false,
    data,
  };
}

/** Best averages per board size, for the shared leaderboard. */
function summaryOf(profileId) {
  const out = {};
  const mine = store.solves({ profileId, clean: true }).filter((s) => s.mode !== "custom");
  for (const N of new Set(mine.map((s) => s.N))) {
    const t = mine.filter((s) => s.N === N).map((s) => s.duration);
    const e = { n: t.length };
    const a5 = rolling(t, 5).best,
      a12 = rolling(t, 12).best;
    if (a5 != null) e.ao5 = Math.round(a5);
    if (a12 != null) e.ao12 = Math.round(a12);
    out[N] = e;
  }
  return out;
}

async function run() {
  const p = store.profile();
  if (!cloudConfigured() || !p || !p.cloud || !p.cloud.token) return { skipped: true };
  const id = p.id,
    token = p.cloud.token;
  set({ state: "syncing", message: "" });
  try {
    // 1. push
    const q = store.syncQueue(id);
    let pushed = 0;
    const pending = q.pending.slice();
    for (let i = 0; i < pending.length; i += 100) {
      const ids = pending.slice(i, i + 100);
      const rows = ids.map((x) => store.getSolve(x)).filter(Boolean).map(row);
      if (rows.length) await cloud.push(token, rows);
      store.clearPending(id, ids, []);
      pushed += rows.length;
    }
    const gone = q.deleted.slice();
    for (let i = 0; i < gone.length; i += 100) {
      const part = gone.slice(i, i + 100);
      await cloud.push(
        token,
        part.map((d) => ({ id: d.id, N: d.N, mode: "", duration: 0, moveCount: 0, optimal: "", date: d.date, deleted: true })),
      );
      store.clearPending(id, [], part.map((d) => d.id));
    }
    // 2. pull everything newer than the last thing seen
    let since = p.cloud.since || null,
      after = p.cloud.after || "";
    let pulled = 0;
    for (let page = 0; page < 400; page++) {
      const res = await cloud.pull(token, since, after);
      const rows = res.solves || [];
      if (rows.length) {
        const m = store.mergeRemote(id, rows);
        pulled += m.added + m.changed + m.removed;
        since = rows[rows.length - 1].t;
        after = rows[rows.length - 1].id;
        store.setCloudCursor(id, since, after);
      }
      if (!res.more) break;
    }
    // 3. name and best averages, when something moved
    const summary = JSON.stringify(summaryOf(id));
    const now = store.state.profiles[id];
    if (now && (pushed || now.nameDirty || now.cloud.summary !== summary)) {
      await cloud.updateProfile(token, { name: now.nameDirty ? now.name : null, summary: JSON.parse(summary) });
      store.setCloudMeta(id, { summary, nameDirty: false });
    }
    set({ state: "idle", last: Date.now(), message: "" });
    return { pushed, pulled };
  } catch (e) {
    if (e && e.code === "bad_session") {
      // signed out from somewhere else, or the account is gone
      store.dropCloudToken(id);
      set({ state: "idle", message: "Signed out online. Sign in again to sync." });
    } else if (e && e.code === "offline") set({ state: "offline", message: "Offline. Will sync later." });
    else set({ state: "error", message: (e && e.message) || "Sync failed." });
    throw e;
  }
}

if (typeof addEventListener === "function") addEventListener("online", () => syncSoon(800));
