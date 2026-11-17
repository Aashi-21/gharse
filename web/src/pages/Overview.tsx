import { Link } from 'react-router-dom';
import { Card } from '../components/ui';
import { useMe } from '../lib/auth';

function Item({ done, title, detail, to, cta }: { done: boolean; title: string; detail: string; to?: string; cta?: string }) {
  return (
    <li className="flex items-start gap-3 py-3">
      <span
        aria-hidden
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${done ? 'bg-sage text-white' : 'border border-cream-300 text-ink-faint'}`}
      >
        {done ? '✓' : ''}
      </span>
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-sm text-ink-soft">{detail}</p>
      </div>
      {to && cta ? (
        <Link to={to} className="ml-auto shrink-0 rounded-full border border-cream-300 px-3 py-1 text-xs font-medium text-clay-dark hover:bg-cream-200">{cta}</Link>
      ) : (
        <span className={`ml-auto shrink-0 text-xs ${done ? 'text-sage' : 'text-ink-faint'}`}>{done ? 'Done' : 'Coming up'}</span>
      )}
    </li>
  );
}

export default function Overview() {
  const me = useMe();
  const first = me.profile?.fullName.split(' ')[0];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Welcome, {first}</h1>
        <p className="mt-1 text-ink-soft">Here is where your store stands.</p>
      </div>

      <Card>
        <h2 className="text-lg font-semibold">Your store</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Address: <span className="font-medium text-ink">{window.location.host}/store/{me.store?.slug}</span>
        </p>
        <p className="mt-2 text-sm text-ink-faint">
          {me.store?.isPublished ? 'Your store is live.' : 'Not published yet — customers cannot see it until you add and publish a product.'}
        </p>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold">Launch checklist</h2>
        <ul className="mt-2 divide-y divide-cream-200">
          <Item done={me.onboarding.profileComplete} title="Seller profile" detail="Your name, contact number and location." />
          <Item done={me.onboarding.storeComplete} title="Store address" detail="Your own link to share with customers." />
          <Item
            done={!!me.brand}
            title="Brand identity"
            detail={me.brand ? `${me.brand.name} · version ${me.brand.version} approved` : 'Name, story, colours and voice — created once, reused for every product.'}
            to="/dashboard/brand"
            cta={me.brand ? 'Edit' : 'Create'}
          />
          <Item done={false} title="First product" detail="Upload a photo and review the draft listing." to="/dashboard/products" cta="Add" />
          <Item done={false} title="Delivery and return policies" detail="Tell customers what to expect." />
        </ul>
      </Card>
    </div>
  );
}
