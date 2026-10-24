import { betterAuth } from 'better-auth';
import { PrismaClient } from '@prisma/client';
import { prismaAdapter } from 'better-auth/adapters/prisma';

const prisma = new PrismaClient();

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:4000',
  secret: process.env.BETTER_AUTH_SECRET,
  emailAndPassword: { enabled: true },
  trustedOrigins: (process.env.AUTH_TRUSTED_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim()),
});
