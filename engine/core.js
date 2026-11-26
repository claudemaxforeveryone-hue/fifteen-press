/*
 * Fifteen Press engine core.
 * Runs in a Web Worker (importScripts), on the main thread as a fallback, and in Node for tests and the PDB build.
 *
 * Board: flat array, length N*N. 0 is the blank. Tile t belongs at index t-1, blank at the last index.
 * Moves are stored as the direction the BLANK travels: 0 up, 1 down, 2 left, 3 right.
 * The tile that slides travels the opposite way.
 */
(function (root) {
  "use strict";

  const DR = [-1, 1, 0, 0];
  const DC = [0, 0, -1, 1];
  const INV = [1, 0, 3, 2];
  const DIR_CHARS = "UDLR"; // blank direction
  const TILE_CHARS = "DURL"; // the tile moves the opposite way

  /* ---------------- seeded RNG ---------------- */

  function hashSeed(str) {
    // cyrb128: four 32-bit words from a string
    let h1 = 1779033703,
      h2 = 3144134277,
      h3 = 1013904242,
      h4 = 2773480762;
    for (let i = 0; i < str.length; i++) {
      const k = str.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    return [
      (h1 ^ h2 ^ h3 ^ h4) >>> 0,
      (h2 ^ h1) >>> 0,
      (h3 ^ h1) >>> 0,
      (h4 ^ h1) >>> 0,
    ];
  }

  function rngFromSeed(str) {
    // sfc32
    let [a, b, c, d] = hashSeed(String(str));
    const next = function () {
      a >>>= 0;
      b >>>= 0;
      c >>>= 0;
      d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
    for (let i = 0; i < 12; i++) next();
    return next;
  }

  const SEED_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  function randomSeed(len) {
    len = len || 8;
    let s = "";
    const buf = new Uint32Array(len);
    if (root.crypto && root.crypto.getRandomValues)
      root.crypto.getRandomValues(buf);
    else
      for (let i = 0; i < len; i++)
        buf[i] = Math.floor(Math.random() * 4294967296);
    for (let i = 0; i < len; i++)
      s += SEED_ALPHABET[buf[i] % SEED_ALPHABET.length];
    return s;
  }

  /* ---------------- basic board ops ---------------- */

  function solvedBoard(N) {
    const b = new Array(N * N);
    for (let i = 0; i < N * N - 1; i++) b[i] = i + 1;
    b[N * N - 1] = 0;
    return b;
  }

  function isSolved(board) {
    const L = board.length;
    for (let i = 0; i < L - 1; i++) if (board[i] !== i + 1) return false;
    return board[L - 1] === 0;
  }

  function permutationParity(board) {
    // parity of the permutation, blank treated as tile N*N
    const L = board.length;
    const seen = new Uint8Array(L);
    let parity = 0;
    for (let i = 0; i < L; i++) {
      if (seen[i]) continue;
      let len = 0,
        j = i;
      while (!seen[j]) {
        seen[j] = 1;
        const v = board[j] === 0 ? L : board[j];
        j = v - 1;
        len++;
      }
      parity ^= (len - 1) & 1;
    }
    return parity;
  }

  function isSolvable(board, N) {
    const L = N * N;
    if (board.length !== L) return false;
    const seen = new Uint8Array(L);
    for (const v of board) {
      if (v < 0 || v >= L || seen[v]) return false;
      seen[v] = 1;
    }
    const b = board.indexOf(0);
    const dist = N - 1 - Math.floor(b / N) + (N - 1 - (b % N));
    return permutationParity(board) === (dist & 1);
  }

  function scrambleFromSeed(seed, N) {
    const rng = rngFromSeed(N + "x" + N + ":" + seed);
    const L = N * N;
    let b;
    do {
      b = [];
      for (let i = 0; i < L; i++) b.push(i);
      for (let i = L - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = b[i];
        b[i] = b[j];
        b[j] = t;
      }
      if (!isSolvable(b, N)) {
        // swap two non-blank tiles to flip parity
        let x = 0,
          y = 1;
        if (b[x] === 0) x = 2;
        if (b[y] === 0) y = 2;
        const t = b[x];
        b[x] = b[y];
        b[y] = t;
      }
    } while (isSolved(b));
    return b;
  }

  function neighbor(cell, dir, N) {
    const r = Math.floor(cell / N) + DR[dir];
    const c = (cell % N) + DC[dir];
    if (r < 0 || r >= N || c < 0 || c >= N) return -1;
    return r * N + c;
  }

  function applyMove(board, N, dir) {
    const b = board.indexOf(0);
    const n = neighbor(b, dir, N);
    if (n < 0) return false;
    board[b] = board[n];
    board[n] = 0;
    return true;
  }

  function applyMoves(board, N, moves) {
    const out = board.slice();
    for (const m of moves) applyMove(out, N, m);
    return out;
  }

  function simplifyMoves(moves) {
    const out = [];
    for (const m of moves) {
      if (out.length && out[out.length - 1] === INV[m]) out.pop();
      else out.push(m);
    }
    return out;
  }

  function manhattan(board, N) {
    let h = 0;
    for (let i = 0; i < board.length; i++) {
      const v = board[i];
      if (!v) continue;
      const g = v - 1;
      h +=
        Math.abs(Math.floor(g / N) - Math.floor(i / N)) +
        Math.abs((g % N) - (i % N));
    }
    return h;
  }

  function linearConflict(board, N) {
    let lc = 0;
    for (let r = 0; r < N; r++) {
      for (let c1 = 0; c1 < N; c1++) {
        const a = board[r * N + c1];
        if (!a || Math.floor((a - 1) / N) !== r) continue;
        for (let c2 = c1 + 1; c2 < N; c2++) {
          const b = board[r * N + c2];
          if (b && Math.floor((b - 1) / N) === r && a > b) lc += 2;
        }
      }
    }
    for (let c = 0; c < N; c++) {
      for (let r1 = 0; r1 < N; r1++) {
        const a = board[r1 * N + c];
        if (!a || (a - 1) % N !== c) continue;
        for (let r2 = r1 + 1; r2 < N; r2++) {
          const b = board[r2 * N + c];
          if (b && (b - 1) % N === c && a > b) lc += 2;
        }
      }
    }
    return lc;
  }

  function heuristic(board, N) {
    return manhattan(board, N) + linearConflict(board, N);
  }

  function now() {
    return root.performance && root.performance.now
      ? root.performance.now()
      : Date.now();
  }

  /* ---------------- 3x3: full distance table ---------------- */

  const FACT = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880];
  let table3 = null;

  function rank9(b) {
    let r = 0;
    for (let i = 0; i < 9; i++) {
      let smaller = 0;
      for (let j = i + 1; j < 9; j++) if (b[j] < b[i]) smaller++;
      r += smaller * FACT[8 - i];
    }
    return r;
  }

  function unrank9(r, out) {
    const avail = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    for (let i = 0; i < 9; i++) {
      const f = FACT[8 - i];
      const q = Math.floor(r / f);
      r -= q * f;
      out[i] = avail[q];
      avail.splice(q, 1);
    }
    return out;
  }

  function buildTable3() {
    if (table3) return table3;
    const dist = new Uint8Array(362880).fill(255);
    const queue = new Int32Array(181440);
    let head = 0,
      tail = 0;
    const start = rank9(solvedBoard(3));
    dist[start] = 0;
    queue[tail++] = start;
    const b = new Array(9);
    while (head < tail) {
      const r = queue[head++];
      unrank9(r, b);
      const z = b.indexOf(0);
      for (let d = 0; d < 4; d++) {
        const n = neighbor(z, d, 3);
        if (n < 0) continue;
        b[z] = b[n];
        b[n] = 0;
        const nr = rank9(b);
        if (dist[nr] === 255) {
          dist[nr] = dist[r] + 1;
          queue[tail++] = nr;
        }
        b[n] = b[z];
        b[z] = 0;
      }
    }
    table3 = dist;
    return dist;
  }

  function distance3(board) {
    return buildTable3()[rank9(board)];
  }

  function solve3(board) {
    const dist = buildTable3();
    const b = board.slice();
    const moves = [];
    let d = dist[rank9(b)];
    while (d > 0) {
      const z = b.indexOf(0);
      let stepped = false;
      for (let dir = 0; dir < 4 && !stepped; dir++) {
        const n = neighbor(z, dir, 3);
        if (n < 0) continue;
        b[z] = b[n];
        b[n] = 0;
        if (dist[rank9(b)] === d - 1) {
          moves.push(dir);
          d--;
          stepped = true;
        } else {
          b[n] = b[z];
          b[z] = 0;
        }
      }
      if (!stepped) throw new Error("3x3 table walk failed");
    }
    return moves;
  }

  function distribution3() {
    const dist = buildTable3();
    const counts = new Array(32).fill(0);
    for (let i = 0; i < dist.length; i++)
      if (dist[i] !== 255) counts[dist[i]]++;
    return counts;
  }

  /* ---------------- 4x4: additive 6-6-3 pattern databases ---------------- */

  // Disjoint tile groups. Each PDB counts only moves of its own tiles, so the sum is admissible.
  const GROUPS4 = [
    [1, 2, 5, 6, 9, 13],
    [3, 4, 7, 8, 11, 12],
    [10, 14, 15],
  ];
  const GROUP_OF = new Int8Array(16).fill(-1);
  const SLOT_OF = new Int8Array(16).fill(-1);
  GROUPS4.forEach((g, gi) =>
    g.forEach((t, si) => {
      GROUP_OF[t] = gi;
      SLOT_OF[t] = si;
    }),
  );

  // Mirror across the main diagonal. The goal is symmetric, so the mirrored position has the same
  // optimal length and gives a second admissible estimate.
  const T4 = new Uint8Array(16);
  for (let i = 0; i < 16; i++) T4[i] = (i % 4) * 4 + Math.floor(i / 4);
  const REFL = new Uint8Array(16);
  for (let t = 1; t < 16; t++) REFL[t] = T4[t - 1] + 1;

  function pdbSize(k) {
    let s = 1;
    for (let i = 0; i < k; i++) s *= 16 - i;
    return s;
  }

  // Compact rank of k distinct cells (ordered).
  function rankCells(cells, k) {
    let idx = 0;
    for (let i = 0; i < k; i++) {
      const p = cells[i];
      let r = p;
      for (let j = 0; j < i; j++) if (cells[j] < p) r--;
      idx = idx * (16 - i) + r;
    }
    return idx;
  }

  let PDB = null; // [Uint8Array, Uint8Array, Uint8Array]

  function setPDB(arrays) {
    PDB = arrays.map((a) => (a instanceof Uint8Array ? a : new Uint8Array(a)));
    for (let g = 0; g < 3; g++) {
      if (PDB[g].length !== pdbSize(GROUPS4[g].length))
        throw new Error("PDB " + g + " has the wrong size");
    }
  }
  // Load pdb0..2 from a base URL. Some static hosts refuse .bin, so the same bytes may sit under .wasm.
  async function fetchPDB(base) {
    const one = async (i) => {
      for (const ext of [".bin", ".wasm"]) {
        try {
          const r = await fetch(new URL("pdb" + i + ext, base));
          if (r.ok) return r.arrayBuffer();
        } catch (e) { /* try the next name */ }
      }
      throw new Error("Pattern database " + i + " could not be loaded");
    };
    setPDB(await Promise.all([0, 1, 2].map(one)));
  }
  function hasPDB() {
    return !!PDB;
  }

  // Search state for the 4x4 solver, reused across calls.
  const S = {
    board: new Uint8Array(16),
    pos: new Uint8Array(16),
    posR: new Uint8Array(16),
    blank: 0,
    hN: new Int32Array(3),
    hR: new Int32Array(3),
    cellsTmp: new Uint8Array(6),
    path: new Int8Array(256),
    nodes: 0,
    solLen: 0,
    bound: 0,
    nextBound: 0,
    deadline: Infinity,
    aborted: false,
  };

  function groupH(g, posArr) {
    const tiles = GROUPS4[g];
    const k = tiles.length;
    const c = S.cellsTmp;
    for (let i = 0; i < k; i++) c[i] = posArr[tiles[i]];
    return PDB[g][rankCells(c, k)];
  }

  function load4(board) {
    for (let i = 0; i < 16; i++) {
      const v = board[i];
      S.board[i] = v;
      if (v) {
        S.pos[v] = i;
        S.posR[REFL[v]] = T4[i];
      } else S.blank = i;
    }
    for (let g = 0; g < 3; g++) {
      S.hN[g] = groupH(g, S.pos);
      S.hR[g] = groupH(g, S.posR);
    }
  }

  function h4() {
    const a = S.hN[0] + S.hN[1] + S.hN[2];
    const b = S.hR[0] + S.hR[1] + S.hR[2];
    return a > b ? a : b;
  }

  function pdbHeuristic(board) {
    if (!PDB) return heuristic(board, 4);
    load4(board);
    return h4();
  }

  const NB4 = [];
  for (let c = 0; c < 16; c++)
    NB4.push([0, 1, 2, 3].map((d) => neighbor(c, d, 4)));

  function dfs4(g, prev) {
    S.nodes++;
    if ((S.nodes & 0x3ffff) === 0 && now() > S.deadline) {
      S.aborted = true;
      return false;
    }
    const h = h4();
    const f = g + h;
    if (f > S.bound) {
      if (f < S.nextBound) S.nextBound = f;
      return false;
    }
    if (h === 0) { S.solLen = g; return true; }
    const blank = S.blank;
    const nb = NB4[blank];
    for (let dir = 0; dir < 4; dir++) {
      if (dir === INV[prev]) continue;
      const n = nb[dir];
      if (n < 0) continue;
      const v = S.board[n];
      const gv = GROUP_OF[v];
      const w = REFL[v];
      const gw = GROUP_OF[w];
      const oldN = S.hN[gv],
        oldR = S.hR[gw];
      // slide tile v from n into the blank
      S.board[blank] = v;
      S.board[n] = 0;
      S.blank = n;
      S.pos[v] = blank;
      S.posR[w] = T4[blank];
      S.hN[gv] = groupH(gv, S.pos);
      S.hR[gw] = groupH(gw, S.posR);
      S.path[g] = dir;
      if (dfs4(g + 1, dir)) return true;
      S.board[n] = v;
      S.board[blank] = 0;
      S.blank = blank;
      S.pos[v] = n;
      S.posR[w] = T4[n];
      S.hN[gv] = oldN;
      S.hR[gw] = oldR;
      if (S.aborted) return false;
    }
    return false;
  }

  /**
   * Optimal 4x4 solve with IDA*.
   * opts.timeLimit ms (default Infinity), opts.onIteration(bound, nodes)
   * Returns {moves, optimal:true, nodes, ms} or {timeout:true, bound, nodes, ms}.
   */
  function solve4(board, opts) {
    opts = opts || {};
    if (!PDB) throw new Error("Pattern databases not loaded");
    const t0 = now();
    S.deadline = t0 + (opts.timeLimit == null ? Infinity : opts.timeLimit);
    S.aborted = false;
    S.nodes = 0;
    load4(board);
    S.bound = h4();
    while (true) {
      S.nextBound = 1e9;
      if (opts.onIteration) opts.onIteration(S.bound, S.nodes);
      load4(board);
      if (dfs4(0, -1)) {
        return {
          moves: Array.from(S.path.slice(0, S.bound)),
          optimal: true,
          nodes: S.nodes,
          ms: now() - t0,
        };
      }
      if (S.aborted)
        return {
          timeout: true,
          bound: S.bound,
          nodes: S.nodes,
          ms: now() - t0,
        };
      S.bound = S.nextBound;
    }
  }

  /**
   * Is there a solution of length <= bound? One IDA* iteration.
   * Returns true, false, or null on timeout.
   */
  function within4(board, bound, timeLimit) {
    if (bound < 0) return false;
    S.deadline = now() + (timeLimit == null ? Infinity : timeLimit);
    S.aborted = false;
    S.nodes = 0;
    load4(board);
    S.bound = bound;
    S.nextBound = 1e9;
    const found = dfs4(0, -1);
    if (S.aborted) return null;
    return found;
  }

  /* ---------------- staged solver for any size ---------------- */

  // Move a small group of tiles to their targets with BFS over (group positions + blank).
  // Locked cells are never entered. Other tiles are interchangeable.
  function placeGroup(board, N, group, locked) {
    const L = N * N;
    const k = group.length;
    const targets = group.map((t) => t - 1);
    const startCells = group.map((t) => board.indexOf(t));
    const startBlank = board.indexOf(0);
    const done = (cells) => cells.every((c, i) => c === targets[i]);
    if (done(startCells)) return [];
    const encode = (cells, blank) => {
      let key = blank;
      for (let i = 0; i < k; i++) key = key * L + cells[i];
      return key;
    };
    const startKey = encode(startCells, startBlank);
    const parent = new Map();
    parent.set(startKey, -1);
    let frontier = [[startCells, startBlank]];
    let goalKey = -1,
      goalCells = null;
    while (frontier.length && goalKey < 0) {
      const next = [];
      for (const [cells, blank] of frontier) {
        const key = encode(cells, blank);
        for (let dir = 0; dir < 4; dir++) {
          const n = neighbor(blank, dir, N);
          if (n < 0 || locked[n]) continue;
          const nc = cells.slice();
          const idx = nc.indexOf(n);
          if (idx >= 0) nc[idx] = blank;
          const nk = encode(nc, n);
          if (parent.has(nk)) continue;
          parent.set(nk, key * 4 + dir);
          if (done(nc)) {
            goalKey = nk;
            goalCells = nc;
            break;
          }
          next.push([nc, n]);
        }
        if (goalKey >= 0) break;
      }
      frontier = next;
    }
    if (goalKey < 0)
      throw new Error("Could not place tiles " + group.join(","));
    const moves = [];
    let key = goalKey;
    while (true) {
      const p = parent.get(key);
      if (p === -1) break;
      moves.push(p % 4);
      key = Math.floor(p / 4);
    }
    moves.reverse();
    for (const m of moves) applyMove(board, N, m);
    return moves;
  }

  function lineGroups(tiles) {
    // pairs, with the last two always together (the corner tiles need each other)
    const groups = [];
    let i = 0;
    if (tiles.length % 2 === 1) {
      groups.push([tiles[0]]);
      i = 1;
    }
    for (; i < tiles.length; i += 2) groups.push([tiles[i], tiles[i + 1]]);
    return groups;
  }

  function extractRegion(board, N, r0, m) {
    const sub = [];
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        const v = board[(r0 + i) * N + (r0 + j)];
        if (!v) {
          sub.push(0);
          continue;
        }
        const gr = Math.floor((v - 1) / N) - r0,
          gc = ((v - 1) % N) - r0;
        sub.push(gr * m + gc + 1);
      }
    }
    return sub;
  }

  /**
   * Solve any NxN. Uses the optimal 3x3 table or the 4x4 PDB solver for the last region.
   * opts.timeLimit applies to the 4x4 optimal attempt; on timeout the 4x4 is staged too.
   */
  function solveStaged(board, N, opts) {
    opts = opts || {};
    const b = board.slice();
    const locked = new Uint8Array(N * N);
    const moves = [];
    let r0 = 0;
    let finalOptimal = false;
    while (N - r0 > 3) {
      const m = N - r0;
      if (m === 4 && PDB && opts.useOptimalCore !== false) {
        const sub = extractRegion(b, N, r0, 4);
        const res = solve4(sub, {
          timeLimit: opts.timeLimit == null ? 3000 : opts.timeLimit,
        });
        if (!res.timeout) {
          for (const mv of res.moves) {
            applyMove(b, N, mv);
            moves.push(mv);
          }
          finalOptimal = r0 === 0;
          r0 = N;
          break;
        }
      }
      const rowTiles = [],
        colTiles = [];
      for (let c = r0; c < N; c++) rowTiles.push(r0 * N + c + 1);
      for (let r = r0 + 1; r < N; r++) colTiles.push(r * N + r0 + 1);
      for (const g of lineGroups(rowTiles)) {
        moves.push(...placeGroup(b, N, g, locked));
        for (const t of g) locked[t - 1] = 1;
      }
      for (const g of lineGroups(colTiles)) {
        moves.push(...placeGroup(b, N, g, locked));
        for (const t of g) locked[t - 1] = 1;
      }
      r0++;
    }
    if (r0 < N && N - r0 === 3) {
      const sub = extractRegion(b, N, r0, 3);
      for (const mv of solve3(sub)) {
        applyMove(b, N, mv);
        moves.push(mv);
      }
      if (N === 3) finalOptimal = true;
    }
    if (!isSolved(b)) throw new Error("Staged solve did not finish");
    return {
      moves: finalOptimal ? moves : simplifyMoves(moves),
      optimal: finalOptimal,
    };
  }

  /**
   * Best available solve.
   * 3x3: exact. 4x4: IDA* within opts.timeLimit, else staged. 5x5+: staged with an optimal 4x4 core.
   */
  function solve(board, N, opts) {
    opts = opts || {};
    const t0 = now();
    if (isSolved(board)) return { moves: [], optimal: true, ms: 0 };
    if (N === 3) return { moves: solve3(board), optimal: true, ms: now() - t0 };
    if (N === 4 && PDB) {
      const res = solve4(board, {
        timeLimit: opts.timeLimit,
        onIteration: opts.onIteration,
      });
      if (!res.timeout) return res;
      const st = solveStaged(board, N, { timeLimit: 0, useOptimalCore: false });
      return {
        moves: st.moves,
        optimal: false,
        lowerBound: res.bound,
        ms: now() - t0,
      };
    }
    const st = solveStaged(board, N, {
      timeLimit: opts.coreTimeLimit == null ? 1500 : opts.coreTimeLimit,
    });
    return { moves: st.moves, optimal: N === 3, ms: now() - t0 };
  }

  /* ---------------- formatting ---------------- */

  // Moves written as the direction the tile travels, run-length compressed: "R3 D L2"
  function formatMoves(moves, compact) {
    if (!compact) return moves.map((m) => TILE_CHARS[m]).join("");
    const out = [];
    for (let i = 0; i < moves.length;) {
      let j = i;
      while (j < moves.length && moves[j] === moves[i]) j++;
      const n = j - i;
      out.push(TILE_CHARS[moves[i]] + (n > 1 ? n : ""));
      i = j;
    }
    return out.join(" ");
  }

  function parseBoard(text, N) {
    const nums = String(text)
      .trim()
      .split(/[^0-9]+/)
      .filter(Boolean)
      .map(Number);
    if (N == null) {
      N = Math.round(Math.sqrt(nums.length));
      if (N * N !== nums.length) return null;
    }
    if (nums.length !== N * N) return null;
    return { board: nums, N };
  }

  const api = {
    DR,
    DC,
    INV,
    DIR_CHARS,
    TILE_CHARS,
    GROUPS4,
    hashSeed,
    rngFromSeed,
    randomSeed,
    solvedBoard,
    isSolved,
    isSolvable,
    permutationParity,
    scrambleFromSeed,
    neighbor,
    applyMove,
    applyMoves,
    simplifyMoves,
    manhattan,
    linearConflict,
    heuristic,
    pdbHeuristic,
    buildTable3,
    distance3,
    solve3,
    distribution3,
    pdbSize,
    rankCells,
    setPDB,
    fetchPDB,
    hasPDB,
    solve4,
    within4,
    placeGroup,
    solveStaged,
    solve,
    formatMoves,
    parseBoard,
  };

  root.FifteenEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
