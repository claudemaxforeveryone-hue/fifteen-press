// Each theme is a page colour, a set of inks and a tile material. Lamplight is the house look
// (Documents\School\Other\design-guide.md); the press runs after it are the older looks, kept on offer.
export const THEMES = {
  lamp: {
    name: "Lamplight",
    note: "Night ink and one lamp. A tile that is home is a lit window",
    dark: true,
    paper: "#0b1122",
    paper2: "#121a30",
    paper3: "#18223c",
    rule: "#232e4d",
    ink: "#e3e8fb",
    ink2: "#c5cbe3",
    ink3: "#8a93b3",
    faint: "#5d6888",
    spot: "#f4c58a",
    spotInk: "#0b1122",
    alert: "#ff8a8a",
    chase: "#121a30",
    bed: "#0b1122",
    block: "#1b2643",
    blockEdge: "#232e4d",
    numeral: "#e3e8fb",
    inks: ["#e3e8fb", "#f4c58a", "#eaa7bd"],
    chartA: "#eaa7bd",
    chartB: "#f4c58a",
    // heat maps: a good cell is warm like the lamp, a poor one goes cold
    heatGood: "#f4c58a",
    heatBad: "#6f8fe0",
    words: { good: "amber", bad: "pink", warm: "amber", cold: "blue" },
  },
  proof: {
    name: "Proof",
    note: "Newsprint, maple blocks, black and vermilion",
    dark: false,
    paper: "#E9E7E1",
    paper2: "#F5F3EF",
    rule: "rgba(23,23,26,.14)",
    ink: "#17171A",
    ink2: "#45454B",
    ink3: "#606067",
    spot: "#D9442B",
    spotInk: "#FFFCF7",
    chase: "#2A2C31",
    bed: "#1A1B1F",
    block: "#E8CFA3",
    blockEdge: "#A8804C",
    numeral: "#17171A",
    inks: ["#17171A", "#D9442B", "#2F5DA8"],
    chartA: "#D9442B",
    chartB: "#2F5DA8",
  },
  nightshift: {
    name: "Night shift",
    note: "Walnut blocks under a work lamp",
    dark: true,
    paper: "#131315",
    paper2: "#1C1C1F",
    rule: "rgba(236,231,221,.12)",
    ink: "#ECE7DD",
    ink2: "#BDB8AE",
    ink3: "#959088",
    spot: "#F0583C",
    spotInk: "#140B08",
    chase: "#2B2B2F",
    bed: "#0A0A0B",
    block: "#5A3F2C",
    blockEdge: "#22160E",
    numeral: "#F3E8D3",
    inks: ["#F3E8D3", "#FF7A5C", "#8FB0EE"],
    chartA: "#F0583C",
    chartB: "#5C86D6",
  },
  riso: {
    name: "Riso",
    note: "Fluoro pink over federal blue, slightly off register",
    dark: false,
    paper: "#F1EDE4",
    paper2: "#FAF7F1",
    rule: "rgba(31,42,92,.16)",
    ink: "#1F2A5C",
    ink2: "#3D477A",
    ink3: "#58618F",
    spot: "#E8398F",
    spotInk: "#FFFCF7",
    chase: "#2F4AA0",
    bed: "#22397F",
    block: "#FBF8F2",
    blockEdge: "#C9C0AF",
    numeral: "#E8398F",
    misregister: "#2F4AA0",
    inks: ["#E8398F", "#2F4AA0", "#F2A516"],
    chartA: "#D9367F",
    chartB: "#2F4AA0",
  },
  lead: {
    name: "Hot metal",
    note: "Lead sorts, brass rule, machine grey",
    dark: true,
    paper: "#25282C",
    paper2: "#2F3338",
    rule: "rgba(231,233,236,.12)",
    ink: "#E7E9EC",
    ink2: "#BCC1C8",
    ink3: "#959BA3",
    spot: "#E2B04A",
    spotInk: "#1A1408",
    chase: "#111214",
    bed: "#0B0C0D",
    block: "#A3A8B0",
    blockEdge: "#565B62",
    numeral: "#121316",
    inks: ["#121316", "#8E2A18", "#1E3F7A"],
    chartA: "#E2B04A",
    chartB: "#5C86D6",
    words: { bad: "gold" },
  },
  circus: {
    name: "Circus bill",
    note: "Wood type on a yellow poster",
    dark: false,
    paper: "#F1C232",
    paper2: "#F6D466",
    rule: "rgba(22,20,17,.2)",
    ink: "#161411",
    ink2: "#38311F",
    ink3: "#4F4628",
    spot: "#C0241A",
    spotInk: "#FFFCF7",
    chase: "#161411",
    bed: "#0E0D0B",
    block: "#FBF5E6",
    blockEdge: "#BBAA7C",
    numeral: "#161411",
    inks: ["#161411", "#C0241A", "#1E4A9A"],
    chartA: "#C0241A",
    chartB: "#1E4A9A",
  },
  kraft: {
    name: "Kraft",
    note: "Rubber stamps on brown paper",
    dark: false,
    paper: "#C9A67A",
    paper2: "#D8BB94",
    rule: "rgba(27,20,13,.2)",
    ink: "#1B140D",
    ink2: "#3A2C1D",
    ink3: "#4E3C29",
    spot: "#B83A1E",
    spotInk: "#FFFCF7",
    chase: "#3A2A1B",
    bed: "#22180E",
    block: "#1E1914",
    blockEdge: "#0E0B08",
    numeral: "#EBDDC2",
    inks: ["#EBDDC2", "#FF8A5E", "#9DC1FF"],
    chartA: "#A8341B",
    chartB: "#24508F",
  },
  navy: {
    name: "Navy ink",
    note: "Cream blocks in a navy chase",
    dark: true,
    paper: "#14213D",
    paper2: "#1B2B4D",
    rule: "rgba(242,235,221,.14)",
    ink: "#F2EBDD",
    ink2: "#C9C3B6",
    ink3: "#A19C93",
    spot: "#F4A93B",
    spotInk: "#1A1205",
    chase: "#0C1529",
    bed: "#070D1C",
    block: "#EFE6D2",
    blockEdge: "#A99A78",
    numeral: "#14213D",
    inks: ["#14213D", "#B8402A", "#2F7A5A"],
    chartA: "#F4A93B",
    chartB: "#6FA0F0",
    words: { bad: "amber" },
  },
  grape: {
    name: "Grape soda",
    note: "The classic web look: purple field, mint tiles",
    dark: true,
    paper: "#5A3E7B",
    paper2: "#4A3266",
    rule: "rgba(255,255,255,.16)",
    ink: "#FFFCF7",
    ink2: "#E4DAF2",
    ink3: "#CFC2E3",
    spot: "#6FCDBE",
    spotInk: "#1E1233",
    // the spot matches the mint blocks here, so home tiles get their own orange
    home: "#E2702F",
    homeInk: "#FFFCF7",
    chase: "#4A3266",
    bed: "#3D2956",
    block: "#6FCDBE",
    blockEdge: "#3E9488",
    numeral: "#FFFCF7",
    numeralShadow: "#3E9488",
    inks: ["#FFFCF7", "#2D1B47", "#FFE08A"],
    chartA: "#FF8FB1",
    chartB: "#7FE0D0",
    words: { good: "mint", bad: "pink" },
  },  minimal: {
    name: "Minimal",
    note: "Speed mode, light: white blocks, black figures, blue when home",
    dark: false,
    paper: "#F3F3F1",
    paper2: "#FAFAF8",
    rule: "rgba(17,18,20,.12)",
    ink: "#111214",
    ink2: "#4A4B50",
    ink3: "#6B6C72",
    spot: "#111214",
    spotInk: "#FAFAF8",
    home: "#2F6FEB",
    homeInk: "#FAFAF8",
    chase: "#E2E2DE",
    bed: "#E2E2DE",
    block: "#FDFDFB",
    blockEdge: "#CFCFCA",
    numeral: "#111214",
    inks: ["#111214", "#D9442B", "#2F5DA8"],
    chartA: "#D9442B",
    chartB: "#2F5DA8",
  },
  void: {
    name: "Void",
    note: "Speed mode, dark: graphite blocks, white figures, blue when home",
    dark: true,
    paper: "#0E0F11",
    paper2: "#17181B",
    rule: "rgba(242,242,240,.12)",
    ink: "#F2F2F0",
    ink2: "#B9BAC0",
    ink3: "#8C8D94",
    spot: "#F2F2F0",
    spotInk: "#0E0F11",
    home: "#3D7BF0",
    homeInk: "#F7F8FA",
    chase: "#17181B",
    bed: "#17181B",
    block: "#2A2C31",
    blockEdge: "#1F2125",
    numeral: "#F2F2F0",
    inks: ["#F2F2F0", "#F0583C", "#5C86D6"],
    chartA: "#F0583C",
    chartB: "#5C86D6",
  },

};

