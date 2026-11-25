import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';
import { findStoredProduct, serializeStoredProduct } from '@/lib/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ProductRouteContext = {
  params: Promise<{ id: string }>;
};

const NO_STORE_HEADERS = { 'cache-control': 'no-store, max-age=0, must-revalidate' };

export async function GET(_request: Request, { params }: ProductRouteContext) {
  const { id } = await params;

  if (!process.env.MONGODB_URI) {
    return NextResponse.json(
      { error: 'Product database connection is not configured' },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }

  try {
    const db = await getDb();
    const stored = await findStoredProduct(db, id);

    if (!stored) {
      return NextResponse.json(
        { error: 'Product not found' },
        { status: 404, headers: NO_STORE_HEADERS }
      );
    }

    return NextResponse.json(
      { product: serializeStoredProduct(stored, { includeColorMask: true }) },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    console.error('Product database read failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: 'Product is temporarily unavailable because the database could not be reached' },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }
}
