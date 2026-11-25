import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import AppFrame from '@/components/AppFrame';
import { getDb } from '@/lib/mongodb';

export async function generateMetadata(): Promise<Metadata> {
  let projectName = 'أرض الجوال';
  if (process.env.MONGODB_URI) {
    try {
      const db = await getDb();
      const brand = await db.collection<{ _id: string; projectName?: string }>('store_settings').findOne({ _id: 'brand' });
      if (typeof brand?.projectName === 'string' && brand.projectName.trim()) projectName = brand.projectName.trim();
    } catch {
      // Keep default metadata until the EE MongoDB environment is configured.
    }
  }
  return {
    title: projectName + ' | متجر الجوالات والإكسسوارات',
    description: projectName + ' — تصفح الجوالات والأجهزة وملحقاتها واختر المنتجات التي تناسبك.',
    applicationName: projectName
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body><AppFrame>{children}</AppFrame></body>
    </html>
  );
}