export const FACES = {
  maple: {
    name: "Mono",
    family: '"Maple Mono", Consolas, monospace',
    scale: 0.4,
    weight: 600,
    note: "Maple Mono, the face the rest of the app is set in",
  },
  ultra: {
    name: "Fat slab",
    family: '"Ultra", Georgia, serif',
    scale: 0.5,
    note: "Wood-type slab, heavy and round",
  },
  rozha: {
    name: "Fat face",
    family: '"Rozha One", Georgia, serif',
    scale: 0.62,
    note: "High-contrast poster Didone",
  },
  gothic: {
    name: "Gothic",
    family: '"Big Shoulders Display", "Arial Narrow", sans-serif',
    scale: 0.7,
    weight: 800,
    note: "Condensed wood gothic",
  },
  grotesk: {
    name: "Grotesk",
    family: '"Archivo", system-ui, sans-serif',
    scale: 0.52,
    weight: 800,
    stretch: "112%",
    note: "Wide modern sans",
  },
};

export const COLORINGS = {
  single: { name: "One ink", note: "Every numeral in the same ink" },
  correct: { name: "Light up home", note: "A tile lights up the moment it reaches its home cell" },
  rows: { name: "By row", note: "Each row prints in its own ink" },
  fringe: { name: "Fringe", note: "L-shaped layers in solving order" },
  fringeBlocks: {
    name: "Fringe blocks",
    note: "Whole blocks coloured by layer",
  },
};

