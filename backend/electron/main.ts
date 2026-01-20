import { app, BrowserWindow, ipcMain, Notification } from "electron";
import path from "node:path";
import log from "electron-log";
import { fileURLToPath } from "node:url";
import { initDB } from "../src/main/db.js";
import { registerIpcHandlers } from "../src/main/ipc.js";
import { getDB } from "../src/main/db.js";
import { ensurePortfolioUniverseSeededFromExpandedUniverseJson } from "../src/main/services/tsmom/universeSeeder.js";
import { startTsmomSyncScheduler } from "../src/main/services/tsmom/syncScheduler.js";
import { startWeeklyDbBackupScheduler } from "../src/main/services/backupService.js";
import { startTsmomMonthlyRebalanceReminder } from "../src/main/services/tsmom/monthlyReminder.js";

log.initialize();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let win: BrowserWindow | null = null;
const FORCE_DIST = process.env.ELECTRON_FORCE_DIST === "true";

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: false,
    webPreferences: {
  preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  // Start maximized (not fullscreen) so system chrome and menu remain visible
  win.maximize();

  if (!app.isPackaged && !FORCE_DIST) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    const indexHtml = path.resolve(__dirname, "../../dist/index.html");
    win.loadFile(indexHtml);
  }

  win.on("closed", () => (win = null));
}

app.on("ready", async () => {
  try {
    const dbPath = path.join(app.getPath("userData"), "swingsense.db");
    await initDB(dbPath);

    // Weekly auto-backup (local-first safety)
    startWeeklyDbBackupScheduler({
      dbPath,
      backupDir: path.join(app.getPath('userData'), 'backups'),
      dayOfWeekLocal: 0, // Sunday
      hourLocal: 3,
      keepLatest: 20,
      onBackup: ({ to }) => log.info('[backup] db backup written', { to }),
      onError: (e) => log.warn('[backup] db backup failed', e),
    });

    // Seed default portfolio universe from JSON once (portfolio-scoped; no global assets table)
    try {
      const seeded = ensurePortfolioUniverseSeededFromExpandedUniverseJson({
        db: getDB(),
        portfolioId: 1,
        jsonPathCandidates: [
          path.resolve(process.cwd(), 'data', 'tsmom_turbo_expanded_universe.json'),
          path.resolve(app.getAppPath(), 'data', 'tsmom_turbo_expanded_universe.json'),
        ],
      });
      if (seeded.seeded) {
        log.info('[tsmom] seeded portfolio universe', { portfolioId: 1, count: seeded.count, path: seeded.usedPath });
      }
    } catch (e) {
      log.warn('[tsmom] seeding failed', e);
    }

    registerIpcHandlers();

    // Automated sync: on app start + daily schedule
    startTsmomSyncScheduler({ dailyHourLocal: 6 });

    // Monthly reminder (1st of month)
    startTsmomMonthlyRebalanceReminder({
      dayOfMonthLocal: 1,
      hourLocal: 9,
      show: ({ title, body }) => {
        try {
          if (Notification.isSupported()) {
            new Notification({ title, body }).show();
          } else {
            log.info('[tsmom] reminder', { title, body });
          }
        } catch (e) {
          log.info('[tsmom] reminder failed', e);
        }
      }
    });

    createWindow();
  } catch (e) {
    log.error("DB init failed", e);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (win === null) createWindow();
});
