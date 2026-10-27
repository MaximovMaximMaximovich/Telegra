import { rewrite } from '@vercel/edge';

export const config = {
  matcher: ['/c/:path*', '/p/:path*', '/sitemap.xml']
};

export default function middleware(request) {
  const url = new URL(request.url);

  // sitemap
  if (url.pathname === '/sitemap.xml') {
    const dest = new URL('/api/sitemap', request.url);
    return rewrite(dest);
  }

  // публичные каналы: /c/username
  const c = url.pathname.match(/^\/c\/([^/]+)\/?$/);
  if (c) {
    const username = decodeURIComponent(c[1] || '').trim();
    if (!username) return;
    const dest = new URL('/api/channel-page', request.url);
    dest.searchParams.set('username', username);
    return rewrite(dest);
  }

  // приватные: /p/id
  const p = url.pathname.match(/^\/p\/([^/]+)\/?$/);
  if (p) {
    const id = decodeURIComponent(p[1] || '').trim();
    if (!id) return;
    const dest = new URL('/api/channel-page', request.url);
    dest.searchParams.set('id', id);
    return rewrite(dest);
  }
}
