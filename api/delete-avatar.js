const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const CRON_SECRET = (process.env.CRON_SECRET || '').trim();

function isAuthorized(req) {
  const auth = req.headers.authorization || '';
  const q = (req.query && req.query.secret) || '';
  if (!CRON_SECRET) return false;
  if (auth === 'Bearer ' + CRON_SECRET) return true;
  if (q === CRON_SECRET) return true;
  return false;
}

/** Достаёт путь внутри bucket avatars из public URL */
function pathFromAvatarUrl(url) {
  if (!url || typeof url !== 'string') return null;
  // https://xxx.supabase.co/storage/v1/object/public/avatars/filename.jpg
  var m = url.match(/\/storage\/v1\/object\/public\/avatars\/(.+)$/i);
  if (m && m[1]) return decodeURIComponent(m[1].split('?')[0]);
  // https://xxx.supabase.co/storage/v1/object/avatars/filename.jpg
  m = url.match(/\/storage\/v1\/object\/avatars\/(.+)$/i);
  if (m && m[1]) return decodeURIComponent(m[1].split('?')[0]);
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Missing Supabase env' });
  }

  const src =
    (req.query && req.query.url) ||
    (req.body && req.body.url) ||
    '';

  const path = pathFromAvatarUrl(src);
  if (!path) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'not_storage_url' });
  }

  try {
    // Supabase Storage API: DELETE /storage/v1/object/{bucket}/{wildcard}
    const delUrl = SUPABASE_URL + '/storage/v1/object/avatars/' + path.split('/').map(encodeURIComponent).join('/');
    const del = await fetch(delUrl, {
      method: 'DELETE',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY
      }
    });
    const text = await del.text();
    if (!del.ok && del.status !== 404) {
      return res.status(502).json({
        ok: false,
        error: 'Delete failed ' + del.status,
        detail: text.slice(0, 200)
      });
    }
    return res.status(200).json({ ok: true, path: path });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
