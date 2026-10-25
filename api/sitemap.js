const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_KEY = (
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''
).trim();

const SITE_URL = (process.env.SITE_URL || 'https://телегра.site').replace(/\/+$/, '');

function xmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeUsername(u) {
  return String(u || '')
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '')
    .split('/')[0]
    .split('?')[0]
    .toLowerCase();
}

async function fetchAllUsernames() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  const out = [];
  const pageSize = 1000;
  let from = 0;

  for (let page = 0; page < 50; page++) {
    const to = from + pageSize - 1;
    const url =
      SUPABASE_URL +
      '/rest/v1/items?select=username,created_at' +
      '&is_private=eq.false' +
      '&username=not.is.null' +
      '&order=created_at.desc' +
      '&limit=' + pageSize +
      '&offset=' + from;

    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        Accept: 'application/json',
        Prefer: 'count=exact'
      }
    });
    if (!res.ok) break;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) break;
    for (let i = 0; i < rows.length; i++) {
      const u = normalizeUsername(rows[i].username);
      if (u && u.length >= 3) {
        out.push({
          username: u,
          lastmod: rows[i].created_at ? String(rows[i].created_at).slice(0, 10) : null
        });
      }
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }

  // уникальные username
  const seen = Object.create(null);
  const unique = [];
  for (let i = 0; i < out.length; i++) {
    if (seen[out[i].username]) continue;
    seen[out[i].username] = true;
    unique.push(out[i]);
  }
  return unique;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).send('Method not allowed');
  }

  let items = [];
  try {
    items = await fetchAllUsernames();
  } catch (e) {
    items = [];
  }

  const today = new Date().toISOString().slice(0, 10);
  const urls = [];

  urls.push(
    '  <url>\n' +
      '    <loc>' + xmlEscape(SITE_URL + '/') + '</loc>\n' +
      '    <lastmod>' + today + '</lastmod>\n' +
      '    <changefreq>hourly</changefreq>\n' +
      '    <priority>1.0</priority>\n' +
      '  </url>'
  );

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const loc = SITE_URL + '/c/' + encodeURIComponent(it.username);
    const lastmod = it.lastmod || today;
    urls.push(
      '  <url>\n' +
        '    <loc>' + xmlEscape(loc) + '</loc>\n' +
        '    <lastmod>' + xmlEscape(lastmod) + '</lastmod>\n' +
        '    <changefreq>weekly</changefreq>\n' +
        '    <priority>0.7</priority>\n' +
        '  </url>'
    );
  }

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join('\n') +
    '\n</urlset>\n';

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).send(xml);
}
