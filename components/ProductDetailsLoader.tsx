'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import ProductDetails from '@/components/ProductDetails';
import type { Product } from '@/lib/products';

type LoadStatus = 'loading' | 'ready' | 'not-found' | 'unavailable';

export default function ProductDetailsLoader({ id }: { id: string }) {
  const [product, setProduct] = useState<Product | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    setProduct(null);
    setStatus('loading');

    void fetch('/api/products/' + encodeURIComponent(id), {
      cache: 'no-store',
      signal: controller.signal
    }).then(async (response) => {
      if (cancelled) return;

      if (response.status === 404) {
        setProduct(null);
        setStatus('not-found');
        return;
      }

      if (!response.ok) {
        setProduct(null);
        setStatus('unavailable');
        return;
      }

      const payload = await response.json() as { product?: Product };
      if (!payload.product) {
        setProduct(null);
        setStatus('unavailable');
        return;
      }

      setProduct(payload.product);
      setStatus('ready');
    }).catch(() => {
      if (!cancelled) {
        setProduct(null);
        setStatus('unavailable');
      }
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [id, retryKey]);

  if (status === 'ready' && product) return <ProductDetails product={product} />;

  return (
    <main className="container product-detail-page">
      <section className="product-detail-card" style={{ padding: 32, textAlign: 'center' }}>
        {status === 'loading' ? (
          <>
            <h1>جارٍ تحميل المنتج</h1>
            <p>يتم جلب بيانات المنتج من قاعدة البيانات.</p>
          </>
        ) : status === 'not-found' ? (
          <>
            <h1>المنتج غير متاح حاليًا</h1>
            <p>لم يتم العثور على هذا المنتج في قاعدة البيانات.</p>
          </>
        ) : (
          <>
            <h1>تعذر تحميل المنتج</h1>
            <p>تعذر الاتصال بقاعدة البيانات. لم نعرض بيانات تجريبية أو محفوظة محليًا.</p>
            <button type="button" className="primary-button" onClick={() => setRetryKey((value) => value + 1)}>
              إعادة المحاولة
            </button>
          </>
        )}
        <div style={{ marginTop: 16 }}>
          <Link href="/#categories" className="primary-button">العودة إلى المنتجات</Link>
        </div>
      </section>
    </main>
  );
}
