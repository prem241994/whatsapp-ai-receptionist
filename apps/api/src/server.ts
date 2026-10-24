import { buildApp } from './app.js';
import { startEmbeddedWorkerScheduler } from './scheduler.js';

const port = Number(process.env.API_PORT ?? 4000);
const app = buildApp();

try {
  await app.listen({ host: '0.0.0.0', port });
  startEmbeddedWorkerScheduler();
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
