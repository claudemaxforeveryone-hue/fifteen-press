// Synthesized sound, no samples. Each pack is a different instrument for the same four events:
// a tile sliding, a tile landing home, a blocked move, and the solve.
let ctx = null;
let out = null;
let verb = null;
let enabled = true;
let volume = 0.5;
let pack = "wood";
let homePing = true;
let noise = null;

export const PACKS = {
  wood: { name: "Wood", note: "Maple blocks on a steel bed" },
  felt: { name: "Felt", note: "Soft, low and quiet" },
  marimba: {
    name: "Marimba",
    note: "Every tile has its own note, so a clean solve plays a tune",
  },
  keys: { name: "Switches", note: "Clicky mechanical keyboard" },
  glass: { name: "Glass", note: "Bright little bells" },
};

// C major pentatonic across three octaves, so any run of tiles sounds in key
const SCALE = [0, 2, 4, 7, 9];
const noteFor = (i) =>
  261.63 * 2 ** ((SCALE[i % 5] + 12 * Math.floor(i / 5)) / 12);

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    const len = Math.floor(ctx.sampleRate * 0.4);
    noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // gentle glue: a soft compressor, then a short room for the tonal packs
    out = ctx.createDynamicsCompressor();
    out.threshold.value = -18;
    out.ratio.value = 3;
    out.attack.value = 0.002;
    out.release.value = 0.12;
    out.connect(ctx.destination);
    verb = ctx.createConvolver();
    const ir = ctx.createBuffer(
      2,
      Math.floor(ctx.sampleRate * 0.9),
      ctx.sampleRate,
    );
    for (let ch = 0; ch < 2; ch++) {
      const b = ir.getChannelData(ch);
      for (let i = 0; i < b.length; i++)
        b[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / b.length, 3.2);
    }
    verb.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = 0.18;
    verb.connect(wet).connect(out);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export function configure(on, vol, packId, ping) {
  enabled = on;
  volume = vol;
  if (packId && PACKS[packId]) pack = packId;
  if (ping != null) homePing = ping;
}

function chain(c, pan, reverb) {
  const g = c.createGain();
  let node = g;
  if (c.createStereoPanner && pan) {
    const p = c.createStereoPanner();
    p.pan.value = pan;
    g.connect(p);
    node = p;
  }
  node.connect(out);
  if (reverb) node.connect(verb);
  return g;
}

function burst(
  c,
  {
    freq,
    q = 4,
    dur,
    gain,
    when = 0,
    type = "bandpass",
    pan = 0,
    reverb = false,
  },
) {
  const t = c.currentTime + when;
  const src = c.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.9 + Math.random() * 0.2;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = chain(c, pan, reverb);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain * volume, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g);
  src.start(t, Math.random() * 0.2);
  src.stop(t + dur + 0.03);
}

function tone(
  c,
  {
    freq,
    dur,
    gain,
    when = 0,
    type = "sine",
    drop = 0.7,
    pan = 0,
    reverb = false,
    attack = 0.003,
  },
) {
  const t = c.currentTime + when;
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (drop !== 1)
    o.frequency.exponentialRampToValueAtTime(freq * drop, t + dur);
  const g = chain(c, pan, reverb);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain * volume, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  o.start(t);
  o.stop(t + dur + 0.03);
}

// a struck bar: fundamental plus the bright 4x partial that dies fast
function mallet(c, freq, gain, when = 0, pan = 0, dur = 0.5) {
  tone(c, { freq, dur, gain, when, drop: 1, pan, reverb: true, attack: 0.002 });
  tone(c, {
    freq: freq * 3.98,
    dur: dur * 0.18,
    gain: gain * 0.35,
    when,
    drop: 1,
    pan,
    reverb: true,
    attack: 0.001,
  });
  burst(c, { freq: freq * 6, q: 2, dur: 0.012, gain: gain * 0.25, when, pan });
}

