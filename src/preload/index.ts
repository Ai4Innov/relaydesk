import { contextBridge, ipcRenderer } from "electron";
import type { Command, DesktopBridge } from "../shared/contracts";

const bridge: DesktopBridge = {
  snapshot: () => ipcRenderer.invoke("relay:snapshot"),
  command: (command: Command) => ipcRenderer.invoke("relay:command", command),
  onChange: listener => {
    const handler = () => listener();
    ipcRenderer.on("relay:changed", handler);
    return () => ipcRenderer.removeListener("relay:changed", handler);
  }
};
contextBridge.exposeInMainWorld("relay", bridge);
