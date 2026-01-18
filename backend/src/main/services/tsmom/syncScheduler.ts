import { TsmomSyncManager } from './syncManager.js';

let started = false;
let timer: NodeJS.Timeout | null = null;
let inFlight = false;

function msUntilNextDailyRun(hourLocal: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hourLocal, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function startTsmomSyncScheduler(opts?: { dailyHourLocal?: number }) {
  if (started) return;
  started = true;

  const dailyHourLocal = Number(opts?.dailyHourLocal ?? 6);
  const mgr = new TsmomSyncManager();

  async function runOnce(tag: string) {
    if (inFlight) {
      console.warn('[tsmom-sync] skip; already running', { tag });
      return;
    }
    inFlight = true;
    try {
      const res = await mgr.syncDailyCandlesForUniverse();
      if (res.warnings.length) console.warn('[tsmom-sync] warnings:', res.warnings.slice(0, 8));
      console.log('[tsmom-sync] done', { tag, assets: res.assets, updated: res.updated });
    } catch (e: any) {
      console.warn('[tsmom-sync] failed', { tag, err: e?.message || e });
    } finally {
      inFlight = false;
    }
  }

  // Fire-and-forget immediate sync on app start
  void runOnce('initial');

  const scheduleNext = () => {
    const waitMs = msUntilNextDailyRun(dailyHourLocal);
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await runOnce('daily');
      } catch (e: any) {
        console.warn('[tsmom-sync] daily sync failed', e?.message || e);
      } finally {
        scheduleNext();
      }
    }, waitMs);
  };

  scheduleNext();
}
