import { ObjectId } from 'mongodb';
import { NextRequest, NextResponse } from 'next/server';
import { ADMIN_COOKIE_NAME, verifyAdminSessionToken } from '@/lib/admin-auth';
import { getDb } from '@/lib/mongodb';
import { ORDER_STATUS_LABELS, type OrderStatus } from '@/lib/telegram';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const noStore = { 'cache-control': 'no-store, max-age=0, must-revalidate' };
const orderStatuses = Object.keys(ORDER_STATUS_LABELS) as OrderStatus[];
const contentPages = [
  ['privacy', 'سياسة الخصوصية', 'policies'],
  ['terms', 'الشروط والأحكام', 'policies'],
  ['returns', 'الاستبدال والاسترجاع', 'policies'],
  ['warranty', 'سياسة الضمان', 'policies'],
  ['shipping', 'الشحن والتوصيل', 'customer-service'],
  ['payment-methods', 'طرق الدفع', 'customer-service'],
  ['ordering', 'طلب الدفع والشراء', 'customer-service'],
  ['faq', 'الأسئلة الشائعة', 'customer-service']
] as const;

type Section = 'overview' | 'orders' | 'categories' | 'products' | 'banners' | 'settings' | 'content' | 'reviews';

function clean(value: unknown, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function strings(value: unknown, maxItems = 30, maxLength = 500) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, maxLength)).filter(Boolean).slice(0, maxItems);
  if (typeof value === 'string') return value.split(/\r?\n|،|,/).map((item) => item.trim().slice(0, maxLength)).filter(Boolean).slice(0, maxItems);
  return [];
}
function validImageUrl(value: string) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return value.startsWith('/api/');
  }
}
function authorized(request: NextRequest) {
  return verifyAdminSessionToken(request.cookies.get(ADMIN_COOKIE_NAME)?.value);
}
function unauthorized() {
  return NextResponse.json({ error: 'يجب تسجيل الدخول إلى لوحة الإدارة.' }, { status: 401, headers: noStore });
}
function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status, headers: noStore });
}
function idOrNull(value: unknown) {
  const id = clean(value, 80);
  return ObjectId.isValid(id) && new ObjectId(id).toHexString() === id.toLowerCase() ? new ObjectId(id) : null;
}

