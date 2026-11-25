import { NextRequest, NextResponse } from 'next/server';
import {
  ADMIN_COOKIE_NAME, createAdminSessionToken, getAdminConfigurationStatus,
  verifyAdminCredentials, verifyAdminSessionToken
} from '@/lib/admin-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const noStore = { 'cache-control': 'no-store, max-age=0' };

export async function GET(request: NextRequest) {
  return NextResponse.json({
    authenticated: verifyAdminSessionToken(request.cookies.get(ADMIN_COOKIE_NAME)?.value),
    configuration: getAdminConfigurationStatus()
  }, { headers: noStore });
}
export async function POST(request: NextRequest) {
  let body: { username?: unknown; password?: unknown };
  try { body = await request.json() as { username?: unknown; password?: unknown }; }
  catch { return NextResponse.json({ error: 'بيانات الدخول غير صالحة.' }, { status: 400, headers: noStore }); }
  const config = getAdminConfigurationStatus();
  if (!config.configured) return NextResponse.json({
    error: 'يجب إعداد بيانات دخول لوحة الويب في متغيرات البيئة أولًا.', missing: config.missing
  }, { status: 503, headers: noStore });
  const username = typeof body.username === 'string' ? body.username.trim().slice(0, 120) : '';
  const password = typeof body.password === 'string' ? body.password.slice(0, 256) : '';
  if (!verifyAdminCredentials(username, password)) {
    return NextResponse.json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' }, { status: 401, headers: noStore });
  }
  const response = NextResponse.json({ authenticated: true }, { headers: noStore });
  response.cookies.set(ADMIN_COOKIE_NAME, createAdminSessionToken(username), {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict',
    path: '/', maxAge: 60 * 60 * 8
  });
  return response;
}
export async function DELETE() {
  const response = NextResponse.json({ authenticated: false }, { headers: noStore });
  response.cookies.set(ADMIN_COOKIE_NAME, '', {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 0
  });
  return response;
}
