/**
 * Seeds ONE clearly-labelled SAMPLE seller, store, brand and products for demonstrations.
 * Everything created here has users.isSample / stores.isSample = true and "(Sample)" in its names.
 * Real sellers are never touched. Idempotent: safe to run repeatedly.
 */
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { loadConfig } from '../src/config';
import { hashPassword } from '../src/lib/password';

const SAMPLE_EMAIL = 'sample.seller@gharse.example';
const SAMPLE_SLUG = 'sample-meeras-diyas';

async function main() {
  const config = loadConfig();
  if (config.isProd && process.env.ALLOW_SEED !== 'true') {
    throw new Error('Refusing to seed in production. Set ALLOW_SEED=true to override.');
  }
  const prisma = new PrismaClient({ datasourceUrl: config.DATABASE_URL });

  const password = process.env.SEED_SAMPLE_PASSWORD || randomBytes(9).toString('base64url');
  const passwordHash = await hashPassword(password);

  const user = await prisma.user.upsert({
    where: { email: SAMPLE_EMAIL },
    create: { email: SAMPLE_EMAIL, passwordHash, isSample: true },
    update: { passwordHash, isSample: true },
  });

  const profile = await prisma.sellerProfile.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      fullName: 'Meera (Sample Seller)',
      phone: '9876543210',
      whatsapp: '9876543210',
      city: 'Jaipur',
      state: 'Rajasthan',
      bio: 'SAMPLE DATA — a fictional seller used to demonstrate GharSe.',
    },
    update: {},
  });

  const store = await prisma.store.upsert({
    where: { sellerProfileId: profile.id },
    create: {
      sellerProfileId: profile.id,
      slug: SAMPLE_SLUG,
      isSample: true,
      isPublished: true,
      contactEmail: SAMPLE_EMAIL,
      contactPhone: null, // the demo store is public: never publish a phone number that might belong to a real person
      deliveryPolicy: 'SAMPLE: Orders are dispatched within 3–5 days. Delivery charges are confirmed by the seller.',
      returnPolicy: 'SAMPLE: Damaged items can be reported within 48 hours of delivery.',
      deliveryChargePaise: 6000,
    },
    update: { isSample: true, contactPhone: null },
  });

  await prisma.brandProfile.upsert({
    where: { storeId: store.id },
    create: {
      storeId: store.id,
      name: "Meera's Diyas (Sample)",
      tagline: 'Light that feels like home',
      story: 'SAMPLE BRAND — a fictional handmade diya brand used for demonstration.',
      primaryColor: '#B5543A',
      secondaryColor: '#E9C46A',
      tone: 'Warm, festive and personal',
      personalityTraits: ['warm', 'traditional', 'heartfelt'],
      descriptionStyle: 'Short, friendly sentences that speak directly to the customer.',
      visualGuidelines: 'Earthy terracotta tones, soft natural light, uncluttered backgrounds.',
      status: 'APPROVED',
      version: 1,
      approvedAt: new Date(),
    },
    update: {},
  });

  const products = [
    { slug: 'sample-hand-painted-diya-set', title: 'Hand-painted diya set (Sample)', pricePaise: 34900, stock: 12 },
    { slug: 'sample-floral-tealight-holder', title: 'Floral tealight holder (Sample)', pricePaise: 24900, stock: 8 },
    { slug: 'sample-festive-diya-gift-box', title: 'Festive diya gift box (Sample)', pricePaise: 59900, stock: 5 },
  ];
  for (const p of products) {
    await prisma.product.upsert({
      where: { storeId_slug: { storeId: store.id, slug: p.slug } },
      create: {
        storeId: store.id,
        ...p,
        description: 'SAMPLE PRODUCT — fictional listing used for demonstration.',
        category: 'Home Décor',
        tags: ['sample', 'diya'],
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
      update: {},
    });
  }

  console.log('Seeded SAMPLE data:');
  console.log(`  login:    ${SAMPLE_EMAIL}`);
  console.log(`  password: ${password}  (set SEED_SAMPLE_PASSWORD to choose your own)`);
  console.log(`  store:    /store/${SAMPLE_SLUG}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
