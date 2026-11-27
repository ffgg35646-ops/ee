import { createHash, randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/mongodb';
import { getAdminFromRequest, ensureBootstrapAdmin, hashAdminPassword } from '@/lib/admin-auth';
import { listCategories, sortStoreCategoriesBySourceOrder, type StoreCategory, type StoredProduct } from '@/lib/catalog';
import { discoverAlBragCategoryProductUrls, discoverAlBragProductUrls, importAlBragProduct } from '@/lib/source-product-importer';
import { isPhoneCaseProduct } from '@/lib/phone-case';
import { fetchRemoteImage } from '@/lib/remote-image';
import {
  getCatalogImportJob,
  startCatalogImportJob,
  processNextCatalogImportBatch,
  stopCatalogImportJob,
  saveImportedSourceProduct
} from '@/lib/source-catalog-jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NO_STORE = { 'cache-control': 'no-store, max-age=0, must-revalidate' };
const PAGE_KEYS: Record<string, { title: string; group: string }> = {
  privacy: { title: 'سياسة الخصوصية', group: 'policies' },
  terms: { title: 'الشروط والأحكام', group: 'policies' },
  returns: { title: 'الاستبدال والاسترجاع', group: 'policies' },
  warranty: { title: 'سياسة الضمان', group: 'policies' },
  shipping: { title: 'الشحن والتوصيل', group: 'customer-service' },
  'payment-methods': { title: 'طرق الدفع', group: 'customer-service' },
  ordering: { title: 'طلب الدفع والشراء', group: 'customer-service' },
  faq: { title: 'الأسئلة الشائعة', group: 'customer-service' }
};
const ORDER_STATUSES = ['new', 'confirmed', 'shipped', 'completed', 'cancelled'] as const;

type Body = Record<string, unknown>;

function textValue(value: unknown, max = 4000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function numberValue(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[٬,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function stringList(value: unknown, maxItems = 40, maxLength = 300): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string' ? value.split(/[\r\n,،;؛]+/) : [];
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))].slice(0, maxItems).map((item) => item.slice(0, maxLength));
}

function priceMap(value: unknown, options: string[]) {
  const result: Record<string, number> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const price = numberValue(raw);
    if (options.includes(key) && Number.isFinite(price) && price > 0 && price <= 100000000) result[key] = price;
  }
  return result;
}

function serializeDocument<T extends { _id: ObjectId }>(document: T) {
  const { _id, ...rest } = document;
  return { ...rest, id: _id.toHexString() };
}

function sameOrigin(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.get('host');
  } catch {
    return false;
  }
}

async function authorized(request: NextRequest) {
  const db = await getDb();
  const admin = await getAdminFromRequest(db, request);
  return admin ? { db, admin } : null;
}

async function readView(db: Awaited<ReturnType<typeof getDb>>, view: string, request: NextRequest, adminEmail: string) {
  if (view === 'dashboard') {
    const [products, categories, orders, banners, reviews, activeOrders, shippedOrders, revenue] = await Promise.all([
      db.collection('products').countDocuments({ deleted: { $ne: true } }),
      db.collection('categories').countDocuments({ deleted: { $ne: true } }),
      db.collection('orders').countDocuments({}),
      db.collection('store_banners').countDocuments({ createdBySystem: { $ne: true } }),
      db.collection('customer_reviews').countDocuments({}),
      db.collection('orders').countDocuments({ status: { $in: ['new', 'confirmed'] } }),
      db.collection('orders').countDocuments({ status: 'shipped' }),
      db.collection('orders').aggregate([{ $match: { status: 'completed' } }, { $group: { _id: null, total: { $sum: '$total' } } }]).toArray()
    ]);
    return {
      stats: { products, categories, orders, banners, reviews, activeOrders, shippedOrders, completedRevenue: revenue[0]?.total || 0 },
      admin: { email: adminEmail }
    };
  }

  if (view === 'products') {
    const q = textValue(request.nextUrl.searchParams.get('q'), 100);
    const categoryId = textValue(request.nextUrl.searchParams.get('categoryId'), 40);
    const filter: Record<string, unknown> = { deleted: { $ne: true } };
    if (categoryId && ObjectId.isValid(categoryId)) filter.categoryId = categoryId;
    if (q) {
      const pattern = q.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/[{}]/g, '\\$&');
      filter.$or = [{ name: { $regex: pattern, $options: 'i' } }, { category: { $regex: pattern, $options: 'i' } }, { sourceSku: { $regex: pattern, $options: 'i' } }];
    }
    const products = await db.collection<StoredProduct>('products').find(filter)
      .project({ colorMask: 0 }).sort({ updatedAt: -1 }).limit(150).toArray();
    return { products: products.map((product) => serializeDocument(product as StoredProduct)) };
  }

  if (view === 'categories') {
    const categories = sortStoreCategoriesBySourceOrder(await listCategories(db));
    const rows = await Promise.all(categories.map(async (category) => ({
      ...serializeDocument(category),
      productCount: await db.collection('products').countDocuments({
        $or: [{ categoryId: category._id.toHexString() }, { category: category.name }],
        deleted: { $ne: true }
      })
    })));
    return { categories: rows };
  }

  if (view === 'orders') {
    const orders = await db.collection('orders')
      .find({})
      .project({ cardNumber: 0, cvv: 0, expiryMonth: 0, expiryYear: 0, cardholderName: 0 })
      .sort({ createdAt: -1 }).limit(150).toArray();
    return { orders: orders.map((order) => {
      const { _id, ...rest } = order;
      return { ...rest, id: _id.toString() };
    }) };
  }

  if (view === 'import') {
    return { job: await getCatalogImportJob(db) };
  }

  if (view === 'store') {
    const [settings, pages, banners] = await Promise.all([
      db.collection<{ _id: string; [key: string]: any }>('store_settings').find({ _id: { $in: ['brand', 'contact', 'footer', 'branding'] } })
        .project({ iconOneImageDataBase64: 0, iconTwoImageDataBase64: 0, iconOneImageSize: 0, iconTwoImageSize: 0 }).toArray(),
      db.collection<{ _id: string; [key: string]: any }>('store_pages').find({}).sort({ _id: 1 }).toArray(),
      db.collection('store_banners').find({ createdBySystem: { $ne: true } }).sort({ createdAt: 1, _id: 1 }).limit(12).toArray()
    ]);
    const settingsByKey = Object.fromEntries(settings.map((item) => [String(item._id), item]));
    return {
      settings: settingsByKey,
      pages: pages.map((page) => ({ key: String(page._id), title: page.title || PAGE_KEYS[String(page._id)]?.title || String(page._id), group: page.group || PAGE_KEYS[String(page._id)]?.group || 'other', content: page.content || '' })),
      banners: banners.map((banner) => ({
        id: String(banner._id),
        imageUrl: banner.imageUrl || (banner._id ? '/api/store-banners/' + String(banner._id) + '/image' : ''),
        alt: banner.alt || 'صورة عرض'
      }))
    };
  }

  if (view === 'reviews') {
    const reviews = await db.collection('customer_reviews').find({}).sort({ createdAt: -1 }).limit(150).toArray();
    return { reviews: reviews.map((review) => {
      const { _id, ...rest } = review;
      return { ...rest, id: String(_id) };
    }) };
  }

  if (view === 'admins') {
    await ensureBootstrapAdmin(db);
    const admins = await db.collection('admin_users').find({}).project({ passwordHash: 0, passwordSalt: 0 }).sort({ createdAt: 1 }).toArray();
    return { admins: admins.map((item) => {
      const { _id, ...rest } = item;
      return { ...rest, id: String(_id) };
    }) };
  }

  return null;
}

