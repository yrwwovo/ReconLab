import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { cachedUser, clearSession, getToken, login as apiLogin, register as apiRegister, setSession, type AuthUser } from './api';

interface AuthState {
  user: AuthUser | null;
  ready: boolean;
  login: (identity: string, password: string) => Promise<void>;
  register: (email: string, password: string, name?: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => (getToken() ? cachedUser() : null));
  const [ready, setReady] = useState(false);

  useEffect(() => { setReady(true); }, []);

  const login = useCallback(async (identity: string, password: string) => {
    const res = await apiLogin(identity, password);
    setSession(res.token, res.record);
    setUser(res.record);
  }, []);

  const register = useCallback(async (email: string, password: string, name?: string) => {
    await apiRegister(email, password, name);
    await login(email, password);
  }, [login]);

  const logout = useCallback(() => {
    clearSession();
    setUser(null);
    window.location.hash = '/login';
  }, []);

  const value = useMemo<AuthState>(() => ({ user, ready, login, register, logout }), [user, ready, login, register, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
