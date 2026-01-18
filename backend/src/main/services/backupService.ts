import fs from 'node:fs';
import path from 'node:path';

let started = false;
let timer: NodeJS.Timeout | null = null;

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function formatStamp(d: Date) {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  return `${y}${m}${day}-${hh}${mm}`;
}

function msUntilNextWeeklyRun(dayOfWeekLocal: number, hourLocal: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hourLocal, 0, 0, 0);

  const targetDow = Math.max(0, Math.min(6, Math.floor(dayOfWeekLocal)));
  while (next.getDay() !== targetDow || next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
    next.setHours(hourLocal, 0, 0, 0);
  }

  return next.getTime() - now.getTime();
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function pruneBackups(backupDir: string, keepLatest: number) {
  try {
    const files = fs
      .readdirSync(backupDir)
      .filter(f => f.endsWith('.db'))
      .map(f => ({
        f,
        ts: fs.statSync(path.join(backupDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.ts - a.ts);

    const toDelete = files.slice(keepLatest);
    for (const x of toDelete) {
      try {
        fs.unlinkSync(path.join(backupDir, x.f));
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

export function startWeeklyDbBackupScheduler(opts: {
  dbPath: string;
  backupDir: string;
  dayOfWeekLocal?: number; // 0=Sun
  hourLocal?: number; // default 3am
  keepLatest?: number; // default 20
  onBackup?: (info: { from: string; to: string }) => void;
  onError?: (err: unknown) => void;
}) {
  if (started) return;
  started = true;

  const dayOfWeekLocal = Number(opts.dayOfWeekLocal ?? 0);
  const hourLocal = Number(opts.hourLocal ?? 3);
  const keepLatest = Number(opts.keepLatest ?? 20);

  const scheduleNext = () => {
    const waitMs = msUntilNextWeeklyRun(dayOfWeekLocal, hourLocal);
    if (timer) clearTimeout(timer);

    timer = setTimeout(() => {
      try {
        ensureDir(opts.backupDir);
        const stamp = formatStamp(new Date());
        const dest = path.join(opts.backupDir, `swingsense-backup-${stamp}.db`);

        fs.copyFileSync(opts.dbPath, dest);
        pruneBackups(opts.backupDir, keepLatest);
        opts.onBackup?.({ from: opts.dbPath, to: dest });
      } catch (e) {
        opts.onError?.(e);
      } finally {
        scheduleNext();
      }
    }, waitMs);
  };

  scheduleNext();
}