let last = 0;
/** One slide. `tile` and `col`/`N` let packs pick a pitch and place it left to right. */
export function tock({ tile = 1, col = 0, N = 4, home = false } = {}) {
  if (!enabled) return;
  const now = performance.now();
  const c = ac();
  if (!c) return;
  // a multi-tile slide would stack into mush, so only the first tile clicks; home pings always play
  const quiet = now - last < 14;
  if (!quiet) last = now;
  const pan = N > 1 ? ((col / (N - 1)) * 2 - 1) * 0.45 : 0;
  const jitter = 0.94 + Math.random() * 0.12;
  if (quiet) {
    // no click
  } else if (pack === "wood") {
    burst(c, { freq: 1900 * jitter, q: 7, dur: 0.04, gain: 0.5, pan });
    tone(c, { freq: 420 * jitter, dur: 0.05, gain: 0.16, drop: 0.6, pan });
    burst(c, { freq: 5200, q: 1.2, dur: 0.008, gain: 0.12, pan });
  } else if (pack === "felt") {
    burst(c, {
      freq: 520 * jitter,
      q: 1.1,
      dur: 0.07,
      gain: 0.55,
      type: "lowpass",
      pan,
    });
    tone(c, { freq: 140 * jitter, dur: 0.07, gain: 0.22, drop: 0.5, pan });
  } else if (pack === "marimba") {
    mallet(c, noteFor(tile - 1), 0.32, 0, pan, 0.45);
  } else if (pack === "keys") {
    burst(c, { freq: 3800 * jitter, q: 5, dur: 0.012, gain: 0.45, pan });
    burst(c, {
      freq: 1200 * jitter,
      q: 2,
      dur: 0.03,
      gain: 0.35,
      when: 0.022,
      pan,
    });
    tone(c, { freq: 180, dur: 0.035, gain: 0.12, when: 0.022, drop: 0.5, pan });
  } else if (pack === "glass") {
    const f = noteFor(tile + 9);
    tone(c, { freq: f, dur: 0.35, gain: 0.12, drop: 1, pan, reverb: true });
    tone(c, {
      freq: f * 2.76,
      dur: 0.12,
      gain: 0.05,
      drop: 1,
      pan,
      reverb: true,
    });
  }
  if (home && homePing) {
    // a small bright tick a beat later: this tile just reached its cell
    const f =
      pack === "felt" ? 660 : pack === "marimba" ? noteFor(tile - 1) * 2 : 1320;
    tone(c, {
      freq: f,
      dur: 0.16,
      gain: 0.07,
      when: 0.035,
      drop: 1,
      pan,
      reverb: true,
      type: "triangle",
    });
  }
}

export function bump() {
  if (!enabled) return;
  const c = ac();
  if (!c) return;
  if (pack === "marimba" || pack === "glass")
    tone(c, { freq: 98, dur: 0.12, gain: 0.25, drop: 0.8 });
  else burst(c, { freq: 320, q: 2.5, dur: 0.07, gain: 0.3 });
}

/** The solve: a chord that rises with the pack's own voice. */
export function thunk() {
  if (!enabled) return;
  const c = ac();
  if (!c) return;
  if (pack === "wood" || pack === "keys") {
    burst(c, { freq: 170, q: 1.2, dur: 0.24, gain: 0.85 });
    tone(c, { freq: 88, dur: 0.32, gain: 0.45 });
  } else if (pack === "felt") {
    tone(c, { freq: 110, dur: 0.4, gain: 0.4 });
  }
  const base = pack === "felt" ? 0 : 5;
  [0, 2, 4, 5, 7].forEach((step, i) => {
    const f = noteFor(base + step);
    if (pack === "marimba" || pack === "felt" || pack === "wood")
      mallet(c, f, 0.22, 0.06 + i * 0.07, (i - 2) * 0.2, 0.9);
    else
      tone(c, {
        freq: f * 2,
        dur: 0.6,
        gain: 0.08,
        when: 0.06 + i * 0.06,
        drop: 1,
        reverb: true,
        pan: (i - 2) * 0.2,
      });
  });
}

export function chime() {
  if (!enabled) return;
  const c = ac();
  if (!c) return;
  mallet(c, 880, 0.14, 0, 0, 0.4);
  mallet(c, 1318.5, 0.11, 0.08, 0, 0.5);
}

/** A run that failed a rule mod: two falling notes. */
export function fail() {
  if (!enabled) return;
  const c = ac();
  if (!c) return;
  tone(c, { freq: 330, dur: 0.22, gain: 0.18, type: "triangle", drop: 0.9 });
  tone(c, {
    freq: 220,
    dur: 0.4,
    gain: 0.18,
    when: 0.16,
    type: "triangle",
    drop: 0.85,
  });
}

/** Lets the settings page audition a pack. */
export function preview() {
  const N = 4;
  [1, 2, 3, 4].forEach((tile, i) =>
    setTimeout(() => {
      last = 0;
      tock({ tile, col: i, N, home: i === 3 });
    }, i * 110),
  );
}
