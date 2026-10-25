const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const CRON_SECRET = (process.env.CRON_SECRET || '').trim();

function getBearer(req) {
  const auth = req.headers.authorization || '';
  if (auth.indexOf('Bearer ') === 0) return auth.slice(7).trim();
  return '';
}

function isCronAuthorized(req) {
  const bearer = getBearer(req);
  const q = (req.query && req.query.secret) || '';
  const headerSecret = req.headers['x-cron-secret'] || '';
  if (!CRON_SECRET) return false;
  if (bearer && bearer === CRON_SECRET) return true;
  if (q && q === CRON_SECRET) return true;
  if (headerSecret && headerSecret === CRON_SECRET) return true;
  return false;
}

async function isAdminUser(accessToken) {
  if (!accessToken || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return false;
  try {
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + accessToken
      }
    });
    if (!userRes.ok) return false;
    const user = await userRes.json();
    const uid = user && user.id;
    if (!uid) return false;

    let adm = await fetch(
      SUPABASE_URL + '/rest/v1/admins?select=user_id&user_id=eq.' + encodeURIComponent(uid) + '&limit=1',
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
          Accept: 'application/json'
        }
      }
    );
    if (adm.ok) {
      const rows = await adm.json();
      if (Array.isArray(rows) && rows.length > 0) return true;
    }
    const email = user.email || '';
    if (!email) return false;
    adm = await fetch(
      SUPABASE_URL + '/rest/v1/admins?select=id&email=eq.' + encodeURIComponent(email) + '&limit=1',
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
          Accept: 'application/json'
        }
      }
    );
    if (!adm.ok) return false;
    const rows2 = await adm.json();
    return Array.isArray(rows2) && rows2.length > 0;
  } catch (e) {
    return false;
  }
}

async function isAuthorized(req) {
  if (isCronAuthorized(req)) return true;
  const bearer = getBearer(req);
  if (bearer && bearer !== CRON_SECRET) {
    return await isAdminUser(bearer);
  }
  return false;
}

function pathFromAvatarUrl(url) {
  if (!url || typeof url !== 'string') return null;
  var m = url.match(/\/storage\/v1\/object\/public\/avatars\/(.+)$/i);
  if (m && m[1]) return decodeURIComponent(m[1].split('?')[0]);
  m = url.match(/\/storage\/v1\/object\/avatars\/(.+)$/i);
  if (m && m[1]) return decodeURIComponent(m[1].split('?')[0]);
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!(await isAuthorized(req))) {
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
    const delUrl =
      SUPABASE_URL +
      '/storage/v1/object/avatars/' +
      path.split('/').map(encodeURIComponent).join('/');
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
