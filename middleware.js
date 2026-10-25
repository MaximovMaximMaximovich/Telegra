import { rewrite } from '@vercel/edge';

export const config = {
  matcher: '/c/:path*'
};

export default function middleware(request) {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/c\/([^/]+)\/?$/);
  if (!m) return;

  const username = decodeURIComponent(m[1] || '').trim();
  if (!username) return;

  const dest = new URL('/api/channel-page', request.url);
  dest.searchParams.set('username', username);
  return rewrite(dest);
}
