import { describe, expect, it } from 'vitest';
import { requireRole, type AuthorizationContext } from '../src/auth.js';

const ownerContext: AuthorizationContext = {
  businessId: 'business-a',
  role: 'OWNER',
  userId: 'user-a',
};

describe('authorization context', () => {
  it('allows an expected role', () => {
    expect(requireRole(ownerContext, ['OWNER', 'MANAGER'])).toEqual(
      ownerContext,
    );
  });

  it('rejects an unexpected role', () => {
    expect(() =>
      requireRole({ ...ownerContext, role: 'STAFF' }, ['OWNER']),
    ).toThrow('insufficient permissions');
  });
});
