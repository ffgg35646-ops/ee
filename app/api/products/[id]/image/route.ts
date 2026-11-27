import { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/mongodb';
import { findStoredProduct, isBlockedCatalogImage } from '@/lib/catalog';
import { telegramApi } from '@/lib/telegram';
import { fetchRemoteImage } from '@/lib/remote-image';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type TelegramFile = { file_path?: string };

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const color = request.nextUrl.searchParams.get('color');
  const source = request.nextUrl.searchParams.get('source');
  const index = Number(request.nextUrl.searchParams.get('index') || '0');
  if (source !== null && source !== 'cover') return NextResponse.json({ error: 'Invalid image source' }, { status: 400 });
  if (source !== 'cover' && color === null && (!Number.isInteger(index) || index < 0 || index > 10)) {
    return NextResponse.json({ error: 'Invalid image index' }, { status: 400 });
  }
  if (color !== null && (!color.trim() || color.length > 80)) {
    return NextResponse.json({ error: 'Invalid product color' }, { status: 400 });
  }
  if (!process.env.MONGODB_URI) {
    return new NextResponse('Product image service not configured', { status: 503 });
  }

  try {
    const db = await getDb();
    const product = await findStoredProduct(db, id);
    if (!product) return new NextResponse('Product not found', { status: 404 });
    const imageValue = source === 'cover' ? product.imageUrl : color !== null ? product.colorImages?.[color] : product.images?.[index];
    if (!imageValue || isBlockedCatalogImage(imageValue)) {
      return new NextResponse('Image not found', { status: 404 });
    }

    // Web-admin uploads are stored in MongoDB and referenced by a generated media ID.
    if (imageValue.startsWith('admin-media:')) {
      const mediaId = imageValue.slice('admin-media:'.length);
      if (!ObjectId.isValid(mediaId)) return new NextResponse('Invalid image reference', { status: 404 });
      const media = await db.collection<{ _id: ObjectId; dataBase64: string; contentType?: string }>('admin_media')
        .findOne({ _id: new ObjectId(mediaId) });
      if (!media?.dataBase64) return new NextResponse('Image not available', { status: 404 });
      return new NextResponse(Buffer.from(media.dataBase64, 'base64'), {
        status: 200,
        headers: {
          'content-type': media.contentType || 'image/jpeg',
          'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
          'x-content-type-options': 'nosniff'
        }
      });
    }

    // Some importers store HTTP(S) image URLs instead of Telegram file IDs.
    // Redirect those to the public image host; only Telegram IDs use getFile.
    try {
      const imageUrl = new URL(imageValue);
      if ((imageUrl.protocol === 'https:' || imageUrl.protocol === 'http:') && !imageUrl.username && !imageUrl.password) {
        return fetchRemoteImage(imageUrl.toString());
      }
    } catch {
      // A non-URL value is treated as a Telegram file ID below.
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return new NextResponse('Telegram image service not configured', { status: 503 });
    const file = await telegramApi<TelegramFile>('getFile', { file_id: imageValue });
    if (!file.file_path) return new NextResponse('Image not available', { status: 404 });

    const telegramResponse = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
      cache: 'force-cache',
      next: { revalidate: 3600 }
    });
    if (!telegramResponse.ok || !telegramResponse.body) {
      return new NextResponse('Unable to load image', { status: 502 });
    }

    const headers = new Headers();
    headers.set('content-type', telegramResponse.headers.get('content-type') || 'image/jpeg');
    headers.set('cache-control', 'public, max-age=3600, stale-while-revalidate=86400');
    return new NextResponse(telegramResponse.body, { status: 200, headers });
  } catch (error) {
    console.error('Product image load failed:', error instanceof Error ? error.message : 'Unknown error');
    return new NextResponse('Unable to load image', { status: 500 });
  }
}
