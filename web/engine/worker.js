/* Solver worker. Messages: {id, type, ...args} -> {id, progress} ... {id, ok, result} | {id, error} */
"use strict";
importScripts("core.js");
const E = self.FifteenEngine;

let pdbReady = null;
function ensurePDB(buffers) {
  if (E.hasPDB()) return Promise.resolve();
  if (buffers) {
    E.setPDB(buffers);
    return Promise.resolve();
  }
  if (!pdbReady) {
    pdbReady = E.fetchPDB(new URL("pdb/", self.location.href)).catch((e) => {
      pdbReady = null;
      throw e;
    });
  }
  return pdbReady;
}

function optimalDistance(board, N, timeLimit) {
  if (E.isSolved(board)) return { d: 0, exact: true };
  if (N === 3) return { d: E.distance3(board), exact: true };
  if (N === 4) {
    const r = E.solve4(board, { timeLimit });
    if (!r.timeout) return { d: r.moves.length, exact: true, moves: r.moves };
    return { d: r.bound, exact: false, lowerBound: true };
  }
  return { d: E.heuristic(board, N), exact: false };
}

const handlers = {
  async init(msg) {
    if (msg.needPDB) await ensurePDB(msg.buffers);
    return { pdb: E.hasPDB() };
  },

  async solve(msg) {
    if (msg.N === 4) await ensurePDB();
    else if (msg.N > 4) await ensurePDB().catch(() => {});
    return E.solve(msg.board, msg.N, {
      timeLimit: msg.timeLimit,
      coreTimeLimit: msg.coreTimeLimit,
    });
  },

  async distance(msg) {
    if (msg.N === 4) await ensurePDB();
    return optimalDistance(msg.board, msg.N, msg.timeLimit);
  },

  // Optimal distance for every position of a solve, last to first.
  // Neighbouring positions differ by exactly one, so each step is a single bounded search.
  async analyze(msg, progress) {
    const { boards, N } = msg;
    const M = boards.length;
    const d = new Array(M).fill(null);
    const exact = new Array(M).fill(false);
    if (N === 4) await ensurePDB();
    if (N > 4) {
      for (let i = 0; i < M; i++) d[i] = E.heuristic(boards[i], N);
      return { d, exact, estimate: true };
    }
    const cache = new Map();
    const stepLimit = msg.stepLimit || 6000;
    d[M - 1] = 0;
    exact[M - 1] = true;
    cache.set(boards[M - 1].join(","), 0);
    let lastPost = 0;
    for (let i = M - 2; i >= 0; i--) {
      const key = boards[i].join(",");
      if (cache.has(key)) {
        d[i] = cache.get(key);
        exact[i] = true;
      } else if (N === 3) {
        d[i] = E.distance3(boards[i]);
        exact[i] = true;
      } else if (exact[i + 1]) {
        const shorter = E.within4(boards[i], d[i + 1] - 1, stepLimit);
        if (shorter !== null) {
          d[i] = shorter ? d[i + 1] - 1 : d[i + 1] + 1;
          exact[i] = true;
        }
      }
      if (!exact[i] && N === 4) {
        const r = optimalDistance(boards[i], 4, stepLimit);
        d[i] = r.d;
        exact[i] = r.exact;
      }
      if (exact[i]) cache.set(key, d[i]);
      const t = Date.now();
      if (t - lastPost > 60 || i === 0) {
        lastPost = t;
        progress({ done: M - i, total: M });
      }
    }
    return { d, exact, estimate: false };
  },

  // Optimal length for a list of seeds.
  async batch(msg, progress) {
    const { seeds, N, timeLimit } = msg;
    if (N === 4) await ensurePDB();
    const out = [];
    for (let i = 0; i < seeds.length; i++) {
      const board = E.scrambleFromSeed(seeds[i], N);
      const t0 = Date.now();
      const r = optimalDistance(board, N, timeLimit);
      out.push({ seed: seeds[i], d: r.d, exact: r.exact, ms: Date.now() - t0 });
      progress({ done: i + 1, total: seeds.length, item: out[out.length - 1] });
    }
    return out;
  },

  async distribution3() {
    return E.distribution3();
  },
};

self.onmessage = async (e) => {
  const msg = e.data;
  const h = handlers[msg.type];
  if (!h) {
    self.postMessage({ id: msg.id, error: "unknown job " + msg.type });
    return;
  }
  try {
    const result = await h(msg, (p) =>
      self.postMessage({ id: msg.id, progress: p }),
    );
    self.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    self.postMessage({
      id: msg.id,
      error: String((err && err.message) || err),
    });
  }
};
