import { getDB } from '../../db.js';

let started = false;
let timer: NodeJS.Timeout | null = null;

function msUntilNextMonthlyRun(dayOfMonthLocal: number, hourLocal: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hourLocal, 0, 0, 0);
  next.setDate(dayOfMonthLocal);

  if (next.getTime() <= now.getTime()) {
    next.setMonth(next.getMonth() + 1);
    next.setDate(dayOfMonthLocal);
    next.setHours(hourLocal, 0, 0, 0);
  }

  return next.getTime() - now.getTime();
}

function monthKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function startTsmomMonthlyRebalanceReminder(opts: {
  dayOfMonthLocal?: number; // default 1
  hourLocal?: number; // default 9
  show: (payload: { title: string; body: string }) => void;
}) {
  if (started) return;
  started = true;

  const day = Number(opts.dayOfMonthLocal ?? 1);
  const hour = Number(opts.hourLocal ?? 9);

  const scheduleNext = () => {
    const waitMs = msUntilNextMonthlyRun(day, hour);
    if (timer) clearTimeout(timer);

    timer = setTimeout(() => {
      try {
        const db = getDB();
        const now = new Date();
        const mk = monthKey(now);
        const metaKey = `tsmom_rebalance_reminder_${mk}`;

        const existing = db.prepare('SELECT value FROM meta WHERE key=?').get(metaKey) as { value?: string } | undefined;
        if (!existing?.value) {
          db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run(metaKey, String(Date.now()));
          opts.show({
            title: 'TSMOM Rebalance Reminder',
            body: 'It\'s the 1st of the month — open the TSMOM Command Center and compute your Turbo plan.',
          });
        }
      } catch {
        // ignore reminder errors
      } finally {
        scheduleNext();
      }
    }, waitMs);
  };

  scheduleNext();
}
