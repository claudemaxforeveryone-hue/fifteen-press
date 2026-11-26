// 1v1: two players, one room code, the same scramble, a running score.
// The two apps talk straight to each other over WebRTC. The public PeerJS broker only introduces them,
// so there is no server of ours, no account and nothing stored anywhere but this device.
// Around the race: a friends list with one press challenges, engine opponents, two ratings and the race log.
import { h, clear, toast, seg, copyText, confirmAction, relDate } from "../ui.js";
import { Game } from "../game.js";
import { BoardView } from "../board-view.js";
import { fmtTime } from "../stats.js";
import { lineChart } from "../charts.js";
import * as audio from "../audio.js";
import * as D from "../versus-data.js";
import { BOTS, nearestBot, typicalMs, planRace, BotRun } from "../versus-bots.js";
import { Presence, loadPeer, brokerOptions } from "../versus-friends.js";
import { notice, confetti, countTo } from "../versus-fx.js";

const E = window.FifteenEngine;

// the link a friend can open in any browser (the desktop app has no web address of its own)
const INVITE_BASE = "https://claudemaxforeveryone-hue.github.io/fifteen-press/";
const ID_PREFIX = "fifteen-press-1v1-";
const CODE_LEN = 5;
const PROTOCOL = 2; // 1 = 5.7.0: no room options, no ratings
const CHATTER = new Set(["hb", "p", "ack", "ping", "pong"]); // fine to lose one of these
const RESEND = 600; // an unconfirmed message goes out again after this long
const BEAT = 2000; // each side says "still here" this often
const SILENCE = 12000; // and gives up on a line that has been quiet this long
const LEGACY_ROOM = { to: 0, lead: 3, peek: false, rated: false };

const makeCode = () => D.randomCode(CODE_LEN);

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

function cleanCode(text) {
  // a pasted invite link works as well as the bare code
  const m = /versus\/([A-Za-z0-9]+)/.exec(String(text || ""));
  return (m ? m[1] : String(text || ""))
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}
function isBoard(b, N) {
  if (!Array.isArray(b) || b.length !== N * N) return false;
  const seen = new Set(b);
  if (seen.size !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (!seen.has(i)) return false;
  return true;
}
const cleanName = D.cleanName;
const signed = (n) => (n > 0 ? "+" + n : String(n));
const about = (ms) => (ms < 10000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000))) + " s";
const roomWords = (room) => [`${room.N}x${room.N}`, room.to ? `first to ${room.to}` : "single rounds", `${room.lead} s countdown`, room.peek ? "board shown early" : null, room.rated ? "rated" : "not rated"].filter(Boolean).join(" · ");

function toggle(label, value, onChange, hint, disabled) {
  const cb = h("input", { type: "checkbox", checked: !!value, disabled: !!disabled });
  cb.addEventListener("change", () => onChange(cb.checked));
  // a mouse click should not leave the box holding the keyboard: Space is "ready" in a room
  cb.addEventListener("click", (e) => {
    if (e.detail > 0) cb.blur();
  });
  return h("label", { class: "switch-row" }, cb, h("span", { class: "switch-text" }, label, hint ? h("small", null, hint) : null));
}

export class VersusView {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.store = ctx.store;
    this.data = D.load();
    this.phase = "lobby"; // lobby | opening | waiting | idle | countdown | racing
    this.tab = "friends"; // friends | engines | stats | options
    this.statsOf = "all";
    this.role = null; // host | guest
    this.code = "";
    this.peer = null;
    this.conn = null;
    this.bot = null; // the engine in the other seat, when there is one
    this.room = D.cleanRoom(this.data.room);
    this.myName = "";
    this.oppName = "";
    this.oppFc = "";
    this.oppElo = null;
    this.oppV = PROTOCOL;
    this.score = { me: 0, opp: 0 };
    this.rounds = [];
    this.round = null;
    this.matchOver = null;
    this.readyMe = false;
    this.readyOpp = false;
    this.rtt = 0;
    this.note = "";
    this.raf = 0;
    this.timers = new Set();
    this.asks = new Map(); // friend code -> the open challenge notice from them
    this.presence = new Presence({
      name: () => this.myName || this.defaultName(),
      elo: () => this.data.elo.friends,
      onChange: () => this.friendsChanged(),
      onChallenge: (c) => this.incomingChallenge(c),
      onAnswer: (a) => this.challengeAnswered(a),
      onAdded: (a) => this.addedBy(a),
    });
    // with friends saved, be reachable from the moment the app opens, whatever page is showing
    if (this.data.friends.length) setTimeout(() => this.presence.start(), 1500);
    window.addEventListener("beforeunload", () => {
      this.teardown(true);
      this.presence.stop();
    });
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
  get N() {
    return this.room.N;
  }
  set N(n) {
    this.room.N = n;
  }
  get prefs() {
    return this.data.prefs;
  }
  // the options in force: a friend still on 5.7.0 only knows single rounds with a 3 second countdown
  get rules() {
    return this.role === "host" && !this.bot && this.oppV < 2 ? Object.assign({}, this.room, LEGACY_ROOM) : this.room;
  }
  sfx(name, ...args) {
    if (this.prefs.sounds) audio[name](...args);
  }

  /* ---------- router hooks ---------- */

  show(params) {
    const p = String(params || "");
    this.presence.retry();
    if (/^add\//i.test(p)) {
      const fc = D.cleanFriendCode("versus/" + p);
      history.replaceState(null, "", "#versus");
      this.tab = "friends";
      if (fc) this.addFriendCode(fc);
      else toast("That friend link does not look right.");
      if (this.phase === "lobby") this.render();
      return;
    }
    const code = cleanCode(p);
    if (code && this.phase === "lobby") {
      this.pendingCode = code;
      this.tab = "friends";
      this.render();
      this.join(code);
    } else if (!this.root.childElementCount || this.phase === "lobby") this.render();
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
    if (conn.bot) return conn.send(msg);
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
    const before = this.myName;
    this.myName = typed || this.myName || this.defaultName();
    try {
      localStorage.setItem("fifteen.versus.name", this.myName);
    } catch (e) {
      /* no storage */
    }
    if (before && before !== this.myName) this.presence.announce();
  }
  inviteLink() {
    return INVITE_BASE + "#versus/" + this.code;
  }
  friendLink() {
    return INVITE_BASE + "#versus/add/" + this.data.fc;
  }
  saveRoom() {
    this.data.room = Object.assign({}, this.room);
    D.save();
  }
  resetSeat() {
    this.role = null;
    this.bot = null;
    this.oppName = "";
    this.oppCid = "";
    this.oppFc = "";
    this.oppElo = null;
    this.oppV = PROTOCOL;
    this.score = { me: 0, opp: 0 };
    this.rounds = [];
    this.matchOver = null;
    this.readyMe = this.readyOpp = false;
    this.pendingChallenge = "";
    // a guest sat under the host's options: back to my own
    this.room = D.cleanRoom(this.data.room);
  }