function colorImageMap(value: unknown, colors: string[]) {
  const result: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [color, image] of Object.entries(value as Record<string, unknown>)) {
    const key = color.trim().slice(0, 80);
    const ref = typeof image === 'string' ? image.trim().slice(0, 1500) : '';
    if (!key || !colors.includes(key) || !ref) continue;
    if (ref.startsWith('admin-media:')) {
      const id = ref.slice('admin-media:'.length);
      if (ObjectId.isValid(id)) result[key] = ref;
      continue;
    }
    try {
      const url = new URL(ref);
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) result[key] = ref;
    } catch {
      if (!/\s/.test(ref) && ref.length >= 12) result[key] = ref;
    }
  }
  return result;
}

function productAdminMediaRefs(product: Partial<StoredProduct>) {
  const values = [
    ...(Array.isArray(product.images) ? product.images : []),
    product.imageUrl,
    ...Object.values(product.colorImages || {})
  ];
  return [...new Set(values.filter((value): value is string =>
    typeof value === 'string' && value.startsWith('admin-media:')
  ))];
}

async function removeUnusedAdminMedia(db: Awaited<ReturnType<typeof getDb>>, refs: string[]) {
  for (const ref of [...new Set(refs)]) {
    const id = ref.slice('admin-media:'.length);
    if (!ObjectId.isValid(id)) continue;
    const usedByProduct = await db.collection<StoredProduct>('products').aggregate([
      { $match: { deleted: { $ne: true } } },
      { $match: { $or: [
        { images: ref },
        { imageUrl: ref },
        { $expr: { $in: [ref, {
          $map: {
            input: { $objectToArray: { $ifNull: ['$colorImages', {}] } },
            as: 'entry',
            in: '$entry.v'
          }
        }] } }
      ] } },
      { $limit: 1 },
      { $project: { _id: 1 } }
    ]).toArray();
    const usedByBanner = await db.collection('store_banners').findOne({
      $or: [{ mediaId: id }, { imageUrl: ref }]
    });
    if (!usedByProduct.length && !usedByBanner) {
      await db.collection('admin_media').deleteOne({ _id: new ObjectId(id) });
    }
  }
}

const IMPORTABLE_IMAGE_HOSTS = new Set([
  'al-brag-ksa.com','www.al-brag-ksa.com','i5.walmartimages.com','cdn.mafrservices.com','www.belkin.com',
  'res.plaisio.gr','multimedia.bbycastatic.ca','shepetivka.com.ua','images.samsung.com',
  'media.tatacroma.com','cdn.beebom.com','cdn.idealo.com','image.vandenborre.be',
  'media.ldlc.com','smartmania.cz','gadgets-msk.ru','www.juzaphoto.com',
  'consumer.huawei.com','www.hi-fi.ru','img-prd-pim.poorvika.com','uk.tech21.com',
  'down-my.img.susercontent.com','i.blogs.es','media.karousell.com','img01.huaweifile.com',
  'store.yohohongkong.com','www.nfm.com','cdn.ballicom.co.uk','assets.mmsrg.com',
  'cdn1.technopark.ru','cdn1.sgliteasset.com','images1.mobilissimo.ro','cdn11.bigcommerce.com',
  'img02.honorfile.com','alkaramhome.com','dwecxxryy5p59.cloudfront.net','xstore.md',
  'www.pbtech.co.nz','www.digitec.ch','lmt-web.mstatic.lv','image.ksdenki.com',
  'cdn.media.amplience.net','cdn2.fptshop.com.vn','s3.us-east-1.amazonaws.com',
  'pimcdn.sharafdg.com','cdn.tmobile.com','ak-asset.jarir.com','www.jbhifi.co.nz',
  'besttrendonline.com','s3.belkin.com','www.costco.com.mx','store.storeimages.cdn-apple.com',
  'files.foxtrot.com.ua','f00.esfr.pl','m.media-amazon.com','cdn.cs.1worldsync.com',
  'cdn.shopify.com','www.courts.com.sg','pisces.bbystatic.com',
  'cdsassets.apple.com','images.apple.com','www.apple.com'
]);

