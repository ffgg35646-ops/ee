import ProductDetailsLoader from '@/components/ProductDetailsLoader';

export const dynamic = 'force-dynamic';

type ProductPageProps = {
  params: Promise<{ id: string }>;
};

export async function generateMetadata(): Promise<{ title: string; description: string }> {
  return {
    title: 'تفاصيل المنتج',
    description: 'تفاصيل المنتج من كتالوج المتجر'
  };
}

export default async function ProductPage({ params }: ProductPageProps) {
  const { id } = await params;
  return <ProductDetailsLoader id={id} />;
}
