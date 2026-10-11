import { useEffect, useState } from 'react';

export function currentPath(): string {
  const raw = window.location.hash.replace(/^#/, '');
  return raw || '/dashboard';
}

export function navigate(path: string) {
  if (currentPath() === path) return;
  window.location.hash = path;
}

export function useRoute(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onChange = () => setPath(currentPath());
    window.addEventListener('hashchange', onChange);
    if (!window.location.hash) window.location.hash = '/dashboard';
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return path;
}

/** 解析 /scans/abc123 → { base: '/scans', id: 'abc123' } */
export function parseRoute(path: string): { base: string; id?: string } {
  const segs = path.split('/').filter(Boolean);
  if (segs.length === 0) return { base: '/dashboard' };
  return { base: `/${segs[0]}`, id: segs[1] };
}
