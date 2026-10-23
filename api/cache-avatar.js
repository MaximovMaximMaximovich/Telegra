import sharp from 'sharp';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const CRON_SECRET = (process.env.CRON_SECRET || '').trim();

const MAX_SIDE = 256;
const JPEG_QUALITY = 82;

function isAuthorized(req) {
  const auth = req.headers.authorization || '';
  const q = (req.query && req.query.secret) || '';
  if (!CRON_SECRET) return false;
  if (auth === 'Bearer ' + CRON_SECRET) return true;
  if (q === CRON_SECRET) return true;
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

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      ok: false,
      step: 'env',
      error: 'Missing Supabase env',
      urlPreview: SUPABASE_URL ? SUPABASE_URL.slice(0, 60) : null
    });
  }

  const src = (req.query && req.query.url) || '';
  const username = (req.query && req.query.username) || 'unknown';

  if (!src || !/^https?:\/\//i.test(src)) {
    return res.status(400).json({ ok: false, step: 'input', error: 'Bad url', src: src });
  }

  if (src.indexOf(SUPABASE_URL) === 0) {
    return res.status(200).json({ ok: true, url: src, skipped: true });
  }

  // --- 1) скачать картинку ---
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
        error: 'HTTP ' + imgRes.status,
        src: src
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
      error: e.message || String(e),
      src: src
    });
  }

  // --- 2) сжать ---
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

  // --- 3) залить в Storage ---
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
        detail: upText.slice(0, 250),
        urlPreview: SUPABASE_URL
      });
    }
  } catch (e) {
    return res.status(502).json({
      ok: false,
      step: 'upload',
      error: e.message || String(e),
      urlPreview: SUPABASE_URL
    });
  }

  const publicUrl = SUPABASE_URL + '/storage/v1/object/public/avatars/' + path;
  return res.status(200).json({
    ok: true,
    url: publicUrl,
    bytes: out.length
  });
}
