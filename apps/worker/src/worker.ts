const apiBaseUrl = (
  process.env.API_BASE_URL ?? 'http://localhost:4000'
).replace(/\/$/, '');
const workerSecret = process.env.INTERNAL_WORKER_SECRET?.trim();
const intervalMs = Math.max(
  5_000,
  Number(process.env.WORKER_INTERVAL_MS ?? 30_000),
);

if (!workerSecret) {
  throw new Error('INTERNAL_WORKER_SECRET is required for the worker');
}
const requiredWorkerSecret: string = workerSecret;

let stopping = false;

async function processEndpoint(path: string, body: object) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-worker-secret': requiredWorkerSecret,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.text();
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${payload}`);
  }
  return payload ? JSON.parse(payload) : {};
}

async function runCycle() {
  const startedAt = Date.now();
  try {
    const reminders = await processEndpoint('/internal/reminders/process', {
      limit: 20,
      horizonDays: 30,
    });
    const outbound = await processEndpoint('/internal/outbound-queue/process', {
      limit: 20,
    });
    console.info(
      JSON.stringify({
        event: 'worker_cycle_completed',
        durationMs: Date.now() - startedAt,
        reminders,
        outbound,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'worker_cycle_failed',
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

function stop() {
  stopping = true;
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

while (!stopping) {
  await runCycle();
  if (!stopping)
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

console.info(JSON.stringify({ event: 'worker_stopped' }));
