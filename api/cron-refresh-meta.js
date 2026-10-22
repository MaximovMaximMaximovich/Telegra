const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const CRON_SECRET = (process.env.CRON_SECRET || '').trim();
const BATCH_LIMIT = 40;

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
    .replace(/&gt;/g, '>');
}

function isBadAvatar(url) {
  if (!url) return true;
  return /telegram\.org|t_logo|favicon|telegram_logo/i.test(url);
}

function isGoodTitle(t, uname) {
  if (!t) return false;
  const s = String(t).trim();
  if (!s) return false;
  if (/^Telegram$/i.test(s)) return false;
  if (s === '@' + uname || s.toLowerCase() === uname.toLowerCase()) return false;
  return true;
}

function parseMeta(html, uname) {
  if (!html || html.length < 80) return null;
  if (/tgme_page_error|doesn.?t seem to exist|page is unavailable/i.test(html)) return null;

  var title = null;
  var tm =
    html.match(/class=["']tgme_page_title["'][^>]*>\s*(?:<[^>]+>\s*)*([^<]{1,200})/i) ||
    html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
    html.match(/content=["']([^"']+)["']\s+property=["']og:title["']/i);
  if (tm && tm[1]) {
    title = decodeEntities(tm[1].trim())
      .replace(/\s*[—|–-]\s*Telegram$/i, '')
      .replace(/^Telegram:\s*/i, '')
      .trim();
    if (!isGoodTitle(title, uname)) title = null;
  }

  var description = null;
  var dm =
    html.match(/class=["']tgme_page_description["'][^>]*>\s*([\s\S]*?)<\//i) ||
    html.match(/property=["']og:description["']\s+content=["']([^"']+)["']/i);
  if (dm && dm[1]) {
    var d = decodeEntities(dm[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (d && d.length >= 3 && !/^If you have.?Telegram/i.test(d)) {
      description = d.slice(0, 500);
    }
  }

  var avatar = null;
  var am =
    html.match(/<img[^>]+class=["'][^"']*tgme_page_photo_image[^"']*["'][^>]+src=["']([^"']+)["']/i) ||
    html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
    html.match(/(https?:\/\/cdn\d*\.telesco\.pe\/file\/[A-Za-z0-9_\-\/]+)/i);
  if (am && am[1]) {
    var a = decodeEntities(am[1].trim());
    if (a.indexOf('//') === 0) a = 'https:' + a;
    if (!isBadAvatar(a)) avatar = a;
  }

  if (!title && !avatar && !description) return null;
  return { title: title, description: description, avatar: avatar };
}

async function fetchTgMetaServer(username) {
  var uname = normalizeUsername(username);
  if (!uname) return null;
  var targets = ['https://t.me/' + uname, 'https://t.me/s/' + uname];

  for (var i = 0; i < targets.length; i++) {
    try {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 10000);
      var res = await fetch(targets[i], {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TelegraCron/1.0)',
          Accept: 'text/html'
        }
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      var html = await res.text();
      var meta = parseMeta(html, uname);
      if (meta && (meta.avatar || meta.title || meta.description)) {
        if (!meta.avatar || isBadAvatar(meta.avatar)) {
          meta.avatar = 'https://unavatar.io/telegram/' + encodeURIComponent(uname);
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
  if (/telesco\.pe/i.test(url)) return true;
  if (/t_logo|favicon|telegram\.org/i.test(url)) return true;
  return false;
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
      error: 'Missing env',
      hasUrl: !!SUPABASE_URL,
      hasKey: !!SUPABASE_SERVICE_ROLE_KEY,
      urlPreview: SUPABASE_URL ? SUPABASE_URL.slice(0, 40) : null
    });
  }

  if (SUPABASE_URL.indexOf('https://') !== 0 || SUPABASE_URL.indexOf('supabase.co') === -1) {
    return res.status(500).json({
      ok: false,
      error: 'SUPABASE_URL looks invalid',
      urlPreview: SUPABASE_URL.slice(0, 80)
    });
  }

  try {
    var listUrl =
      SUPABASE_URL +
      '/rest/v1/items?select=id,username,display_name,description,avatar_url,is_private' +
      '&is_private=eq.false&username=not.is.null&order=created_at.desc&limit=300';

    var listRes = await fetch(listUrl, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
        Accept: 'application/json'
      }
    });

    var listText = await listRes.text();
    if (!listRes.ok) {
      return res.status(500).json({
        ok: false,
        error: 'Supabase list failed',
        status: listRes.status,
        body: listText.slice(0, 300),
        urlPreview: SUPABASE_URL
      });
    }

    var rows = [];
    try {
      rows = JSON.parse(listText);
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Bad JSON from Supabase', body: listText.slice(0, 200) });
    }
    if (!Array.isArray(rows)) rows = [];

    var list = [];
    for (var i = 0; i < rows.length; i++) {
      var it = rows[i];
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

        var patchRes = await fetch(
          SUPABASE_URL + '/rest/v1/items?id=eq.' + encodeURIComponent(item.id),
          {
            method: 'PATCH',
            headers: {
              apikey: SUPABASE_SERVICE_ROLE_KEY,
              Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal'
            },
            body: JSON.stringify(patch)
          }
        );

        if (!patchRes.ok) {
          var errText = await patchRes.text();
          throw new Error('PATCH ' + patchRes.status + ': ' + errText.slice(0, 120));
        }
        updated++;
      } catch (e) {
        failed++;
        if (errors.length < 5) {
          errors.push({ username: item.username, error: e.message || String(e) });
        }
      }
      await new Promise(function (r) { setTimeout(r, 200); });
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
      error: e.message || String(e),
      urlPreview: SUPABASE_URL
    });
  }
}
