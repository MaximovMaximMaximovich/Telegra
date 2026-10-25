import sharp from 'sharp';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const CRON_SECRET = (process.env.CRON_SECRET || '').trim();

const MAX_SIDE = 256;
const JPEG_QUALITY = 82;

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

/** Проверка: JWT пользователя есть в таблице admins */
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

    const adm = await fetch(
      SUPABASE_URL + '/rest/v1/admins?select=user_id&user_id=eq.' + encodeURIComponent(uid) + '&limit=1',
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
          Accept: 'application/json'
        }
      }
    );
    if (!adm.ok) {
      // fallback: иногда в admins хранят email
      const email = user.email || '';
      if (!email) return false;
      const adm2 = await fetch(
        SUPABASE_URL + '/rest/v1/admins?select=id&email=eq.' + encodeURIComponent(email) + '&limit=1',
        {
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
            Accept: 'application/json'
          }
        }
      );
      if (!adm2.ok) return false;
      const rows2 = await adm2.json();
      return Array.isArray(rows2) && rows2.length > 0;
    }
    const rows = await adm.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    return false;
  }
}

async function isAuthorized(req) {
  if (isCronAuthorized(req)) return true;
  const bearer = getBearer(req);
  // Не принимаем CRON_SECRET как единственный Bearer уже проверили;
  // пользовательский JWT
  if (bearer && bearer !== CRON_SECRET) {
    return await isAdminUser(bearer);
  }
  return false;
}

function safeName(input) {
  return String(input || 'avatar')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'avatar';
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!(await isAuthorized(req))) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      ok: false,
      step: 'env',
      error: 'Missing Supabase env'
    });
  }

  const src =
    (req.query && req.query.url) ||
    (req.body && req.body.url) ||
    '';
  const username =
    (req.query && req.query.username) ||
    (req.body && req.body.username) ||
    'unknown';

  if (!src || !/^https?:\/\//i.test(src)) {
    return res.status(400).json({ ok: false, step: 'input', error: 'Bad url' });
  }

  if (src.indexOf(SUPABASE_URL) === 0) {
    return res.status(200).json({ ok: true, url: src, skipped: true });
  }

  let input;
  try {
    const imgRes = await fetch(src, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
      },
      redirect: 'follow'
    });
    if (!imgRes.ok) {
      return res.status(502).json({
        ok: false,
        step: 'download',
        error: 'HTTP ' + imgRes.status
      });
    }
    input = Buffer.from(await imgRes.arrayBuffer());
    if (!input.length || input.length > 8 * 1024 * 1024) {
      return res.status(400).json({ ok: false, step: 'download', error: 'Bad image size' });
    }
  } catch (e) {
    return res.status(502).json({
      ok: false,
      step: 'download',
      error: e.message || String(e)
    });
  }

  let out;
  try {
    out = await sharp(input)
      .rotate()
      .resize(MAX_SIDE, MAX_SIDE, { fit: 'cover', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
  } catch (e) {
    return res.status(500).json({
      ok: false,
      step: 'sharp',
      error: e.message || String(e)
    });
  }

  const path = safeName(username) + '_' + Date.now() + '.jpg';
  try {
    const uploadUrl = SUPABASE_URL + '/storage/v1/object/avatars/' + path;
    const up = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'image/jpeg',
        'x-upsert': 'true'
      },
      body: out
    });
    const upText = await up.text();
    if (!up.ok) {
      return res.status(502).json({
        ok: false,
        step: 'upload',
        error: 'HTTP ' + up.status,
        detail: upText.slice(0, 250)
      });
    }
  } catch (e) {
    return res.status(502).json({
      ok: false,
      step: 'upload',
      error: e.message || String(e)
    });
  }

  const publicUrl = SUPABASE_URL + '/storage/v1/object/public/avatars/' + path;
  return res.status(200).json({
    ok: true,
    url: publicUrl,
    bytes: out.length
  });
}
