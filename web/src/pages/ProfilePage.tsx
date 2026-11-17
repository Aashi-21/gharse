import ProfileForm from '../components/ProfileForm';
import { Card } from '../components/ui';
import { useAuth, useMe } from '../lib/auth';

export default function ProfilePage() {
  const me = useMe();
  const { refresh } = useAuth();
  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Your profile</h1>
        <p className="mt-1 text-ink-soft">Signed in as {me.user.email}</p>
      </div>
      <Card>
        <ProfileForm initial={me.profile} submitLabel="Save changes" onSaved={refresh} />
      </Card>
    </div>
  );
}
