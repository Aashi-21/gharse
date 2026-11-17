import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';

export interface Profile {
  id: string;
  fullName: string;
  phone: string;
  whatsapp: string | null;
  city: string;
  state: string;
  bio: string | null;
}
export interface Store {
  id: string;
  slug: string;
  isSample: boolean;
  isPublished: boolean;
}
export interface BrandSummary {
  name: string;
  version: number;
  status: 'DRAFT' | 'APPROVED';
}
export interface Me {
  user: { id: string; email: string; isSample: boolean };
  profile: Profile | null;
  store: Store | null;
  brand: BrandSummary | null;
  counts: { products: number; published: number };
  onboarding: { profileComplete: boolean; storeComplete: boolean };
}

type State = { status: 'loading' } | { status: 'anon' } | { status: 'authed'; me: Me };

interface AuthCtx {
  state: State;
  login(email: string, password: string): Promise<Me>;
  register(email: string, password: string): Promise<Me>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  const refresh = useCallback(async () => {
    try {
      setState({ status: 'authed', me: await api<Me>('/api/auth/me') });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setState({ status: 'anon' });
      else throw e;
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => setState({ status: 'anon' }));
  }, [refresh]);

  const value = useMemo<AuthCtx>(
    () => ({
      state,
      refresh,
      async login(email, password) {
        const me = await api<Me>('/api/auth/login', { method: 'POST', body: { email, password } });
        setState({ status: 'authed', me });
        return me;
      },
      async register(email, password) {
        const me = await api<Me>('/api/auth/register', { method: 'POST', body: { email, password } });
        setState({ status: 'authed', me });
        return me;
      },
      async logout() {
        await api('/api/auth/logout', { method: 'POST' });
        setState({ status: 'anon' });
      },
    }),
    [state, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

export function useMe(): Me {
  const { state } = useAuth();
  if (state.status !== 'authed') throw new Error('useMe outside authenticated route');
  return state.me;
}
