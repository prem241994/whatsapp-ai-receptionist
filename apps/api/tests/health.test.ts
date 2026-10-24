import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('health endpoint', () => {
  it('reports the API as healthy', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'api' });
    await app.close();
  });
});
