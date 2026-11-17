import type { PrismaClient } from '@prisma/client';

/** The "who am I and how far through onboarding" payload used by the web app. */
export async function buildMe(prisma: PrismaClient, userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      isSample: true,
      sellerProfile: {
        include: {
          store: { include: { brandProfile: { select: { name: true, version: true, status: true } } } },
        },
      },
    },
  });
  const { store: storeWithBrand, ...profile } = user.sellerProfile ?? ({} as never);
  const { brandProfile, ...store } = storeWithBrand ?? ({} as never);
  const hasProfile = !!user.sellerProfile;
  const hasStore = !!storeWithBrand;
  return {
    user: { id: user.id, email: user.email, isSample: user.isSample },
    profile: hasProfile ? profile : null,
    store: hasStore ? store : null,
    brand: brandProfile ?? null,
    onboarding: { profileComplete: hasProfile, storeComplete: hasStore },
  };
}
