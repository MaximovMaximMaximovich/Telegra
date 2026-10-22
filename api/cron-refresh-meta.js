const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const BATCH_LIMIT = 80;

function unauthorized(res) {
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

function isAuthorized(req) {
  const auth = req.headers.authorization || '';
  const headerSecret = req.headers['x-cron-secret'] || '';
  const querySecret = (req.query && req.query.secret) || '';

  if (!CRON_SECRET) return false;
  if (auth === 'Bearer ' + CRON_SECRET) return true;
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
    .replace(/&#(\d+);/g, function (_, n) {
      return String.fromCharCode(parseInt(n, 10));
    })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) {
      return String.fromCharCode(parseInt(n, 16));
    });
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

  var title = null;
  var titlePatterns = [
    /class=["']tgme_page_title["'][^>]*>\s*(?:<[^>]+>\s*)*([^<]{1,200})/i,
    /tgme_page_title[^>]*>\s*(?:<span[^>]*>)?\s*([^<]{1,200})/i,
    /property=["']og:title["']\s+content=["']([^"']+)["']/i,
    /content=["']([^"']+)["']\s+property=["']og:title["']/i,
    /<title>\s*([^<]{1,200}?)\s*<\/title>/i
  ];
  for (var i = 0; i < titlePatterns.length; i++) {
    var m = html.match(titlePatterns[i]);
    if (m && m[1]) {
      title = decodeEntities(m[1].trim())
        .replace(/\s*[—|–-]\s*Telegram$/i, '')
        .replace(/^Telegram:\s*/i, '')
        .trim();
      if (isGoodTitle(title, uname)) break;
      title = null;
    }
  }

  var description = null;
  var descPatterns = [
    /class=["']tgme_page_description["'][^>]*>\s*([\s\S]*?)<\//i,
    /property=["']og:description["']\s+content=["']([^"']+)["']/i,
    /content=["']([^"']+)["']\s+property=["']og:description["']/i
  ];
  for (var j = 0; j < descPatterns.length; j++) {
    var dm = html.match(descPatterns[j]);
    if (dm && dm[1]) {
      var d = dm[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      d = decodeEntities(d);
      if (d && d.length >= 3 && !/^If you have.?Telegram/i.test(d)) {
        description = d.slice(0, 500);
        break;
      }
    }
  }

  var avatar = null;
  var avatarPatterns = [
    /<img[^>]+class=["'][^"']*tgme_page_photo_image[^"']*["'][^>]+src=["']([^"']+)["']/i,
    /<img[^>]+src=["']([^"']+)["'][^>]+class=["'][^"']*tgme_page_photo_image[^"']*["']/i,
    /background-image:\s*url\(['"]?(https?:\/\/cdn\d*\.telesco\.pe\/[^'")\s]+)/i,
    /property=["']og:image["']\s+content=["']([^"']+)["']/i,
    /content=["']([^"']+)["']\s+property=["']og:image["']/i,
    /(https?:\/\/cdn\d*\.telesco\.pe\/file\/[A-Za-z0-9_\-\/]+\.(?:jpg|jpeg|png|webp))/i
  ];
  for (var k = 0; k < avatarPatterns.length; k++) {
    var am = html.match(avatarPatterns[k]);
    if (am && am[1]) {
      var a = decodeEntities(am[1].trim());
      if (a.indexOf('//') === 0) a = 'https:' + a;
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
    avatar: avatar || null
  };
}

async function fetchTgMetaServer(username) {
  var uname = normalizeUsername(username);
  if (!uname) return null;

  var targets = [
    'https://t.me/' + uname,
    'https://t.me/s/' + uname
  ];

  for (var t = 0; t < targets.length; t++) {
    try {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 12000);
      var res = await fetch(targets[t], {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TelegraCron/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
        },
        redirect: 'follow'
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      var html = await res.text();
      var meta = parseMeta(html, uname);
      if (meta && (meta.avatar || meta.title || meta.description)) {
        if (!meta.avatar || isBadAvatar(meta.avatar)) {
          meta.avatar = 'https://unavatar.io/telegram/' + encodeURIComponent(uname);
        }
        if (!isGoodTitle(meta.title, uname)) {
          meta.title = null;
        }
        return meta;
      }
    } catch (e) {}
  }

  return {
    title: null,
    description: null,
    avatar: 'https://unavatar.io/telegram/' + encodeURIComponent(uname)
  };
}

function isWeakAvatar(url) {
  if (!url) return true;
  if (/unavatar\.io/i.test(url)) return true;
  if (/telesco\.pe|cdn\d*\.telegram/i.test(url)) return true;
  if (/t_logo|favicon|telegram\.org\/img/i.test(url)) return true;
  return false;
}

async function supabaseRequest(path, options) {
  options = options || {};
  var headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
    Prefer: options.prefer || 'return=representation'
  };
  if (options.headers) {
    for (var key in options.headers) {
      headers[key] = options.headers[key];
    }
  }

  var res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: options.method || 'GET',
    headers: headers,
    body: options.body || undefined
  });

  var text = await res.text();
  var data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = text;
  }
  if (!res.ok) {
    var msg = typeof data === 'object' ? JSON.stringify(data) : String(data);
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
      error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'
    });
  }

  try {
    var rows = await supabaseRequest(
      'items?select=id,username,type,display_name,description,avatar_url,is_private' +
      '&is_private=eq.false' +
      '&username=not.is.null' +
      '&order=created_at.desc' +
      '&limit=400'
    );

    var all = Array.isArray(rows) ? rows : [];
    var list = [];
    for (var i = 0; i < all.length; i++) {
      var it = all[i];
      if (!it.username || it.is_private) continue;
      if (isWeakAvatar(it.avatar_url) || !it.display_name || !it.description) {
        list.push(it);
      }
      if (list.length >= BATCH_LIMIT) break;
    }

    var updated = 0;
    var skipped = 0;
    var failed = 0;
    var errors = [];

    for (var n = 0; n < list.length; n++) {
      var item = list[n];
      try {
        var meta = await fetchTgMetaServer(item.username);
        if (!meta) {
          skipped++;
          continue;
        }

        var patch = {};
        if (meta.avatar) patch.avatar_url = meta.avatar;
        if (meta.title) patch.display_name = meta.title;
        if (meta.description) patch.description = meta.description;

        if (!patch.avatar_url && !patch.display_name && !patch.description) {
          skipped++;
          continue;
        }

        await supabaseRequest('items?id=eq.' + encodeURIComponent(item.id), {
          method: 'PATCH',
          body: JSON.stringify(patch),
          prefer: 'return=minimal'
        });
        updated++;
      } catch (e) {
        failed++;
        if (errors.length < 8) {
          errors.push({
            username: item.username,
            error: e.message || String(e)
          });
        }
      }
      await new Promise(function (r) { setTimeout(r, 250); });
    }

    return res.status(200).json({
      ok: true,
      checked: list.length,
      updated: updated,
      skipped: skipped,
      failed: failed,
      errors: errors,
      at: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message || String(e)
    });
  }
}