  /* ---------- lobby ---------- */

  render() {
    if (this.phase === "lobby" || this.phase === "opening") this.renderLobby();
    else this.renderRoom();
  }

  renderLobby() {
    clear(this.root);
    this.view = this.oppView = null;
    this.friendsEl = null;
    const d = this.data;
    const rating = (label, value) => h("div", { class: "stat vs-rating" }, h("div", { class: "label" }, label), h("div", { class: "figure tnum" }, value));
    this.tabBody = h("div", { class: "vs-tab" });
    this.root.append(
      h(
        "div",
        { class: "vs-lobby" },
        h(
          "div",
          { class: "page-head" },
          h("div", null, h("div", { class: "label" }, "1v1"), h("h1", { class: "sub-title" }, "Race on the same scramble")),
          h("div", { class: "vs-ratings" }, rating("rating vs friends", d.elo.friends), rating("rating vs engines", d.elo.engine)),
        ),
        h(
          "div",
          { class: "tabs vs-tabs" },
          seg(
            [
              { value: "friends", label: "Friends" },
              { value: "engines", label: "Engines" },
              { value: "stats", label: "Stats" },
              { value: "options", label: "Options" },
            ],
            this.tab,
            (t) => {
              this.tab = t;
              this.renderTab();
            },
            "1v1 sections",
          ),
        ),
        this.tabBody,
      ),
    );
    this.renderTab();
  }

  renderTab() {
    const body = clear(this.tabBody);
    this.friendsEl = null;
    this.lobbyNote = null;
    this.nameInput = null;
    this.codeInput = null;
    if (this.tab === "engines") this.renderEngines(body);
    else if (this.tab === "stats") this.renderStats(body);
    else if (this.tab === "options") this.renderOptions(body);
    else this.renderFriendsTab(body);
  }

  nameField() {
    this.nameInput = h("input", {
      type: "text",
      maxlength: 20,
      value: this.myName || this.defaultName(),
      "aria-label": "Your name",
      autocomplete: "off",
      spellcheck: false,
      onchange: () => this.readName(),
    });
    return h("label", { class: "field vs-field" }, h("span", null, "your name"), this.nameInput);
  }

  sizeSeg() {
    return seg(
      D.SIZES.map((n) => ({ value: n, label: `${n}x${n}` })),
      this.N,
      (n) => {
        this.N = n;
        this.saveRoom();
        if (this.tab === "engines" && this.phase === "lobby") this.renderTab();
      },
      "Board size",
    );
  }

