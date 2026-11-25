'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { CartProvider } from '@/components/CartProvider';
import SiteHeader from '@/components/SiteHeader';
import WhatsAppSupport from '@/components/WhatsAppSupport';
import StoreFooter from '@/components/StoreFooter';
import MobileBottomNav from '@/components/MobileBottomNav';

export default function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isAdminRoute = pathname === '/admin' || pathname.startsWith('/admin/');
  return (
    <CartProvider>
      {isAdminRoute ? children : (
        <div className="mobile-app-shell">
          <SiteHeader />
          {children}
          <StoreFooter />
          <WhatsAppSupport />
          <MobileBottomNav />
        </div>
      )}
    </CartProvider>
  );
}
