export type ServiceRecord = {
  id: string;
  businessId: string;
  name: string;
  durationMinutes: number;
  priceMinor: number;
  enabled: boolean;
};

export type ServiceStore = {
  service: {
    findMany(args: {
      where: { businessId: string };
      orderBy: { name: 'asc' };
    }): Promise<ServiceRecord[]>;
    create(args: { data: Omit<ServiceRecord, 'id'> }): Promise<ServiceRecord>;
    updateMany(args: {
      where: { id: string; businessId: string };
      data: Partial<
        Pick<
          ServiceRecord,
          'name' | 'durationMinutes' | 'priceMinor' | 'enabled'
        >
      >;
    }): Promise<{ count: number }>;
    deleteMany(args: {
      where: { id: string; businessId: string };
    }): Promise<{ count: number }>;
  };
};

export function createServiceRepository(
  store: ServiceStore,
  businessId: string,
) {
  if (!businessId) {
    throw new Error('businessId is required');
  }

  return {
    list: () =>
      store.service.findMany({
        where: { businessId },
        orderBy: { name: 'asc' },
      }),
    create: (input: Omit<ServiceRecord, 'id' | 'businessId'>) =>
      store.service.create({ data: { ...input, businessId } }),
    update: async (
      id: string,
      data: Partial<
        Pick<
          ServiceRecord,
          'name' | 'durationMinutes' | 'priceMinor' | 'enabled'
        >
      >,
    ) => {
      const result = await store.service.updateMany({
        where: { id, businessId },
        data,
      });
      return result.count === 1;
    },
    remove: async (id: string) => {
      const result = await store.service.deleteMany({
        where: { id, businessId },
      });
      return result.count === 1;
    },
  };
}

export type StaffRecord = {
  id: string;
  businessId: string;
  name: string;
  enabled: boolean;
};

export type StaffStore = {
  staff: {
    findMany(args: {
      where: { businessId: string };
      orderBy: { name: 'asc' };
    }): Promise<StaffRecord[]>;
    create(args: { data: Omit<StaffRecord, 'id'> }): Promise<StaffRecord>;
    updateMany(args: {
      where: { id: string; businessId: string };
      data: Partial<Pick<StaffRecord, 'name' | 'enabled'>>;
    }): Promise<{ count: number }>;
    deleteMany(args: {
      where: { id: string; businessId: string };
    }): Promise<{ count: number }>;
  };
};

export function createStaffRepository(store: StaffStore, businessId: string) {
  if (!businessId) throw new Error('businessId is required');
  return {
    list: () =>
      store.staff.findMany({ where: { businessId }, orderBy: { name: 'asc' } }),
    create: (input: Omit<StaffRecord, 'id' | 'businessId'>) =>
      store.staff.create({ data: { ...input, businessId } }),
    update: async (
      id: string,
      data: Partial<Pick<StaffRecord, 'name' | 'enabled'>>,
    ) =>
      (await store.staff.updateMany({ where: { id, businessId }, data }))
        .count === 1,
    remove: async (id: string) =>
      (await store.staff.deleteMany({ where: { id, businessId } })).count === 1,
  };
}