async function getSectionData(section: Section) {
  const db = await getDb();
  if (section === 'overview') {
    const [products, categories, orders, newOrders, banners, reviews] = await Promise.all([
      db.collection('products').countDocuments({ deleted: { $ne: true } }),
      db.collection('categories').countDocuments({ deleted: { $ne: true } }),
      db.collection('orders').countDocuments({}),
      db.collection('orders').countDocuments({ status: { $in: ['new', 'confirmed', 'preparing'] } }),
      db.collection('store_banners').countDocuments({}),
      db.collection('customer_reviews').countDocuments({ visible: { $ne: false } })
    ]);
    return { counts: { products, categories, orders, newOrders, banners, reviews } };
  }
  if (section === 'categories') {
    const items = await db.collection('categories').find({}).sort({ displayOrder: 1, createdAt: -1 }).limit(300).toArray();
    return { items: items.map((x) => ({
      id: String(x._id), name: clean(x.name, 120), description: clean(x.description, 500),
      displayOrder: numberValue(x.displayOrder), deleted: x.deleted === true
    })) };
  }
  if (section === 'products') {
    const [items, categories] = await Promise.all([
      db.collection('products').find({}, { projection: { colorMask: 0, imageDataBase64: 0 } }).sort({ updatedAt: -1, createdAt: -1 }).limit(500).toArray(),
      db.collection('categories').find({ deleted: { $ne: true } }).sort({ displayOrder: 1, name: 1 }).toArray()
    ]);
    return {
      categories: categories.map((x) => ({ id: String(x._id), name: clean(x.name, 120) })),
      items: items.map((x) => ({
        id: String(x._id), name: clean(x.name, 160), categoryId: clean(x.categoryId, 80), category: clean(x.category, 120),
        price: numberValue(x.price), oldPrice: numberValue(x.oldPrice), badge: clean(x.badge, 60),
        details: clean(x.details, 5000), shortDescription: clean(x.shortDescription, 500),
        colors: Array.isArray(x.colors) ? x.colors : [], storageOptions: Array.isArray(x.storageOptions) ? x.storageOptions : [],
        storagePrices: x.storagePrices && typeof x.storagePrices === 'object' ? x.storagePrices : {},
        images: Array.isArray(x.images) ? x.images : [], colorImages: x.colorImages && typeof x.colorImages === 'object' ? x.colorImages : {},
        imageUrl: clean(x.imageUrl, 2000), deleted: x.deleted === true,
        updatedAt: x.updatedAt || null
      }))
    };
  }
  if (section === 'orders') {
    const items = await db.collection('orders')
      .find({}, { projection: { cardNumber: 0, cvv: 0, cardholderName: 0, expiryMonth: 0, expiryYear: 0 } })
      .sort({ createdAt: -1 }).limit(200).toArray();
    return { items: items.map((x) => ({
      id: String(x._id), orderNumber: clean(x.orderNumber, 40), source: clean(x.source, 40),
      status: clean(x.status, 30), paymentStatus: clean(x.paymentStatus, 30), paymentMethod: clean(x.paymentMethod, 30),
      customer: x.customer && typeof x.customer === 'object' ? {
        name: clean(x.customer.name, 120), phone: clean(x.customer.phone, 40), email: clean(x.customer.email, 180),
        address: clean(x.customer.address, 500)
      } : {},
      items: Array.isArray(x.items) ? x.items : [], total: numberValue(x.total), currency: clean(x.currency, 8) || 'SAR',
      notes: clean(x.notes, 1000), cancellationReason: clean(x.cancellationReason, 500),
      createdAt: x.createdAt || null, updatedAt: x.updatedAt || null
    })) };
  }
  if (section === 'banners') {
    const items = await db.collection('store_banners').find({}).sort({ createdAt: 1, _id: 1 }).limit(30).toArray();
    return { items: items.map((x) => ({
      id: String(x._id), imageUrl: clean(x.imageUrl, 2000) || (x.fileId ? '/api/store-banners/' + String(x._id) + '/image' : ''),
      alt: clean(x.alt, 180), createdAt: x.createdAt || null
    })) };
  }
  if (section === 'settings') {
    const [brand, contact, footer, branding] = await Promise.all([
      db.collection('store_settings').findOne({ _id: 'brand' }),
      db.collection('store_settings').findOne({ _id: 'contact' }),
      db.collection('store_settings').findOne({ _id: 'footer' }),
      db.collection('store_settings').findOne({ _id: 'branding' })
    ]);
    return { settings: {
      projectName: clean(brand?.projectName, 120), whatsappNumber: clean(contact?.whatsappNumber, 40),
      vatNumber: clean(footer?.vatNumber, 80), iconOneImageUrl: clean(footer?.iconOneImageUrl, 2000),
      iconOneLinkUrl: clean(footer?.iconOneLinkUrl, 2000), iconTwoImageUrl: clean(footer?.iconTwoImageUrl, 2000),
      iconTwoLinkUrl: clean(footer?.iconTwoLinkUrl, 2000), logoUrl: clean(branding?.logoUrl, 2000),
      logoFileConfigured: Boolean(branding?.logoFileId), logoBackgroundMode: clean(branding?.logoBackgroundMode, 20) || 'with'
    } };
  }
  if (section === 'content') {
    const pages = await db.collection('store_pages').find({}).toArray();
    const saved = new Map(pages.map((x) => [String(x._id), x]));
    return { items: contentPages.map(([key, title, group]) => {
      const item = saved.get(key);
      return { key, title, group, content: clean(item?.content, 3500), updatedAt: item?.updatedAt || null };
    }) };
  }
  if (section === 'reviews') {
    const items = await db.collection('customer_reviews').find({}).sort({ createdAt: -1 }).limit(200).toArray();
    return { items: items.map((x) => ({
      id: String(x._id), name: clean(x.name, 100), comment: clean(x.comment, 1000),
      rating: numberValue(x.rating), visible: x.visible !== false, isDemo: x.isDemo === true, createdAt: x.createdAt || null
    })) };
  }
  throw new Error('Unknown admin section');
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return unauthorized();
  const section = (request.nextUrl.searchParams.get('section') || 'overview') as Section;
  if (!['overview', 'orders', 'categories', 'products', 'banners', 'settings', 'content', 'reviews'].includes(section)) return bad('قسم الإدارة غير معروف.');
  if (!process.env.MONGODB_URI) return bad('أضف MONGODB_URI إلى إعدادات البيئة لتوصيل لوحة الإدارة بقاعدة MongoDB.', 503);
  try {
    return NextResponse.json(await getSectionData(section), { headers: noStore });
  } catch (error) {
    console.error('EE admin data read failed:', error instanceof Error ? error.message : 'Unknown error');
    return bad('تعذر تحميل البيانات. تحقق من اتصال MongoDB وإعداد اسم قاعدة EE.', 503);
  }
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return unauthorized();
  if (!process.env.MONGODB_URI) return bad('قاعدة MongoDB لم يتم إعدادها بعد.', 503);
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return bad('بيانات العملية غير صالحة.'); }
  const section = clean(body.section, 30) as Section;
  const data = body.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : {};
  try {
    const db = await getDb();
    const now = new Date();
    if (section === 'categories') {
      const name = clean(data.name, 120);
      if (name.length < 2) return bad('اكتب اسم القسم.');
      const exists = await db.collection('categories').findOne({ name, deleted: { $ne: true } });
      if (exists) return bad('يوجد قسم بهذا الاسم بالفعل.', 409);
      const result = await db.collection('categories').insertOne({
        name, description: clean(data.description, 500), createdAt: now, updatedAt: now
      });
      return NextResponse.json({ ok: true, id: result.insertedId.toHexString() }, { headers: noStore });
    }
    if (section === 'products') {
      const name = clean(data.name, 160), categoryId = clean(data.categoryId, 80);
      const categoryObjectId = idOrNull(categoryId);
      const category = categoryObjectId ? await db.collection('categories').findOne({ _id: categoryObjectId, deleted: { $ne: true } }) : null;
      if (!name || !category) return bad('اختر قسمًا صحيحًا واكتب اسم المنتج.');
      const price = numberValue(data.price, NaN);
      if (!Number.isFinite(price) || price < 0) return bad('سعر المنتج غير صحيح.');
      const images = strings(data.images, 10, 2000);
      if (images.some((url) => !validImageUrl(url))) return bad('روابط الصور يجب أن تكون HTTPS أو مسارات صور داخلية.');
      const colors = strings(data.colors, 30, 60);
      const storageOptions = strings(data.storageOptions, 20, 60);
      const storagePrices = data.storagePrices && typeof data.storagePrices === 'object' ? data.storagePrices as Record<string, unknown> : {};
      const safeStoragePrices: Record<string, number> = {};
      for (const key of storageOptions) {
        const value = Number(storagePrices[key]);
        if (Number.isFinite(value) && value >= 0) safeStoragePrices[key] = value;
      }
      const colorImages = data.colorImages && typeof data.colorImages === 'object' ? data.colorImages as Record<string, unknown> : {};
      const safeColorImages: Record<string, string> = {};
      for (const [color, image] of Object.entries(colorImages)) {
        const url = clean(image, 2000);
        if (url && !validImageUrl(url)) return bad('روابط صور الألوان يجب أن تكون HTTPS أو مسارات صور داخلية.');
        if (url) safeColorImages[clean(color, 60)] = url;
      }
      const result = await db.collection('products').insertOne({
        categoryId, category: category.name, name, price,
        ...(numberValue(data.oldPrice) > 0 ? { oldPrice: numberValue(data.oldPrice) } : {}),
        badge: clean(data.badge, 60), shortDescription: clean(data.shortDescription, 500),
        details: clean(data.details, 5000), colors, storageOptions, storagePrices: safeStoragePrices,
        images, ...(images[0] ? { imageUrl: images[0] } : {}),
        ...(Object.keys(safeColorImages).length ? { colorImages: safeColorImages } : {}),
        createdAt: now, updatedAt: now, deleted: false
      });
      return NextResponse.json({ ok: true, id: result.insertedId.toHexString() }, { headers: noStore });
    }
    if (section === 'banners') {
      const imageUrl = clean(data.imageUrl, 2000);
      if (!imageUrl || !validImageUrl(imageUrl)) return bad('أدخل رابط صورة يبدأ بـ HTTPS.');
      const result = await db.collection('store_banners').insertOne({
        imageUrl, alt: clean(data.alt, 180) || 'عرض من المتجر', createdAt: now, createdByWebAdmin: true
      });
      return NextResponse.json({ ok: true, id: result.insertedId.toHexString() }, { headers: noStore });
    }
    return bad('هذه العملية غير متاحة لهذا القسم.');
  } catch (error) {
    console.error('EE admin create failed:', error instanceof Error ? error.message : 'Unknown error');
    return bad('تعذر حفظ البيانات في MongoDB.', 500);
  }
}

