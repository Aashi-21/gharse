import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Field, Input, Logo } from '../components/ui';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

export default function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const isLogin = mode === 'login';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setFields({});
    try {
      const me = await (isLogin ? login : register)(email, password);
      const done = me.onboarding.profileComplete && me.onboarding.storeComplete;
      navigate(done ? '/dashboard' : '/onboarding', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields);
      } else setError('Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center px-5 py-10">
      <Logo />
      <Card className="mt-10 w-full max-w-md">
        <h1 className="text-2xl font-semibold">{isLogin ? 'Welcome back' : 'Create your account'}</h1>
        <p className="mt-1 text-sm text-ink-soft">
          {isLogin ? 'Log in to manage your store.' : 'It takes a couple of minutes to get started.'}
        </p>
        <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
          {error && <Alert>{error}</Alert>}
          <Field label="Email" error={fields.email}>
            <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password" error={fields.password} hint={isLogin ? undefined : 'At least 8 characters'}>
            <Input
              type="password"
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              required
              minLength={isLogin ? undefined : 8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" loading={busy} className="w-full">
            {isLogin ? 'Log in' : 'Create account'}
          </Button>
        </form>
        <p className="mt-5 text-center text-sm text-ink-soft">
          {isLogin ? (
            <>New to GharSe? <Link to="/register" className="font-medium text-clay hover:underline">Create an account</Link></>
          ) : (
            <>Already have an account? <Link to="/login" className="font-medium text-clay hover:underline">Log in</Link></>
          )}
        </p>
      </Card>
      <p className="mt-6 text-sm text-ink-faint">Need help? <Link to="/contact" className="font-medium text-clay-dark hover:underline">Contact us</Link></p>
    </div>
  );
}