async function refreshStoredProductImagesFromSource(
  db: Awaited<ReturnType<typeof getDb>>,
  product: StoredProduct
): Promise<StoredProduct> {
  const rawUrl = typeof product.sourceProductUrl === 'string' ? product.sourceProductUrl : '';
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(rawUrl);
  } catch {
    return product;
  }
  if (
    sourceUrl.protocol !== 'https:'
    || !['al-brag-ksa.com','www.al-brag-ksa.com','al-brag-ksa.store','www.al-brag-ksa.store'].includes(sourceUrl.hostname.toLowerCase())
    || !/^\/product2\/\d+\/?$/.test(sourceUrl.pathname)
  ) {
    return product;
  }

  const sourceProduct = await importAlBragProduct(sourceUrl.toString());
  const sourceImages = [...new Set(sourceProduct.images.filter((value) => typeof value === 'string' && value.startsWith('https://')))].slice(0, 10);
  if (!sourceImages.length) throw new Error('صفحة المنتج الأصلية لم تُرجع صورة قابلة للحفظ: ' + sourceUrl.pathname);

  const colorImages = { ...(product.colorImages || {}) };
  for (const color of product.colors || []) colorImages[color] = sourceImages[0];
  const refreshed: StoredProduct = {
    ...product,
    images: sourceImages,
    sourceImageUrls: sourceImages,
    colorImages,
    updatedAt: new Date()
  };
  await db.collection<StoredProduct>('products').updateOne(
    { _id: product._id },
    { $set: { images: refreshed.images, sourceImageUrls: refreshed.sourceImageUrls, colorImages: refreshed.colorImages, updatedAt: refreshed.updatedAt } }
  );
  return refreshed;
}

async function importProductImagesToAdminMedia(
  db: Awaited<ReturnType<typeof getDb>>,
  adminEmail: string,
  product: StoredProduct
) {
  const urls = [...new Set([
    ...(Array.isArray(product.images) ? product.images : []),
    ...Object.values(product.colorImages || {})
  ].filter((value): value is string => {
    if (typeof value !== 'string' || value.startsWith('admin-media:')) return false;
    try {
      const url = new URL(value);
      return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
    } catch {
      return false;
    }
  }))];
  if (!urls.length) return { images: product.images || [], colorImages: product.colorImages || {}, importedCount: 0 };
  if (urls.length > 20) throw new Error('عدد روابط الصور لهذا المنتج أكبر من الحد المسموح به في عملية واحدة.');
  for (const value of urls) {
    const host = new URL(value).hostname.toLowerCase();
    if (!IMPORTABLE_IMAGE_HOSTS.has(host)) {
      throw new Error('مصدر إحدى الصور غير موجود في قائمة النطاقات المسموح باستيرادها: ' + host);
    }
  }

  const replacements = new Map<string, string>();
  const insertedIds: ObjectId[] = [];
  try {
    for (let offset = 0; offset < urls.length; offset += 4) {
      const batch = await Promise.all(urls.slice(offset, offset + 4).map(async (url) => {
        const response = await fetchRemoteImage(url);
        if (!response.ok) throw new Error('تعذر تنزيل إحدى الصور من مصدرها الخارجي (HTTP ' + response.status + ').');
        const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!['image/jpeg','image/png','image/webp','image/gif','image/avif'].includes(contentType)) {
          throw new Error('المصدر لم يُرجع ملف صورة مدعومًا.');
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length || bytes.length > 4 * 1024 * 1024) {
          throw new Error('حجم إحدى الصور أكبر من 4 ميجابايت أو أن الملف فارغ.');
        }
        const id = new ObjectId();
        const pathname = new URL(url).pathname;
        const filename = decodeURIComponent(pathname.split('/').pop() || 'product-image').slice(0, 180);
        await db.collection('admin_media').insertOne({
          _id: id,
          dataBase64: bytes.toString('base64'),
          contentType,
          filename,
          size: bytes.length,
          createdAt: new Date(),
          createdByAdminEmail: adminEmail
        });
        insertedIds.push(id);
        replacements.set(url, 'admin-media:' + id.toHexString());
      }));
      void batch;
    }
  } catch (error) {
    if (insertedIds.length) await db.collection('admin_media').deleteMany({ _id: { $in: insertedIds } });
    throw error;
  }

  const images = (product.images || []).map((image) => replacements.get(image) || image);
  const colorImages = Object.fromEntries(
    Object.entries(product.colorImages || {}).map(([color, image]) => [color, replacements.get(image) || image])
  );
  return { images, colorImages, importedCount: replacements.size };
}

