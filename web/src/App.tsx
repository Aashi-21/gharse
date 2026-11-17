import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { PageLoader } from './components/ui';
import { useAuth } from './lib/auth';
import AuthPage from './pages/AuthPage';
import BrandPage from './pages/BrandPage';
import Dashboard from './pages/Dashboard';
import Landing from './pages/Landing';
import NewProductPage from './pages/NewProductPage';
import Onboarding from './pages/Onboarding';
import ProductReviewPage from './pages/ProductReviewPage';
import ProductsPage from './pages/ProductsPage';
import ProfilePage from './pages/ProfilePage';
import Overview from './pages/Overview';

/** Requires login; sends sellers who haven't finished onboarding to /onboarding. */
function RequireSeller({ needOnboarded }: { needOnboarded: boolean }) {
  const { state } = useAuth();
  if (state.status === 'loading') return <PageLoader />;
  if (state.status === 'anon') return <Navigate to="/login" replace />;
  const { profileComplete, storeComplete } = state.me.onboarding;
  const done = profileComplete && storeComplete;
  if (needOnboarded && !done) return <Navigate to="/onboarding" replace />;
  if (!needOnboarded && done) return <Navigate to="/dashboard" replace />;
  return <Outlet />;
}

/** Login/register pages bounce already-logged-in users onward. */
function GuestOnly() {
  const { state } = useAuth();
  if (state.status === 'loading') return <PageLoader />;
  if (state.status === 'authed') return <Navigate to="/dashboard" replace />;
  return <Outlet />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route element={<GuestOnly />}>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
      </Route>
      <Route element={<RequireSeller needOnboarded={false} />}>
        <Route path="/onboarding" element={<Onboarding />} />
      </Route>
      <Route element={<RequireSeller needOnboarded />}>
        <Route path="/dashboard" element={<Dashboard />}>
          <Route index element={<Overview />} />
          <Route path="brand" element={<BrandPage />} />
          <Route path="products" element={<ProductsPage />} />
          <Route path="products/new" element={<NewProductPage />} />
          <Route path="products/:id" element={<ProductReviewPage />} />
          <Route path="profile" element={<ProfilePage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
