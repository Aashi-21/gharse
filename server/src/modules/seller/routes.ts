import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../../lib/httpError';
import { indianPhone as phone } from '../../lib/indiaAddress';
import { slugSchema } from '../../lib/slug';

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const profileBody = z.object({
  fullName: z.string().trim().min(2, 'Enter your name').max(80),
  phone,
  whatsapp: z.preprocess(emptyToUndefined, phone.optional()),
  city: z.string().trim().min(2, 'Enter your city').max(60),
  state: z.string().trim().min(2, 'Select your state').max(60),
  bio: z.preprocess(emptyToUndefined, z.string().trim().max(500, 'Keep it under 500 characters').optional()),
});

const storeBody = z.object({ slug: slugSchema });

/** All routes here require a logged-in seller and only ever touch that seller's own records. */
export async function sellerRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  const getProfile = (userId: string) => app.prisma.sellerProfile.findUnique({ where: { userId } });

  app.get('/api/seller/profile', async (req) => ({ profile: await getProfile(req.user!.id) }));

  app.put('/api/seller/profile', async (req) => {
    const b = profileBody.parse(req.body);
    const data = { ...b, whatsapp: b.whatsapp ?? null, bio: b.bio ?? null };
    const profile = await app.prisma.sellerProfile.upsert({
      where: { userId: req.user!.id },
      create: { userId: req.user!.id, ...data },
      update: data,
    });
    return { profile };
  });

  app.get('/api/seller/store', async (req) => {
    const profile = await getProfile(req.user!.id);
    const store = profile ? await app.prisma.store.findUnique({ where: { sellerProfileId: profile.id } }) : null;
    return { store };
  });

  app.get('/api/seller/store/slug-check', async (req) => {
    const parsed = slugSchema.safeParse((req.query as { slug?: string }).slug ?? '');
    if (!parsed.success) return { available: false, reason: parsed.error.issues[0].message };
    const existing = await app.prisma.store.findUnique({
      where: { slug: parsed.data },
      select: { sellerProfile: { select: { userId: true } } },
    });
    const available = !existing || existing.sellerProfile.userId === req.user!.id;
    return { available, reason: available ? undefined : 'This address is already taken' };
  });

  app.put('/api/seller/store', async (req) => {
    const { slug } = storeBody.parse(req.body);
    const profile = await getProfile(req.user!.id);
    if (!profile) throw new HttpError(409, 'profile_required', 'Please complete your seller profile first.');

    const current = await app.prisma.store.findUnique({ where: { sellerProfileId: profile.id } });
    if (current?.isPublished && current.slug !== slug) {
      throw new HttpError(409, 'slug_locked', 'Your store address cannot change after it is published, because shared links would break.');
    }
    try {
      const store = current
        ? await app.prisma.store.update({ where: { id: current.id }, data: { slug } })
        : await app.prisma.store.create({ data: { sellerProfileId: profile.id, slug } });
      return { store };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new HttpError(409, 'slug_taken', 'This store address is already taken.', { slug: 'Already taken' });
      }
      throw e;
    }
  });
}
