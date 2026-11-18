import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PAYMENT_NOTE, type PublicStore } from '../lib/publicStore';

/** Shared chrome for public store pages: brand header, demo banner and the seller's contact/policies footer. */
export default function StoreFrame({ store, children }: { store: PublicStore; children: ReactNode }) {
  useEffect(() => {
    document.title = `${store.name} — ${store.tagline}`;
    return () => {
      document.title = 'GharSe — your handmade brand, online';
    };
  }, [store.name, store.tagline]);

  const whatsapp = store.contactPhone ? `https://wa.me/91${store.contactPhone}` : null;
  return (
    <div className="min-h-screen bg-cream-100">
      {store.isSample && (
        <div className="bg-ink px-4 py-2 text-center text-xs text-cream-100">
          <strong>Demo store.</strong> This is a sample store for demonstration. Orders cannot be placed here.
        </div>
      )}
      <header style={{ backgroundColor: store.primaryColor }} className="text-white">
        <div className="mx-auto max-w-5xl px-5 py-8">
          <Link to={`/store/${store.slug}`} className="font-display text-3xl font-semibold sm:text-4xl">{store.name}</Link>
          <p className="mt-1 text-sm opacity-90 sm:text-base">{store.tagline}</p>
          <div className="mt-4 h-1.5 w-16 rounded-full" style={{ backgroundColor: store.secondaryColor }} />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 py-8">{children}</main>
      <footer className="border-t border-cream-300 bg-cream-50">
        <div className="mx-auto grid max-w-5xl gap-6 px-5 py-8 text-sm text-ink-soft sm:grid-cols-3">
          <div>
            <p className="font-medium text-ink">Contact the seller</p>
            {store.contactPhone ? (
              <p className="mt-1 space-y-1">
                <a href={`tel:+91${store.contactPhone}`} className="block hover:underline">+91 {store.contactPhone}</a>
                {whatsapp && <a href={whatsapp} target="_blank" rel="noreferrer" className="block text-clay-dark hover:underline">Message on WhatsApp</a>}
              </p>
            ) : (
              <p className="mt-1">Contact details are not available.</p>
            )}
          </div>
          {store.deliveryPolicy && (
            <div>
              <p className="font-medium text-ink">Delivery</p>
              <p className="mt-1 whitespace-pre-line">{store.deliveryPolicy}</p>
            </div>
          )}
          {store.returnPolicy && (
            <div>
              <p className="font-medium text-ink">Returns</p>
              <p className="mt-1 whitespace-pre-line">{store.returnPolicy}</p>
            </div>
          )}
          <p className="text-xs text-ink-faint sm:col-span-3">{PAYMENT_NOTE} Store powered by GharSe. <Link to="/contact" className="text-clay-dark underline">Contact GharSe</Link></p>
        </div>
      </footer>
    </div>
  );
}
