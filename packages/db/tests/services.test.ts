import { describe, expect, it } from 'vitest';
import {
  createServiceRepository,
  type ServiceRecord,
} from '../src/repositories/services.js';

describe('tenant-scoped service repository', () => {
  it('always applies the selected business scope', async () => {
    const calls: unknown[] = [];
    const records: ServiceRecord[] = [];
    const repository = createServiceRepository(
      {
        service: {
          findMany: async (args) => {
            calls.push(args);
            return records;
          },
        },
      },
      'business-a',
    );

    await repository.list();

    expect(calls).toEqual([
      { where: { businessId: 'business-a' }, orderBy: { name: 'asc' } },
    ]);
  });

  it('rejects an empty business scope', () => {
    expect(() =>
      createServiceRepository({ service: { findMany: async () => [] } }, ''),
    ).toThrow('businessId is required');
  });
});
