import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Logo } from '../components/ui';
import { useAuth, useMe } from '../lib/auth';

const linkCls = ({ isActive }: { isActive: boolean }) =>
  `rounded-full px-4 py-2 text-sm font-medium ${isActive ? 'bg-clay-light text-clay-dark' : 'text-ink-soft hover:bg-cream-200'}`;

export default function Dashboard() {
  const me = useMe();
  const { logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen">
      {me.user.isSample && (
        <div className="bg-ink px-4 py-2 text-center text-xs text-cream-100">
          You are viewing the <strong>sample seller account</strong>. Everything here is demonstration data, not real activity.
        </div>
      )}
      <header className="border-b border-cream-300 bg-cream-50">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-5 py-4">
          <Logo to="/dashboard" />
          <nav className="flex items-center gap-1">
            <NavLink to="/dashboard" end className={linkCls}>Overview</NavLink>
            <NavLink to="/dashboard/brand" className={linkCls}>Brand</NavLink>
            <NavLink to="/dashboard/products" className={linkCls}>Products</NavLink>
            <NavLink to="/dashboard/orders" className={linkCls}>
              Orders
              {me.newOrders > 0 && (
                <span className="ml-1.5 rounded-full bg-clay px-2 py-0.5 text-xs font-semibold text-white" aria-label={`${me.newOrders} new orders`}>{me.newOrders}</span>
              )}
            </NavLink>
            <NavLink to="/dashboard/store" className={linkCls}>Store</NavLink>
            <NavLink to="/dashboard/profile" className={linkCls}>Profile</NavLink>
            <button
              onClick={async () => {
                await logout();
                navigate('/', { replace: true });
              }}
              className="rounded-full px-4 py-2 text-sm font-medium text-ink-soft hover:bg-cream-200"
            >
              Log out
            </button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 py-8">
        <Outlet />
      </main>
    </div>
  );
}
