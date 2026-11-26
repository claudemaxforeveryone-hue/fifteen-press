// The showy bits of 1v1: a notice that can be answered from any page, and paper confetti for a win.
import { h } from "./ui.js";
import { motion } from "./motion.js";

let stack = null;

/**
 * A notice at the top of the window with one or two buttons. Returns a function that removes it.
 * opts: { title, text, actions: [{ label, primary, run }], ms }
 */
export function notice({ title, text, actions = [], ms = 40000 }) {
  if (!stack) {
    stack = h("div", { class: "vs-notices", role: "region", "aria-label": "1v1 notices" });
    document.body.appendChild(stack);
  }
  let timer = 0;
  const close = () => {
    clearTimeout(timer);
    el.remove();
  };
  const el = h(
    "div",
    { class: "vs-notice", role: "alertdialog", "aria-label": title },
    h("div", { class: "vs-notice-text" }, h("b", null, title), text ? h("span", null, text) : null),
    h(
      "div",
      { class: "vs-notice-actions" },
      actions.map((a) =>
        h(
          "button",
          {
            class: "btn btn--small" + (a.primary ? " btn--primary" : " btn--ghost"),
            type: "button",
            onclick: () => {
              close();
              if (a.run) a.run();
            },
          },
          a.label,
        ),
      ),
    ),
  );
  stack.appendChild(el);
  if (ms) timer = setTimeout(close, ms);
  return close;
}

function inks() {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => (cs.getPropertyValue(name) || "").trim() || fallback;
  return [pick("--spot", "#f4c58a"), pick("--ink-c", "#eaa7bd"), pick("--ink", "#e3e8fb"), pick("--spot", "#f4c58a")];
}

let live = null;

/**
 * Paper offcuts thrown up from an element and left to fall. big = a match, not just a round.
 * Does nothing when motion is reduced.
 */
export function confetti(anchor, { big = false } = {}) {
  if (motion.reduced || !anchor || !anchor.isConnected) return;
  if (live) live.stop();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = window.innerWidth,
    H = window.innerHeight;
  const canvas = h("canvas", { class: "vs-confetti", "aria-hidden": "true" });
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  document.body.appendChild(canvas);
  const g = canvas.getContext("2d");
  g.scale(dpr, dpr);
  const box = anchor.getBoundingClientRect();
  const colors = inks();
  const count = big ? 170 : 70;
  const life = big ? 3400 : 2000;
  const bits = [];
  for (let i = 0; i < count; i++) {
    const fromLeft = i % 2 === 0;
    const spread = big ? 1 : 0.7;
    bits.push({
      x: box.left + box.width * (big ? Math.random() : 0.2 + Math.random() * 0.6),
      y: box.top + box.height * (big ? 0.35 : 0.5),
      vx: (fromLeft ? -1 : 1) * (40 + Math.random() * 260) * spread,
      vy: -(260 + Math.random() * 420) * (big ? 1.15 : 1),
      w: 5 + Math.random() * 6,
      h: 3 + Math.random() * 7,
      spin: (Math.random() - 0.5) * 12,
      a: Math.random() * Math.PI,
      flip: 2 + Math.random() * 5,
      color: colors[i % colors.length],
      delay: big ? Math.random() * 500 : Math.random() * 90,
    });
  }
  const t0 = performance.now();
  let last = t0;
  let raf = 0;
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const age = now - t0;
    g.clearRect(0, 0, W, H);
    for (const b of bits) {
      if (age < b.delay) continue;
      b.vy += 900 * dt;
      b.vx *= 1 - 0.9 * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.a += b.spin * dt;
      const fade = Math.max(0, Math.min(1, (life - age) / 500));
      g.save();
      g.globalAlpha = fade;
      g.translate(b.x, b.y);
      g.rotate(b.a);
      g.scale(1, Math.cos((age / 1000) * b.flip));
      g.fillStyle = b.color;
      g.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      g.restore();
    }
    if (age < life) raf = requestAnimationFrame(frame);
    else stop();
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    canvas.remove();
    if (live && live.canvas === canvas) live = null;
  };
  live = { canvas, stop };
  raf = requestAnimationFrame(frame);
}

/** Counts a number up or down to its new value over a short moment. */
export function countTo(el, from, to, ms = 700) {
  if (motion.reduced || from === to) {
    el.textContent = String(to);
    return;
  }
  const t0 = performance.now();
  const step = (now) => {
    if (!el.isConnected) return;
    const k = Math.min(1, (now - t0) / ms);
    const eased = 1 - (1 - k) ** 3;
    el.textContent = String(Math.round(from + (to - from) * eased));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
