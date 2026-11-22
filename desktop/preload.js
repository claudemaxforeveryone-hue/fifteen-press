// The window has no frame, so the page draws its own bar. This hands the page the three things
// that bar needs from the window and nothing else.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fifteenWindow", {
  minimize: () => ipcRenderer.send("win:minimize"),
  toggle: () => ipcRenderer.send("win:toggle"),
  close: () => ipcRenderer.send("win:close"),
  // calls back now and again whenever the window is made full size or put back
  onState: (fn) => {
    ipcRenderer.on("win:state", (_e, st) => fn(st));
    ipcRenderer.invoke("win:state").then(fn, () => {});
  },
});