// Copy that points at a colour ("the blue line") asks here, so the word matches the theme that is on.
// good and bad are the two chart inks; warm and cold are the two ends of a heat map.
let current = null;
export function colourWords() {
  const t = current || THEMES.lamp;
  const w = { good: "blue", bad: "red", ...(t.words || {}) };
  return { warm: w.good, cold: w.bad, ...w };
}
export const cap = (word) => word[0].toUpperCase() + word.slice(1);

export function resolveTheme(id) {
  if (id === "auto" || !THEMES[id]) {
    // An embedding host may pin light or dark on <html data-theme>; otherwise follow the OS.
    const pinned = document.documentElement.getAttribute("data-theme");
    const dark = pinned === "dark" || (pinned !== "light" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    return {
      id: dark ? "nightshift" : "proof",
      ...THEMES[dark ? "nightshift" : "proof"],
    };
  }
  return { id, ...THEMES[id] };
}

export function applyTheme(id, faceId) {
  const t = resolveTheme(id);
  current = t;
  const f = FACES[faceId] || FACES.maple;
  const r = document.documentElement.style;
  const vars = {
    paper: t.paper,
    "paper-2": t.paper2,
    // hover, selected rows and input fields: one step up from paper-2
    "paper-3": t.paper3 || `color-mix(in srgb, ${t.paper2} 90%, ${t.ink})`,
    rule: t.rule,
    ink: t.ink,
    "ink-2": t.ink2,
    "ink-3": t.ink3,
    // disabled and past: never for anything that has to be read
    faint: t.faint || `color-mix(in srgb, ${t.ink3} 65%, ${t.paper})`,
    // late, error, failed. only those
    alert: t.alert || (t.dark ? "#ff8a8a" : "#b3261e"),
    spot: t.spot,
    "spot-ink": t.spotInk,
    home: t.home || t.spot,
    "home-ink": t.homeInk || t.spotInk,
    chase: t.chase,
    bed: t.bed,
    block: t.block,
    "block-edge": t.blockEdge,
    numeral: t.numeral,
    "ink-a": t.inks[0],
    "ink-b": t.inks[1],
    "ink-c": t.inks[2],
    "chart-a": t.chartA,
    "chart-b": t.chartB,
    "heat-good": t.heatGood || t.chartB,
    "heat-bad": t.heatBad || t.chartA,
    misregister: t.misregister || "transparent",
    "numeral-shadow": t.numeralShadow || "transparent",
    "numeral-face": f.family,
    "numeral-scale": f.scale,
    "numeral-weight": f.weight || 400,
    "numeral-stretch": f.stretch || "100%",
  };
  for (const [k, v] of Object.entries(vars)) r.setProperty("--" + k, v);
  document.documentElement.dataset.press = t.id;
  document.documentElement.dataset.mode = t.dark ? "dark" : "light";
  document.documentElement.style.colorScheme = t.dark ? "dark" : "light";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t.paper;
  return t;
}

// Per-tile ink for a colouring scheme. Returns {ink, face} (face null = theme block colour).
export function tileInk(coloring, tile, cell, N) {
  const goal = tile - 1;
  const gr = Math.floor(goal / N),
    gc = goal % N;
  switch (coloring) {
    case "rows":
      return { ink: `var(--ink-${"abc"[gr % 3]})`, face: null };
    case "fringe":
      return { ink: `var(--ink-${"abc"[Math.min(gr, gc) % 3]})`, face: null };
    case "fringeBlocks": {
      const layer = Math.min(gr, gc) % 3;
      return { ink: "var(--block)", face: `var(--ink-${"abc"[layer]})` };
    }
    case "correct":
      return cell === goal
        ? { ink: "var(--home-ink)", face: "var(--home)" }
        : { ink: "var(--numeral)", face: null };
    default:
      return { ink: "var(--numeral)", face: null };
  }
}
