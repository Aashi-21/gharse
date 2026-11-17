import { Link } from 'react-router-dom';
import { Logo } from '../components/ui';
import { useAuth } from '../lib/auth';

export default function Landing() {
  const { state } = useAuth();
  const authed = state.status === 'authed';
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-5 py-5">
        <Logo />
        <nav className="flex items-center gap-2 text-sm">
          {authed ? (
            <Link to="/dashboard" className="rounded-full bg-clay px-5 py-2.5 font-medium text-white hover:bg-clay-dark">
              Go to dashboard
            </Link>
          ) : (
            <>
              <Link to="/login" className="rounded-full px-4 py-2.5 font-medium text-ink-soft hover:bg-cream-200">Log in</Link>
              <Link to="/register" className="rounded-full bg-clay px-5 py-2.5 font-medium text-white hover:bg-clay-dark">Start your store</Link>
            </>
          )}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-5 pb-20 pt-10 sm:pt-20">
        <p className="text-sm font-medium uppercase tracking-widest text-clay">For women who make things by hand</p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-tight sm:text-6xl">
          Turn what you make into a brand you own.
        </h1>
        <p className="mt-6 max-w-xl text-lg text-ink-soft">
          Build your brand, list your handmade products from a photograph, and share your own online store with
          customers on WhatsApp and Instagram.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link to={authed ? '/dashboard' : '/register'} className="rounded-full bg-clay px-7 py-3 font-medium text-white hover:bg-clay-dark">
            {authed ? 'Go to dashboard' : 'Create your free store'}
          </Link>
        </div>

        <ul className="mt-20 grid gap-4 sm:grid-cols-3">
          {[
            ['Your brand, remembered', 'Create your brand once. Every new product is written in the same voice.'],
            ['From photo to listing', 'Upload a photograph and review a draft listing. You approve everything.'],
            ['Your own store link', 'Share one link. Customers order directly from you — no marketplace in between.'],
          ].map(([t, d]) => (
            <li key={t} className="rounded-2xl border border-cream-300 bg-white p-6 shadow-card">
              <h3 className="text-lg font-semibold">{t}</h3>
              <p className="mt-2 text-sm text-ink-soft">{d}</p>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
