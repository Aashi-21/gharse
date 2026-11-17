import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import OrderForm from '../components/OrderForm';
import ProductImage from '../components/ProductImage';
import StoreFrame from '../components/StoreFrame';
import { Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { inr, type PublicProduct, type PublicStore } from '../lib/publicStore';
import { StoreUnavailable } from './StorefrontPage';

export default function PublicProductPage() {
  const { slug, productSlug } = useParams();
  const [data, setData] = useState<{ store: PublicStore; product: PublicProduct } | null>(null);
  const [state, setState] = useState<'loading' | 'missing' | 'error' | 'ok'>('loading');

  useEffect(() => {
    setState('loading');
    api<{ store: PublicStore; product: PublicProduct }>(`/api/public/stores/${slug}/products/${productSlug}`)
      .then((r) => {
        setData(r);
        setState('ok');
      })
      .catch((e) => setState(e instanceof ApiError && e.status === 404 ? 'missing' : 'error'));
  }, [slug, productSlug]);

  if (state === 'loading') return <div className="flex min-h-screen items-center justify-center text-clay"><Spinner className="h-8 w-8" /></div>;
  if (state === 'missing') return <StoreUnavailable />;
  if (state === 'error' || !data) {
    return <div className="flex min-h-screen items-center justify-center px-5 text-center text-ink-soft">We could not load this product right now. Please try again in a moment.</div>;
  }
  const { store, product } = data;

  return (
    <StoreFrame store={store}>
      <Link to={`/store/${store.slug}`} className="text-sm text-ink-soft hover:underline">← All products</Link>
      <div className="mt-4 grid gap-8 md:grid-cols-2">
        <div className="relative overflow-hidden rounded-2xl border border-cream-300 bg-white shadow-card">
          <ProductImage src={product.imageUrl} alt={product.title} className="aspect-square w-full" />
          {!product.inStock && <span className="absolute left-3 top-3 rounded-full bg-ink px-3 py-1 text-xs font-medium text-white">Sold out</span>}
        </div>
        <div>
          <h1 className="text-3xl font-semibold leading-tight">{product.title}</h1>
          <p className="mt-2 text-2xl font-semibold" style={{ color: store.primaryColor }}>{inr(product.pricePaise)}</p>
          {product.category && <p className="mt-1 text-sm text-ink-faint">{product.category}</p>}
          <p className="mt-4 whitespace-pre-line leading-relaxed text-ink-soft">{product.description}</p>
          {product.tags.length > 0 && (
            <ul className="mt-4 flex flex-wrap gap-2">
              {product.tags.map((t) => <li key={t} className="rounded-full bg-cream-200 px-3 py-1 text-xs text-ink-soft">{t}</li>)}
            </ul>
          )}
          <div id="order" className="mt-8">
            <OrderForm key={product.slug} store={store} product={product} />
          </div>
        </div>
      </div>
    </StoreFrame>
  );
}
