export type MembershipRole = 'OWNER' | 'MANAGER' | 'STAFF';

export type MembershipRecord = {
  businessId: string;
  userId: string;
  role: MembershipRole;
};

export type MembershipStore = {
  membership: {
    findUnique(args: {
      where: { businessId_userId: { businessId: string; userId: string } };
      select: { businessId: true; userId: true; role: true };
    }): Promise<MembershipRecord | null>;
  };
};

export async function getMembership(
  store: MembershipStore,
  input: { businessId: string; userId: string },
) {
  if (!input.businessId || !input.userId) {
    throw new Error('businessId and userId are required');
  }

  return store.membership.findUnique({
    where: {
      businessId_userId: input,
    },
    select: {
      businessId: true,
      userId: true,
      role: true,
    },
  });
}
