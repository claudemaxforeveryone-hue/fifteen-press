// Desktop shell. Serves web/ over a private app:// scheme so module scripts,
// workers and fetch() behave exactly as they do on the website.
const { app, BrowserWindow, protocol, net, shell, Menu, ipcMain } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..", "web");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".bin": "application/octet-stream",
  ".json": "application/json",
};

async function serve(request) {
  const url = new URL(request.url);
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch (e) {
    return new Response("Bad request", { status: 400 });
  }
  if (!rel || rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(ROOT, rel));
  const inside = path.relative(ROOT, file);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside))
    return new Response("Not found", { status: 404 });
  try {
    const res = await net.fetch(pathToFileURL(file).toString());
    const type = MIME[path.extname(file).toLowerCase()];
    if (!type) return res;
    return new Response(await res.arrayBuffer(), {
      status: res.status,
      headers: { "content-type": type },
    });
  } catch (e) {
    return new Response("Not found", { status: 404 });
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 380,
    minHeight: 560,
    title: "Fifteen Press",
    backgroundColor: "#0b1122",
    icon: path.join(__dirname, "icon.png"),
    autoHideMenuBar: true,
    // no title bar: the page's own bar drags the window and carries minimize, full size and close
    frame: false,
    roundedCorners: false,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, "preload.js") },
  });
  const state = () => ({ maximized: win.isMaximized(), fullscreen: win.isFullScreen() });
  const tell = () => {
    if (!win.isDestroyed()) win.webContents.send("win:state", state());
  };
  for (const ev of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) win.on(ev, tell);
  const mine = (e) => !win.isDestroyed() && e.sender === win.webContents;
  ipcMain.on("win:minimize", (e) => mine(e) && win.minimize());
  ipcMain.on("win:toggle", (e) => {
    if (!mine(e)) return;
    if (win.isFullScreen()) win.setFullScreen(false);
    else if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on("win:close", (e) => mine(e) && win.close());
  ipcMain.handle("win:state", (e) => (mine(e) ? state() : null));
  if (process.argv.includes("--smoke")) {
    // headless self-test: load the app, run an optimal solve through the worker, print, quit
    win.webContents.once("did-finish-load", async () => {
      try {
        const out = await win.webContents.executeJavaScript(`(async () => {
          await new Promise((r) => setTimeout(r, 1500));
          const v = window.fifteen.views.play;
          const errs = [];
          window.addEventListener('error', (e) => errs.push(String(e.message)));
          window.addEventListener('unhandledrejection', (e) => errs.push(String(e.reason && e.reason.message || e.reason)));
          const res = await v.engine.run('solve', { board: v.game.board.slice(), N: 4, timeLimit: 20000 });
          // walk every page once, then run the coach and one drill rep
          const pages = {};
          for (const name of ['train', 'blind', 'solves', 'stats/visual', 'stats/all', 'settings', 'play']) {
            location.hash = name;
            await new Promise((r) => setTimeout(r, 350));
            pages[name] = document.querySelector('.view:not([hidden])').childElementCount;
          }
          v.toggleCoach();
          await new Promise((r) => setTimeout(r, 200));
          const coach = !!v.coach && v.coach.left();
          v.toggleCoach();
          const t = window.fifteen.views.train;
          location.hash = 'train';
          await new Promise((r) => setTimeout(r, 200));
          t.start('sprint', { pattern: 'loop' });
          for (const m of t.drill.seq.slice()) t.tryMove(m, 'key');
          const rep = t.drill.result;
          t.leave();
          return JSON.stringify({ ok: !errs.length, optimal: res.optimal, moves: res.moves.length, maple: document.fonts.check('14px "Maple Mono"'), desktop: document.documentElement.classList.contains('desktop'), workers: v.engine.usingWorkers(), pages, coach, rep: rep && rep.m, errs });
        })()`);
        console.log("SMOKE", out);
      } catch (e) {
        console.log("SMOKE FAIL", e.message);
      }
      app.quit();
    });
  } else win.once("ready-to-show", () => win.show());
  win.loadURL("app://fifteen/index.html");
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("app://")) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F11") {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    }
    if (
      input.key === "F12" ||
      (input.control && input.shift && input.key.toLowerCase() === "i")
    ) {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    protocol.handle("app", serve);
    Menu.setApplicationMenu(null);
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
