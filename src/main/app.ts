import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, shell, Tray } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { host, openTerminal } from "./platform";
import { Vault } from "./storage/vault";
import { RelayService, safeError } from "./service";
import { PlaywrightMailError } from "./browser/playwright-mail";
import { commandSchema } from "./ipc/schema";
import type { Settings } from "../shared/contracts";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

if (process.env.RELAY_DATA_DIR) app.setPath("userData", resolve(process.env.RELAY_DATA_DIR));
if (process.env.RELAY_E2E) console.info("[Relay Desk] Main module loaded.");
if (host.id === "win32") app.setAppUserModelId("com.relaydesk.personal");
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let service: RelayService | undefined;
let quitting = false;
let closing = false;
let changedTimer: ReturnType<typeof setTimeout> | undefined;

function changed(): void {
  if (changedTimer) return;
  changedTimer = setTimeout(() => {
    changedTimer = undefined;
    if (window && !window.isDestroyed()) window.webContents.send("relay:changed");
  }, 100);
}
function icon() {
  const size = 32, pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const index = (y * size + x) * 4;
    const mark = (x >= 9 && x <= 12 && y >= 7 && y <= 25) || (y >= 7 && y <= 10 && x >= 9 && x <= 23)
      || (y >= 15 && y <= 18 && x >= 9 && x <= 20) || (x >= 21 && x <= 24 && y >= 7 && y <= 18)
      || (x >= y - 1 && x <= y + 2 && y >= 18 && y <= 25);
    pixels[index] = mark ? 230 : 117;
    pixels[index + 1] = mark ? 255 : 126;
    pixels[index + 2] = mark ? 245 : 18;
    pixels[index + 3] = 255;
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}
/** macOS menu-bar icons are ~18pt; Windows/Linux trays use the 32px bitmap. */
function trayIcon() {
  return host.id === "darwin" ? icon().resize({ width: 18, height: 18 }) : icon();
}
/** Refuses to create an archive when the OS cannot protect its key (for example Linux without a keyring). */
function protectedKeyStore(): void {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error(`${host.credentialStore} is unavailable. Relay Desk will not create an unencrypted archive.`);
  if (host.id === "linux") {
    const backend = safeStorage.getSelectedStorageBackend();
    if (backend === "basic_text" || backend === "unknown")
      throw new Error("No desktop keyring is available (Secret Service/GNOME Keyring or KWallet). Install and unlock one, then restart Relay Desk; it will not protect the archive key with a hardcoded password.");
  }
}
function openWindow(): void {
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
  window = new BrowserWindow({
    width: 1380, height: 920, minWidth: 900, minHeight: 640, title: "Relay Desk",
    backgroundColor: "#f6f7f9", icon: icon(), autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false,
      sandbox: true, webSecurity: true, spellcheck: true
    }
  });
  const rendererFile = join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
  const entryUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL || pathToFileURL(rendererFile).href;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (url !== entryUrl) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => callback({
    responseHeaders: {
      ...details.responseHeaders,
      "Content-Security-Policy": [
        `default-src 'self'; script-src 'self'${MAIN_WINDOW_VITE_DEV_SERVER_URL ? " 'unsafe-inline'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; worker-src 'self' blob:; connect-src 'self'${MAIN_WINDOW_VITE_DEV_SERVER_URL ? " ws://localhost:* ws://127.0.0.1:*" : ""}; object-src 'none'; frame-src 'self'; base-uri 'self'`
      ]
    }
  }));
  window.on("close", event => {
    if (!quitting && service?.settings().closeToTray) { event.preventDefault(); window?.hide(); }
  });
  window.on("closed", () => { window = undefined; });
  void window.loadURL(entryUrl).catch(error => { console.error("Renderer load failed:", safeError(error)); });
}
function trusted(event: Electron.IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
    throw new Error("Untrusted application command.");
  const url = new URL(event.senderFrame.url);
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    if (url.origin !== new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin) throw new Error("Untrusted renderer origin.");
  } else {
    const expected = pathToFileURL(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)).href;
    if (url.href.split("#")[0] !== expected) throw new Error("Untrusted renderer URL.");
  }
}
function preferences(settings: Settings): void {
  if (!process.env.RELAY_E2E) app.setLoginItemSettings({ openAtLogin: settings.startAtLogin });
}
async function start(): Promise<void> {
  if (process.env.RELAY_E2E) console.info("[Relay Desk] Electron ready.");
  protectedKeyStore();
  const directory = app.getPath("userData");
  mkdirSync(directory, { recursive: true });
  // Windows keeps its historical file name so existing archives open unchanged.
  const keyPath = join(directory, host.id === "win32" ? "archive-key.dpapi" : "archive-key.safestorage");
  let key: Buffer;
  if (existsSync(keyPath)) key = Buffer.from(safeStorage.decryptString(readFileSync(keyPath)), "hex");
  else {
    key = randomBytes(32);
    writeFileSync(keyPath, safeStorage.encryptString(key.toString("hex")), { flag: "wx" });
  }
  if (key.length !== 32) throw new Error("The protected archive key is invalid.");
  const vault = new Vault(directory, key);
  if (process.env.RELAY_E2E) console.info("[Relay Desk] Encrypted archive opened.");
  key.fill(0);
  const extensionDirectory = join(__dirname, "browser-extension");
  const extensionManifest = JSON.parse(readFileSync(join(extensionDirectory, "manifest.json"), "utf8")) as { key: string };
  const extensionId = createHash("sha256").update(Buffer.from(extensionManifest.key, "base64")).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/g, character => String.fromCharCode(97 + parseInt(character, 16)));
  service = new RelayService(vault, directory, {
    browserExtensionId: extensionId,
    browserExtensionDirectory: extensionDirectory,
    playwrightProfileDirectory: join(directory, "playwright-gmail-profile"),
    downloadsDirectory: app.getPath("downloads"),
    documentsDirectory: app.getPath("documents"),
    openPath: async (path, reveal) => {
      if (reveal) { shell.showItemInFolder(path); return; }
      const error = await shell.openPath(path);
      if (error) throw new Error(`${host.name} could not open this file.`);
    },
    chooseFolder: async (title, defaultPath) => {
      const options: Electron.OpenDialogOptions = { title, defaultPath, properties: ["openDirectory", "createDirectory", "dontAddToRecent"] };
      const result = window && !window.isDestroyed() ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return result.canceled || result.filePaths.length !== 1 ? undefined : result.filePaths[0];
    },
    openBrowserExtension: async () => {
      const error = await shell.openPath(extensionDirectory);
      if (error) throw new Error("Could not open the browser companion folder.");
    },
    changed,
    openExternal: async url => {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") throw new Error("Only HTTPS provider links can be opened.");
      await shell.openExternal(url);
    },
    copy: text => clipboard.writeText(text),
    loginCopilot: async () => {
      try { await openTerminal("copilot"); }
      catch { throw new Error("Install Copilot CLI (npm install -g @github/copilot), run copilot in a terminal and use /login, then reconnect here."); }
    },
    loginCodex: async executable => {
      try { await openTerminal(executable, host, undefined, ["login"]); }
      catch { throw new Error("Run codex login in a terminal, then click Connect here."); }
    },
    backupPath: async () => (await dialog.showSaveDialog({ title: "Save encrypted Relay Desk backup", defaultPath: "relay-desk.backup", filters: [{ name: "Encrypted backup", extensions: ["backup"] }] })).filePath,
    saveAttachmentPath: async name => {
      const options: Electron.SaveDialogOptions = {
        title: "Save attachment to Downloads", defaultPath: join(app.getPath("downloads"), name),
        buttonLabel: "Save original", properties: ["dontAddToRecent", "showOverwriteConfirmation"]
      };
      const result = window && !window.isDestroyed()
        ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
      return result.canceled ? undefined : result.filePath;
    },
    importAttachmentPath: async () => {
      const confirmation = await dialog.showMessageBox({
        type: "info", title: "Import downloaded browser attachment", message: "Choose the original copy you downloaded from Gmail or WhatsApp.",
        detail: "Gmail attachments can download automatically with the updated companion. This picker is a fallback for a matching original already downloaded from Gmail or WhatsApp. The app stores an encrypted copy and extracts supported text locally. File-size approval and safety limits still apply. The manually selected file is not deleted.",
        buttons: ["Cancel", "Choose downloaded file"], defaultId: 0, cancelId: 0
      });
      if (confirmation.response !== 1) return undefined;
      const result = await dialog.showOpenDialog({ title: "Import downloaded file", properties: ["openFile", "dontAddToRecent"] });
      return result.canceled || result.filePaths.length !== 1 ? undefined : result.filePaths[0];
    },
    restorePath: async () => {
      const confirmation = await dialog.showMessageBox({
        type: "warning", title: "Replace local archive?", message: "Restoring replaces this local archive.",
        detail: "Create a backup first. The backup must use this archive's encryption key. Sync and AI automation will be paused after restore.",
        buttons: ["Cancel", "Choose backup"], defaultId: 0, cancelId: 0
      });
      if (confirmation.response !== 1) return undefined;
      const result = await dialog.showOpenDialog({ title: "Restore encrypted archive", properties: ["openFile"], filters: [{ name: "Encrypted backup", extensions: ["backup"] }] });
      return result.canceled ? undefined : result.filePaths[0];
    },
    settingsChanged: preferences,
    notify: (title, body) => { if (Notification.isSupported()) new Notification({ title, body, icon: icon() }).show(); }
  });
  ipcMain.handle("relay:snapshot", event => { trusted(event); return service!.rendererSnapshot(); });
  ipcMain.handle("relay:command", async (event, input: unknown) => {
    trusted(event);
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success) throw new Error(`Invalid application command: ${parsed.error.issues.map(issue => issue.path.join(".") + " " + issue.message).join("; ")}`);
    try { return await service!.command(parsed.data); }
    catch (error) { throw new Error(safeError(error)); }
  });
  await service.initialize();
  if (process.env.RELAY_E2E) console.info("[Relay Desk] Services initialized.");
  tray = new Tray(trayIcon());
  tray.setToolTip("Relay Desk - your communications workspace");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Relay Desk", click: openWindow },
    { type: "separator" },
    { label: "Quit Relay Desk", click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on("double-click", openWindow);
  if (host.id === "darwin") app.dock?.setIcon(icon());
  openWindow();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", openWindow);
  app.whenReady().then(start).catch(error => {
    console.error("Relay Desk startup failed:", safeError(error));
    if (!process.env.RELAY_E2E) dialog.showErrorBox("Relay Desk could not start", safeError(error));
    app.exit(1);
  });
}
app.on("activate", openWindow);
app.on("window-all-closed", () => { if (!service?.settings().closeToTray) app.quit(); });
app.on("before-quit", event => {
  quitting = true;
  if (!service || closing) return;
  event.preventDefault();
  closing = true;
  void service.stop().then(() => {
    tray?.destroy();
    app.quit();
  }).catch(error => {
    if (error instanceof PlaywrightMailError && error.code === "busy") {
      closing = false;
      quitting = false;
      dialog.showErrorBox("Finish in the managed browser before quitting", error.message);
      return;
    }
    console.error("Shutdown:", safeError(error));
    tray?.destroy();
    app.quit();
  });
});
