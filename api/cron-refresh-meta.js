const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// За одну ночь обновляем ограниченную пачку (чтобы не поймать timeout)
const BATCH_LIMIT = 80;

function unauthorized(res) {
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

function isAuthorized(req) {
  const auth = req.headers.authorization || '';
  const headerSecret = req.headers['x-cron-secret'] || '';
  const querySecret = req.query && req.query.secret;

  if (!CRON_SECRET) return false;
  if (auth === Bearer ${CRON_SECRET}) return true;
  if (headerSecret === CRON_SECRET) return true;
  if (querySecret === CRON_SECRET) return true;
  return false;
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

function decodeEntities(s) {
  if (!s) return s;
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function isBadAvatar(url) {
  if (!url) return true;
  return /telegram\.org|t_logo|favicon|img\/Telegram|\/img\/t_logo|telegram_logo/i.test(url);
}

function isGoodTitle(t, uname) {
  if (!t) return false;
  const s = String(t).trim();
  if (!s || s.length < 1) return false;
  if (/^Telegram$/i.test(s)) return false;
  if (s === '@' + uname || s.toLowerCase() === uname.toLowerCase()) return false;
  return true;
}

function parseMeta(html, uname) {
  if (!html || html.length < 80) return null;
  if (/tgme_page_error|icon-error|doesn.?t seem to exist|page is unavailable/i.test(html)) {
    return null;
  }

  let title = null;
  const titlePatterns = [
    /class=["']tgme_page_title["'][^>]*>\s*(?:<[^>]+>\s*)*([^<]{1,200})/i,
    /tgme_page_title[^>]*>\s*(?:<span[^>]*>)?\s*([^<]{1,200})/i,
    /property=["']og:title["']\s+content=["']([^"']+)["']/i,
    /content=["']([^"']+)["']\s+property=["']og:title["']/i,
    /<title>\s*([^<]{1,200}?)\s*<\/title>/i,
  ];
  for (const re of titlePatterns) {
    const m = html.match(re);
    if (m && m[1]) {
      title = decodeEntities(m[1].trim())
        .replace(/\s*[—|–-]\s*Telegram$/i, '')
        .replace(/^Telegram:\s*/i, '')
        .trim();
      if (isGoodTitle(title, uname)) break;
      title = null;
    }
  }

  let description = null;
  const descPatterns = [
    /class=["']tgme_page_description["'][^>]*>\s*([\s\S]*?)<\//i,
    /property=["']og:description["']\s+content=["']([^"']+)["']/i,
    /content=["']([^"']+)["']\s+property=["']og:description["']/i,
  ];
  for (const re of descPatterns) {
    const m = html.match(re);
    if (m && m[1]) {
      let d = m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      d = decodeEntities(d);
      if (d && d.length >= 3 && !/^If you have.?Telegram/i.test(d)) {
        description = d.slice(0, 500);
        break;
      }
    }
  }

  let avatar = null;
  const avatarPatterns = [
    /<img[^>]+class=["'][^"']*tgme_page_photo_image[^"']*["'][^>]+src=["']([^"']+)["']/i,
    /<img[^>]+src=["']([^"']+)["'][^>]+class=["'][^"']*tgme_page_photo_image[^"']*["']/i,
    /background-image:\s*url\(['"]?(https?:\/\/cdn\d*\.telesco\.pe\/[^'")\s]+)/i,
    /property=["']og:image["']\s+content=["']([^"']+)["']/i,
    /content=["']([^"']+)["']\s+property=["']og:image["']/i,
    /(https?:\/\/cdn\d*\.telesco\.pe\/file\/[A-Za-z0-9_\-\/]+\.(?:jpg|jpeg|png|webp))/i,
  ];
  for (const re of avatarPatterns) {
    const m = html.match(re);
    if (m && m[1]) {
      let a = decodeEntities(m[1].trim());
      if (a.startsWith('//')) a = 'https:' + a;
      if (!isBadAvatar(a) && /^https?:\/\//i.test(a)) {
        avatar = a;
        break;
      }
    }
  }

  if (!title && !avatar && !description) return null;
  return {
    title: title || null,
    description: description || null,
    avatar: avatar || null,
  };
}

async function fetchTgMetaServer(username) {
  const uname = normalizeUsername(username);
  if (!uname) return null;

  const targets = [
    'https://t.me/' + uname,
    'https://t.me/s/' + uname,
  ];

  for (const target of targets) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(target, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TelegraCron/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        },
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const html = await res.text();
      const meta = parseMeta(html, uname);
      if (meta && (meta.avatar  meta.title  meta.description)) {
        // Если с CDN не вышло — стабильный запасной вариант для публичных
        if (!meta.avatar || isBadAvatar(meta.avatar)) {
          meta.avatar = 'https://unavatar.io/telegram/' + encodeURIComponent(uname);
        }
        if (!isGoodTitle(meta.title, uname)) {
          meta.title = null;
        }
        return meta;
      }
    } catch (e) {
      // пробуем следующий URL
    }
  }

  // совсем пусто — хотя бы unavatar
  return {
    title: null,
    description: null,
    avatar: 'https://unavatar.io/telegram/' + encodeURIComponent(uname),
  };
}

function isWeakAvatar(url) {
  if (!url) return true;
  if (/unavatar\.io/i.test(url)) return true;
  if (/telesco\.pe|cdn\d*\.telegram/i.test(url)) return true;
  if (/t_logo|favicon|telegram\.org\/img/i.test(url)) return true;
  return false;
}

async function supabaseRequest(path, options = {}) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = text;
  }
  if (!res.ok) {
    const msg = typeof data === 'object' ? JSON.stringify(data) : String(data);
    throw new Error('Supabase ' + res.status + ': ' + msg);
  }
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!isAuthorized(req)) {
    return unauthorized(res);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY',
    });
  }

  try {
    // Берём публичные записи; приоритет — слабые/протухающие аватарки
    // (простая выборка последних + фильтр на стороне кода)
    const rows = await supabaseRequest(
      'items?select=id,username,type,display_name,description,avatar_url,is_private' +
        '&is_private=eq.false' +
        '&username=not.is.null' +
        '&order=created_at.desc' +
        '&limit=400'
    );

    const list = (Array.isArray(rows) ? rows : [])
      .filter((it) => it.username && !it.is_private)
      .filter((it) => isWeakAvatar(it.avatar_url)  !it.display_name  !it.description)
      .slice(0, BATCH_LIMIT);

    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];

    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      try {
        const meta = await fetchTgMetaServer(item.username);
        if (!meta) {
          skipped++;
          continue;
        }