function readProductPayload(body: Body) {
  const name = textValue(body.name, 120);
  const categoryId = textValue(body.categoryId, 40);
  const price = numberValue(body.price);
  const details = textValue(body.details, 3000);
  if (name.length < 2 || !ObjectId.isValid(categoryId) || !Number.isFinite(price) || price <= 0 || price > 100000000 || details.length < 2) {
    throw new Error('أدخل اسم المنتج والقسم والسعر والتفاصيل بصورة صحيحة.');
  }
  const colors = stringList(body.colors, 30, 80);
  const storageOptions = stringList(body.storageOptions, 30, 80);
  const storagePrices = priceMap(body.storagePrices, storageOptions);
  const specifications = stringList(body.specifications, 40, 300);
  const images = stringList(body.images, 10, 1500);
  const colorImages = colorImageMap(body.colorImages, colors);
  for (const image of images) {
    if (image.startsWith('admin-media:')) {
      if (!ObjectId.isValid(image.slice('admin-media:'.length))) throw new Error('معرّف صورة الإدارة غير صالح.');
      continue;
    }
    try {
      const url = new URL(image);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch {
      if (/\s/.test(image) || image.length < 12) throw new Error('كل صورة يجب أن تكون رابط HTTP(S) صالحًا أو معرّف صورة تيليجرام.');
    }
  }
  const oldPrice = numberValue(body.oldPrice);
  if (Number.isFinite(oldPrice) && oldPrice > 0 && oldPrice <= price) throw new Error('السعر السابق يجب أن يكون أكبر من السعر الحالي.');
  return { name, categoryId, price, details, colors, storageOptions, storagePrices, specifications, images, colorImages, oldPrice };
}

async function performAction(db: Awaited<ReturnType<typeof getDb>>, admin: { id: string; email: string; role: string }, action: string, body: Body) {
  const now = new Date();

  if (action === 'import-catalog-media-batch') {
    const collection = db.collection<StoredProduct>('products');
    const allProducts = await collection.find({ deleted: { $ne: true } })
      .project({ _id: 1, name: 1, images: 1, colorImages: 1, sourceProductUrl: 1, colors: 1 })
      .sort({ _id: 1 }).toArray();
    const needsImport = allProducts.filter((product) => [
      ...(Array.isArray(product.images) ? product.images : []),
      ...Object.values(product.colorImages || {})
    ].some((value) => {
      if (typeof value !== 'string' || value.startsWith('admin-media:')) return false;
      try {
        const url = new URL(value);
        return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
      } catch {
        return false;
      }
    }));
    if (!needsImport.length) {
      return { message: 'كل صور المنتجات محفوظة بالفعل في مكتبة الإدارة.', importedImages: 0, processedCount: 0, remainingCount: 0, errors: [] };
    }

    let importedImages = 0;
    let processedCount = 0;
    const errors: string[] = [];
    const productPage = needsImport.find((product) => {
      try {
        const url = new URL(String(product.sourceProductUrl || ''));
        return /^\/product2\/\d+\/?$/.test(url.pathname)
          && ['al-brag-ksa.com','www.al-brag-ksa.com','al-brag-ksa.store','www.al-brag-ksa.store'].includes(url.hostname.toLowerCase());
      } catch {
        return false;
      }
    });
    // Refresh one exact source product page at a time; other URL-only products
    // can be migrated in small groups without a second source-page request.
    const batch = productPage ? [productPage] : needsImport.slice(0, 3);
    for (const product of batch) {
      try {
        const refreshed = await refreshStoredProductImagesFromSource(db, product as StoredProduct);
        const imported = await importProductImagesToAdminMedia(db, admin.email, refreshed);
        if (imported.importedCount) {
          await collection.updateOne(
            { _id: product._id },
            { $set: { images: imported.images, colorImages: imported.colorImages, updatedAt: now } }
          );
          importedImages += imported.importedCount;
        }
        processedCount += 1;
      } catch (error) {
        errors.push(String(product.name || product._id) + ': ' + (error instanceof Error ? error.message : 'تعذر تنزيل الصورة.'));
      }
    }
    const remainingCount = Math.max(0, needsImport.length - processedCount);
    return {
      message: 'تم حفظ ' + importedImages + ' صورة في هذه الدفعة.',
      importedImages,
      processedCount,
      remainingCount,
      errors
    };
  }

  if (action === 'import-product-media') {
    const id = textValue(body.id, 40);
    if (!ObjectId.isValid(id)) throw new Error('معرّف المنتج غير صالح.');
    const collection = db.collection<StoredProduct>('products');
    const product = await collection.findOne({ _id: new ObjectId(id), deleted: { $ne: true } });
    if (!product) throw new Error('المنتج غير موجود أو تم حذفه.');
    const refreshedProduct = await refreshStoredProductImagesFromSource(db, product);
    const imported = await importProductImagesToAdminMedia(db, admin.email, refreshedProduct);
    if (imported.importedCount) {
      await collection.updateOne(
        { _id: product._id },
        { $set: { images: imported.images, colorImages: imported.colorImages, updatedAt: now } }
      );
    }
    return {
      message: imported.importedCount
        ? 'تم حفظ ' + imported.importedCount + ' صورة داخل مكتبة صور الإدارة.'
        : 'صور هذا المنتج محفوظة بالفعل أو لا توجد روابط صور قابلة للاستيراد.',
      importedCount: imported.importedCount
    };
  }

  if (action === 'save-product') {
    const fields = readProductPayload(body);
    const category = await db.collection<StoreCategory>('categories').findOne({ _id: new ObjectId(fields.categoryId), deleted: { $ne: true } });
    if (!category) throw new Error('القسم المحدد غير موجود.');
    const update = {
      categoryId: category._id.toHexString(),
      category: category.name,
      name: fields.name,
      price: fields.price,
      colors: fields.colors,
      storageOptions: fields.storageOptions,
      storagePrices: fields.storagePrices,
      specifications: fields.specifications,
      details: fields.details,
      shortDescription: textValue(body.shortDescription, 300) || fields.details.slice(0, 300),
      images: fields.images,
      colorImages: fields.colorImages,
      updatedAt: now
    };
    const id = textValue(body.id, 40);
    if (id) {
      if (!ObjectId.isValid(id)) throw new Error('معرّف المنتج غير صالح.');
      const existing = await db.collection<StoredProduct>('products').findOne({ _id: new ObjectId(id), deleted: { $ne: true } });
      if (!existing) throw new Error('المنتج غير موجود أو تم حذفه.');
      const hasOldPrice = Number.isFinite(fields.oldPrice) && fields.oldPrice > fields.price;
      const previousMediaRefs = productAdminMediaRefs(existing);
      const nextMediaRefs = new Set(productAdminMediaRefs(update));
      await db.collection('products').updateOne(
        { _id: existing._id },
        {
          $set: { ...update, ...(hasOldPrice ? { oldPrice: fields.oldPrice } : {}) },
          $unset: { colorMask: '', ...(!hasOldPrice ? { oldPrice: '' } : {}) }
        }
      );
      await removeUnusedAdminMedia(db, previousMediaRefs.filter((ref) => !nextMediaRefs.has(ref)));
      return { message: 'تم تحديث المنتج.' };
    }
    const product: StoredProduct = {
      _id: new ObjectId(),
      ...update,
      ...(Number.isFinite(fields.oldPrice) && fields.oldPrice > fields.price ? { oldPrice: fields.oldPrice } : {}),
      createdAt: now,
      updatedAt: now,
      createdByAdminEmail: admin.email
    };
    await db.collection<StoredProduct>('products').insertOne(product);
    return { message: 'تم إضافة المنتج.' };
  }

  if (action === 'delete-product') {
    const id = textValue(body.id, 40);
    if (!ObjectId.isValid(id)) throw new Error('معرّف المنتج غير صالح.');
    const collection = db.collection<StoredProduct>('products');
    const existing = await collection.findOne({ _id: new ObjectId(id) });
    if (!existing) throw new Error('المنتج غير موجود.');
    const previousMediaRefs = productAdminMediaRefs(existing);
    if (existing.seedId) await collection.updateOne({ _id: existing._id }, { $set: { deleted: true, updatedAt: now } });
    else await collection.deleteOne({ _id: existing._id });
    await removeUnusedAdminMedia(db, previousMediaRefs);
    return { message: 'تم حذف المنتج من المتجر.' };
  }

  if (action === 'save-category') {
    const name = textValue(body.name, 80).replace(/\s+/g, ' ');
    const description = textValue(body.description, 300);
    if (name.length < 2) throw new Error('اسم القسم يجب أن يكون من حرفين إلى 80 حرفًا.');
    const id = textValue(body.id, 40);
    const all = await db.collection<StoreCategory>('categories').find({}).toArray();
    if (all.some((item) => (!id || item._id.toHexString() !== id) && item.name.trim().toLocaleLowerCase('ar') === name.toLocaleLowerCase('ar') && !item.deleted)) {
      throw new Error('يوجد قسم آخر بهذا الاسم.');
    }
    if (id) {
      if (!ObjectId.isValid(id)) throw new Error('معرّف القسم غير صالح.');
      const result = await db.collection<StoreCategory>('categories').findOneAndUpdate(
        { _id: new ObjectId(id), deleted: { $ne: true } },
        { $set: { name, description, updatedAt: now } },
        { returnDocument: 'after' }
      );
      if (!result) throw new Error('القسم غير موجود.');
      await db.collection('products').updateMany({ categoryId: id, deleted: { $ne: true } }, { $set: { category: name, updatedAt: now } });
      return { message: 'تم تحديث القسم.' };
    }
    const deleted = all.find((item) => item.name.trim().toLocaleLowerCase('ar') === name.toLocaleLowerCase('ar') && item.deleted);
    if (deleted) {
      await db.collection('categories').updateOne({ _id: deleted._id }, { $set: { deleted: false, description, updatedAt: now } });
      return { message: 'تمت استعادة القسم.' };
    }
    await db.collection('categories').insertOne({ _id: new ObjectId(), name, description, createdAt: now, updatedAt: now, deleted: false });
    return { message: 'تم إضافة القسم.' };
  }

  if (action === 'delete-category') {
    const id = textValue(body.id, 40);
    if (!ObjectId.isValid(id)) throw new Error('معرّف القسم غير صالح.');
    const category = await db.collection<StoreCategory>('categories').findOne({ _id: new ObjectId(id), deleted: { $ne: true } });
    if (!category) throw new Error('القسم غير موجود.');
    await db.collection('products').updateMany(
      { $or: [{ categoryId: id }, { category: category.name }], deleted: { $ne: true } },
      { $set: { deleted: true, updatedAt: now } }
    );
    await db.collection('categories').updateOne({ _id: category._id }, { $set: { deleted: true, updatedAt: now } });
    return { message: 'تم حذف القسم وإخفاء المنتجات التابعة له.' };
  }

  if (action === 'reorder-categories') {
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (!ids.length || ids.some((id) => !ObjectId.isValid(id))) throw new Error('ترتيب الأقسام غير صالح.');
    const categories = await db.collection<StoreCategory>('categories').find({ _id: { $in: ids.map((id) => new ObjectId(id)) }, deleted: { $ne: true } }).toArray();
    if (categories.length !== ids.length) throw new Error('تعذر تحديث الترتيب لأن أحد الأقسام لم يعد موجودًا.');
    await db.collection<StoreCategory>('categories').bulkWrite(ids.map((id, index) => ({
      updateOne: { filter: { _id: new ObjectId(id) }, update: { $set: { displayOrder: index + 1, updatedAt: now } } }
    })));
    return { message: 'تم حفظ ترتيب الأقسام.' };
  }

  if (action === 'update-order') {
    const id = textValue(body.id, 40);
    const status = textValue(body.status, 30);
    const reason = textValue(body.reason, 500);
    if (!ObjectId.isValid(id) || !ORDER_STATUSES.includes(status as typeof ORDER_STATUSES[number])) throw new Error('الطلب أو الحالة غير صالحين.');
    const orders = db.collection('orders');
    const order = await orders.findOne({ _id: new ObjectId(id) });
    if (!order) throw new Error('الطلب غير موجود.');
    const canShip = ['new', 'confirmed', 'preparing'].includes(String(order.status)) && status === 'shipped';
    const canComplete = ['new', 'confirmed', 'preparing', 'shipped'].includes(String(order.status)) && status === 'completed';
    const canCancel = ['new', 'confirmed', 'preparing', 'shipped'].includes(String(order.status)) && status === 'cancelled';
    if (!canShip && !canComplete && !canCancel) throw new Error('حالة الطلب الحالية لا تسمح بهذا الإجراء.');
    const result = await orders.updateOne(
      { _id: order._id, status: order.status },
      { $set: { status, updatedAt: now, updatedByAdminEmail: admin.email, ...(status === 'cancelled' && reason ? { cancellationReason: reason } : {}) }, ...(status === 'cancelled' && reason ? {} : { $unset: { cancellationReason: '' } }) }
    );
    if (result.modifiedCount !== 1) throw new Error('تغير الطلب في نفس الوقت. حدّث الصفحة وحاول مرة أخرى.');
    if (order.customerNotificationKey && ['shipped', 'cancelled'].includes(status)) {
      await db.collection('customer_notifications').insertOne({
        customerNotificationKey: order.customerNotificationKey,
        orderId: order._id.toHexString(),
        orderNumber: order.orderNumber || order._id.toHexString(),
        status,
        statusLabel: status === 'shipped' ? 'تم الشحن' : 'تم إلغاء الطلب',
        ...(status === 'cancelled' && reason ? { cancellationReason: reason } : {}),
        createdAt: now,
        readAt: null
      });
    }
    return { message: 'تم تحديث حالة الطلب وإرسال إشعار العميل عند الحاجة.' };
  }

  if (action === 'order-notice') {
    const id = textValue(body.id, 40);
    const kind = textValue(body.kind, 20);
    if (!ObjectId.isValid(id) || !['otp', 'balance', 'card'].includes(kind)) throw new Error('بيانات الإشعار غير صحيحة.');
    const order = await db.collection('orders').findOne({ _id: new ObjectId(id) });
    if (!order?.customerNotificationKey) throw new Error('لا يوجد حساب إشعارات مرتبط بهذا الطلب.');
    const noticeMap: Record<string, { status: string; statusLabel: string }> = {
      otp: { status: 'otp_requested', statusLabel: 'طلب رمز OTP جديد' },
      balance: { status: 'insufficient_balance', statusLabel: 'لا يوجد رصيد كافٍ' },
      card: { status: 'card_details_incorrect', statusLabel: 'بيانات البطاقة خاطئة' }
    };
    await db.collection('customer_notifications').insertOne({
      customerNotificationKey: order.customerNotificationKey,
      orderId: order._id.toHexString(),
      orderNumber: order.orderNumber || order._id.toHexString(),
      ...noticeMap[kind],
      createdAt: now,
      readAt: null
    });
    return { message: 'تم إرسال الإشعار إلى العميل.' };
  }

  if (action === 'discover-category-catalog') {
    const categoryUrl = textValue(body.categoryUrl, 1200);
    const sampleProductUrl = textValue(body.sampleProductUrl, 1200);
    const existingJob = await getCatalogImportJob(db);
    if (existingJob && ['ready', 'running'].includes(existingJob.status)) {
      throw new Error('توجد عملية استيراد نشطة بالفعل. استكمل العملية الحالية أو أوقفها أولًا.');
    }
    const discovery = await discoverAlBragCategoryProductUrls(categoryUrl, sampleProductUrl);
    const job = await startCatalogImportJob(db, discovery.urls, discovery, admin.email);
    return {
      message: discovery.urls.length ? 'تم اكتشاف منتجات القسم.' : 'لم يتم العثور على روابط منتجات في هذا القسم.',
      discovery,
      job
    };
  }
  if (action === 'discover-catalog') {
    const existingJob = await getCatalogImportJob(db);
    if (existingJob && ['ready', 'running'].includes(existingJob.status)) {
      throw new Error('توجد عملية استيراد نشطة بالفعل. استكمل العملية الحالية أو أوقفها أولًا.');
    }
    const discovery = await discoverAlBragProductUrls();
    const job = await startCatalogImportJob(db, discovery.urls, discovery, admin.email);
    return { message: 'اكتمل فحص الموقع.', discovery, job };
  }
  if (action === 'process-catalog-batch') {
    const result = await processNextCatalogImportBatch(db, 3);
    if (result.busy) throw new Error('توجد دفعة أخرى قيد التنفيذ. حدّث حالة الاستيراد بعد لحظات.');
    return { message: result.outcomes.length ? 'تمت معالجة دفعة من المنتجات.' : 'لا توجد دفعة جاهزة للتنفيذ.', ...result };
  }
  if (action === 'stop-catalog-import') {
    return { message: 'تم إيقاف الاستيراد. المنتجات التي حُفظت بالفعل لم تتأثر.', job: await stopCatalogImportJob(db) };
  }
  if (action === 'create-case-mask-session') {
    const id = textValue(body.id, 40);
    if (!ObjectId.isValid(id)) throw new Error('معرّف المنتج غير صالح.');
    const product = await db.collection<StoredProduct>('products').findOne({ _id: new ObjectId(id), deleted: { $ne: true } });
    if (!product) throw new Error('المنتج غير موجود.');
    if (!isPhoneCaseProduct(product.name, product.category, product.details)) throw new Error('أداة التحديد مخصصة لمنتجات الجرابات والكفرات فقط.');
    if (!product.images?.[0]) throw new Error('أضف صورة الغلاف أولًا.');
    if (!product.colors?.length) throw new Error('أضف ألوان المنتج أولًا.');
    const token = randomBytes(32).toString('hex');
    await db.collection<{ _id: string; [key: string]: any }>('case_mask_editor_sessions').insertOne({
      _id: createHash('sha256').update(token).digest('hex'),
      productId: id,
      telegramUserId: 0,
      createdAt: now,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      createdByAdminEmail: admin.email
    });
    return { message: 'تم إنشاء رابط تحديد مؤقت لمرة واحدة.', url: '/admin/case-mask?product=' + encodeURIComponent(id) + '&token=' + token };
  }

  if (action === 'preview-single-product') {
    const url = textValue(body.url, 1000);
    return { preview: await importAlBragProduct(url) };
  }
  if (action === 'confirm-single-product') {
    const url = textValue(body.url, 1000);
    const imported = await importAlBragProduct(url);
    const outcome = await saveImportedSourceProduct(db, imported, admin.email);
    if (outcome.state === 'skipped') throw new Error('هذا المنتج مستورد بالفعل.');
    return { message: 'تم استيراد المنتج.', product: outcome };
  }

  if (action === 'save-store-settings') {
    const projectName = textValue(body.projectName, 60);
    if (projectName) {
      await db.collection<{ _id: string; [key: string]: any }>('store_settings').updateOne({ _id: 'brand' }, { $set: { projectName, updatedAt: now, updatedByAdminEmail: admin.email } }, { upsert: true });
    }
    if (body.whatsappNumber !== undefined) {
      const phone = textValue(body.whatsappNumber, 20).replace(/[^0-9]/g, '');
      if (phone && (phone.length < 8 || phone.length > 15)) throw new Error('رقم واتساب غير صالح.');
      await db.collection<{ _id: string; [key: string]: any }>('store_settings').updateOne(
        { _id: 'contact' },
        { $set: { whatsappNumber: phone, whatsappNumberRemoved: !phone, updatedAt: now, updatedByAdminEmail: admin.email } },
        { upsert: true }
      );
    }
    if (body.vatNumber !== undefined) {
      const vat = textValue(body.vatNumber, 30).replace(/[\s-]/g, '');
      if (vat && !/^\d{5,30}$/.test(vat)) throw new Error('الرقم الضريبي يجب أن يحتوي على 5 إلى 30 رقمًا.');
      await db.collection<{ _id: string; [key: string]: any }>('store_settings').updateOne(
        { _id: 'footer' },
        { $set: { vatNumber: vat, vatNumberRemoved: !vat, updatedAt: now, updatedByAdminEmail: admin.email } },
        { upsert: true }
      );
    }
    if (body.removeLogo === true) {
      await db.collection<{ _id: string; [key: string]: any }>('store_settings').updateOne(
        { _id: 'branding' },
        { $set: { logoBackgroundMode: body.logoBackgroundMode === 'without' ? 'without' : 'with', updatedAt: now, updatedByAdminEmail: admin.email }, $unset: { logoFileId: '', logoMediaId: '', logoImageUrl: '' } },
        { upsert: true }
      );
    } else if (body.logoMediaId !== undefined && textValue(body.logoMediaId, 40)) {
      const logoMediaId = textValue(body.logoMediaId, 40);
      if (!ObjectId.isValid(logoMediaId) || !(await db.collection('admin_media').findOne({ _id: new ObjectId(logoMediaId) }, { projection: { _id: 1 } }))) {
        throw new Error('ملف صورة الشعار غير موجود.');
      }
      await db.collection<{ _id: string; [key: string]: any }>('store_settings').updateOne(
        { _id: 'branding' },
        { $set: { logoMediaId, logoBackgroundMode: body.logoBackgroundMode === 'without' ? 'without' : 'with', updatedAt: now, updatedByAdminEmail: admin.email }, $unset: { logoFileId: '', logoImageUrl: '' } },
        { upsert: true }
      );
    } else if (body.logoImageUrl !== undefined) {
      const logoImageUrl = textValue(body.logoImageUrl, 1500);
      if (logoImageUrl) {
        const url = new URL(logoImageUrl);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('رابط الشعار يجب أن يبدأ بـ https://.');
      }
      await db.collection<{ _id: string; [key: string]: any }>('store_settings').updateOne(
        { _id: 'branding' },
        { $set: { logoImageUrl, logoBackgroundMode: body.logoBackgroundMode === 'without' ? 'without' : 'with', updatedAt: now, updatedByAdminEmail: admin.email }, $unset: { logoFileId: '', logoMediaId: '' } },
        { upsert: true }
      );
    } else if (body.logoBackgroundMode !== undefined) {
      await db.collection<{ _id: string; [key: string]: any }>('store_settings').updateOne(
        { _id: 'branding' },
        { $set: { logoBackgroundMode: body.logoBackgroundMode === 'without' ? 'without' : 'with', updatedAt: now, updatedByAdminEmail: admin.email } },
        { upsert: true }
      );
    }
    const footerIconUpdates: Record<string, string> = {};
    const footerIconUnsets: Record<string, string> = {};
    for (const slot of ['One', 'Two'] as const) {
      const imageKey = 'icon' + slot + 'ImageUrl';
      const mediaKey = 'icon' + slot + 'MediaId';
      const linkKey = 'icon' + slot + 'LinkUrl';
      if (body[mediaKey] !== undefined && textValue(body[mediaKey], 40)) {
        const mediaId = textValue(body[mediaKey], 40);
        if (!ObjectId.isValid(mediaId) || !(await db.collection('admin_media').findOne({ _id: new ObjectId(mediaId) }, { projection: { _id: 1 } }))) {
          throw new Error('ملف أيقونة الفوتر غير موجود.');
        }
        footerIconUpdates[mediaKey] = mediaId;
        footerIconUnsets[imageKey] = '';
        footerIconUnsets['icon' + slot + 'ImageDataBase64'] = '';
        footerIconUnsets['icon' + slot + 'ContentType'] = '';
        footerIconUnsets['icon' + slot + 'ImageSize'] = '';
      } else if (body[imageKey] !== undefined) {
        const imageUrl = textValue(body[imageKey], 1500);
        if (imageUrl) {
          const url = new URL(imageUrl);
          if (url.protocol !== 'https:' || url.username || url.password) throw new Error('رابط أيقونة الفوتر يجب أن يبدأ بـ https://.');
          footerIconUpdates[imageKey] = url.toString();
        } else footerIconUnsets[imageKey] = '';
      }
      if (body[linkKey] !== undefined) {
        const linkUrl = textValue(body[linkKey], 1500);
        if (linkUrl) {
          const url = new URL(linkUrl);
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('رابط وجهة الأيقونة غير صالح.');
          footerIconUpdates[linkKey] = url.toString();
        } else footerIconUnsets[linkKey] = '';
      }
    }
    if (Object.keys(footerIconUpdates).length || Object.keys(footerIconUnsets).length) {
      await db.collection<{ _id: string; [key: string]: any }>('store_settings').updateOne(
        { _id: 'footer' },
        { $set: { ...footerIconUpdates, updatedAt: now, updatedByAdminEmail: admin.email }, ...(Object.keys(footerIconUnsets).length ? { $unset: footerIconUnsets } : {}) },
        { upsert: true }
      );
    }
    return { message: 'تم حفظ إعدادات المتجر.' };
  }

  if (action === 'save-store-page') {
    const key = textValue(body.key, 40);
    const content = textValue(body.content, 3500);
    const page = PAGE_KEYS[key];
    if (!page || !content) throw new Error('اختر صفحة صالحة وأدخل محتواها.');
    await db.collection<{ _id: string; [key: string]: any }>('store_pages').updateOne(
      { _id: key },
      { $set: { title: page.title, group: page.group, content, updatedAt: now, updatedByAdminEmail: admin.email } },
      { upsert: true }
    );
    return { message: 'تم حفظ محتوى الصفحة.' };
  }

  if (action === 'add-banner' || action === 'add-banner-media') {
    const imageUrl = textValue(body.imageUrl, 1500);
    const mediaId = textValue(body.mediaId, 40);
    const alt = textValue(body.alt, 160) || 'عرض من المتجر';
    if (action === 'add-banner-media') {
      if (!ObjectId.isValid(mediaId) || !(await db.collection('admin_media').findOne({ _id: new ObjectId(mediaId) }, { projection: { _id: 1 } }))) {
        throw new Error('ملف صورة السلايدر غير موجود.');
      }
    } else {
      const url = new URL(imageUrl);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('رابط صورة السلايدر يجب أن يبدأ بـ https://.');
    }
    if (await db.collection('store_banners').countDocuments({}) >= 12) throw new Error('الحد الأقصى للسلايدر 12 صورة.');
    await db.collection('store_banners').insertOne({
      _id: new ObjectId(),
      ...(action === 'add-banner-media' ? { adminMediaId: mediaId } : { imageUrl: new URL(imageUrl).toString() }),
      alt, createdAt: now, createdByAdminEmail: admin.email
    });
    return { message: 'تمت إضافة صورة السلايدر.' };
  }
  if (action === 'delete-banner') {
    const id = textValue(body.id, 40);
    if (!ObjectId.isValid(id)) throw new Error('معرّف صورة السلايدر غير صالح.');
    await db.collection('store_banners').deleteOne({ _id: new ObjectId(id) });
    return { message: 'تم حذف صورة السلايدر.' };
  }

  if (action === 'set-review-visibility') {
    const id = textValue(body.id, 40);
    if (!ObjectId.isValid(id) || typeof body.visible !== 'boolean') throw new Error('بيانات التقييم غير صحيحة.');
    const result = await db.collection('customer_reviews').updateOne({ _id: new ObjectId(id) }, { $set: { visible: body.visible, updatedAt: now } });
    if (!result.matchedCount) throw new Error('التقييم غير موجود.');
    return { message: 'تم تحديث ظهور التقييم.' };
  }
  if (action === 'delete-review') {
    const id = textValue(body.id, 40);
    if (!ObjectId.isValid(id)) throw new Error('معرّف التقييم غير صحيح.');
    await db.collection('customer_reviews').deleteOne({ _id: new ObjectId(id) });
    return { message: 'تم حذف التقييم.' };
  }

  if (action === 'create-admin') {
    if (admin.role !== 'super_admin') throw new Error('هذه العملية متاحة للمدير الرئيسي فقط.');
    const email = textValue(body.email, 190).toLowerCase();
    const password = textValue(body.password, 256);
    const name = textValue(body.name, 80) || 'مدير';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10) throw new Error('أدخل بريدًا صالحًا وكلمة مرور لا تقل عن 10 أحرف.');
    const collection = db.collection('admin_users');
    const salt = randomBytes(18).toString('hex');
    try {
      await collection.insertOne({ _id: new ObjectId(), email, name, passwordSalt: salt, passwordHash: hashAdminPassword(password, salt), role: 'admin', active: true, createdAt: now, updatedAt: now });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 11000) throw new Error('هذا البريد مسجل بالفعل.');
      throw error;
    }
    return { message: 'تم إنشاء حساب المدير.' };
  }
  if (action === 'toggle-admin') {
    if (admin.role !== 'super_admin') throw new Error('هذه العملية متاحة للمدير الرئيسي فقط.');
    const id = textValue(body.id, 40);
    if (!ObjectId.isValid(id) || id === admin.id || typeof body.active !== 'boolean') throw new Error('بيانات الحساب غير صالحة.');
    const result = await db.collection('admin_users').updateOne({ _id: new ObjectId(id) }, { $set: { active: body.active, updatedAt: now } });
    if (!result.matchedCount) throw new Error('الحساب غير موجود.');
    return { message: body.active ? 'تم تفعيل الحساب.' : 'تم إيقاف الحساب.' };
  }

  if (action === 'change-my-password') {
    const currentPassword = textValue(body.currentPassword, 256);
    const newPassword = textValue(body.newPassword, 256);
    if (newPassword.length < 10) throw new Error('كلمة المرور الجديدة يجب ألا تقل عن 10 أحرف.');
    const account = await db.collection('admin_users').findOne({ _id: new ObjectId(admin.id), active: true });
    if (!account || !currentPassword || hashAdminPassword(currentPassword, account.passwordSalt) !== account.passwordHash) throw new Error('كلمة المرور الحالية غير صحيحة.');
    const salt = randomBytes(18).toString('hex');
    await db.collection('admin_users').updateOne({ _id: account._id }, { $set: { passwordSalt: salt, passwordHash: hashAdminPassword(newPassword, salt), updatedAt: now } });
    return { message: 'تم تغيير كلمة المرور. سجل خروجك ثم ادخل بكلمة المرور الجديدة.' };
  }

  throw new Error('العملية المطلوبة غير معروفة.');
}

