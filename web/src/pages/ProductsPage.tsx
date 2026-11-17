import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Card, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { rupees } from '../lib/categories';
import type { Product } from '../lib/products';

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ products: Product[] }>('/api/seller/products')
      .then((r) => setProducts(r.products))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load your products.'));
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold">Products</h1>
          <p className="mt-1 text-ink-soft">Upload a photo and review the draft listing written in your brand voice.</p>
        </div>
        <Link to="/dashboard/products/new" className="rounded-full bg-clay px-5 py-2.5 text-sm font-medium text-white hover:bg-clay-dark">
          Add a product
        </Link>
      </div>

      {error && <Alert>{error}</Alert>}
      {!products && !error && <div className="flex justify-center py-16 text-clay"><Spinner className="h-7 w-7" /></div>}

      {products?.length === 0 && (
        <Card className="py-12 text-center">
          <h2 className="text-xl font-semibold">No products yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">
            Take a clear photo of something you made. GharSe drafts the title and description in your brand voice, and you review everything.
          </p>
          <Link to="/dashboard/products/new" className="mt-5 inline-block rounded-full bg-clay px-5 py-2.5 text-sm font-medium text-white hover:bg-clay-dark">
            Add your first product
          </Link>
        </Card>
      )}

      {products && products.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => (
            <li key={p.id}>
              <Link to={`/dashboard/products/${p.id}`} className="block overflow-hidden rounded-2xl border border-cream-300 bg-white shadow-card transition hover:shadow-md">
                <div className="aspect-[4/3] bg-cream-200">
                  {p.imageUrl && <img src={p.imageUrl} alt={p.title} className="h-full w-full object-cover" loading="lazy" />}
                </div>
                <div className="space-y-1 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium leading-snug">{p.title}</p>
                    <span className="shrink-0 rounded-full bg-cream-200 px-2 py-0.5 text-xs text-ink-soft">{p.status === 'DRAFT' ? 'Draft' : p.status === 'PUBLISHED' ? 'Live' : 'Archived'}</span>
                  </div>
                  <p className="text-sm text-ink-soft">
                    {p.pricePaise !== null ? `₹${rupees(p.pricePaise)}` : 'Price not set'} · {p.stock} in stock
                  </p>
                  {p.status === 'DRAFT' && p.readiness.issues.length > 0 && (
                    <p className="text-xs text-clay-dark">To publish: {p.readiness.issues.map((i) => i.field).join(', ')}</p>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
