// 1v1: two players, one room code, the same scramble, a running score.
// The two apps talk straight to each other over WebRTC. The public PeerJS broker only introduces them,
// so there is no server of ours, no account and nothing stored anywhere but this device.
import { h, clear, toast, seg, copyText } from "../ui.js";
import { Game } from "../game.js";
import { BoardView } from "../board-view.js";
import { fmtTime } from "../stats.js";
import * as audio from "../audio.js";

const E = window.FifteenEngine;

// the link a friend can open in any browser (the desktop app has no web address of its own)
const INVITE_BASE = "https://claudemaxforeveryone-hue.github.io/fifteen-press/";
const ID_PREFIX = "fifteen-press-1v1-";
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0 O 1 I L
const CODE_LEN = 5;
const LEAD = 3000; // countdown before the board shows
const RECORD_KEY = "fifteen.versus.v1";
const PROTOCOL = 1;
const CHATTER = new Set(["hb", "p", "ack", "ping", "pong"]); // fine to lose one of these
const RESEND = 600; // an unconfirmed message goes out again after this long
const BEAT = 2000; // each side says "still here" this often
const SILENCE = 12000; // and gives up on a line that has been quiet this long

// one id per tab, kept across a reload, so a friend who drops can take their seat back
function clientId() {
  try {
    let id = sessionStorage.getItem("fifteen.versus.cid");
    if (!id) {
      id = makeCode() + makeCode();
      sessionStorage.setItem("fifteen.versus.cid", id);
    }
    return id;
  } catch (e) {
    return (clientId.temp = clientId.temp || makeCode() + makeCode());
  }
}

const KEYMAP = {
  tile: { ArrowLeft: 3, ArrowRight: 2, ArrowUp: 1, ArrowDown: 0, a: 3, d: 2, w: 1, s: 0 },
  blank: { ArrowLeft: 2, ArrowRight: 3, ArrowUp: 0, ArrowDown: 1, a: 2, d: 3, w: 0, s: 1 },
};

let peerLib = null;
function loadPeer() {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (!peerLib)
    peerLib = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "js/vendor/peerjs.min.js";
      s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error("PeerJS did not load")));
      s.onerror = () => {
        peerLib = null;
        reject(new Error("PeerJS did not load"));
      };
      document.head.appendChild(s);
    });
  return peerLib;
}

// a test can point the handshake at its own broker: localStorage "fifteen.versus.broker" = {host, port, path, secure}
function brokerOptions() {
  try {
    const raw = localStorage.getItem("fifteen.versus.broker");
    if (raw) return JSON.parse(raw);
  } catch (e) {
    /* default broker */
  }
  return {};
}

function makeCode() {
  let out = "";
  const buf = new Uint32Array(CODE_LEN);
  crypto.getRandomValues(buf);
  for (let i = 0; i < CODE_LEN; i++) out += CODE_CHARS[buf[i] % CODE_CHARS.length];
  return out;
}
function cleanCode(text) {
  // a pasted invite link works as well as the bare code
  const m = /versus\/([A-Za-z0-9]+)/.exec(String(text || ""));
  return (m ? m[1] : String(text || "")).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}
