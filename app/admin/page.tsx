import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import AdminDashboard from '@/components/AdminDashboard';
import { ADMIN_COOKIE_NAME, verifyAdminSessionToken } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'لوحة إدارة المتجر', robots: { index: false, follow: false } };

export default async function AdminPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
  if (!verifyAdminSessionToken(token)) redirect('/admin/login');
  return <AdminDashboard />;
}
