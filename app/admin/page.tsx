import { redirect } from 'next/navigation';
import { getDb } from '@/lib/mongodb';
import { getAdminFromCookies, type AdminPrincipal } from '@/lib/admin-auth';
import AdminDashboard from '@/components/AdminDashboard';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'لوحة الإدارة | أرض الجوال',
  robots: { index: false, follow: false }
};

export default async function AdminPage() {
  let admin: AdminPrincipal | null = null;
  try {
    const db = await getDb();
    admin = await getAdminFromCookies(db);
  } catch {
    redirect('/admin/login');
  }
  if (!admin) redirect('/admin/login');
  return <AdminDashboard initialAdmin={admin} />;
}
