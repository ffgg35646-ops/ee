import type { Metadata } from 'next';
import AdminLoginForm from '@/components/AdminLoginForm';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'دخول الإدارة | أرض الجوال', robots: { index: false, follow: false } };

export default function AdminLoginPage() {
  return <AdminLoginForm />;
}
