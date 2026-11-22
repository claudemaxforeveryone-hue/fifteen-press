// Every mod, grouped by what it does to a run. Any of these on tags the solve and keeps it off the boards.
export const MOD_GROUPS = [
  {
    name: "Training",
    mods: [
      {
        key: "modLiveDistance",
        name: "Live distance",
        text: "Shows the exact number of moves left after every move (estimate above 4×4).",
      },
      {
        key: "modGhostHint",
        name: "Ghost hint",
        text: "Always highlights the next optimal tile. Training wheels.",
      },
      {
        key: "modUndo",
        name: "Undo",
        text: "Take back moves with Z without them counting.",
      },
      {
        key: "modHeatmap",
        name: "Heatmap",
        text: "Tints each block by how far it sits from home.",
      },
    ],
  },
  {
    name: "Memory and sight",
    mods: [
      {
        key: "modFog",
        name: "Fog",
        text: "Only the tiles touching the gap show their numbers.",
      },
      {
        key: "modVanish",
        name: "Vanish on home",
        text: "A tile's number disappears once it reaches its cell. Remember what you placed.",
      },
      {
        key: "modDistNums",
        name: "Distance numbers",
        text: "Tiles show how far they are from home instead of who they are.",
      },
    ],
  },
  {
    name: "Twisted board",
    mods: [
      {
        key: "modMirror",
        name: "Mirror",
        text: "The board is drawn back to front. Left on the keys moves right on screen.",
      },
      {
        key: "modFlip",
        name: "Upside down",
        text: "The board is turned 180°. Every key feels reversed.",
      },
    ],
  },
  {
    name: "Rules",
    mods: [
      {
        key: "modBudget",
        name: "Move budget",
        text: "Optimal plus 20 moves on 4×4, plus 10 on 3×3. Go over and the run ends. 3×3 and 4×4 only, where the engine knows the exact optimal.",
      },
      {
        key: "modTimeAttack",
        name: "Time attack",
        text: "Beat the clock: 10 s on 3×3, 30 s on 4×4, 75 s on 5×5, longer above.",
      },
      {
        key: "modNoWrong",
        name: "Sudden death",
        text: "One move away from the goal and the run is over. 3×3 and 4×4 only.",
      },
      {
        key: "modMarathon",
        name: "Marathon",
        text: "Five scrambles back to back. The next one starts the moment you finish.",
      },
    ],
  },
  {
    name: "Boards",
    mods: [
      {
        key: "modBigBoards",
        name: "Big boards",
        text: "Unlocks 8×8, 9×9 and 10×10. Solved with the staged engine.",
        free: true,
      },
    ],
  },
];

// Blindfold is no longer a mod: it has its own page (views/blind.js), with its own settings and records.
export const MODS = MOD_GROUPS.flatMap((g) => g.mods);

// display mods map straight onto a class on the board
export const VIEW_MODS = {
  modFog: "mod-fog",
  modVanish: "mod-vanish",
  modDistNums: "mod-distnums",
  modMirror: "mod-mirror",
  modFlip: "mod-flip",
};

export const TIME_LIMIT = {
  3: 10000,
  4: 30000,
  5: 75000,
  6: 150000,
  7: 270000,
};
export const timeLimit = (N) => TIME_LIMIT[N] || 270000 + (N - 7) * 150000;
export const budgetFor = (N, optimal) =>
  optimal == null ? null : optimal + (N <= 3 ? 10 : 20);
