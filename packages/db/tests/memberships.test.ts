import { describe, expect, it } from 'vitest';
import {
  getMembership,
  type MembershipRecord,
} from '../src/repositories/memberships.js';

describe('membership authorization lookup', () => {
  it('looks up membership by both user and business', async () => {
    const calls: unknown[] = [];
    const membership: MembershipRecord = {
      businessId: 'business-a',
      userId: 'user-a',
      role: 'OWNER',
    };

    const result = await getMembership(
      {
        membership: {
          findUnique: async (args) => {
            calls.push(args);
            return membership;
          },
        },
      },
      { businessId: 'business-a', userId: 'user-a' },
    );

    expect(result).toEqual(membership);
    expect(calls).toEqual([
      {
        where: {
          businessId_userId: { businessId: 'business-a', userId: 'user-a' },
        },
        select: { businessId: true, userId: true, role: true },
      },
    ]);
  });

  it('returns no access when membership is absent', async () => {
    const result = await getMembership(
      { membership: { findUnique: async () => null } },
      { businessId: 'business-a', userId: 'user-b' },
    );

    expect(result).toBeNull();
  });

  it('rejects incomplete identity or business scope', async () => {
    await expect(
      getMembership(
        { membership: { findUnique: async () => null } },
        { businessId: '', userId: 'user-a' },
      ),
    ).rejects.toThrow('businessId and userId are required');
  });
});
