import { ObjectId, type Db, type Document } from 'mongodb';
import type { Product, ProductColorMask } from '@/lib/products';

export type StoreCategory = Document & {
  _id: ObjectId;
  name: string;
  description?: string;
  icon?: string;
  seedName?: string;
  createdAt: Date;
  updatedAt: Date;
  deleted?: boolean;
  displayOrder?: number;
};

// Cache the cleanup within each configured database/runtime. This is only
// for the existing broken-image reference cleanup, not catalogue seeding.
const blockedCatalogImageCleanup = new Map<string, Promise<void>>();

function initializationKey(db: Db) {
  return (process.env.MONGODB_URI || '') + ':' + db.databaseName;
}

export type StoredProduct = Document & {
  _id: ObjectId;
  categoryId: string;
  seedId?: string;
  deleted?: boolean;
  imageUrl?: string;
  oldPrice?: number;
  badge?: string;
  shortDescription?: string;
  specifications?: string[];
  category: string;
  name: string;
  colors: string[];
  colorImages?: Record<string, string>;
  storageOptions: string[];
  storagePrices?: Record<string, number>;
  price: number;
  details: string;
  images: string[];
  sourceStore?: string;
  sourceProductUrl?: string;
  colorMask?: ProductColorMask;
  createdAt: Date;
  updatedAt: Date;
};

// These compatibility functions intentionally perform no writes. BB must never
// seed or replace MongoDB catalogue records from a local source file.
export async function ensureDefaultCategories(_db: Db): Promise<void> {}
export async function ensureDefaultProducts(_db: Db): Promise<void> {}

// This list is used only to sort categories already returned by MongoDB.
// It is never used to create or display categories when the database is empty.
const SOURCE_CATEGORY_ORDER = [
  'سلسلة آيفون 18 برو ماكس',
  'سلسلة آيفون 18 برو',
  'سلسلة آيفون 18 ديو',
  'سلسلة آيفون 17 برو ماكس',
  'سلسلة آيفون 17 برو',
  'سلسلة آيفون 17',
  'سلسلة آيفون 17 Air',
  'سلسلة آيفون 16',
  'سلسلة آيفون 16 برو',
  'سلسلة آيفون 16 بلس',
  'سلسلة آيفون 15',
  'سلسلة آيفون 15 بلس',
  'سلسلة آيفون 14',
  'سلسلة آيفون 13',
  'سلسلة سامسونج ألترا',
  'العاب بلايستيشن 5',
  'العاب نينتندو سويتش',
  'سامسونج S26',
  'سامسونج S25',
  'سامسونج S24'
] as const;

export function sortStoreCategoriesBySourceOrder<T extends { name: string; createdAt?: Date | string; displayOrder?: number }>(items: T[]): T[] {
  const sourceOrder = new Map<string, number>(
    SOURCE_CATEGORY_ORDER.map((name, index) => [name, index] as const)
  );

  const timestamp = (value: Date | string | undefined) => {
    if (!value) return 0;
    const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  };

  return [...items].sort((left, right) => {
    const leftManual = Number.isFinite(left.displayOrder) ? left.displayOrder : undefined;
    const rightManual = Number.isFinite(right.displayOrder) ? right.displayOrder : undefined;

    // Once an administrator assigns positions, those saved positions take
    // precedence over the legacy source ordering.
    if (leftManual !== undefined && rightManual !== undefined) {
      return leftManual - rightManual || left.name.localeCompare(right.name, 'ar');
    }
    if (leftManual !== undefined) return -1;
    if (rightManual !== undefined) return 1;

    const leftOrder = sourceOrder.get(left.name);
    const rightOrder = sourceOrder.get(right.name);

    if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder;
    if (leftOrder !== undefined) return -1;
    if (rightOrder !== undefined) return 1;

    return timestamp(left.createdAt) - timestamp(right.createdAt)
      || left.name.localeCompare(right.name, 'ar');
  });
}

