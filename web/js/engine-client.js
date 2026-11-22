// Talks to solver workers. Falls back to running the engine on the main thread
// when the host refuses workers (some sandboxed pages do).
const E = window.FifteenEngine;
const WORKER_URL = new URL("../engine/worker.js", import.meta.url);
const PDB_BASE = new URL("../engine/pdb/", import.meta.url);

let workerSupported = null;
let mainThreadPDB = null;

class Slot {
  constructor(name) {
    this.name = name;
    this.worker = null;
    this.pending = new Map();
    this.seq = 0;
  }
  spawn() {
    this.worker = new Worker(WORKER_URL);
    this.worker.onmessage = (e) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.progress) {
        p.onProgress && p.onProgress(m.progress);
        return;
      }
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.result);
    };
    this.worker.onerror = (e) => {
      const err = new Error(e.message || "Solver worker crashed");
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker = null;
    };
  }
  run(type, args, onProgress) {
    if (!this.worker) this.spawn();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage(Object.assign({ id, type }, args));
    });
  }
  cancel() {
    // an idle worker keeps its loaded tables; only a busy one is torn down
    if (!this.worker || this.pending.size === 0) return;
    this.worker.terminate();
    this.worker = null;
    const err = new Error("cancelled");
    err.cancelled = true;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

const slots = {};
function slot(name) {
  return slots[name] || (slots[name] = new Slot(name));
}

// One shared probe: several jobs start at boot, and each must wait on the same answer.
let probe = null;
function canUseWorkers() {
  if (workerSupported !== null) return Promise.resolve(workerSupported);
  if (!probe) {
    probe = (async () => {
      const s = slot("probe");
      try {
        await Promise.race([
          s.run("init", { needPDB: false }),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error("timeout")), 4000),
          ),
        ]);
        workerSupported = true;
      } catch (e) {
        console.warn(
          "Workers unavailable, solving on the main thread:",
          e.message,
        );
        workerSupported = false;
      }
      s.cancel();
      return workerSupported;
    })();
  }
  return probe;
}

async function ensureMainPDB() {
  if (E.hasPDB()) return;
  if (!mainThreadPDB) {
    mainThreadPDB = E.fetchPDB(PDB_BASE).catch((e) => {
      mainThreadPDB = null;
      throw e;
    });
  }
  await mainThreadPDB;
}

// Main-thread versions of the worker jobs (same results, blocks while running)
const local = {
  async solve(a) {
    if (a.N >= 4) await ensureMainPDB();
    return E.solve(a.board, a.N, {
      timeLimit: Math.min(a.timeLimit ?? 4000, 4000),
      coreTimeLimit: 800,
    });
  },
  async distance(a) {
    if (a.N === 3) return { d: E.distance3(a.board), exact: true };
    if (a.N === 4) {
      await ensureMainPDB();
      const r = E.solve4(a.board, {
        timeLimit: Math.min(a.timeLimit ?? 3000, 3000),
      });
      return r.timeout
        ? { d: r.bound, exact: false, lowerBound: true }
        : { d: r.moves.length, exact: true, moves: r.moves };
    }
    return { d: E.heuristic(a.board, a.N), exact: false };
  },
  async analyze(a, onProgress) {
    const M = a.boards.length;
    const d = new Array(M).fill(null),
      exact = new Array(M).fill(false);
    if (a.N > 4)
      return {
        d: a.boards.map((b) => E.heuristic(b, a.N)),
        exact,
        estimate: true,
      };
    if (a.N === 4) await ensureMainPDB();
    d[M - 1] = 0;
    exact[M - 1] = true;
    for (let i = M - 2; i >= 0; i--) {
      if (a.N === 3) {
        d[i] = E.distance3(a.boards[i]);
        exact[i] = true;
      } else if (exact[i + 1]) {
        const r = E.within4(a.boards[i], d[i + 1] - 1, 1500);
        if (r !== null) {
          d[i] = r ? d[i + 1] - 1 : d[i + 1] + 1;
          exact[i] = true;
        } else d[i] = E.pdbHeuristic(a.boards[i]);
      } else d[i] = E.pdbHeuristic(a.boards[i]);
      if (i % 10 === 0) {
        onProgress && onProgress({ done: M - i, total: M });
        await new Promise((r) => setTimeout(r));
      }
    }
    return { d, exact, estimate: false };
  },
  async batch(a, onProgress) {
    const out = [];
    for (let i = 0; i < a.seeds.length; i++) {
      const board = E.scrambleFromSeed(a.seeds[i], a.N);
      const t0 = performance.now();
      const r = await local.distance({ board, N: a.N, timeLimit: a.timeLimit });
      out.push({
        seed: a.seeds[i],
        d: r.d,
        exact: r.exact,
        ms: performance.now() - t0,
      });
      onProgress &&
        onProgress({
          done: i + 1,
          total: a.seeds.length,
          item: out[out.length - 1],
        });
      await new Promise((r) => setTimeout(r));
    }
    return out;
  },
  async distribution3() {
    return E.distribution3();
  },
};

/**
 * Run a job. `lane` keeps unrelated jobs from queueing behind each other
 * (hints shouldn't wait for a 100-seed batch). Starting a job in a lane with
 * `replace` cancels whatever that lane was doing.
 */
export async function run(
  type,
  args,
  { lane = "main", onProgress, replace = false } = {},
) {
  if (await canUseWorkers()) {
    const s = slot(lane);
    if (replace) s.cancel();
    return s.run(type, args, onProgress);
  }
  return local[type](args, onProgress);
}

export function cancel(lane) {
  if (slots[lane]) slots[lane].cancel();
}

export function lanes(prefix, count) {
  return Array.from({ length: count }, (_, i) => prefix + i);
}

export function usingWorkers() {
  return workerSupported;
}

export function warm() {
  // load the pattern databases early so the first hint is instant
  canUseWorkers().then((ok) => {
    if (ok)
      slot("main")
        .run("init", { needPDB: true })
        .catch(() => {});
    else ensureMainPDB().catch(() => {});
  });
}