function isBoard(b, N) {
  if (!Array.isArray(b) || b.length !== N * N) return false;
  const seen = new Set(b);
  if (seen.size !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (!seen.has(i)) return false;
  return true;
}
function cleanName(text) {
  return String(text || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 20);
}

function loadRecord() {
  try {
    return JSON.parse(localStorage.getItem(RECORD_KEY)) || {};
  } catch (e) {
    return {};
  }
}
function saveRecord(rec) {
  try {
    localStorage.setItem(RECORD_KEY, JSON.stringify(rec));
  } catch (e) {
    /* private window: the score for this sitting still shows */
  }
}

export class VersusView {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.store = ctx.store;
    this.phase = "lobby"; // lobby | opening | waiting | idle | countdown | racing
    this.role = null; // host | guest
    this.code = "";
    this.peer = null;
    this.conn = null;
    this.N = 4;
    this.myName = "";
    this.oppName = "";
    this.score = { me: 0, opp: 0 };
    this.rounds = [];
    this.round = null;
    this.readyMe = false;
    this.readyOpp = false;
    this.rtt = 0;
    this.note = "";
    this.raf = 0;
    this.timers = new Set();
    window.addEventListener("beforeunload", () => this.teardown(true));
    // a mouse click should not leave a button holding the keyboard: Space is "ready" here
    root.addEventListener("click", (e) => {
      const b = e.target.closest && e.target.closest("button");
      if (b && e.detail > 0) b.blur();
    });
    this.render();
  }

  get s() {
    return this.store.settings;
  }

  /* ---------- router hooks ---------- */

  show(params) {
    const code = cleanCode(params);
    if (code && this.phase === "lobby") {
      this.pendingCode = code;
      this.render();
      this.join(code);
    } else if (!this.root.childElementCount) this.render();
  }

  hide() {
    /* a room stays open while you look at another page */
  }

  onStore(e) {
    if (e.type !== "settings" && e.type !== "all") return;
    if (this.view) this.view.setColoring(this.s.coloring);
    if (this.oppView) this.oppView.setColoring(this.s.coloring);
  }

  /* ---------- small helpers ---------- */

  later(fn, ms) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
    return id;
  }
  clearTimers() {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    cancelAnimationFrame(this.raf);
  }
  // Everything but the chatter (heartbeats, live board updates) is numbered, acknowledged and sent again until
  // the other side confirms it. A message sent in the first instant of a connection can go missing otherwise.
  send(msg) {
    const conn = this.conn;
    if (!conn || !conn.open) return;
    if (!CHATTER.has(msg.t)) {
      const link = conn.fifteen || (conn.fifteen = { seq: 0, unacked: new Map(), seen: new Set() });
      msg.q = ++link.seq;
      link.unacked.set(msg.q, { msg, at: performance.now() });
    }
    this.raw(conn, msg);
  }
  raw(conn, msg) {
    try {
      conn.send(msg);
    } catch (e) {
      /* the close event follows */
    }
  }
  resend() {
    const conn = this.conn;
    if (!conn || !conn.open || !conn.fifteen) return;
    const now = performance.now();
    for (const item of conn.fifteen.unacked.values())
      if (now - item.at > RESEND) {
        item.at = now;
        this.raw(conn, item.msg);
      }
  }
  defaultName() {
    let saved = "";
    try {
      saved = localStorage.getItem("fifteen.versus.name") || "";
    } catch (e) {
      /* no storage */
    }
    const p = this.store.profile && this.store.profile();
    return cleanName(saved || (p && p.name) || "Player") || "Player";
  }
  readName() {
    const typed = this.nameInput ? cleanName(this.nameInput.value) : "";
    this.myName = typed || this.defaultName();
    try {
      localStorage.setItem("fifteen.versus.name", this.myName);
    } catch (e) {
      /* no storage */
    }
  }
  inviteLink() {
    return INVITE_BASE + "#versus/" + this.code;
  }

  /* ---------- lobby ---------- */

  render() {
    if (this.phase === "lobby" || this.phase === "opening") this.renderLobby();
    else this.renderRoom();
  }

  renderLobby() {
    clear(this.root);
    this.view = this.oppView = null;
    const busy = this.phase === "opening";
    this.nameInput = h("input", { type: "text", maxlength: 20, value: this.myName || this.defaultName(), "aria-label": "Your name", autocomplete: "off", spellcheck: false });
    this.codeInput = h("input", {
      type: "text",
      class: "vs-code-input",
      maxlength: 80,
      placeholder: "room code",
      value: this.pendingCode || "",
      "aria-label": "Room code",
      autocomplete: "off",
      spellcheck: false,
      onkeydown: (e) => {
        if (e.key === "Enter") this.join(this.codeInput.value);
      },
    });
    const rec = loadRecord();
    const rivals = Object.entries(rec)
      .sort((a, b) => (b[1].last || 0) - (a[1].last || 0))
      .slice(0, 8);
    this.root.append(
      h(
        "div",
        { class: "vs-lobby" },
        h("div", { class: "page-head" }, h("div", null, h("div", { class: "label" }, "1v1"), h("h1", { class: "sub-title" }, "Race a friend on the same scramble"))),
        h("p", { class: "hint-text vs-lede" }, "One of you makes a room and sends the code. The board stays hidden through a 3 second countdown, then you both get the same scramble. Fastest solve takes the round."),
        h("label", { class: "field vs-field" }, h("span", null, "your name"), this.nameInput),
        h(
          "div",
          { class: "vs-choices" },
          h(
            "div",
            { class: "vs-choice" },
            h("div", { class: "label" }, "start a room"),
            h(
              "div",
              { class: "row" },
              seg(
                [3, 4, 5].map((n) => ({ value: n, label: `${n}x${n}` })),
                this.N,
                (n) => (this.N = n),
                "Board size",
              ),
            ),
            h("div", { class: "row" }, h("button", { class: "btn btn--primary", type: "button", disabled: busy, onclick: () => this.host() }, "Create room")),
          ),
          h(
            "div",
            { class: "vs-choice" },
            h("div", { class: "label" }, "join a friend"),
            h("div", { class: "row" }, this.codeInput),
            h("div", { class: "row" }, h("button", { class: "btn", type: "button", disabled: busy, onclick: () => this.join(this.codeInput.value) }, "Join")),
          ),
        ),
        (this.lobbyNote = h("p", { class: "vs-note", role: "status" }, this.note || (busy ? "Connecting…" : ""))),
        rivals.length
          ? h(
              "div",
              { class: "panel vs-rivals" },
              h("div", { class: "label" }, "all time on this device"),
              h(
                "table",
                { class: "ledger" },
                h("thead", null, h("tr", null, h("th", null, "against"), h("th", { class: "tnum" }, "won"), h("th", { class: "tnum" }, "lost"), h("th", { class: "tnum" }, "drawn"), h("th", { class: "tnum" }, "best"))),
                h(
                  "tbody",
                  null,
                  rivals.map(([name, r]) =>
                    h("tr", null, h("td", null, name), h("td", { class: "tnum" }, r.w || 0), h("td", { class: "tnum" }, r.l || 0), h("td", { class: "tnum" }, r.d || 0), h("td", { class: "tnum" }, r.best ? fmtTime(r.best) : "")),
                  ),
                ),
              ),
            )
          : null,
      ),
    );
  }

  setNote(text) {
    this.note = text || "";
    if (this.lobbyNote && (this.phase === "lobby" || this.phase === "opening")) this.lobbyNote.textContent = this.note || (this.phase === "opening" ? "Connecting…" : "");
    if (this.statusEl && this.phase !== "lobby" && this.phase !== "opening") this.refresh();
  }

  /* ---------- connecting ---------- */

  async host() {
    if (this.phase !== "lobby") return;
    this.readName();
    this.role = "host";
    this.phase = "opening";
    this.note = "";
    this.render();
    try {
      await loadPeer();
    } catch (e) {
      return this.fail("Could not load the connection code. Check your internet and try again.");
    }
    this.openHostPeer(0);
  }

  openHostPeer(tries) {
    this.code = makeCode();
    const peer = new window.Peer(ID_PREFIX + this.code, brokerOptions());
    this.peer = peer;
    peer.on("open", () => {
      if (this.peer !== peer) return;
      this.phase = "waiting";
      this.note = "";
      this.render();
    });
    peer.on("connection", (conn) => {
      if (this.peer !== peer) return;
      const cid = conn.metadata && conn.metadata.cid;
      const same = cid && cid === this.oppCid;
      const quiet = performance.now() - (this.lastSeen || 0) > 5000;
      if (this.conn && this.conn.open && !same && !quiet) {
        // a room holds two
        conn.on("open", () => {
          const say = () => this.raw(conn, { t: "full" });
          say();
          setTimeout(say, 300);
          setTimeout(say, 700);
          setTimeout(() => conn.close(), 1200);
        });
        return;
      }
      const old = this.conn;
      if (this.oppCid && cid !== this.oppCid) {
        // somebody new sat down: a fresh score sheet
        this.score = { me: 0, opp: 0 };
        this.rounds = [];
      }
      this.oppCid = cid || "";
      this.adopt(conn);
      if (old) {
        try {
          old.close();
        } catch (e) {
          /* already gone */
        }
      }
    });
    peer.on("error", (err) => {
      if (this.peer !== peer) return;
      if (err && err.type === "unavailable-id" && tries < 4) {
        peer.destroy();
        this.openHostPeer(tries + 1);
        return;
      }
      this.peerError(err);
    });
    peer.on("disconnected", () => this.brokerLost(peer));
  }

  async join(text) {
    if (this.phase !== "lobby") return;
    const code = cleanCode(text);
    if (code.length < 4) {
      this.setNote("Type the room code your friend sent.");
      return;
    }
    this.readName();
    this.role = "guest";
    this.code = code;
    this.pendingCode = code;
    this.phase = "opening";
    this.note = "";
    this.render();
    try {
      await loadPeer();
    } catch (e) {
      return this.fail("Could not load the connection code. Check your internet and try again.");
    }
    const peer = new window.Peer(brokerOptions());
    this.peer = peer;
    peer.on("open", () => {
      if (this.peer !== peer) return;
      this.dial();
    });
    peer.on("error", (err) => {
      if (this.peer !== peer) return;
      if (err && err.type === "peer-unavailable") {
        if (this.redialing) return; // the host may still be coming back
        return this.fail(`No open room with the code ${this.code}. Check it with your friend.`);
      }
      this.peerError(err);
    });
    peer.on("disconnected", () => this.brokerLost(peer));
  }

  dial() {
    if (!this.peer || this.peer.destroyed) return;
    const conn = this.peer.connect(ID_PREFIX + this.code, { reliable: true, serialization: "json", metadata: { cid: clientId() } });
    this.adopt(conn);
    const peer = this.peer;
    this.later(() => {
      if (this.peer === peer && this.phase === "opening" && !(this.conn && this.conn.open)) this.fail("Could not reach that room. Check the code, or ask your friend to make a new one.");
    }, 15000);
  }

  adopt(conn) {
    this.conn = conn;
    conn.on("open", () => {
      if (this.conn !== conn) return;
      this.redialing = false;
      this.redials = 0;
      this.lastSeen = performance.now();
      this.startBeat();
      this.send({ t: "hello", v: PROTOCOL, name: this.myName, N: this.N, score: this.role === "host" ? { host: this.score.me, guest: this.score.opp } : null });
      if (this.role === "host") this.send({ t: "ping", ts: performance.now() });
    });
    conn.on("data", (msg) => {
      if (this.conn !== conn || !msg || typeof msg !== "object") return;
      this.lastSeen = performance.now();
      const link = conn.fifteen || (conn.fifteen = { seq: 0, unacked: new Map(), seen: new Set() });
      if (msg.t === "ack") {
        link.unacked.delete(msg.q);
        return;
      }
      if (msg.q) {
        this.raw(conn, { t: "ack", q: msg.q });
        if (link.seen.has(msg.q)) return; // a repeat of one we already have
        link.seen.add(msg.q);
      }
      try {
        this.onData(msg);
      } catch (e) {
        console.error("1v1 message", e);
      }
    });
    conn.on("close", () => {
      if (this.conn !== conn) return;
      this.lostFriend();
    });
    conn.on("error", () => {
      /* close follows */
    });
  }

  startBeat() {
    clearInterval(this.beat);
    let last = 0;
    this.beat = setInterval(() => {
      const conn = this.conn;
      if (!conn || !conn.open) return;
      this.resend();
      // by the clock, not by counting ticks: a hidden tab only ticks once a second
      if (performance.now() - last < BEAT) return;
      last = performance.now();
      this.send({ t: "hb" });
      if (this.role === "host") this.send({ t: "ping", ts: performance.now() });
      if (performance.now() - this.lastSeen > SILENCE) {
        // nothing for a while: the other side closed a laptop or lost its network
        this.conn = null;
        try {
          conn.close();
        } catch (e) {
          /* already gone */
        }
        this.lostFriend();
      }
    }, BEAT / 10);
  }

  brokerLost(peer) {
    // the handshake server dropped: an open game carries on, and we ask to be listed again
    if (this.peer !== peer || peer.destroyed) return;
    setTimeout(() => {
      if (this.peer === peer && !peer.destroyed && peer.disconnected) {
        try {
          peer.reconnect();
        } catch (e) {
          /* tried */
        }
      }
    }, 1500);
  }

  peerError(err) {
    const type = (err && err.type) || "";
    if (this.conn && this.conn.open) return; // the game itself is fine
    if (type === "browser-incompatible") return this.fail("This browser cannot open a live connection. Try Chrome, Edge, Firefox or Safari.");
    if (this.phase === "opening") return this.fail("Could not connect. Check your internet and try again.");
    this.setNote("Connection trouble. Trying again…");
  }

  fail(text) {
    this.teardown();
    this.phase = "lobby";
    this.role = null;
    this.oppName = "";
    this.oppCid = "";
    this.score = { me: 0, opp: 0 };
    this.rounds = [];
    this.readyMe = this.readyOpp = false;
    this.note = text;
    this.render();
  }

  lostFriend() {
    this.conn = null;
    this.abortRound();
    this.readyMe = this.readyOpp = false;
    if (this.phase === "lobby" || this.phase === "opening") return;
    this.phase = "waiting";
    if (this.role === "guest" && !this.leftOnPurpose) {
      this.redialing = true;
      this.redials = 0;
      this.note = "Lost the connection. Trying to get back in…";
      this.redial();
    } else this.note = this.oppName ? `${this.oppName} dropped out. The room is still open with the same code.` : "";
    this.render();
  }

  redial() {
    if (!this.redialing || this.role !== "guest" || !this.peer || this.peer.destroyed) return;
    if (this.redials >= 8) {
      this.redialing = false;
      return this.fail("The room closed.");
    }
    this.redials++;
    if (this.peer.disconnected) {
      try {
        this.peer.reconnect();
      } catch (e) {
        /* tried */
      }
    }
    const conn = this.peer.connect(ID_PREFIX + this.code, { reliable: true, serialization: "json", metadata: { cid: clientId() } });
    this.adopt(conn);
    this.later(() => {
      if (this.redialing && !(this.conn && this.conn.open)) this.redial();
    }, 2500);
  }

  teardown(silent) {
    this.clearTimers();
    clearInterval(this.beat);
    this.redialing = false;
    if (this.conn && this.conn.open) {
      try {
        this.conn.send({ t: "bye" });
      } catch (e) {
        /* closing anyway */
      }
    }
    const peer = this.peer;
    this.peer = null;
    this.conn = null;
    if (peer) {
      // give the goodbye a moment to leave
      if (silent) peer.destroy();
      else setTimeout(() => peer.destroy(), 150);
    }
    this.round = null;
    this.game = null;
  }

  leave() {
    this.leftOnPurpose = true;
    this.teardown();
    this.leftOnPurpose = false;
    this.phase = "lobby";
    this.role = null;
    this.code = "";
    this.pendingCode = "";
    this.oppName = "";
    this.oppCid = "";
    this.score = { me: 0, opp: 0 };
    this.rounds = [];
    this.readyMe = this.readyOpp = false;
    this.note = "";
    if (location.hash.startsWith("#versus/")) history.replaceState(null, "", "#versus");
    this.render();
  }

  /* ---------- messages ---------- */

  onData(msg) {
    switch (msg.t) {
      case "hello": {
        this.oppName = cleanName(msg.name) || "Friend";
        if (this.oppName === this.myName) this.oppName += " (2)";
        if (this.role === "guest") {
          if ([3, 4, 5].includes(msg.N)) this.N = msg.N;
          if (msg.score) this.score = { me: msg.score.guest | 0, opp: msg.score.host | 0 };
        }
        this.abortRound();
        this.round = null;
        this.game = null;
        this.readyMe = this.readyOpp = false;
        this.phase = "idle";
        this.note = "";
        this.render();
        audio.thunk();
        break;
      }
      case "hb":
        break;
      case "ping":
        this.send({ t: "pong", ts: msg.ts });
        break;
      case "pong":
        if (typeof msg.ts === "number") this.rtt = Math.max(0, Math.min(1500, performance.now() - msg.ts));
        break;
      case "cfg":
        if (this.role === "guest" && [3, 4, 5].includes(msg.N) && this.phase === "idle") {
          this.N = msg.N;
          this.readyMe = this.readyOpp = false;
          this.round = null;
          this.game = null;
          this.showIdleBoards();
          this.refresh();
        }
        break;
      case "ready":
        this.readyOpp = true;
        this.refresh();
        this.maybeStart();
        break;
      case "start":
        if (this.role === "guest" && typeof msg.seed === "string" && /^[A-Za-z0-9]{1,32}$/.test(msg.seed) && [3, 4, 5].includes(msg.N)) this.beginCountdown(msg.seed, msg.N, msg.n | 0, LEAD);
        break;
      case "p": {
        const r = this.round;
        if (!r || msg.n !== r.n || !isBoard(msg.b, r.N)) break;
        r.opp.moves = msg.m | 0;
        if (this.oppView && this.phase !== "countdown") this.oppView.set(msg.b, r.N);
        this.refreshOpp();
        break;
      }
      case "done": {
        const r = this.round;
        if (!r || msg.n !== r.n || r.opp.status !== "solving" || !(msg.ms > 0)) break;
        r.opp.status = "done";
        r.opp.ms = Number(msg.ms);
        r.opp.moves = msg.m | 0;
        if (this.oppView) this.oppView.set(E.solvedBoard(r.N), r.N);
        this.checkPassed();
        this.decide();
        this.refresh();
        break;
      }
      case "passed": {
        const r = this.round;
        if (!r || msg.n !== r.n) break;
        r.opp.passed = true;
        this.decide();
        this.refresh();
        break;
      }
      case "dnf": {
        const r = this.round;
        if (!r || msg.n !== r.n || r.opp.status !== "solving") break;
        r.opp.status = "dnf";
        this.decide();
        this.refresh();
        break;
      }
      case "result": {
        const r = this.round;
        if (this.role !== "guest" || !r || msg.n !== r.n || r.winner) break;
        const w = msg.w === "guest" ? "me" : msg.w === "host" ? "opp" : "draw";
        this.applyResult(w, msg.score ? { me: msg.score.guest | 0, opp: msg.score.host | 0 } : null);
        break;
      }
      case "score":
        if (this.role === "guest" && msg.score) {
          this.score = { me: msg.score.guest | 0, opp: msg.score.host | 0 };
          this.rounds = [];
          this.round = null;
          this.game = null;
          this.showIdleBoards();
          this.refresh();
        }
        break;
      case "full":
        this.fail("That room already has two players.");
        break;
      case "bye":
        if (this.role === "guest") this.fail(`${this.oppName || "Your friend"} closed the room.`);
        else {
          const conn = this.conn;
          this.conn = null;
          if (conn) conn.close();
          this.lostFriend();
        }
        break;
    }
  }

  /* ---------- the room ---------- */

  renderRoom() {
    clear(this.root);
    this.timeEl = h("div", { class: "figure tnum timer" }, "0.00");
    this.movesEl = h("div", { class: "figure tnum" }, "0");
    this.boardWrap = h("div", { class: "board-wrap vs-board" });
    this.view = new BoardView(this.boardWrap, {
      interactive: true,
      onCell: (cell, e) => {
        if (e.pointerType !== "mouse" || this.s.mouseMode !== "hover") this.moveCell(cell);
      },
      onHover: (cell) => {
        if (this.s.mouseMode === "hover") this.moveCell(cell);
      },
      label: "Your board. Use the arrow keys to slide tiles.",
    });
    this.view.setColoring(this.s.coloring);
    this.countEl = h("div", { class: "vs-count", "aria-live": "assertive", hidden: true });
    this.boardWrap.appendChild(this.countEl);

    this.oppWrap = h("div", { class: "vs-opp-board" });
    this.oppView = new BoardView(this.oppWrap, { small: true, label: "Your friend's board" });
    this.oppView.setColoring(this.s.coloring);

    this.scoreEl = h("div", { class: "vs-score" });
    this.statusEl = h("p", { class: "vs-status", role: "status" });
    this.inviteEl = h("div", { class: "vs-invite", hidden: true });
    this.readyBtn = h("button", { class: "btn btn--primary", type: "button", onclick: () => this.pressReady() }, "Ready");
    this.giveBtn = h("button", { class: "btn btn--ghost", type: "button", hidden: true, onclick: () => this.giveUp() }, "Give up");
    this.oppNameEl = h("div", { class: "label" });
    this.oppStateEl = h("div", { class: "vs-opp-state tnum" });
    this.sizeRow = h("div", { class: "row vs-size" });
    this.historyEl = h("div", { class: "vs-history" });
    this.roomEl = h("div", { class: "vs-roomline" });

    this.root.append(
      (this.roomRoot = h(
        "div",
        { class: "vs-room" },
        h("div", { class: "vs-top" }, this.scoreEl, this.roomEl),
        h(
          "div",
          { class: "vs-grid" },
          h(
            "div",
            { class: "vs-main" },
            h(
              "div",
              { class: "ticket vs-ticket" },
              h("div", { class: "stat" }, h("div", { class: "label" }, "time"), this.timeEl),
              h("div", { class: "stat" }, h("div", { class: "label" }, "moves"), this.movesEl),
            ),
            this.boardWrap,
            this.inviteEl,
            this.statusEl,
            h("div", { class: "row vs-actions" }, this.readyBtn, this.giveBtn),
          ),
          h(
            "aside",
            { class: "vs-side" },
            h("div", { class: "vs-opp" }, this.oppNameEl, this.oppWrap, this.oppStateEl),
            this.sizeRow,
            this.historyEl,
          ),
        ),
      )),
    );
    this.showIdleBoards();
    this.refresh();
  }

  showIdleBoards() {
    if (!this.view) return;
    const r = this.round;
    if (r && this.game) {
      this.view.set(this.game.board, r.N, { instant: true });
      return;
    }
    const solved = E.solvedBoard(this.N);
    this.view.clearProofed();
    this.view.set(solved, this.N, { instant: true });
    this.view.setHidden(false);
    this.oppView.set(solved, this.N, { instant: true });
    this.oppView.setHidden(false);
  }

  refresh() {
    if (!this.statusEl || this.phase === "lobby" || this.phase === "opening") return;
    const opp = this.oppName || "Friend";
    const r = this.round;
    const linked = !!(this.conn && this.conn.open);

    // score line
    clear(this.scoreEl).append(
      h("span", { class: "vs-who" }, this.myName),
      h("span", { class: "vs-points tnum" }, h("b", { class: this.score.me > this.score.opp ? "is-up" : null }, this.score.me), h("i", null, ":"), h("b", { class: this.score.opp > this.score.me ? "is-up" : null }, this.score.opp)),
      h("span", { class: "vs-who" }, linked || this.oppName ? opp : "waiting"),
    );

    // room line
    clear(this.roomEl).append(
      h("span", { class: "label" }, "room"),
      h("button", { class: "vs-codechip", type: "button", title: "copy the invite link", onclick: () => this.copyInvite() }, this.code),
      this.role === "host" && this.rounds.length ? h("button", { class: "btn btn--ghost btn--small", type: "button", disabled: this.phase !== "idle", onclick: () => this.resetScore() }, "Reset score") : null,
      h("button", { class: "btn btn--ghost btn--small", type: "button", onclick: () => this.leave() }, "Leave"),
    );

    // headline
    let text = "";
    let tone = "";
    if (this.phase === "waiting") {
      text = this.note || (this.role === "host" ? "Send your friend the code or the link. The race starts when you are both ready." : "Connecting to the room…");
    } else if (this.phase === "countdown") {
      text = "Same scramble for both of you. Get ready.";
    } else if (this.phase === "racing" && r) {
      if (r.me.status === "solving") {
        if (r.winner === "opp") {
          text = `${opp} took this one in ${fmtTime(r.opp.ms)}. Finish for your time, or give up.`;
          tone = "bad";
        } else if (r.winner === "me") {
          text = `${opp} gave up. The round is yours. Finish for your time, or give up.`;
          tone = "good";
        } else text = "Go.";
      } else if (!r.winner) text = r.me.status === "done" ? `Done in ${fmtTime(r.me.ms)}. Waiting on ${opp}…` : `Waiting on ${opp}…`;
    } else if (this.phase === "idle") {
      if (r && r.winner) {
        const me = r.me,
          them = r.opp;
        const mine = fmtTime(me.ms),
          theirs = fmtTime(them.ms);
        if (r.winner === "me") {
          tone = "good";
          if (me.status === "done" && them.status === "done") text = `You win the round, ${mine} to ${theirs}.`;
          else if (me.status === "done") text = them.status === "dnf" ? `You win the round with ${mine}. ${opp} gave up.` : `You win the round with ${mine}.`;
          else text = `You win the round. ${opp} gave up first.`;
        } else if (r.winner === "opp") {
          tone = "bad";
          if (me.status === "done" && them.status === "done") text = `${opp} wins the round, ${theirs} to your ${mine}.`;
          else if (them.status === "done") text = `${opp} wins the round with ${theirs}.`;
          else text = `${opp} wins the round. You gave up first.`;
        } else text = me.status === "done" ? `Dead even at ${mine}. No point.` : "Nobody finished. No point.";
        if (this.readyMe && !this.readyOpp) text += ` Waiting on ${opp}.`;
        else if (!this.readyMe && this.readyOpp) text += ` ${opp} is ready.`;
      } else if (this.readyMe && !this.readyOpp) text = `You are ready. Waiting on ${opp}.`;
      else if (!this.readyMe && this.readyOpp) text = `${opp} is ready. Press Space when you are.`;
      else text = `${opp} is in. Press Space when you are ready.`;
    }
    this.statusEl.textContent = text;
    this.statusEl.dataset.tone = tone;
    this.roomRoot.classList.toggle("is-inviting", this.phase === "waiting" && this.role === "host");

    // the code, large, while the room waits for its second player
    const inviting = this.phase === "waiting" && this.role === "host";
    this.inviteEl.hidden = !inviting;
    clear(this.inviteEl);
    if (inviting)
      this.inviteEl.append(
        h("div", { class: "label" }, "room code"),
        h("div", { class: "vs-bigcode" }, this.code),
        h("div", { class: "label" }, "or the link, which opens in any browser"),
        h("div", { class: "vs-link" }, this.inviteLink()),
      );

    // buttons
    const canReady = this.phase === "idle" && linked && !this.readyMe;
    this.readyBtn.disabled = !canReady;
    this.readyBtn.hidden = this.phase === "racing" || this.phase === "countdown";
    clear(this.readyBtn).append(this.phase === "waiting" && this.role === "host" ? "Copy invite link" : this.readyMe ? "Ready" : r ? "Next round" : "Ready", canReady ? h("kbd", null, "Space") : null);
    if (this.phase === "waiting" && this.role === "host") {
      this.readyBtn.disabled = false;
      this.readyBtn.hidden = false;
    }
    this.giveBtn.hidden = !(this.phase === "racing" && r && r.me.status === "solving");

    // host picks the size between rounds
    clear(this.sizeRow);
    if (this.role === "host" && (this.phase === "idle" || this.phase === "waiting"))
      this.sizeRow.append(
        h("span", { class: "label" }, "board"),
        seg(
          [3, 4, 5].map((n) => ({ value: n, label: `${n}x${n}` })),
          this.N,
          (n) => this.setSize(n),
          "Board size",
        ),
      );
    else this.sizeRow.append(h("span", { class: "label" }, `board ${this.N}x${this.N}`));

    this.refreshOpp();
    this.renderHistory();
  }

  refreshOpp() {
    if (!this.oppNameEl) return;
    const r = this.round;
    const linked = !!(this.conn && this.conn.open);
    this.oppNameEl.textContent = this.oppName || "your friend";
    let text = "";
    if (!linked) text = this.oppName ? "not connected" : "not here yet";
    else if (!r || this.phase === "countdown") text = this.readyOpp ? "ready" : this.phase === "countdown" ? "" : "not ready";
    else if (r.opp.status === "done") text = `${fmtTime(r.opp.ms)} · ${r.opp.moves} moves`;
    else if (r.opp.status === "dnf") text = "gave up";
    else if (this.phase === "idle") text = this.readyOpp ? "ready" : `still solving · ${r.opp.moves} moves`;
    else text = `${r.opp.moves} moves`;
    this.oppStateEl.textContent = text;
  }

  renderHistory() {
    clear(this.historyEl);
    const rec = this.oppName ? loadRecord()[this.oppName] : null;
    if (rec && (rec.w || rec.l || rec.d))
      this.historyEl.append(h("p", { class: "hint-text" }, `All time against ${this.oppName}: ${rec.w || 0} won, ${rec.l || 0} lost${rec.d ? `, ${rec.d} drawn` : ""}.`));
    const done = this.rounds.filter((x) => x.winner);
    if (!done.length) return;
    const cell = (p) => (p.status === "done" ? fmtTime(p.ms) : p.status === "dnf" ? "gave up" : "…");
    this.historyEl.append(
      h(
        "table",
        { class: "ledger vs-ledger" },
        h("thead", null, h("tr", null, h("th", null, "round"), h("th", { class: "tnum" }, "you"), h("th", { class: "tnum" }, this.oppName || "friend"))),
        h(
          "tbody",
          null,
          done
            .slice()
            .reverse()
            .slice(0, 12)
            .map((x) =>
              h(
                "tr",
                null,
                h("td", null, `${x.n} · ${x.N}x${x.N}`),
                h("td", { class: "tnum" + (x.winner === "me" ? " is-win" : "") }, cell(x.me)),
                h("td", { class: "tnum" + (x.winner === "opp" ? " is-win" : "") }, cell(x.opp)),
              ),
            ),
        ),
      ),
    );
  }

  copyInvite() {
    const link = this.inviteLink();
    copyText(`Race me on Fifteen Press: ${link} (room code ${this.code})`).then((ok) => toast(ok ? "Invite copied. Paste it to your friend." : "Could not copy. The code is " + this.code));
  }

  setSize(n) {
    if (this.role !== "host" || (this.phase !== "idle" && this.phase !== "waiting")) return;
    this.N = n;
    this.readyMe = this.readyOpp = false;
    this.round = null;
    this.game = null;
    this.send({ t: "cfg", N: n });
    this.showIdleBoards();
    this.refresh();
  }

  resetScore() {
    if (this.role !== "host" || this.phase !== "idle") return;
    this.score = { me: 0, opp: 0 };
    this.rounds = [];
    this.round = null;
    this.game = null;
    this.send({ t: "score", score: { host: 0, guest: 0 } });
    this.showIdleBoards();
    this.refresh();
  }

  /* ---------- a round ---------- */

  pressReady() {
    if (this.phase === "waiting" && this.role === "host") return this.copyInvite();
    if (this.phase !== "idle" || this.readyMe || !(this.conn && this.conn.open)) return;
    this.readyMe = true;
    this.send({ t: "ready" });
    this.refresh();
    this.maybeStart();
  }

  maybeStart() {
    if (this.role !== "host" || this.phase !== "idle" || !this.readyMe || !this.readyOpp) return;
    const seed = E.randomSeed(8);
    const n = (this.rounds.length ? this.rounds[this.rounds.length - 1].n : 0) + 1;
    this.send({ t: "start", n, seed, N: this.N });
    // the friend hears about it half a round trip later, so wait that long to count down together
    this.beginCountdown(seed, this.N, n, LEAD + this.rtt / 2);
    this.send({ t: "ping", ts: performance.now() });
  }

  beginCountdown(seed, N, n, lead) {
    this.clearTimers();
    this.N = N;
    this.readyMe = this.readyOpp = false;
    this.phase = "countdown";
    const board = E.scrambleFromSeed(seed, N);
    const r = {
      n,
      N,
      seed,
      winner: null,
      me: { status: "solving", ms: 0, moves: 0, passed: false },
      opp: { status: "solving", ms: 0, moves: 0, passed: false },
    };
    this.round = r;
    this.rounds.push(r);
    const game = new Game({ N, board, seed, mode: "seed", label: "1v1" });
    this.game = game;
    game.on((type, data) => this.onGame(game, type, data));
    if (!this.view) this.renderRoom();
    this.view.clearProofed();
    this.view.fast = !!this.s.speedMode;
    this.view.set(board, N, { instant: true });
    this.view.setHidden(true);
    this.oppView.clearProofed();
    this.oppView.set(board, N, { instant: true });
    this.oppView.setHidden(true);
    this.timeEl.textContent = fmtTime(0);
    this.movesEl.textContent = "0";
    this.goAt = performance.now() + lead;
    this.countEl.hidden = false;
    this.refresh();
    const tick = () => {
      if (this.round !== r || this.phase !== "countdown") return;
      const left = this.goAt - performance.now();
      if (left <= 0) return this.go(r);
      const shown = String(Math.ceil(left / 1000));
      if (this.countEl.textContent !== shown) this.countEl.textContent = shown;
      this.later(tick, Math.min(50, left));
    };
    tick();
  }

  go(r) {
    this.phase = "racing";
    this.goAt = performance.now();
    this.countEl.hidden = true;
    this.countEl.textContent = "";
    this.view.setHidden(false);
    this.oppView.setHidden(false);
    this.view.enter();
    this.view.setRunning(true);
    audio.thunk();
    this.refresh();
    const frame = () => {
      if (this.round !== r || this.phase !== "racing" || r.me.status !== "solving") return;
      this.timeEl.textContent = fmtTime(performance.now() - this.goAt);
      this.checkPassed();
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
    // a hidden tab stops drawing, so keep the clock check alive there too
    const slow = () => {
      if (this.round !== r || r.me.status !== "solving") return;
      this.checkPassed();
      this.later(slow, 500);
    };
    this.later(slow, 500);
  }

  racing() {
    const r = this.round;
    return this.phase === "racing" && r && r.me.status === "solving" && this.game;
  }

  onGame(game, type, data) {
    const r = this.round;
    if (game !== this.game || !r) return;
    if (type === "move") {
      this.view.set(game.board, game.N);
      r.me.moves = game.moves.length;
      this.movesEl.textContent = String(r.me.moves);
      audio.tock({ tile: data.tile, col: data.to % game.N, N: game.N, home: data.to === data.tile - 1 });
      this.queueProgress();
    } else if (type === "solved") {
      r.me.status = "done";
      r.me.ms = Math.max(1, Math.round(game.finishedAt - this.goAt));
      r.me.moves = game.moves.length;
      this.timeEl.textContent = fmtTime(r.me.ms);
      this.view.setRunning(false);
      this.view.inkWave();
      audio.chime();
      this.flushProgress();
      this.send({ t: "done", n: r.n, ms: r.me.ms, m: r.me.moves });
      this.noteBest(r);
      this.decide();
      this.settle();
    }
  }

  queueProgress() {
    if (this.progTimer) return;
    this.progTimer = setTimeout(() => this.flushProgress(), 70);
  }
  flushProgress() {
    clearTimeout(this.progTimer);
    this.progTimer = 0;
    const r = this.round;
    if (r && this.game) this.send({ t: "p", n: r.n, b: this.game.board, m: this.game.moves.length });
  }

  // still solving after the other clock stopped: the round is theirs
  checkPassed() {
    const r = this.round;
    if (!r || r.me.status !== "solving" || r.me.passed || r.opp.status !== "done" || this.phase !== "racing") return;
    if (performance.now() - this.goAt > r.opp.ms) {
      r.me.passed = true;
      this.send({ t: "passed", n: r.n });
      this.decide();
      this.refresh();
    }
  }

  giveUp() {
    const r = this.round;
    if (!this.racing()) return;
    r.me.status = "dnf";
    this.view.setRunning(false);
    this.send({ t: "dnf", n: r.n });
    this.decide();
    this.settle();
  }

  // the host calls the round and tells the guest, so both score sheets always agree
  decide() {
    const r = this.round;
    if (this.role !== "host" || !r || r.winner) return;
    const a = r.me,
      b = r.opp;
    let w = null;
    if (a.status === "done" && b.status === "done") w = a.ms < b.ms ? "host" : b.ms < a.ms ? "guest" : "draw";
    else if (a.status === "dnf" && b.status === "dnf") w = "draw";
    else if (a.status === "dnf") w = "guest";
    else if (b.status === "dnf") w = "host";
    else if (a.status === "done" && b.passed) w = "host";
    else if (b.status === "done" && a.passed) w = "guest";
    if (!w) return;
    const score = { host: this.score.me + (w === "host" ? 1 : 0), guest: this.score.opp + (w === "guest" ? 1 : 0) };
    this.send({ t: "result", n: r.n, w, score });
    this.applyResult(w === "host" ? "me" : w === "guest" ? "opp" : "draw", { me: score.host, opp: score.guest });
  }

  applyResult(winner, score) {
    const r = this.round;
    if (!r || r.winner) return;
    r.winner = winner;
    if (score) this.score = score;
    if (this.oppName) {
      const rec = loadRecord();
      const row = rec[this.oppName] || (rec[this.oppName] = { w: 0, l: 0, d: 0 });
      if (winner === "me") row.w = (row.w || 0) + 1;
      else if (winner === "opp") row.l = (row.l || 0) + 1;
      else row.d = (row.d || 0) + 1;
      row.last = Date.now();
      saveRecord(rec);
    }
    if (winner === "opp" && r.me.status === "solving") audio.fail();
    this.settle();
  }

  noteBest(r) {
    if (!this.oppName || r.N !== 4) return;
    const rec = loadRecord();
    const row = rec[this.oppName] || (rec[this.oppName] = { w: 0, l: 0, d: 0 });
    if (!row.best || r.me.ms < row.best) {
      row.best = r.me.ms;
      row.last = Date.now();
      saveRecord(rec);
    }
  }

  // back to the waiting room once the round is called and my own board is finished
  settle() {
    const r = this.round;
    if (r && r.winner && r.me.status !== "solving" && this.phase === "racing") {
      this.phase = "idle";
      cancelAnimationFrame(this.raf);
    }
    this.refresh();
  }

  abortRound() {
    const r = this.round;
    this.clearTimers();
    if (r && !r.winner) {
      // a round cut off by a dropped connection counts for nobody
      this.rounds = this.rounds.filter((x) => x !== r);
      this.round = null;
      this.game = null;
    }
    if (this.countEl) {
      this.countEl.hidden = true;
      this.countEl.textContent = "";
    }
    if (this.view) {
      this.view.setRunning(false);
      this.view.setHidden(false);
    }
    if (this.oppView) this.oppView.setHidden(false);
  }

  /* ---------- input ---------- */

  onKey(e) {
    if (this.phase === "lobby" || this.phase === "opening") return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const map = KEYMAP[this.s.arrowMode] || KEYMAP.tile;
    if (key in map && (key.startsWith("Arrow") || this.s.wasd)) {
      e.preventDefault();
      if (!this.racing()) return;
      if (!this.game.move(map[key])) audio.bump();
      return;
    }
    if (key === " " || key === "Enter") {
      // a focused button answers these keys itself
      if (e.target && e.target.tagName === "BUTTON") return;
      e.preventDefault();
      if (this.phase === "idle") this.pressReady();
    }
  }

  moveCell(cell) {
    if (!this.racing()) return;
    if (!this.game.moveCell(cell)) audio.bump();
  }
}
