import { PrismaClient } from '@prisma/client';

export const criarPrisma = (url?: string) =>
  new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
