import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';
import {
  ADMIN_COOKIE_NAME,
  adminSessionMaxAge,
  authenticateAdmin,
  createAdminSessionToken,
  ensureBootstrapAdmin,
  getAdminFromRequest
} from '@/lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store, max-age=0, must-revalidate' };

export async function GET(request: NextRequest) {
  try {
    const db = await getDb();
    const admin = await getAdminFromRequest(db, request);
    if (!admin) return NextResponse.json({ authenticated: false }, { status: 401, headers: NO_STORE });
    return NextResponse.json({ authenticated: true, admin }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ authenticated: false }, { status: 401, headers: NO_STORE });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { email?: string; password?: string };
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password || email.length > 190 || password.length > 256) {
      return NextResponse.json({ error: 'أدخل البريد الإلكتروني وكلمة المرور.' }, { status: 400, headers: NO_STORE });
    }

    const db = await getDb();
    const bootstrap = await ensureBootstrapAdmin(db);
    if (!bootstrap) {
      return NextResponse.json({
        error: 'حساب المدير الأول غير مهيأ. أضف ADMIN_EMAIL وADMIN_PASSWORD في متغيرات Vercel؛ كلمة المرور 10 أحرف على الأقل.'
      }, { status: 503, headers: NO_STORE });
    }

    const account = await authenticateAdmin(db, email, password);
    if (!account) {
      return NextResponse.json({ error: 'بيانات الدخول غير صحيحة أو الحساب موقوف.' }, { status: 401, headers: NO_STORE });
    }

    const token = createAdminSessionToken(account);
    const response = NextResponse.json({
      authenticated: true,
      admin: { id: account._id.toHexString(), email: account.email, name: account.name, role: account.role }
    }, { headers: NO_STORE });
    response.cookies.set(ADMIN_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: adminSessionMaxAge()
    });
    return response;
  } catch (error) {
    console.error('Admin login failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'تعذر تسجيل الدخول حاليًا. تحقق من اتصال قاعدة البيانات.' }, { status: 500, headers: NO_STORE });
  }
}

export async function DELETE() {
  const response = NextResponse.json({ success: true }, { headers: NO_STORE });
  response.cookies.set(ADMIN_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 0
  });
  return response;
}
