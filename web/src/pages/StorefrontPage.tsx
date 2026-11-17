import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import ProductImage from '../components/ProductImage';
import StoreFrame from '../components/StoreFrame';
import { Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { inr, type PublicProduct, type PublicStore } from '../lib/publicStore';

export function StoreUnavailable() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-5 text-center">
      <h1 className="text-3xl font-semibold">This store isn’t available</h1>
      <p className="mt-2 max-w-md text-ink-soft">The link may be wrong, or the seller has taken the store offline for now.</p>
      <Link to="/" className="mt-6 rounded-full bg-clay px-6 py-2.5 text-sm font-medium text-white hover:bg-clay-dark">Go to GharSe</Link>
    </div>
  );
}

export default function StorefrontPage() {
  const { slug } = useParams();
  const [data, setData] = useState<{ store: PublicStore; products: PublicProduct[] } | null>(null);
  const [state, setState] = useState<'loading' | 'missing' | 'error' | 'ok'>('loading');

  useEffect(() => {
    setState('loading');
    api<{ store: PublicStore; products: PublicProduct[] }>(`/api/public/stores/${slug}`)
      .then((r) => {
        setData(r);
        setState('ok');
      })
      .catch((e) => setState(e instanceof ApiError && e.status === 404 ? 'missing' : 'error'));
  }, [slug]);

  if (state === 'loading') return <div className="flex min-h-screen items-center justify-center text-clay"><Spinner className="h-8 w-8" /></div>;
  if (state === 'missing') return <StoreUnavailable />;
  if (state === 'error' || !data) {
    return <div className="flex min-h-screen items-center justify-center px-5 text-center text-ink-soft">We could not load this store right now. Please try again in a moment.</div>;
  }
  const { store, products } = data;

  return (
    <StoreFrame store={store}>
      <section className="max-w-2xl">
        <h2 className="text-xl font-semibold">Our story</h2>
        <p className="mt-2 whitespace-pre-line leading-relaxed text-ink-soft">{store.story}</p>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold">Products</h2>
        {products.length === 0 ? (
          <p className="mt-3 text-ink-soft">No products are available right now. Please check back soon.</p>
        ) : (
          <ul className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-3">
            {products.map((p) => (
              <li key={p.slug}>
                <Link to={`/store/${store.slug}/p/${p.slug}`} className="group block overflow-hidden rounded-2xl border border-cream-300 bg-white shadow-card transition hover:shadow-md">
                  <div className="relative">
                    <ProductImage src={p.imageUrl} alt={p.title} className={`aspect-[4/3] w-full ${p.inStock ? '' : 'opacity-60'}`} />
                    {!p.inStock && (
                      <span className="absolute left-2 top-2 rounded-full bg-ink px-2.5 py-1 text-xs font-medium text-white">Sold out</span>
                    )}
                  </div>
                  <div className="p-3 sm:p-4">
                    <p className="font-medium leading-snug group-hover:underline">{p.title}</p>
                    <p className="mt-1 text-sm font-semibold" style={{ color: store.primaryColor }}>{inr(p.pricePaise)}</p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </StoreFrame>
  );
}