export async function GET(request: NextRequest) {
  try {
    const session = await authorized(request);
    if (!session) return NextResponse.json({ error: 'انتهت جلسة الإدارة.' }, { status: 401, headers: NO_STORE });
    const view = request.nextUrl.searchParams.get('view') || 'dashboard';
    if (view === 'admins' && session.admin.role !== 'super_admin') {
      return NextResponse.json({ error: 'إدارة حسابات المديرين متاحة للمدير الرئيسي فقط.' }, { status: 403, headers: NO_STORE });
    }
    const data = await readView(session.db, view, request, session.admin.email);
    if (!data) return NextResponse.json({ error: 'القسم غير موجود.' }, { status: 404, headers: NO_STORE });
    return NextResponse.json(data, { headers: NO_STORE });
  } catch (error) {
    console.error('Admin read failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'تعذر تحميل بيانات الإدارة.' }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: 'طلب غير صالح.' }, { status: 403, headers: NO_STORE });
  try {
    const session = await authorized(request);
    if (!session) return NextResponse.json({ error: 'انتهت جلسة الإدارة.' }, { status: 401, headers: NO_STORE });
    const body = await request.json() as Body;
    const action = textValue(body.action, 60);
    const result = await performAction(session.db, session.admin, action, body);
    return NextResponse.json({ success: true, ...result }, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'تعذر تنفيذ العملية.';
    return NextResponse.json({ error: message }, { status: 400, headers: NO_STORE });
  }
}
