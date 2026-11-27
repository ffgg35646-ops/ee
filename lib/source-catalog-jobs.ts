import { randomBytes } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import { importAlBragProduct, type ImportedSourceProduct } from '@/lib/source-product-importer';
import type { StoreCategory, StoredProduct } from '@/lib/catalog';

export const AL_BRAG_IMPORT_JOB_ID = 'al-brag-ksa';

export type CatalogImportOutcome = {
  state: 'imported' | 'skipped' | 'failed';
  name: string;
  error?: string;
};

export type CatalogImportJob = {
  _id: string;
  status: 'ready' | 'running' | 'completed' | 'stopped' | 'failed';
  urls: string[];
  cursor: number;
  imported: number;
  skipped: number;
  failed: number;
  errors: string[];
  scannedSitemaps: number;
  scannedPages: number;
  warnings: string[];
  lockToken?: string;
  lockUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
  startedBy?: string;
  lastBatch?: CatalogImportOutcome[];
};

let sourceProductIndexPromise: Promise<void> | undefined;

async function ensureSourceProductIndex(db: Db) {
  if (!sourceProductIndexPromise) {
    sourceProductIndexPromise = db.collection('products')
      .createIndex({ sourceProductUrl: 1 }, { unique: true, sparse: true })
      .then(() => undefined);
  }
  try {
    await sourceProductIndexPromise;
  } catch (error) {
    sourceProductIndexPromise = undefined;
    throw error;
  }
}

export async function getCatalogImportJob(db: Db) {
  return db.collection<CatalogImportJob>('catalog_import_jobs').findOne({ _id: AL_BRAG_IMPORT_JOB_ID });
}

export async function startCatalogImportJob(
  db: Db,
  urls: string[],
  discovery: { scannedSitemaps?: number; scannedPages?: number; warnings?: string[]; categoryOverride?: string } = {},
  startedBy = 'web'
) {
  const uniqueUrls = [...new Set(urls)].filter((url) => /^https:\/\/(?:www\.)?al-brag-ksa\.store\/product2\/\d+\/?$/i.test(url)).slice(0, 2000);
  const jobs = db.collection<CatalogImportJob>('catalog_import_jobs');
  const active = await jobs.findOne({ _id: AL_BRAG_IMPORT_JOB_ID, status: { $in: ['ready', 'running'] } });
  if (active) throw new Error('توجد عملية استيراد كتالوج نشطة بالفعل. استكملها أو أوقفها قبل بدء عملية جديدة.');
  const now = new Date();
  const job: CatalogImportJob = {
    _id: AL_BRAG_IMPORT_JOB_ID,
    status: uniqueUrls.length ? 'ready' : 'failed',
    urls: uniqueUrls,
    cursor: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    scannedSitemaps: Number(discovery.scannedSitemaps || 0),
    scannedPages: Number(discovery.scannedPages || 0),
    warnings: Array.isArray(discovery.warnings) ? discovery.warnings.slice(0, 20) : [],
    createdAt: now,
    updatedAt: now,
    startedBy
  };
  await db.collection<CatalogImportJob>('catalog_import_jobs').replaceOne(
    { _id: AL_BRAG_IMPORT_JOB_ID },
    job,
    { upsert: true }
  );
  return job;
}

async function ensureImportedCategory(db: Db, rawName: string) {
  const name = (rawName || 'منتجات مستوردة').trim().replace(/\s+/g, ' ').slice(0, 120) || 'منتجات مستوردة';
  const categories = db.collection<StoreCategory>('categories');
  let category = await categories.findOne({ name, deleted: { $ne: true } });
  if (category) return category;

  const deleted = await categories.findOne({ name });
  const now = new Date();
  if (deleted) {
    await categories.updateOne({ _id: deleted._id }, { $set: { deleted: false, updatedAt: now } });
    return { ...deleted, deleted: false, updatedAt: now };
  }

  const created: StoreCategory = {
    _id: new ObjectId(),
    name,
    description: 'قسم أُنشئ عند استيراد المنتجات من al-brag-ksa.store',
    createdAt: now,
    updatedAt: now,
    deleted: false
  };
  await categories.insertOne(created);
  return created;
}

