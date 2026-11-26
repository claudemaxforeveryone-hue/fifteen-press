// Friends for 1v1 with no account and no server of ours. Each device has a friend code. While the app is open it
// listens under that code on the same public PeerJS broker the rooms use, so a friend who has the code can see
// that you are around and send a challenge straight to you. Turn it off under 1v1, Options.
import * as D from "./versus-data.js";

const ID_PREFIX = "fifteen-press-u-";
const PROBE = 20000; // how often to look for friends who were offline
const PING = 8000;
const QUIET = 26000; // a line this silent is treated as gone
const RESEND = 700;
const TRIES = 8;

let peerLib = null;
export function loadPeer() {
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
export function brokerOptions() {
  try {
    const raw = localStorage.getItem("fifteen.versus.broker");
    if (raw) return JSON.parse(raw);
  } catch (e) {
    /* default broker */
  }
  return {};
}

/**
 * hooks: {
 *   name(): my display name, elo(): my friends rating,
 *   onChange(): a friend came or went, or the list changed,
 *   onChallenge({fc, name, code, room}), onAnswer({fc, name, answer}), onAdded({fc, name})
 * }
 */
export class Presence {
  constructor(hooks) {
    this.hooks = hooks;
    this.peer = null;
    this.state = "off"; // off | starting | on | elsewhere | failed
    this.links = new Map(); // friend code -> Set of connections
    this.sure = new Map(); // message id -> { fc, msg, tries }
    this.seen = [];
    this.timer = 0;
    this.lastProbe = 0;
  }

  get wanted() {
    return D.load().prefs.online;
  }

  async start() {
    if (!this.wanted || this.state === "starting" || this.state === "on" || this.state === "elsewhere") return;
    this.state = "starting";
    try {
      await loadPeer();
    } catch (e) {
      this.state = "failed";
      return;
    }
    if (this.state !== "starting") return;
    const peer = new window.Peer(ID_PREFIX + D.load().fc, brokerOptions());
    this.peer = peer;
    peer.on("open", () => {
      if (this.peer !== peer) return;
      this.state = "on";
      this.probe(true);
      this.hooks.onChange();
    });
    peer.on("connection", (conn) => {
      if (this.peer !== peer) return;
      const fc = conn.metadata && conn.metadata.fc;
      if (!D.isFriendCode(fc) || fc === D.load().fc) {
        conn.on("open", () => conn.close());
        return;
      }
      this.adopt(conn, fc);
    });
    peer.on("error", (err) => {
      if (this.peer !== peer) return;
      const type = (err && err.type) || "";
      if (type === "peer-unavailable") return; // a friend who is not around right now
      if (type === "unavailable-id") {
        // this friend code is already listening in another window of the app
        this.state = "elsewhere";
        this.peer = null;
        peer.destroy();
        this.hooks.onChange();
        return;
      }
      if (this.state === "starting") {
        this.state = "failed";
        this.peer = null;
        peer.destroy();
        this.hooks.onChange();
      }
    });
    peer.on("disconnected", () => {
      // the broker dropped: open lines to friends carry on, and we ask to be listed again
      setTimeout(() => {
        if (this.peer === peer && !peer.destroyed && peer.disconnected) {
          try {
            peer.reconnect();
          } catch (e) {
            /* tried */
          }
        }
      }, 2000);
    });
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop() {
    clearInterval(this.timer);
    const peer = this.peer;
    this.peer = null;
    this.state = "off";
    this.links.clear();
    this.sure.clear();
    if (peer) peer.destroy();
    this.hooks.onChange();
  }

  // a failed start gets another go the next time the 1v1 page asks
  retry() {
    if (this.state === "failed") this.state = "off";
    return this.start();
  }

  online(fc) {
    const set = this.links.get(fc);
    if (set) for (const c of set) if (c.open) return true;
    return false;
  }

  line(fc) {
    const set = this.links.get(fc);
    if (set) for (const c of set) if (c.open) return c;
    return null;
  }

  adopt(conn, fc) {
    let set = this.links.get(fc);
    if (!set) this.links.set(fc, (set = new Set()));
    set.add(conn);
    conn.fpSeen = performance.now();
    conn.on("open", () => {
      conn.fpSeen = performance.now();
      this.say(conn, { t: "hi", name: this.hooks.name(), elo: this.hooks.elo() });
      const f = D.friend(fc);
      if (f && !f.told) this.sendSure(fc, { t: "added", name: this.hooks.name() });
      this.hooks.onChange();
    });
    conn.on("data", (msg) => {
      if (!msg || typeof msg !== "object") return;
      conn.fpSeen = performance.now();
      try {
        this.onData(conn, fc, msg);
      } catch (e) {
        console.error("1v1 friends message", e);
      }
    });
    const gone = () => {
      const s = this.links.get(fc);
      if (!s || !s.has(conn)) return;
      s.delete(conn);
      if (!s.size) this.links.delete(fc);
      this.hooks.onChange();
    };
    conn.on("close", gone);
    conn.on("error", gone);
  }

  say(conn, msg) {
    try {
      if (conn && conn.open) conn.send(msg);
    } catch (e) {
      /* the close event follows */
    }
  }

  // sent again until the other side confirms it
  sendSure(fc, msg) {
    msg.id = D.randomCode(10);
    this.sure.set(msg.id, { fc, msg, tries: 0, at: 0 });
    this.flush();
    return msg.id;
  }

  flush() {
    const now = performance.now();
    for (const [id, item] of this.sure) {
      if (now - item.at < RESEND) continue;
      const conn = this.line(item.fc);
      if (!conn || item.tries >= TRIES) {
        if (item.tries >= TRIES || now - (item.born || (item.born = now)) > 15000) this.sure.delete(id);
        continue;
      }
      item.at = now;
      item.tries++;
      this.say(conn, item.msg);
    }
  }

  onData(conn, fc, msg) {
    if (msg.t === "ack") {
      const item = this.sure.get(msg.id);
      if (item) {
        this.sure.delete(msg.id);
        if (item.msg.t === "added") {
          const f = D.friend(fc);
          if (f) {
            f.told = true;
            D.save();
          }
        }
      }
      return;
    }
    if (msg.id) {
      this.say(conn, { t: "ack", id: msg.id });
      if (this.seen.includes(msg.id)) return;
      this.seen.push(msg.id);
      if (this.seen.length > 200) this.seen.shift();
    }
    const known = D.friend(fc);
    const name = D.cleanName(msg.name) || (known && known.name) || "A player";
    switch (msg.t) {
      case "hi":
        if (known) {
          const elo = D.cleanElo(msg.elo);
          if (known.name !== name || known.elo !== elo) {
            known.name = name;
            known.elo = elo;
            D.save();
          }
          this.hooks.onChange();
        }
        break;
      case "ping":
        break;
      case "who":
        this.say(conn, { t: "hi", name: this.hooks.name(), elo: this.hooks.elo() });
        break;
      case "added":
        if (!known) this.hooks.onAdded({ fc, name });
        break;
      case "challenge":
        if (typeof msg.code === "string" && /^[A-Z0-9]{4,12}$/.test(msg.code)) this.hooks.onChallenge({ fc, name, code: msg.code, room: D.cleanRoom(msg.room), known: !!known });
        break;
      case "answer":
        if (msg.a === "no" || msg.a === "busy") this.hooks.onAnswer({ fc, name, answer: msg.a });
        break;
    }
  }

  /** Ask a friend into a room. False when there is no open line to them. */
  challenge(fc, code, room) {
    if (!this.online(fc)) return false;
    this.sendSure(fc, { t: "challenge", code, room, name: this.hooks.name() });
    return true;
  }
  answer(fc, a) {
    if (this.online(fc)) this.sendSure(fc, { t: "answer", a, name: this.hooks.name() });
  }

  // just added them: ask for their name and rating again, the first hello came before they were on my list
  ask(fc) {
    const conn = this.line(fc);
    if (conn) this.say(conn, { t: "who" });
  }

  // tell every connected friend my name or rating changed
  announce() {
    for (const set of this.links.values()) for (const c of set) this.say(c, { t: "hi", name: this.hooks.name(), elo: this.hooks.elo() });
  }

  /** Dial the friends we have no line to. */
  probe(force) {
    if (this.state !== "on" || !this.peer || this.peer.destroyed || this.peer.disconnected) return;
    const now = performance.now();
    if (!force && now - this.lastProbe < PROBE) return;
    this.lastProbe = now;
    for (const f of D.load().friends) {
      const set = this.links.get(f.fc);
      if (set && set.size) continue; // open, or still being set up
      let conn;
      try {
        conn = this.peer.connect(ID_PREFIX + f.fc, { reliable: true, serialization: "json", metadata: { fc: D.load().fc } });
      } catch (e) {
        continue;
      }
      if (!conn) continue;
      this.adopt(conn, f.fc);
      // a dial that never opens (friend offline) is dropped so the next round can try again
      setTimeout(() => {
        if (conn.open) return;
        const s = this.links.get(f.fc);
        if (s && s.has(conn)) {
          s.delete(conn);
          if (!s.size) this.links.delete(f.fc);
        }
        try {
          conn.close();
        } catch (e) {
          /* never opened */
        }
      }, 12000);
    }
  }

  tick() {
    if (this.state !== "on") return;
    const now = performance.now();
    this.flush();
    if (document.visibilityState !== "hidden") this.probe(false);
    if (now - (this.lastPing || 0) < PING) return;
    this.lastPing = now;
    for (const [fc, set] of this.links)
      for (const c of [...set]) {
        if (!c.open) continue;
        if (now - c.fpSeen > QUIET) {
          set.delete(c);
          if (!set.size) this.links.delete(fc);
          try {
            c.close();
          } catch (e) {
            /* already gone */
          }
          this.hooks.onChange();
        } else this.say(c, { t: "ping" });
      }
  }
}