export async function listCategories(db: Db) {
  const categories = await db.collection<StoreCategory>('categories')
    .find({ deleted: { $ne: true } })
    .sort({ createdAt: 1, name: 1 })
    .toArray();
  return sortStoreCategoriesBySourceOrder(categories);
}

const REMOVED_CATALOG_IMAGE_NAME = 'GjaaIMG_fbc54b6d-bf6a-49e0-83c1-8c3551b1036c.png';
const BLOCKED_CATALOG_IMAGE_NAMES = new Set([
  'mtc3img_6a7a1945-3a12-4fac-82cc-e207d76bdee8.png',
  '1793472237161236.png',
  REMOVED_CATALOG_IMAGE_NAME
]);

function catalogImageFilename(value: string) {
  const path = value.trim().replace(/\\/g, '/').split(/[?#]/, 1)[0];
  const filename = path.slice(path.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(filename).toLowerCase();
  } catch {
    return filename.toLowerCase();
  }
}

/** Exclude known broken source images from absolute URLs and relative paths. */
export function isBlockedCatalogImage(value: unknown): boolean {
  return typeof value === 'string'
    && BLOCKED_CATALOG_IMAGE_NAMES.has(catalogImageFilename(value));
}

function isRemovedCatalogImage(value: unknown) {
  return typeof value === 'string'
    && catalogImageFilename(value) === REMOVED_CATALOG_IMAGE_NAME.toLowerCase();
}

/**
 * Permanently remove the requested source image from product records once per
 * database/runtime. This cleans the stored gallery, cover image, and variants,
 * rather than relying only on presentation-time filtering.
 */
async function removeRequestedCatalogImageReferences(db: Db) {
  const key = initializationKey(db);
  let pending = blockedCatalogImageCleanup.get(key);

  if (!pending) {
    pending = (async () => {
      const collection = db.collection<StoredProduct>('products');
      const products = await collection.find({}, {
        projection: { _id: 1, imageUrl: 1, images: 1, colorImages: 1 }
      }).toArray();

      for (const product of products) {
        const originalImages = Array.isArray(product.images) ? product.images : [];
        const filteredImages = originalImages.filter((image) => !isRemovedCatalogImage(image));
        const originalColorImages = Object.entries(product.colorImages || {});
        const filteredColorImages = Object.fromEntries(
          originalColorImages.filter(([, image]) => !isRemovedCatalogImage(image))
        );
        const removeGalleryImage = filteredImages.length !== originalImages.length;
        const removeCoverImage = isRemovedCatalogImage(product.imageUrl);
        const removeVariantImage = Object.keys(filteredColorImages).length !== originalColorImages.length;

        if (!removeGalleryImage && !removeCoverImage && !removeVariantImage) continue;

        const setFields: Partial<StoredProduct> = { updatedAt: new Date() };
        if (removeGalleryImage) setFields.images = filteredImages;
        if (removeVariantImage) setFields.colorImages = filteredColorImages;

        const update: {
          $set: Partial<StoredProduct>;
          $unset?: { imageUrl: '' };
        } = { $set: setFields };
        if (removeCoverImage) update.$unset = { imageUrl: '' };
        await collection.updateOne({ _id: product._id }, update);
      }
    })();
    blockedCatalogImageCleanup.set(key, pending);
  }

  try {
    await pending;
  } catch (error) {
    if (blockedCatalogImageCleanup.get(key) === pending) {
      blockedCatalogImageCleanup.delete(key);
    }
    throw error;
  }
}

function isHttpImageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function getStoredProductStorage(
  product: Pick<StoredProduct, 'storageOptions' | 'storagePrices'>
) {
  // The imported product document already stores its exact available choices
  // and per-capacity prices. Never reduce them based on the capacity in its name.
  return {
    storageOptions: product.storageOptions || [],
    storagePrices: product.storagePrices || {}
  };
}

export function serializeStoredProduct(product: StoredProduct, options: { includeColorMask?: boolean } = {}): Product & {
  categoryId: string;
  colors: string[];
  storageOptions: string[];
  storagePrices: Record<string, number>;
  images: string[];
} {
  const id = product._id.toHexString();
  const colorImageVersion = product.updatedAt instanceof Date ? product.updatedAt.getTime() : 0;
  const images = Array.isArray(product.images) ? product.images : [];
  // Filter the known broken source images, but retain original indices for
  // Telegram file IDs because the image API reads from the stored array.
  const storedImageUrls = images.flatMap((image, index) => (
    isBlockedCatalogImage(image)
      ? []
      : [`/api/products/${id}/image?index=${index}`]
  ));
  const fallbackImage = isBlockedCatalogImage(product.imageUrl)
    ? ''
    : isHttpImageUrl(product.imageUrl)
      ? `/api/products/${id}/image?source=cover&v=${colorImageVersion}`
      : product.imageUrl || '';
  const displayImages = storedImageUrls.length ? storedImageUrls : fallbackImage ? [fallbackImage] : [];
  const storage = getStoredProductStorage(product);
  const colorImages = Object.fromEntries(
    Object.entries(product.colorImages || {})
      .filter(([, image]) => !isBlockedCatalogImage(image))
      .map(([color, image]) => [
        color,
        isHttpImageUrl(image)
          ? `/api/products/${id}/image?color=${encodeURIComponent(color)}&v=${colorImageVersion}`
          : `/api/products/${id}/image?color=${encodeURIComponent(color)}&v=${colorImageVersion}`
      ] as const)
  );
  // Match the product-details page's initial color selection so the homepage
  // card uses the same variant image that customers see when opening the item.
  const normalizeColor = (value: string) => value.trim().normalize('NFKC').replace(/\\s+/g, ' ');
  const defaultColor = normalizeColor(product.colorMask?.sourceColor || product.colors?.[0] || '');
  const defaultColorImage = defaultColor
    ? colorImages[defaultColor] || Object.entries(colorImages).find(
        ([color]) => normalizeColor(color) === defaultColor
      )?.[1] || ''
    : '';
  return {
    id: product.seedId || id,
    name: product.name,
    category: product.category,
    categoryId: product.categoryId,
    price: product.price,
    image: defaultColorImage || displayImages[0] || '',
    images: displayImages,
    ...(product.oldPrice !== undefined ? { oldPrice: product.oldPrice } : {}),
    ...(product.badge ? { badge: product.badge } : {}),
    colors: product.colors || [],
    ...(Object.keys(colorImages).length ? { colorImages } : {}),
    // Qauraa imports represent each source product URL as one sellable SKU.
    // Do not inherit capacities merged from similarly named sibling products.
    storageOptions: storage.storageOptions,
    storagePrices: storage.storagePrices,
    shortDescription: product.shortDescription || product.details,
    description: product.details,
    specifications: product.specifications || [],
    ...(options.includeColorMask && product.colorMask ? { colorMask: product.colorMask } : {})
  };
}

export async function listCatalogProducts(db: Db): Promise<Product[]> {
  await ensureDefaultProducts(db);
  await removeRequestedCatalogImageReferences(db);
  // The homepage catalogue never needs the large AI color mask payload.
  const saved = await db.collection<StoredProduct>('products')
    .find({ deleted: { $ne: true } }, { projection: { colorMask: 0 } })
    .sort({ createdAt: -1 })
    .toArray();

  // Keep every imported source product as its own catalogue entry.
  // Storage capacities from separate Qauraa product URLs must never be merged.
  return saved.map((product) => serializeStoredProduct(product));

}

export async function findStoredProduct(db: Db, id: string) {
  const collection = db.collection<StoredProduct>('products');
  return ObjectId.isValid(id)
    ? collection.findOne({ _id: new ObjectId(id), deleted: { $ne: true } })
    : collection.findOne({ seedId: id, deleted: { $ne: true } });
}