  renderFriendsTab(body) {
    const busy = this.phase === "opening";
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
    this.friendInput = h("input", {
      type: "text",
      class: "vs-code-input",
      maxlength: 120,
      placeholder: "friend code",
      "aria-label": "A friend's code or friend link",
      autocomplete: "off",
      spellcheck: false,
      onkeydown: (e) => {
        if (e.key === "Enter") this.addFriendTyped();
      },
    });
    this.friendsEl = h("div", { class: "vs-friends" });
    body.append(
      h("p", { class: "hint-text vs-lede" }, "One of you makes a room and sends the code, or challenges a friend from the list. You both get the same scramble after the countdown. Fastest solve takes the round."),
      this.nameField(),
      h(
        "div",
        { class: "vs-choices" },
        h(
          "div",
          { class: "vs-choice" },
          h("div", { class: "label" }, "start a room"),
          h("div", { class: "row" }, this.sizeSeg()),
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
      h(
        "div",
        { class: "vs-section" },
        h("div", { class: "label" }, "friends"),
        this.friendsEl,
        h(
          "div",
          { class: "vs-addfriend" },
          h(
            "div",
            { class: "vs-mycode" },
            h("span", { class: "label" }, "your friend code"),
            h("button", { class: "vs-codechip", type: "button", title: "copy your friend link", onclick: () => this.copyFriendLink() }, this.data.fc),
            h("button", { class: "btn btn--ghost btn--small", type: "button", onclick: () => this.copyFriendLink() }, "Copy friend link"),
          ),
          h("div", { class: "row" }, this.friendInput, h("button", { class: "btn btn--small", type: "button", onclick: () => this.addFriendTyped() }, "Add friend")),
        ),
      ),
    );
    this.renderFriends();
  }

  renderFriends() {
    const el = this.friendsEl;
    if (!el || !el.isConnected) return;
    clear(el);
    const d = this.data;
    const p = this.presence;
    const busy = this.phase !== "lobby" && this.phase !== "waiting";
    if (!d.friends.length) {
      el.append(h("p", { class: "hint-text" }, "Nobody yet. Send a friend your friend link, type their code below, or race someone with a room code and press Add friend in the room."));
    } else {
      const heads = new Map(D.rivals(d.log.filter((x) => x.k === "f")).map((r) => [r.id, r]));
      el.append(
        h(
          "table",
          { class: "ledger vs-friendlist" },
          h(
            "tbody",
            null,
            d.friends.map((f) => {
              const on = p.online(f.fc);
              const rec = heads.get(f.fc);
              return h(
                "tr",
                { "data-fc": f.fc },
                h("td", { class: "vs-friend-name" }, h("span", { class: "vs-dot", "data-on": on ? "1" : null, title: on ? "online" : "offline" }), f.name || f.fc),
                h("td", { class: "tnum vs-friend-elo" }, f.elo != null ? f.elo : ""),
                h("td", { class: "tnum vs-friend-rec" }, rec ? `${rec.w} won, ${rec.l} lost` : ""),
                h(
                  "td",
                  { class: "vs-friend-act" },
                  on
                    ? h("button", { class: "btn btn--small btn--primary", type: "button", disabled: busy, onclick: () => this.challengeFriend(f.fc) }, "Challenge")
                    : h("span", { class: "hint-text" }, "offline"),
                  h("button", { class: "btn btn--ghost btn--small", type: "button", onclick: () => this.removeFriendAsk(f) }, "Remove"),
                ),
              );
            }),
          ),
        ),
      );
    }
    let state = "";
    if (!this.prefs.online) state = "You are hidden: friends cannot see you or challenge you. Change it under Options.";
    else if (p.state === "elsewhere") state = "Your friend code is already online in another window of Fifteen Press, so challenges arrive there.";
    else if (p.state === "failed") state = "Could not reach the friends service. Room codes still work.";
    if (state) el.append(h("p", { class: "hint-text vs-presence" }, state));
  }

  friendsChanged() {
    if (this.phase === "lobby" || this.phase === "opening") this.renderFriends();
    else if (this.phase === "waiting") this.refresh();
  }

  renderEngines(body) {
    const mine = this.data.elo.engine;
    const level = nearestBot(mine);
    const heads = new Map(D.rivals(this.data.log.filter((x) => x.k === "e")).map((r) => [r.id, r]));
    body.append(
      h("p", { class: "hint-text vs-lede" }, "The app's own solver, played at set speeds. Always here, no connection needed. Your engine rating moves the way it would against people: a win over a weaker engine pays little, a win over a stronger one pays a lot."),
      h("div", { class: "row vs-enginebar" }, h("span", { class: "label" }, "board"), this.sizeSeg()),
      h(
        "table",
        { class: "ledger vs-ladder" },
        h(
          "thead",
          null,
          h("tr", null, h("th", null, "engine"), h("th", { class: "tnum" }, "rating"), h("th", { class: "tnum" }, `about, ${this.N}x${this.N}`), h("th", { class: "tnum" }, "you"), h("th", { class: "tnum" }, "win / loss"), h("th", null, "")),
        ),
        h(
          "tbody",
          null,
          BOTS.map((b) => {
            const rec = heads.get(b.id);
            return h(
              "tr",
              { class: b === level ? "is-me" : null, "data-bot": b.id },
              h("td", null, b.name, b === level ? h("span", { class: "tag tag--spot vs-level" }, "your level") : null),
              h("td", { class: "tnum" }, b.elo),
              h("td", { class: "tnum" }, about(typicalMs(b, this.N))),
              h("td", { class: "tnum" }, rec ? `${rec.w} to ${rec.l}` : ""),
              h("td", { class: "tnum" }, `${signed(D.eloDelta(mine, b.elo, 1))} / ${signed(D.eloDelta(mine, b.elo, 0))}`),
              h("td", { class: "vs-friend-act" }, h("button", { class: "btn btn--small" + (b === level ? " btn--primary" : ""), type: "button", onclick: () => this.raceBot(b) }, "Race")),
            );
          }),
        ),
      ),
    );
  }

  renderStats(body) {
    const d = this.data;
    const rows = d.log.filter((x) => this.statsOf === "all" || (this.statsOf === "friends" ? x.k === "f" : x.k === "e"));
    const t = D.tally(rows);
    const fact = (label, value) => h("tr", null, h("td", null, label), h("td", { class: "tnum" }, value));
    const chartEl = h("div", { class: "vs-chart" });
    const head = h(
      "div",
      { class: "row vs-statsbar" },
      seg(
        [
          { value: "all", label: "All" },
          { value: "friends", label: "Friends" },
          { value: "engines", label: "Engines" },
        ],
        this.statsOf,
        (v) => {
          this.statsOf = v;
          this.renderTab();
        },
        "Which races",
      ),
    );
    body.append(head);
    if (!d.log.length) {
      body.append(h("p", { class: "hint-text" }, "No races yet. Every round against a friend or an engine lands here: results, times, both ratings and who you have beaten."));
      return;
    }
    const bySize = D.SIZES.map((N) => ({ N, t: D.tally(rows.filter((x) => x.N === N)) })).filter((x) => x.t.n);
    const rivals = D.rivals(rows).slice(0, 14);
    const recent = rows.slice(-14).reverse();
    const resultWord = { w: "won", l: "lost", d: "draw" };
    body.append(
      h(
        "div",
        { class: "cols vs-statcols" },
        h(
          "div",
          { class: "stat-block" },
          h("div", { class: "label" }, "ratings"),
          h(
            "table",
            { class: "ledger ledger--facts" },
            h(
              "tbody",
              null,
              fact("against friends", `${d.elo.friends} (peak ${d.peak.friends})`),
              fact("against engines", `${d.elo.engine} (peak ${d.peak.engine})`),
              fact("matches won", `${d.matches.w} of ${d.matches.w + d.matches.l}`),
            ),
          ),
          chartEl,
        ),
        h(
          "div",
          { class: "stat-block" },
          h("div", { class: "label" }, "rounds"),
          h(
            "table",
            { class: "ledger ledger--facts" },
            h(
              "tbody",
              null,
              fact("raced", t.n),
              fact("won, lost, drawn", `${t.w}, ${t.l}, ${t.d}`),
              fact("win rate", t.n ? Math.round(t.rate * 100) + "%" : ""),
              fact("winning streak now", t.streak),
              fact("longest winning streak", t.bestStreak),
              fact("fastest race solve", t.best ? fmtTime(t.best) : ""),
              fact("turns per second", t.tps ? t.tps.toFixed(1) : ""),
            ),
          ),
        ),
      ),
      bySize.length
        ? h(
            "div",
            { class: "vs-section" },
            h("div", { class: "label" }, "by board"),
            h(
              "table",
              { class: "ledger" },
              h("thead", null, h("tr", null, h("th", null, "board"), h("th", { class: "tnum" }, "rounds"), h("th", { class: "tnum" }, "won"), h("th", { class: "tnum" }, "best"), h("th", { class: "tnum" }, "median"), h("th", { class: "tnum" }, "tps"))),
              h(
                "tbody",
                null,
                bySize.map((x) =>
                  h(
                    "tr",
                    null,
                    h("td", null, `${x.N}x${x.N}`),
                    h("td", { class: "tnum" }, x.t.n),
                    h("td", { class: "tnum" }, Math.round(x.t.rate * 100) + "%"),
                    h("td", { class: "tnum" }, x.t.best ? fmtTime(x.t.best) : ""),
                    h("td", { class: "tnum" }, x.t.median ? fmtTime(x.t.median) : ""),
                    h("td", { class: "tnum" }, x.t.tps ? x.t.tps.toFixed(1) : ""),
                  ),
                ),
              ),
            ),
          )
        : null,
      rivals.length
        ? h(
            "div",
            { class: "vs-section" },
            h("div", { class: "label" }, "head to head"),
            h(
              "table",
              { class: "ledger" },
              h("thead", null, h("tr", null, h("th", null, "against"), h("th", { class: "tnum" }, "won"), h("th", { class: "tnum" }, "lost"), h("th", { class: "tnum" }, "drawn"), h("th", { class: "tnum" }, "your best"), h("th", { class: "tnum" }, "last"))),
              h(
                "tbody",
                null,
                rivals.map((r) =>
                  h(
                    "tr",
                    null,
                    h("td", null, r.name, r.kind === "e" ? h("span", { class: "tag vs-level" }, "engine") : null),
                    h("td", { class: "tnum" }, r.w),
                    h("td", { class: "tnum" }, r.l),
                    h("td", { class: "tnum" }, r.d),
                    h("td", { class: "tnum" }, r.best ? fmtTime(r.best) : ""),
                    h("td", { class: "tnum" }, relDate(r.last)),
                  ),
                ),
              ),
            ),
          )
        : null,
      h(
        "div",
        { class: "vs-section" },
        h("div", { class: "label" }, "latest rounds"),
        h(
          "table",
          { class: "ledger" },
          h("thead", null, h("tr", null, h("th", null, "against"), h("th", null, "board"), h("th", { class: "tnum" }, "you"), h("th", { class: "tnum" }, "them"), h("th", null, "result"), h("th", { class: "tnum" }, "rating"))),
          h(
            "tbody",
            null,
            recent.map((x) =>
              h(
                "tr",
                null,
                h("td", null, x.o),
                h("td", null, `${x.N}x${x.N}`),
                h("td", { class: "tnum" + (x.r === "w" ? " is-win" : "") }, x.ms ? fmtTime(x.ms) : "no time"),
                h("td", { class: "tnum" + (x.r === "l" ? " is-win" : "") }, x.oms ? fmtTime(x.oms) : "no time"),
                h("td", null, resultWord[x.r] || ""),
                h("td", { class: "tnum" }, x.e != null ? `${x.e} (${signed(x.d)})` : "not rated"),
              ),
            ),
          ),
        ),
      ),
      h(
        "div",
        { class: "row vs-section" },
        h(
          "button",
          {
            class: "btn btn--ghost btn--small",
            type: "button",
            onclick: () =>
              confirmAction("Clear every 1v1 result and set both ratings back to 1000? Friends stay.", "Clear 1v1 stats", () => {
                D.clearStats();
                this.presence.announce();
                this.render();
              }),
          },
          "Clear 1v1 stats",
        ),
      ),
    );
    // rating after each rated round, one line per kind
    const series = [];
    const line = (k, name, color) => {
      const pts = d.log.filter((x) => x.k === k && x.e != null).map((x, i) => ({ x: i + 1, y: x.e }));
      if (pts.length > 1) series.push({ name, color, points: [{ x: 0, y: D.START_ELO }, ...pts] });
    };
    if (this.statsOf !== "engines") line("f", "friends", "var(--chart-a)");
    if (this.statsOf !== "friends") line("e", "engines", "var(--chart-b)");
    if (series.length) {
      const ys = series.flatMap((s) => s.points.map((pt) => pt.y));
      lineChart(chartEl, series, { height: 180, yMin: Math.floor((Math.min(...ys) - 20) / 50) * 50, yMax: Math.ceil((Math.max(...ys) + 20) / 50) * 50, xLabel: "rated rounds", xFmt: (v) => (Number.isInteger(v) ? String(v) : ""), title: "Rating after each rated round" });
      if (series.length > 1) chartEl.append(h("p", { class: "hint-text vs-chartkey" }, h("span", { style: { color: "var(--chart-a)" } }, "friends"), " and ", h("span", { style: { color: "var(--chart-b)" } }, "engines")));
    }
  }

  renderOptions(body) {
    const set = (key) => (on) => {
      this.prefs[key] = on;
      D.save();
      if (key === "online") {
        if (on) this.presence.start();
        else this.presence.stop();
      }
    };
    body.append(
      this.nameField(),
      h(
        "div",
        { class: "vs-options" },
        toggle("Race sounds", this.prefs.sounds, set("sounds"), "The countdown, a win, a loss, a friend arriving, a challenge. Tile clicks and volume follow Settings."),
        toggle("Winning animations", this.prefs.fx, set("fx"), "Paper confetti for a round, more of it for a match. Stays off when motion is reduced."),
        toggle("Show me online to friends", this.prefs.online, set("online"), "While the app is open, people who have your friend code can see you are here and challenge you. Off: room codes and engines still work."),
      ),
      h("p", { class: "hint-text vs-lede" }, "Board size, match length, countdown and whether a room is rated are set by whoever makes the room, in the room itself. They are remembered for next time."),
    );
  }

  setNote(text) {
    this.note = text || "";
    if (this.lobbyNote && (this.phase === "lobby" || this.phase === "opening")) this.lobbyNote.textContent = this.note || (this.phase === "opening" ? "Connecting…" : "");
    if (this.statusEl && this.phase !== "lobby" && this.phase !== "opening") this.refresh();
  }

  /* ---------- friends ---------- */

  copyFriendLink() {
    copyText(`Add me on Fifteen Press 1v1: ${this.friendLink()} (friend code ${this.data.fc})`).then((ok) => toast(ok ? "Friend link copied. Send it to a friend." : "Could not copy. Your friend code is " + this.data.fc));
  }

  addFriendTyped() {
    const fc = D.cleanFriendCode(this.friendInput ? this.friendInput.value : "");
    if (!fc) return toast("A friend code is 8 letters and numbers. A friend link works too.");
    if (this.friendInput) this.friendInput.value = "";
    this.addFriendCode(fc);
  }

  addFriendCode(fc, name) {
    if (fc === this.data.fc) return toast("That is your own friend code.");
    const had = D.friend(fc);
    const f = D.addFriend(fc, name);
    if (!f) return toast(`The friends list is full (${D.MAX_FRIENDS}).`);
    if (!had) toast(name ? `${name} is on your friends list.` : "Added. Their name shows up once they are online.");
    this.presence.ask(fc);
    this.presence.retry().then(() => this.presence.probe(true));
    this.friendsChanged();
    if (this.statusEl) this.refresh();
  }

  removeFriendAsk(f) {
    confirmAction(`Remove ${f.name || f.fc} from your friends?`, "Remove", () => {
      D.removeFriend(f.fc);
      this.friendsChanged();
    });
  }

  // somebody who has my code added me
  addedBy({ fc, name }) {
    notice({
      title: `${name} added you as a friend`,
      text: "Add them back to challenge each other with one press.",
      actions: [
        { label: "Add back", primary: true, run: () => this.addFriendCode(fc, name) },
        { label: "Not now" },
      ],
    });
    this.sfx("knock");
  }

  challengeFriend(fc) {
    const f = D.friend(fc);
    if (!f) return;
    if (this.phase === "waiting" && this.role === "host") {
      this.pendingChallenge = fc;
      return this.sendChallenge();
    }
    if (this.phase !== "lobby") return;
    this.pendingChallenge = fc;
    this.host();
  }

  sendChallenge() {
    const fc = this.pendingChallenge;
    const f = fc && D.friend(fc);
    if (!f || this.phase !== "waiting" || this.role !== "host") return;
    const name = f.name || "your friend";
    if (this.presence.challenge(fc, this.code, this.room)) this.setNote(`Challenge sent to ${name}. The race starts when you are both ready.`);
    else this.setNote(`${name} is not online right now. Send them the code or the link instead.`);
  }

  challengeAnswered({ fc, name, answer }) {
    if (fc !== this.pendingChallenge || this.phase !== "waiting") return;
    this.setNote(answer === "busy" ? `${name} is in the middle of a race. Try again in a minute.` : `${name} said not now.`);
  }

  incomingChallenge({ fc, name, code, room, known }) {
    if (this.phase === "countdown" || this.phase === "racing" || this.phase === "opening") return this.presence.answer(fc, "busy");
    const old = this.asks.get(fc);
    if (old) old();
    const words = `${room.N}x${room.N}${room.to ? `, first to ${room.to}` : ""}${room.rated ? ", rated" : ""}${known ? "" : ". Not on your friends list."}`;
    const close = notice({
      title: `${name} wants to race`,
      text: words,
      ms: 45000,
      actions: [
        {
          label: "Accept",
          primary: true,
          run: () => {
            this.asks.delete(fc);
            this.acceptChallenge(code);
          },
        },
        {
          label: "Not now",
          run: () => {
            this.asks.delete(fc);
            this.presence.answer(fc, "no");
          },
        },
      ],
    });
    this.asks.set(fc, close);
    this.sfx("ring");
  }

  acceptChallenge(code) {
    if (this.phase !== "lobby") this.leave();
    this.pendingCode = code;
    this.tab = "friends";
    if (location.hash !== "#versus/" + code) location.hash = "#versus/" + code;
    else this.show(code);
  }

  /* ---------- connecting ---------- */

  async host() {
    if (this.phase !== "lobby") return;
    this.readName();
    this.role = "host";
    this.bot = null;
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
      if (this.pendingChallenge) this.sendChallenge();
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
        this.matchOver = null;
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
    this.bot = null;
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

  hello() {
    this.send({
      t: "hello",
      v: PROTOCOL,
      name: this.myName,
      fc: this.data.fc,
      elo: this.data.elo.friends,
      N: this.N,
      room: this.role === "host" ? this.room : null,
      score: this.role === "host" ? { host: this.score.me, guest: this.score.opp } : null,
    });
  }

  adopt(conn) {
    this.conn = conn;
    conn.on("open", () => {
      if (this.conn !== conn) return;
      this.redialing = false;
      this.redials = 0;
      this.lastSeen = performance.now();
      this.startBeat();
      this.hello();
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
      if (!conn || !conn.open || conn.bot) return;
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
    this.resetSeat();
    this.note = text;
    this.tab = "friends";
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
    if (this.conn && this.conn.open && !this.conn.bot) {
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
    const wasBot = !!this.bot;
    this.leftOnPurpose = true;
    this.teardown();
    this.leftOnPurpose = false;
    this.phase = "lobby";
    this.code = "";
    this.pendingCode = "";
    this.resetSeat();
    this.note = "";
    this.tab = wasBot ? "engines" : "friends";
    if (location.hash.startsWith("#versus/")) history.replaceState(null, "", "#versus");
    this.render();
  }

  /* ---------- engines ---------- */

  raceBot(bot) {
    if (this.phase !== "lobby") return;
    if (this.nameInput) this.readName();
    else this.myName = this.myName || this.defaultName();
    this.resetSeat();
    this.role = "host";
    this.bot = bot;
    this.code = "";
    this.oppName = bot.name;
    this.oppElo = bot.elo;
    // the engine sits on the other end of a line that never leaves this page
    this.conn = { open: true, bot: true, send: (msg) => this.botHears(msg), close() {} };
    this.round = null;
    this.game = null;
    this.phase = "idle";
    this.note = "";
    this.render();
  }

  botHears(msg) {
    if (msg.t === "ready")
      this.later(() => {
        if (this.bot && this.phase === "idle") this.onData({ t: "ready" });
      }, 220);
  }

  swapBot(step) {
    if (!this.bot || this.phase !== "idle") return;
    const next = BOTS[BOTS.indexOf(this.bot) + step];
    if (!next) return;
    this.bot = next;
    this.oppName = next.name;
    this.oppElo = next.elo;
    this.score = { me: 0, opp: 0 };
    this.rounds = [];
    this.round = null;
    this.game = null;
    this.matchOver = null;
    this.readyMe = this.readyOpp = false;
    this.hideVerdict();
    this.showIdleBoards();
    this.refresh();
  }

  async runBot(r) {
    let plan = null;
    try {
      plan = await r.plan;
    } catch (e) {
      console.error("1v1 engine", e);
    }
    if (!plan || this.round !== r || !this.bot) return;
    const run = new BotRun(plan, E.scrambleFromSeed(r.seed, r.N), r.N);
    const tick = () => {
      if (this.round !== r || !this.bot) return;
      const elapsed = performance.now() - r.goAt;
      const step = run.step(elapsed);
      if (step.done) return this.onData({ t: "done", n: r.n, ms: plan.ms, m: plan.moves.length });
      if (step.moved) this.onData({ t: "p", n: r.n, b: run.board, m: step.moves });
      if (r.me.status === "done" && !r.opp.passed && elapsed > r.me.ms) this.onData({ t: "passed", n: r.n });
      this.later(tick, 33);
    };
    tick();
  }

  /* ---------- messages ---------- */

  onData(msg) {
    switch (msg.t) {
      case "hello": {
        this.oppName = cleanName(msg.name) || "Friend";
        if (this.oppName === this.myName) this.oppName += " (2)";
        this.oppV = msg.v | 0 || 1;
        this.oppFc = D.isFriendCode(msg.fc) && msg.fc !== this.data.fc ? msg.fc : "";
        this.oppElo = this.oppV >= 2 && msg.elo != null ? D.cleanElo(msg.elo) : null;
        if (this.role === "guest") {
          this.room = this.oppV >= 2 ? D.cleanRoom(msg.room, this.room) : Object.assign(D.cleanRoom({ N: msg.N }, this.room), LEGACY_ROOM);
          if (msg.score) this.score = { me: msg.score.guest | 0, opp: msg.score.host | 0 };
        }
        if (this.oppFc) {
          const f = D.friend(this.oppFc);
          if (f && (f.name !== this.oppName || f.elo !== this.oppElo)) {
            f.name = this.oppName;
            if (this.oppElo != null) f.elo = this.oppElo;
            D.save();
          }
        }
        this.abortRound();
        this.round = null;
        this.game = null;
        this.matchOver = null;
        this.readyMe = this.readyOpp = false;
        this.phase = "idle";
        this.note = "";
        this.render();
        if (this.prefs.sounds) audio.knock();
        else audio.thunk();
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
        if (this.role === "guest" && this.phase === "idle") {
          this.room = D.cleanRoom(msg.room || { N: msg.N }, this.room);
          this.readyMe = this.readyOpp = false;
          this.round = null;
          this.game = null;
          this.hideVerdict();
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
        if (this.role === "guest" && typeof msg.seed === "string" && /^[A-Za-z0-9]{1,32}$/.test(msg.seed) && D.SIZES.includes(msg.N)) {
          this.room.lead = D.LEADS.includes(msg.lead) ? msg.lead : 3;
          this.room.peek = msg.peek === true;
          this.beginCountdown(msg.seed, msg.N, msg.n | 0, this.room.lead * 1000, msg.fresh === true);
        }
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
        if (r.row) {
          r.row.oms = Math.round(r.opp.ms);
          D.save();
        }
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
          this.matchOver = null;
          this.hideVerdict();
          this.showIdleBoards();
          this.refresh();
        }
        break;
      case "friend":
        // the other player in the room put me on their list
        if (this.oppFc && !D.friend(this.oppFc)) this.addedBy({ fc: this.oppFc, name: this.oppName });
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
    this.verdictEl = h("div", { class: "vs-verdict", hidden: true });
    this.boardWrap.append(this.countEl, this.verdictEl);

    this.oppWrap = h("div", { class: "vs-opp-board" });
    this.oppView = new BoardView(this.oppWrap, { small: true, label: "The other board" });
    this.oppView.setColoring(this.s.coloring);

    this.scoreEl = h("div", { class: "vs-score" });
    this.statusEl = h("p", { class: "vs-status", role: "status" });
    this.inviteEl = h("div", { class: "vs-invite", hidden: true });
    this.readyBtn = h("button", { class: "btn btn--primary", type: "button", onclick: () => this.pressReady() }, "Ready");
    this.giveBtn = h("button", { class: "btn btn--ghost", type: "button", hidden: true, onclick: () => this.giveUp() }, "Give up");
    this.oppNameEl = h("div", { class: "label" });
    this.oppStateEl = h("div", { class: "vs-opp-state tnum" });
    this.oppToolsEl = h("div", { class: "row vs-opp-tools" });
    this.optionsEl = h("div", { class: "vs-roomopts" });
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
          h("aside", { class: "vs-side" }, h("div", { class: "vs-opp" }, this.oppNameEl, this.oppWrap, this.oppStateEl, this.oppToolsEl), this.optionsEl, this.historyEl),
        ),
      )),
    );
    this.showIdleBoards();
    this.refresh();
    const r = this.round;
    if (r && r.winner && this.phase === "idle") this.showVerdict(r, true);
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

  myElo() {
    return this.bot ? this.data.elo.engine : this.data.elo.friends;
  }
  // does a round in this room move the ratings
  ratedNow() {
    if (this.bot) return true;
    return this.room.rated && this.oppElo != null && this.oppV >= 2;
  }

  refresh() {
    if (!this.statusEl || this.phase === "lobby" || this.phase === "opening") return;
    const opp = this.oppName || "Friend";
    const r = this.round;
    const linked = !!(this.conn && this.conn.open);
    const rated = this.ratedNow();
    const to = this.rules.to;

    // score line
    this.myEloEl = h("small", { class: "vs-elo tnum" }, rated || this.bot ? this.myElo() : "");
    clear(this.scoreEl).append(
      h("span", { class: "vs-who" }, this.myName, this.myEloEl),
      h("span", { class: "vs-points tnum" }, h("b", { class: this.score.me > this.score.opp ? "is-up" : null }, this.score.me), h("i", null, ":"), h("b", { class: this.score.opp > this.score.me ? "is-up" : null }, this.score.opp)),
      h("span", { class: "vs-who" }, linked || this.oppName ? opp : "waiting", this.oppElo != null && (linked || this.oppName) ? h("small", { class: "vs-elo tnum" }, this.oppElo) : null),
      to ? h("span", { class: "label vs-target" }, `first to ${to}`) : null,
    );

    // room line
    clear(this.roomEl).append(
      this.bot ? h("span", { class: "label" }, "engine race") : h("span", { class: "label" }, "room"),
      this.bot ? null : h("button", { class: "vs-codechip", type: "button", title: "copy the invite link", onclick: () => this.copyInvite() }, this.code),
      this.role === "host" && this.rounds.length ? h("button", { class: "btn btn--ghost btn--small", type: "button", disabled: this.phase !== "idle", onclick: () => this.resetScore() }, "Reset score") : null,
      h("button", { class: "btn btn--ghost btn--small", type: "button", onclick: () => this.leave() }, "Leave"),
    );

    // headline
    let text = "";
    let tone = "";
    if (this.phase === "waiting") {
      text = this.note || (this.role === "host" ? "Send your friend the code or the link. The race starts when you are both ready." : "Connecting to the room…");
    } else if (this.phase === "countdown") {
      text = this.rules.peek ? "Same scramble for both of you. Read it now, the clock starts at zero." : "Same scramble for both of you. Get ready.";
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
        if (r.delta != null && r.eloTo != null) text += ` Rating ${signed(r.delta)}, now ${r.eloTo}.`;
        if (this.matchOver) text += this.matchOver === "me" ? ` That is the match, ${this.score.me} to ${this.score.opp}.` : ` ${opp} takes the match, ${this.score.opp} to ${this.score.me}.`;
        if (this.readyMe && !this.readyOpp) text += ` Waiting on ${opp}.`;
        else if (!this.readyMe && this.readyOpp && !this.bot) text += ` ${opp} is ready.`;
      } else if (this.readyMe && !this.readyOpp) text = `You are ready. Waiting on ${opp}.`;
      else if (!this.readyMe && this.readyOpp) text = `${opp} is ready. Press Space when you are.`;
      else if (this.bot) text = `${opp}, rated ${this.bot.elo}, about ${about(typicalMs(this.bot, this.N))} on this board. Press Space when you are ready.`;
      else text = `${opp} is in. Press Space when you are ready.`;
      if (!this.bot && this.oppV < 2 && !(r && r.winner)) text += " They are on an older version, so room options and ratings are off until they update.";
    }
    this.statusEl.textContent = text;
    this.statusEl.dataset.tone = tone;
    this.roomRoot.classList.toggle("is-inviting", this.phase === "waiting" && this.role === "host");

    // the code, large, while the room waits for its second player
    const inviting = this.phase === "waiting" && this.role === "host";
    this.inviteEl.hidden = !inviting;
    clear(this.inviteEl);
    if (inviting) {
      const around = this.data.friends.filter((f) => this.presence.online(f.fc));
      this.inviteEl.append(
        h("div", { class: "label" }, "room code"),
        h("div", { class: "vs-bigcode" }, this.code),
        h("div", { class: "label" }, "or the link, which opens in any browser"),
        h("div", { class: "vs-link" }, this.inviteLink()),
        around.length
          ? h(
              "div",
              { class: "row vs-around" },
              h("span", { class: "label" }, "online now"),
              around.map((f) => h("button", { class: "btn btn--small", type: "button", onclick: () => this.challengeFriend(f.fc) }, `Challenge ${f.name || f.fc}`)),
            )
          : null,
      );
    }

    // buttons
    const canReady = this.phase === "idle" && linked && !this.readyMe;
    this.readyBtn.disabled = !canReady;
    this.readyBtn.hidden = this.phase === "racing" || this.phase === "countdown";
    const readyWord = this.readyMe ? "Ready" : this.matchOver ? "New match" : r ? "Next round" : "Ready";
    clear(this.readyBtn).append(this.phase === "waiting" && this.role === "host" ? "Copy invite link" : readyWord, canReady ? h("kbd", null, "Space") : null);
    if (this.phase === "waiting" && this.role === "host") {
      this.readyBtn.disabled = false;
      this.readyBtn.hidden = false;
    }
    this.giveBtn.hidden = !(this.phase === "racing" && r && r.me.status === "solving");

    this.renderRoomOptions();
    this.refreshOpp();
    this.renderHistory();
  }

  // whoever made the room sets it up between rounds; the guest reads the same line
  renderRoomOptions() {
    const el = clear(this.optionsEl);
    const mine = this.role === "host" && (this.phase === "idle" || this.phase === "waiting");
    const legacy = !this.bot && this.oppV < 2 && !!this.oppName;
    if (!mine) {
      el.append(h("span", { class: "label" }, "room"), h("p", { class: "hint-text vs-roomwords" }, roomWords(Object.assign({}, this.room, { rated: this.ratedNow() }))));
      return;
    }
    const pick = (key) => (value) => this.setRoom(key, value);
    el.append(
      h("div", { class: "vs-opt" }, h("span", { class: "label" }, "board"), seg(D.SIZES.map((n) => ({ value: n, label: `${n}x${n}` })), this.room.N, pick("N"), "Board size")),
    );
    if (legacy) return;
    el.append(
      h(
        "div",
        { class: "vs-opt" },
        h("span", { class: "label" }, "first to"),
        seg(D.TARGETS.map((n) => ({ value: n, label: n ? String(n) : "off", title: n ? `a match is first to ${n} rounds` : "single rounds, no match" })), this.room.to, pick("to"), "Match length"),
      ),
      h("div", { class: "vs-opt" }, h("span", { class: "label" }, "countdown"), seg(D.LEADS.map((n) => ({ value: n, label: `${n} s` })), this.room.lead, pick("lead"), "Countdown")),
      toggle("Show the board during the countdown", this.room.peek, pick("peek"), "Time to read the scramble before the clock starts."),
      this.bot ? null : toggle("Rated", this.room.rated, pick("rated"), "Rounds move both players' rating against friends."),
    );
  }

  setRoom(key, value) {
    if (this.role !== "host" || (this.phase !== "idle" && this.phase !== "waiting")) return;
    if (this.room[key] === value) return;
    this.room[key] = value;
    this.saveRoom();
    this.readyMe = this.readyOpp = false;
    if (key === "N" || key === "to") {
      this.round = null;
      this.game = null;
      this.hideVerdict();
    }
    this.send({ t: "cfg", N: this.room.N, room: this.room });
    if (key === "to" && (this.score.me || this.score.opp || this.matchOver)) {
      // a new match length starts a new match
      this.score = { me: 0, opp: 0 };
      this.rounds = [];
      this.matchOver = null;
      this.send({ t: "score", score: { host: 0, guest: 0 } });
    }
    this.showIdleBoards();
    this.refresh();
  }

  refreshOpp() {
    if (!this.oppNameEl) return;
    const r = this.round;
    const linked = !!(this.conn && this.conn.open);
    this.oppNameEl.textContent = this.oppName || "your friend";
    let text = "";
    if (!linked) text = this.oppName ? "not connected" : "not here yet";
    else if (!r || this.phase === "countdown") text = this.readyOpp ? "ready" : this.phase === "countdown" || this.bot ? "" : "not ready";
    else if (r.opp.status === "done") text = `${fmtTime(r.opp.ms)} · ${r.opp.moves} moves`;
    else if (r.opp.status === "dnf") text = "gave up";
    else if (this.phase === "idle") text = this.readyOpp ? "ready" : `still solving · ${r.opp.moves} moves`;
    else text = `${r.opp.moves} moves`;
    this.oppStateEl.textContent = text;
  }

  renderHistory() {
    // the tools under the other board: add a friend, or step to the next engine
    const tools = clear(this.oppToolsEl);
    if (this.bot) {
      const i = BOTS.indexOf(this.bot);
      const idle = this.phase === "idle";
      tools.append(
        h("button", { class: "btn btn--ghost btn--small", type: "button", disabled: !idle || i <= 0, onclick: () => this.swapBot(-1) }, "Easier"),
        h("button", { class: "btn btn--ghost btn--small", type: "button", disabled: !idle || i >= BOTS.length - 1, onclick: () => this.swapBot(1) }, "Harder"),
      );
    } else if (this.oppFc && this.conn && this.conn.open) {
      if (D.friend(this.oppFc)) tools.append(h("span", { class: "hint-text" }, "on your friends list"));
      else tools.append(h("button", { class: "btn btn--small", type: "button", onclick: () => this.addOpponent() }, "Add friend"));
    }

    clear(this.historyEl);
    const id = this.bot ? this.bot.id : this.oppFc;
    const kind = this.bot ? "e" : "f";
    const all = this.oppName ? D.tally(this.data.log.filter((x) => x.k === kind && (id ? x.id === id : x.o === this.oppName))) : null;
    if (all && all.n) this.historyEl.append(h("p", { class: "hint-text" }, `All time against ${this.oppName}: ${all.w} won, ${all.l} lost${all.d ? `, ${all.d} drawn` : ""}.`));
    const done = this.rounds.filter((x) => x.winner);
    if (!done.length) return;
    const cell = (p) => (p.status === "done" ? fmtTime(p.ms) : p.status === "dnf" ? "gave up" : "…");
    this.historyEl.append(
      h(
        "table",
        { class: "ledger vs-ledger" },
        h("thead", null, h("tr", null, h("th", null, "round"), h("th", { class: "tnum" }, "you"), h("th", { class: "tnum" }, this.oppName || "friend"), h("th", { class: "tnum" }, "rating"))),
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
                h("td", { class: "tnum" }, x.delta != null && x.eloTo != null ? signed(x.delta) : ""),
              ),
            ),
        ),
      ),
    );
  }

  addOpponent() {
    if (!this.oppFc) return;
    this.addFriendCode(this.oppFc, this.oppName);
    this.send({ t: "friend" });
    const f = D.friend(this.oppFc);
    if (f) {
      f.told = true;
      if (this.oppElo != null) f.elo = this.oppElo;
      D.save();
    }
    this.refresh();
  }

  copyInvite() {
    const link = this.inviteLink();
    copyText(`Race me on Fifteen Press: ${link} (room code ${this.code})`).then((ok) => toast(ok ? "Invite copied. Paste it to your friend." : "Could not copy. The code is " + this.code));
  }

  resetScore() {
    if (this.role !== "host" || this.phase !== "idle") return;
    this.score = { me: 0, opp: 0 };
    this.rounds = [];
    this.round = null;
    this.game = null;
    this.matchOver = null;
    this.send({ t: "score", score: { host: 0, guest: 0 } });
    this.hideVerdict();
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
    const fresh = !!this.matchOver;
    const n = fresh ? 1 : (this.rounds.length ? this.rounds[this.rounds.length - 1].n : 0) + 1;
    const rules = this.rules;
    const lead = rules.lead * 1000;
    this.send({ t: "start", n, seed, N: this.N, lead: rules.lead, peek: rules.peek, fresh });
    // the friend hears about it half a round trip later, so wait that long to count down together
    this.beginCountdown(seed, this.N, n, lead + (this.bot ? 0 : this.rtt / 2), fresh);
    this.send({ t: "ping", ts: performance.now() });
  }

  beginCountdown(seed, N, n, lead, fresh) {
    this.clearTimers();
    this.N = N;
    this.readyMe = this.readyOpp = false;
    if (fresh) {
      // the last match is over: a clean sheet for the next one
      this.score = { me: 0, opp: 0 };
      this.rounds = [];
      this.matchOver = null;
    }
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
    if (this.bot) r.plan = planRace(this.bot, board, N, lead).catch(() => null);
    const game = new Game({ N, board, seed, mode: "seed", label: "1v1" });
    this.game = game;
    game.on((type, data) => this.onGame(game, type, data));
    if (!this.view) this.renderRoom();
    this.hideVerdict();
    const covered = !this.rules.peek;
    this.view.clearProofed();
    this.view.fast = !!this.s.speedMode;
    this.view.set(board, N, { instant: true });
    this.view.setHidden(covered);
    this.oppView.clearProofed();
    this.oppView.set(board, N, { instant: true });
    this.oppView.setHidden(covered);
    this.timeEl.textContent = fmtTime(0);
    this.movesEl.textContent = "0";
    this.goAt = performance.now() + lead;
    this.countEl.hidden = false;
    this.countEl.classList.toggle("is-peek", !covered);
    this.countEl.textContent = "";
    this.refresh();
    const tick = () => {
      if (this.round !== r || this.phase !== "countdown") return;
      const left = this.goAt - performance.now();
      if (left <= 0) return this.go(r);
      const shown = String(Math.ceil(left / 1000));
      if (this.countEl.textContent !== shown) {
        this.countEl.textContent = shown;
        this.sfx("count", shown === "1");
      }
      this.later(tick, Math.min(50, left));
    };
    tick();
  }

  go(r) {
    this.phase = "racing";
    this.goAt = performance.now();
    r.goAt = this.goAt;
    this.countEl.hidden = true;
    this.countEl.textContent = "";
    this.view.setHidden(false);
    this.oppView.setHidden(false);
    if (!this.rules.peek) this.view.enter();
    this.view.setRunning(true);
    if (this.prefs.sounds) audio.go();
    else audio.thunk();
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
    if (this.bot) this.runBot(r);
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
      if (r.row) {
        // the round was already called while I was still solving: fill in my own time
        r.row.ms = r.me.ms;
        r.row.m = r.me.moves;
        D.save();
      }
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
    const nobody = winner === "draw" && r.me.status !== "done";
    if (this.oppName && !nobody) {
      // each side works out its own rating change from the same two numbers, so the two always mirror each other
      const kind = this.bot ? "engine" : "friends";
      const rated = this.ratedNow();
      const before = this.data.elo[kind];
      const out = D.recordRace({
        kind,
        opp: this.oppName,
        id: this.bot ? this.bot.id : this.oppFc,
        N: r.N,
        result: winner === "me" ? "w" : winner === "opp" ? "l" : "d",
        ms: r.me.status === "done" ? r.me.ms : 0,
        oppMs: r.opp.status === "done" ? r.opp.ms : 0,
        moves: r.me.moves,
        oppElo: this.oppElo,
        rated,
      });
      r.row = this.data.log[this.data.log.length - 1];
      if (rated) {
        r.delta = out.delta;
        r.eloFrom = before;
        r.eloTo = out.rating;
        if (!this.bot) {
          this.oppElo = D.cleanElo(this.oppElo - out.delta);
          const f = this.oppFc && D.friend(this.oppFc);
          if (f) {
            f.elo = this.oppElo;
            D.save();
          }
          this.presence.announce();
        }
      }
    }
    const to = this.rules.to;
    if (to && !this.matchOver && (this.score.me >= to || this.score.opp >= to)) {
      this.matchOver = this.score.me >= to ? "me" : "opp";
      D.recordMatch(this.matchOver === "me");
    }
    if (winner === "opp" && r.me.status === "solving") {
      // beaten to it while still solving: hear it now, see it when my own board is done
      r.toldLoss = true;
      if (this.prefs.sounds) audio.lose();
      else audio.fail();
    }
    this.settle();
  }

  // back to the waiting room once the round is called and my own board is finished
  settle() {
    const r = this.round;
    if (r && r.winner && r.me.status !== "solving" && this.phase === "racing") {
      this.phase = "idle";
      cancelAnimationFrame(this.raf);
      this.refresh();
      this.celebrate(r);
      return;
    }
    this.refresh();
  }

  // the moment a round is over for me: the word across the board, the sound, the paper
  celebrate(r) {
    this.showVerdict(r, false);
    const match = this.matchOver;
    if (r.winner === "me") {
      if (this.prefs.fx) confetti(match === "me" ? this.roomRoot : this.boardWrap, { big: match === "me" });
      this.later(() => this.sfx(match === "me" ? "fanfare" : "win"), 160);
    } else if (r.winner === "opp" && !r.toldLoss) this.later(() => this.sfx("lose"), 160);
  }

  showVerdict(r, quiet) {
    const el = this.verdictEl;
    if (!el) return;
    const match = this.matchOver;
    const word = match ? (match === "me" ? "match won" : "match lost") : r.winner === "me" ? "round won" : r.winner === "opp" ? "round lost" : "no point";
    const sub = match ? `${this.score.me} to ${this.score.opp}` : r.me.status === "done" ? fmtTime(r.me.ms) : "";
    clear(el).append(h("div", { class: "vs-verdict-word" }, word), sub ? h("div", { class: "vs-verdict-sub tnum" }, sub) : null);
    if (r.delta != null && r.eloTo != null) {
      const num = h("b", { class: "tnum" }, quiet ? r.eloTo : r.eloFrom);
      el.append(h("div", { class: "vs-verdict-elo tnum" }, "rating ", num, h("span", { "data-up": r.delta > 0 ? "1" : null }, ` ${signed(r.delta)}`)));
      if (!quiet) countTo(num, r.eloFrom, r.eloTo, 800);
    }
    el.dataset.tone = r.winner === "me" ? "good" : r.winner === "opp" ? "bad" : "";
    el.hidden = false;
    el.classList.toggle("is-quiet", !!quiet);
  }
  hideVerdict() {
    if (this.verdictEl) this.verdictEl.hidden = true;
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