export async function saveImportedSourceProduct(
  db: Db,
  imported: ImportedSourceProduct,
  createdBy = 'web'
): Promise<CatalogImportOutcome> {
  await ensureSourceProductIndex(db);
  const products = db.collection<StoredProduct>('products');
  const existing = await products.findOne({ sourceProductUrl: imported.sourceProductUrl });
  if (existing) return { state: 'skipped', name: imported.name };

  const section = await ensureImportedCategory(db, imported.sourceCategory);
  const now = new Date();
  const product: StoredProduct = {
    _id: new ObjectId(),
    categoryId: section._id.toHexString(),
    category: section.name,
    name: imported.name.slice(0, 120),
    price: imported.price,
    ...(imported.oldPrice && imported.oldPrice > imported.price ? { oldPrice: imported.oldPrice } : {}),
    shortDescription: imported.shortDescription.slice(0, 300),
    details: imported.details.slice(0, 3000),
    specifications: imported.specifications.slice(0, 40),
    colors: imported.colors.slice(0, 30),
    storageOptions: imported.storageOptions.slice(0, 30),
    ...(Object.keys(imported.storagePrices).length ? { storagePrices: imported.storagePrices } : {}),
    images: imported.images.slice(0, 10),
    sourceImageUrls: imported.images.slice(0, 10),
    sourceStore: imported.sourceStore,
    sourceProductUrl: imported.sourceProductUrl,
    sourceBrand: imported.sourceBrand,
    sourceSku: imported.sourceSku,
    sourceBarcode: imported.sourceBarcode,
    sourceImportedAt: now,
    createdByAdminEmail: createdBy,
    createdAt: now,
    updatedAt: now
  };
  try {
    await products.insertOne(product);
    return { state: 'imported', name: imported.name };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
      return { state: 'skipped', name: imported.name };
    }
    throw error;
  }
}

export async function processNextCatalogImportBatch(db: Db, batchSize = 3) {
  const jobs = db.collection<CatalogImportJob>('catalog_import_jobs');
  const now = new Date();
  const lockToken = randomBytes(16).toString('hex');
  const job = await jobs.findOneAndUpdate(
    {
      _id: AL_BRAG_IMPORT_JOB_ID,
      status: { $in: ['ready', 'running'] },
      $or: [{ lockUntil: { $exists: false } }, { lockUntil: { $lte: now } }]
    },
    {
      $set: { status: 'running', lockToken, lockUntil: new Date(Date.now() + 90_000), updatedAt: now }
    },
    { returnDocument: 'after' }
  );
  if (!job) {
    const current = await getCatalogImportJob(db);
    return { job: current, outcomes: [] as CatalogImportOutcome[], busy: Boolean(current && ['ready', 'running'].includes(current.status)) };
  }

  const urls = job.urls.slice(job.cursor, job.cursor + Math.max(1, Math.min(batchSize, 5)));
  const fetched = await Promise.all(urls.map(async (url) => {
    try {
      return { url, imported: await importAlBragProduct(url), error: '' };
    } catch (error) {
      return {
        url,
        imported: null,
        error: error instanceof Error ? error.message.slice(0, 220) : 'تعذر قراءة المنتج.'
      };
    }
  }));

  // Fetch pages concurrently, but save in sequence so products from the same
  // source category reuse one category record instead of creating duplicates.
  const outcomes: CatalogImportOutcome[] = [];
  for (const item of fetched) {
    if (!item.imported) {
      outcomes.push({ state: 'failed', name: item.url, error: item.error });
      continue;
    }
    try {
      outcomes.push(await saveImportedSourceProduct(db, item.imported, job.startedBy || 'web'));
    } catch (error) {
      outcomes.push({
        state: 'failed',
        name: item.url,
        error: error instanceof Error ? error.message.slice(0, 220) : 'تعذر حفظ المنتج.'
      });
    }
  }

  const cursor = job.cursor + urls.length;
  const importedCount = outcomes.filter((item) => item.state === 'imported').length;
  const skippedCount = outcomes.filter((item) => item.state === 'skipped').length;
  const failedCount = outcomes.filter((item) => item.state === 'failed').length;
  const completed = cursor >= job.urls.length;
  await jobs.updateOne(
    { _id: AL_BRAG_IMPORT_JOB_ID, lockToken },
    {
      $set: {
        cursor,
        imported: job.imported + importedCount,
        skipped: job.skipped + skippedCount,
        failed: job.failed + failedCount,
        errors: [...job.errors, ...outcomes.filter((item) => item.error).map((item) => item.name + ': ' + item.error)].slice(-20),
        lastBatch: outcomes,
        status: completed ? 'completed' : 'ready',
        updatedAt: new Date()
      },
      $unset: { lockToken: '', lockUntil: '' }
    }
  );
  return { job: await getCatalogImportJob(db), outcomes, busy: false };
}

export async function stopCatalogImportJob(db: Db) {
  await db.collection<CatalogImportJob>('catalog_import_jobs').updateOne(
    { _id: AL_BRAG_IMPORT_JOB_ID, status: { $in: ['ready', 'running'] } },
    { $set: { status: 'stopped', updatedAt: new Date() }, $unset: { lockToken: '', lockUntil: '' } }
  );
  return getCatalogImportJob(db);
}
