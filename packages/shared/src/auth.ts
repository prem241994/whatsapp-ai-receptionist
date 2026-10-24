export type AuthenticatedUser = {
  userId: string;
};

export type AuthorizationContext = AuthenticatedUser & {
  businessId: string;
  role: 'OWNER' | 'MANAGER' | 'STAFF';
};

export function requireRole(
  context: AuthorizationContext,
  allowedRoles: readonly AuthorizationContext['role'][],
) {
  if (!allowedRoles.includes(context.role)) {
    throw new Error('insufficient permissions');
  }

  return context;
}
