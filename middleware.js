import { rewrite } from '@vercel/edge';

export const config = {
  matcher: ['/c/:path*', '/sitemap.xml']
};

export default function middleware(request) {
  const url = new URL(request.url);

  // sitemap
  if (url.pathname === '/sitemap.xml') {
    const dest = new URL('/api/sitemap', request.url);
    return rewrite(dest);
  }

  // страницы каналов
  const m = url.pathname.match(/^\/c\/([^/]+)\/?$/);
  if (m) {
    const username = decodeURIComponent(m[1] || '').trim();
    if (!username) return;
    const dest = new URL('/api/channel-page', request.url);
    dest.searchParams.set('username', username);
    return rewrite(dest);
  }
}
