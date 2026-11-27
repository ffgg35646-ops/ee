import { ObjectId } from 'mongodb';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';
import { getAdminFromRequest } from '@/lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_FILE_SIZE = 4 * 1024 * 1024;
const MAX_TOTAL_SIZE = 4 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== request.headers.get('host')) {
        return NextResponse.json({ error: 'طلب رفع غير صالح.' }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: 'طلب رفع غير صالح.' }, { status: 403 });
    }
  }

  try {
    const db = await getDb();
    const admin = await getAdminFromRequest(db, request);
    if (!admin) return NextResponse.json({ error: 'انتهت جلسة الإدارة.' }, { status: 401 });

    const form = await request.formData();
    const files = form.getAll('files').filter((value): value is File => value instanceof File && value.size > 0);
    if (!files.length || files.length > 10) {
      return NextResponse.json({ error: 'اختر من صورة واحدة إلى 10 صور.' }, { status: 400 });
    }

    const totalSize = files.reduce((total, file) => total + file.size, 0);
    if (totalSize > MAX_TOTAL_SIZE) {
      return NextResponse.json({ error: 'إجمالي الصور في الرفع الواحد يجب ألا يتجاوز 4 ميجابايت لتجنب الطلبات الكبيرة.' }, { status: 413 });
    }

    const saved = [];
    for (const file of files) {
      const contentType = file.type.toLowerCase();
      if (!ALLOWED_TYPES.has(contentType)) {
        return NextResponse.json({ error: 'نوع الصورة غير مدعوم: ' + file.name }, { status: 415 });
      }
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json({ error: 'حجم الصورة يتجاوز 4 ميجابايت: ' + file.name }, { status: 413 });
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      if (!bytes.length || bytes.length !== file.size) {
        return NextResponse.json({ error: 'تعذرت قراءة الصورة: ' + file.name }, { status: 400 });
      }
      const id = new ObjectId();
      await db.collection('admin_media').insertOne({
        _id: id,
        dataBase64: bytes.toString('base64'),
        contentType,
        filename: file.name.slice(0, 180),
        size: bytes.length,
        createdAt: new Date(),
        createdByAdminEmail: admin.email
      });
      saved.push({ id: id.toHexString(), ref: 'admin-media:' + id.toHexString(), name: file.name });
    }
    return NextResponse.json({ files: saved }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('Admin media upload failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'تعذر رفع الصور إلى قاعدة البيانات.' }, { status: 500 });
  }
}