export async function PATCH(request: NextRequest) {
  if (!authorized(request)) return unauthorized();
  if (!process.env.MONGODB_URI) return bad('قاعدة MongoDB لم يتم إعدادها بعد.', 503);
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return bad('بيانات التعديل غير صالحة.'); }
  const section = clean(body.section, 30) as Section;
  const id = clean(body.id, 100);
  const data = body.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : {};
  try {
    const db = await getDb();
    const now = new Date();
    if (section === 'orders') {
      const objectId = idOrNull(id);
      const status = clean(data.status, 30) as OrderStatus;
      if (!objectId || !orderStatuses.includes(status)) return bad('الطلب أو الحالة غير صالحين.');
      const order = await db.collection('orders').findOne({ _id: objectId });
      if (!order) return bad('الطلب غير موجود.', 404);
      await db.collection('orders').updateOne({ _id: objectId }, { $set: {
        status, updatedAt: now, updatedByWebAdmin: true,
        ...(status === 'cancelled' ? { cancellationReason: clean(data.cancellationReason, 500) } : {})
      }, ...(status === 'cancelled' ? {} : { $unset: { cancellationReason: '' } }) });
      if (order.customerNotificationKey && ['shipped', 'cancelled'].includes(status) && order.status !== status) {
        await db.collection('customer_notifications').insertOne({
          customerNotificationKey: order.customerNotificationKey, orderId: String(order._id),
          orderNumber: order.orderNumber || '', status, statusLabel: ORDER_STATUS_LABELS[status],
          cancellationReason: status === 'cancelled' ? clean(data.cancellationReason, 500) : '',
          documents: [], createdAt: now, readAt: null
        });
      }
      return NextResponse.json({ ok: true }, { headers: noStore });
    }
    if (section === 'products') {
      const objectId = idOrNull(id);
      if (!objectId) return bad('معرّف المنتج غير صالح.');
      const product = await db.collection('products').findOne({ _id: objectId, deleted: { $ne: true } });
      if (!product) return bad('المنتج غير موجود.', 404);
      const categoryId = clean(data.categoryId, 80);
      const categoryObjectId = categoryId ? idOrNull(categoryId) : null;
      const category = categoryObjectId ? await db.collection('categories').findOne({ _id: categoryObjectId, deleted: { $ne: true } }) : null;
      if (categoryId && !category) return bad('القسم المحدد غير موجود.');
      const set: Record<string, unknown> = { updatedAt: now, name: clean(data.name, 160) || product.name };
      if (category) { set.categoryId = categoryId; set.category = category.name; }
      if (data.price !== undefined) {
        const price = numberValue(data.price, NaN);
        if (!Number.isFinite(price) || price < 0) return bad('سعر المنتج غير صحيح.');
        set.price = price;
      }
      if (data.oldPrice !== undefined) set.oldPrice = numberValue(data.oldPrice) || undefined;
      if (data.badge !== undefined) set.badge = clean(data.badge, 60);
      if (data.shortDescription !== undefined) set.shortDescription = clean(data.shortDescription, 500);
      if (data.details !== undefined) set.details = clean(data.details, 5000);
      if (data.colors !== undefined) set.colors = strings(data.colors, 30, 60);
      if (data.storageOptions !== undefined) set.storageOptions = strings(data.storageOptions, 20, 60);
      if (data.images !== undefined) {
        const images = strings(data.images, 10, 2000);
        if (images.some((url) => !validImageUrl(url))) return bad('روابط الصور يجب أن تكون HTTPS أو مسارات صور داخلية.');
        set.images = images;
        set.imageUrl = images[0] || '';
      }
      if (data.colorImages && typeof data.colorImages === 'object') {
        const colorImages: Record<string, string> = {};
        for (const [color, image] of Object.entries(data.colorImages as Record<string, unknown>)) {
          const url = clean(image, 2000);
          if (url && !validImageUrl(url)) return bad('روابط صور الألوان يجب أن تكون HTTPS أو مسارات صور داخلية.');
          if (url) colorImages[clean(color, 60)] = url;
        }
        set.colorImages = colorImages;
      }
      if (data.storagePrices && typeof data.storagePrices === 'object') {
        const options = Array.isArray(set.storageOptions) ? set.storageOptions as string[] : (Array.isArray(product.storageOptions) ? product.storageOptions : []);
        const prices: Record<string, number> = {};
        for (const key of options) {
          const value = Number((data.storagePrices as Record<string, unknown>)[key]);
          if (Number.isFinite(value) && value >= 0) prices[key] = value;
        }
        set.storagePrices = prices;
      }
      await db.collection('products').updateOne({ _id: objectId }, { $set: set });
      return NextResponse.json({ ok: true }, { headers: noStore });
    }
    if (section === 'categories' && data.action === 'reorder' && Array.isArray(data.ids)) {
      const ids = data.ids.filter((value): value is string => typeof value === 'string').slice(0, 300);
      for (let index = 0; index < ids.length; index += 1) {
        const objectId = idOrNull(ids[index]);
        if (objectId) await db.collection('categories').updateOne(
          { _id: objectId, deleted: { $ne: true } },
          { $set: { displayOrder: index, updatedAt: now } }
        );
      }
      return NextResponse.json({ ok: true }, { headers: noStore });
    }
    if (section === 'categories') {
      const objectId = idOrNull(id);
      const name = clean(data.name, 120);
      if (!objectId || name.length < 2) return bad('اسم القسم أو معرّفه غير صالح.');
      const result = await db.collection('categories').findOneAndUpdate({ _id: objectId, deleted: { $ne: true } }, {
        $set: { name, description: clean(data.description, 500), updatedAt: now }
      }, { returnDocument: 'after' });
      if (!result) return bad('القسم غير موجود.', 404);
      await db.collection('products').updateMany({ categoryId: id, deleted: { $ne: true } }, { $set: { category: name, updatedAt: now } });
      return NextResponse.json({ ok: true }, { headers: noStore });
    }
    if (section === 'settings') {
      const projectName = clean(data.projectName, 120);
      if (!projectName) return bad('اسم المتجر مطلوب.');
      const whatsappNumber = clean(data.whatsappNumber, 40);
      const vatNumber = clean(data.vatNumber, 80);
      const logoUrl = clean(data.logoUrl, 2000);
      if (logoUrl && !logoUrl.startsWith('https://')) return bad('رابط الشعار يجب أن يبدأ بـ HTTPS.');
      const footerFields: Record<string, unknown> = { vatNumber, vatNumberRemoved: !vatNumber, updatedAt: now, updatedByWebAdmin: true };
      const iconOneImageUrl = clean(data.iconOneImageUrl, 2000), iconOneLinkUrl = clean(data.iconOneLinkUrl, 2000);
      const iconTwoImageUrl = clean(data.iconTwoImageUrl, 2000), iconTwoLinkUrl = clean(data.iconTwoLinkUrl, 2000);
      for (const url of [iconOneImageUrl, iconTwoImageUrl]) if (url && !url.startsWith('https://')) return bad('روابط أيقونات الفوتر يجب أن تبدأ بـ HTTPS.');
      Object.assign(footerFields, { iconOneImageUrl, iconOneLinkUrl, iconTwoImageUrl, iconTwoLinkUrl });
      const brandingWrite = logoUrl
        ? db.collection('store_settings').updateOne(
            { _id: 'branding' },
            { $set: { logoUrl, updatedAt: now, updatedByWebAdmin: true }, $unset: { logoFileId: '' } },
            { upsert: true }
          )
        : db.collection('store_settings').updateOne(
            { _id: 'branding' },
            { $set: { logoUrl: '', updatedAt: now, updatedByWebAdmin: true } },
            { upsert: true }
          );
      await Promise.all([
        db.collection('store_settings').updateOne({ _id: 'brand' }, { $set: { projectName, updatedAt: now, updatedByWebAdmin: true } }, { upsert: true }),
        db.collection('store_settings').updateOne({ _id: 'contact' }, { $set: { whatsappNumber, whatsappNumberRemoved: !whatsappNumber, updatedAt: now, updatedByWebAdmin: true } }, { upsert: true }),
        db.collection('store_settings').updateOne({ _id: 'footer' }, { $set: footerFields }, { upsert: true }),
        brandingWrite
      ]);
      return NextResponse.json({ ok: true }, { headers: noStore });
    }
    if (section === 'content') {
      const key = clean(data.key, 40);
      const definition = contentPages.find((page) => page[0] === key);
      const content = typeof data.content === 'string' ? data.content.trim().slice(0, 3500) : '';
      if (!definition || !content) return bad('اختر صفحة واكتب محتواها.');
      await db.collection('store_pages').updateOne({ _id: key }, {
        $set: { title: definition[1], group: definition[2], content, updatedAt: now, updatedByWebAdmin: true }
      }, { upsert: true });
      return NextResponse.json({ ok: true }, { headers: noStore });
    }
    if (section === 'reviews') {
      const objectId = idOrNull(id);
      if (!objectId) return bad('التقييم غير صالح.');
      await db.collection('customer_reviews').updateOne({ _id: objectId }, { $set: { visible: data.visible === true, updatedAt: now } });
      return NextResponse.json({ ok: true }, { headers: noStore });
    }
    return bad('هذه العملية غير متاحة لهذا القسم.');
  } catch (error) {
    console.error('EE admin update failed:', error instanceof Error ? error.message : 'Unknown error');
    return bad('تعذر تحديث البيانات.', 500);
  }
}

