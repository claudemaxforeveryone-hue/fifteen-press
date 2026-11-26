// Background grading: runs every ungraded 3x3 and 4x4 solve through the engine, one at a time,
// so the engine-line stats cover the whole history and not just the proofs you opened.
import { store, decodeMoves } from "./store.js";
import { positionsFrom } from "./game.js";
import * as engine from "./engine-client.js";

const listeners = new Set();
let queue = [];
let running = false;
let done = 0;
let total = 0;
let failed = new Set();

function emit() {
  const state = status();
  for (const fn of listeners) fn(state);
}

export function onGrader(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function status() {
  return { running, done, total, left: queue.length };
}

export function needsGrading(solve) {
  return solve.N <= 4 && !solve.dist && solve.moveCount > 0 && !failed.has(solve.id);
}

/** Queue every ungraded solve of a player (newest first), or one solve. */
export function gradeAll(profileId) {
  const ids = store
    .solves({ profileId })
    .filter(needsGrading)
    .map((s) => s.id)
    .reverse();
  for (const id of ids) if (!queue.includes(id)) queue.push(id);
  total = done + queue.length;
  pump();
  emit();
  return ids.length;
}

export function gradeOne(id) {
  if (queue.includes(id)) return;
  queue.unshift(id);
  total = done + queue.length;
  pump();
  emit();
}

export function stopGrading() {
  queue = [];
  total = done;
  engine.cancel("grader");
  emit();
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const id = queue.shift();
    const solve = store.getSolve(id);
    if (!solve || !needsGrading(solve)) {
      total = done + queue.length;
      continue;
    }
    try {
      const boards = positionsFrom(solve.start, solve.N, decodeMoves(solve.moves));
      const res = await engine.run("analyze", { boards, N: solve.N, stepLimit: 4000 }, { lane: "grader" });
      const allExact = res.exact.every(Boolean);
      const patch = {
        dist: res.d.map((x) => (x == null ? "" : x)).join(","),
        distExact: allExact,
        distMask: allExact ? null : res.exact.map((x) => (x ? "1" : "0")).join(""),
        distEstimate: !!res.estimate,
      };
      if (!res.estimate && res.exact[0] && solve.optimal == null) {
        patch.optimal = res.d[0];
        patch.optimalExact = true;
      }
      store.updateSolve(id, patch, { quiet: true });
      done++;
    } catch (e) {
      if (e && e.cancelled) break;
      failed.add(id);
      total = done + queue.length;
    }
    emit();
    // let input and painting through between solves
    await new Promise((r) => setTimeout(r, 30));
  }
  running = false;
  if (!queue.length) {
    store.flush({ type: "graded" });
    done = 0;
    total = 0;
  }
  emit();
}
