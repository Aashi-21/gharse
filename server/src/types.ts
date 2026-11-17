import type { PrismaClient } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config';
import type { Mailer } from './lib/mailer';
import type { Storage } from './lib/storage';
import type { AiClient } from './modules/ai/client';

export interface AuthUser {
  id: string;
  email: string;
  isSample: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    config: Config;
    storage: Storage;
    mailer: Mailer | null;
    ai: AiClient;
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user: AuthUser | null;
  }
}
