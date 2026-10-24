import { processOutboundQueue } from './outbound-queue.js';
import {
  processReminderQueue,
  scheduleAppointmentReminders,
} from './reminders.js';

export function startEmbeddedWorkerScheduler() {
  if (process.env.EMBEDDED_WORKER_ENABLED !== 'true') return undefined;

  const intervalMs = Math.max(
    5_000,
    Number(process.env.WORKER_INTERVAL_MS ?? 30_000),
  );
  let stopped = false;

  const runCycle = async () => {
    const startedAt = Date.now();
    try {
      const reminders = await scheduleAppointmentReminders({ horizonDays: 30 });
      const processedReminders = await processReminderQueue({ limit: 20 });
      let outbound: Awaited<ReturnType<typeof processOutboundQueue>> | null =
        null;
      if (process.env.META_ACCESS_TOKEN?.trim()) {
        outbound = await processOutboundQueue(20);
      }
      console.info(
        JSON.stringify({
          event: 'embedded_worker_cycle_completed',
          durationMs: Date.now() - startedAt,
          reminders,
          processedReminders,
          outbound,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'embedded_worker_cycle_failed',
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const timer = setInterval(() => {
    if (!stopped) void runCycle();
  }, intervalMs);
  timer.unref();
  void runCycle();

  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return stop;
}