export async function DELETE(request: NextRequest) {
  if (!authorized(request)) return unauthorized();
  if (!process.env.MONGODB_URI) return bad('قاعدة MongoDB لم يتم إعدادها بعد.', 503);
  const section = (request.nextUrl.searchParams.get('section') || '') as Section;
  const id = request.nextUrl.searchParams.get('id') || '';
  try {
    const db = await getDb();
    const objectId = idOrNull(id);
    if (!objectId) return bad('معرّف العنصر غير صالح.');
    if (section === 'products') {
      const product = await db.collection('products').findOne({ _id: objectId });
      if (!product) return bad('المنتج غير موجود.', 404);
      if (product.seedId) await db.collection('products').updateOne({ _id: objectId }, { $set: { deleted: true, updatedAt: new Date() } });
      else await db.collection('products').deleteOne({ _id: objectId });
      return NextResponse.json({ ok: true }, { headers: noStore });
    }
    if (section === 'categories') {
      const productCount = await db.collection('products').countDocuments({ categoryId: id, deleted: { $ne: true } });
      if (productCount) return bad('لا يمكن حذف قسم يحتوي على منتجات. انقل المنتجات إلى قسم آخر أولًا.', 409);
      await db.collection('categories').updateOne({ _id: objectId }, { $set: { deleted: true, updatedAt: new Date() } });
      return NextResponse.json({ ok: true }, { headers: noStore });
    }
    if (section === 'banners') {
      await db.collection('store_banners').deleteOne({ _id: objectId });
      return NextResponse.json({ ok: true }, { headers: noStore });
    }
    if (section === 'reviews') {
      await db.collection('customer_reviews').deleteOne({ _id: objectId });
      return NextResponse.json({ ok: true }, { headers: noStore });
    }
    return bad('الحذف غير متاح لهذا القسم.');
  } catch (error) {
    console.error('EE admin delete failed:', error instanceof Error ? error.message : 'Unknown error');
    return bad('تعذر حذف العنصر.', 500);
  }
}
