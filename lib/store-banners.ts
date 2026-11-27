import type { Db } from 'mongodb';

export type StoreBanner = {
  id: string;
  imageUrl: string;
  alt: string;
};

const SLIDER_DEFAULT_CLEANUP_MARKER_ID = 'store_banners_default_seed_cleanup_v1';

function isHttpsImageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Return only banners intentionally uploaded or added by an administrator.
 * Old system-generated demo banners are removed once and are never recreated.
 */
export async function listStoreBanners(db: Db): Promise<StoreBanner[]> {
  const bannerCollection = db.collection('store_banners');
  const cleanupClaim = await db.collection<{ _id: string; createdAt?: Date; purpose?: string }>('store_settings').updateOne(
    { _id: SLIDER_DEFAULT_CLEANUP_MARKER_ID },
    { $setOnInsert: { createdAt: new Date(), purpose: 'remove system-generated demo slider images' } },
    { upsert: true }
  );

  if (cleanupClaim.upsertedCount === 1) {
    // These records were inserted only by the old hard-coded demo image seed.
    await bannerCollection.deleteMany({ createdBySystem: true });
  }

  const banners = await bannerCollection
    .find({ createdBySystem: { $ne: true } })
    .sort({ createdAt: 1, _id: 1 })
    .limit(12)
    .toArray();

  return banners.map((banner) => ({
    id: String(banner._id),
    imageUrl: isHttpsImageUrl(banner.imageUrl)
      ? banner.imageUrl
      : '/api/store-banners/' + String(banner._id) + '/image',
    alt: typeof banner.alt === 'string' && banner.alt.trim() ? banner.alt : 'عرض من أرض الجوال'
  }));
}
