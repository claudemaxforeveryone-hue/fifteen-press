# Fifteen Press

The 15 puzzle, built for getting fast at it. A real optimal solver, a coach, drills,
detailed stats, and a full trainer for solving it blindfolded.

## Download

1. Go to [Releases](../../releases/latest).
2. Download `FifteenPress-portable-v5.6.1.exe`.
3. Double-click it. There is nothing to install.

Windows 10 or 11, 64-bit.

### Windows will warn you

The exe is not code-signed, so the first time you open it Windows shows
"Windows protected your PC". Click **More info**, then **Run anyway**.

If your PC has Smart App Control turned on, Windows may block it with no way to
run it. In that case use "Run from source" below.

## What is in it

- **Play**: timed solves on several board sizes, keyboard or mouse, a dozen themes.
- **Practice and coach**: a practice mode where a coach shows the best next move.
- **Train**: short drills for the parts of a solve.
- **Solves**: every solve saved, sortable, with a move-by-move review against the
  shortest solution.
- **Stats**: averages, records and charts.
- **Blind**: memorise the scramble, then solve with the numbers hidden. It has free
  play, a 20 level progression, and a trainer for the chain method (a step by step
  lesson, one run of moves for every number with path maps, a random test,
  then full blind solves).
- **Lab, Proofs, Leaders**: a seed lab, optimal solutions for any position, and
  local leaderboards.

The background picture of the lamp theme is not included, see
[web/img/README.md](web/img/README.md).

## Your data

Everything stays on your computer. There is no sign-up and no internet is needed.
Players and solves are saved in the app's own data folder.

## Run from source

You need [Node.js](https://nodejs.org) 20 or newer.

```
npm install
npm start
```

To build the portable exe yourself (on Windows):

```
npm run dist
```

The result lands in `dist/`.

The app is plain HTML, CSS and JavaScript modules in `web/`, with no build step.
`desktop/` is the small Electron shell around it.

## Credits

- The blind chain method is the one taught in Bobby Mack's video
  [How To Solve a 15 Puzzle Blindfolded](https://www.youtube.com/watch?v=4hRvVgrYwyY).
- Position counts by solution length are from OEIS A089484 (Korf and Schultze, 2005).
- Fonts: see [web/fonts/FONTS.md](web/fonts/FONTS.md).
- Built with [Electron](https://www.electronjs.org).

## Licence

MIT, see [LICENSE](LICENSE). The fonts keep their own licences.
