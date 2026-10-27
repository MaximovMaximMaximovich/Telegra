const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_KEY = (
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''
).trim();

const SITE_URL = (process.env.SITE_URL || 'https://телегра.site').replace(/\/+$/, '');
const SITE_NAME = 'Телегра';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function typeLabel(t) {
  if (t === 'chat') return 'Чат';
  if (t === 'bot') return 'Бот';
  return 'Канал';
}

function truncate(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trim() + '…';
}

function isActiveTop(row) {
  if (!row || !row.is_top) return false;
  if (!row.top_until) return true;
  try {
    return new Date(row.top_until).getTime() > Date.now();
  } catch (e) {
    return !!row.is_top;
  }
}

function letterFallback(name) {
  const s = String(name || '?').replace(/^@/, '').trim();
  return (s[0] || '?').toUpperCase();
}

const EYE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>' +
  '<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>' +
  '<path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>' +
  '<line x1="1" y1="1" x2="23" y2="23"/>' +
  '</svg>';

function heroAvatar(url, name, isPrivate) {
  if (isPrivate) {
    return '<div class="hero-avatar fallback eye-slash" title="Приватный">' + EYE_SVG + '</div>';
  }
  const letter = escapeHtml(letterFallback(name));
  if (url && /^https?:\/\//i.test(String(url))) {
    return (
      '<img class="hero-avatar" src="' +
      escapeHtml(url) +
      '" alt="' +
      escapeHtml(name || '') +
      '" width="96" height="96" referrerpolicy="no-referrer">'
    );
  }
  return '<div class="hero-avatar fallback">' + letter + '</div>';
}

function cardAvatar(url, name, isPrivate) {
  if (isPrivate) {
    return '<span class="ph ph-eye" title="Приватный">' + EYE_SVG + '</span>';
  }
  const letter = escapeHtml(letterFallback(name));
  if (url && /^https?:\/\//i.test(String(url))) {
    return (
      '<img src="' +
      escapeHtml(url) +
      '" alt="" width="40" height="40" loading="lazy" referrerpolicy="no-referrer">'
    );
  }
  return '<span class="ph">' + letter + '</span>';
}

async function sbFetch(qs) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const res = await fetch(SUPABASE_URL + '/rest/v1/items?' + qs, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      Accept: 'application/json'
    }
  });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function fetchItemByUsername(username) {
  const qs =
    'select=id,username,type,display_name,description,category,avatar_url,is_private,invite_link,is_top,top_until,created_at' +
    '&username=eq.' +
    encodeURIComponent(username) +
    '&is_private=eq.false&limit=1';
  const rows = await sbFetch(qs);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function fetchItemById(id) {
  const qs =
    'select=id,username,type,display_name,description,category,avatar_url,is_private,invite_link,is_top,top_until,created_at' +
    '&id=eq.' +
    encodeURIComponent(id) +
    '&limit=1';
  const rows = await sbFetch(qs);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function fetchSimilar(category, excludeUsername, excludeId, limit) {
  if (!category) return [];
  let qs =
    'select=id,username,display_name,type,avatar_url,category,is_top,top_until,is_private,invite_link' +
    '&category=eq.' +
    encodeURIComponent(category) +
    '&is_private=eq.false&order=created_at.desc&limit=' +
    (limit || 8);
  if (excludeUsername) {
    qs += '&username=neq.' + encodeURIComponent(excludeUsername);
  }
  const rows = await sbFetch(qs);
  if (!Array.isArray(rows)) return [];
  if (excludeId) {
    return rows.filter(function (r) {
      return String(r.id) !== String(excludeId);
    });
  }
  return rows;
}

async function fetchTopItems(excludeUsername, excludeId, limit) {
  limit = limit || 8;
  const qs =
    'select=id,username,display_name,type,avatar_url,category,is_top,top_until,is_private,invite_link' +
    '&is_top=eq.true&order=created_at.desc&limit=50';
  const rows = await sbFetch(qs);
  if (!Array.isArray(rows)) return [];
  const ex = String(excludeUsername || '').toLowerCase();
  const exId = excludeId ? String(excludeId) : '';
  return rows
    .filter(function (r) {
      if (!isActiveTop(r)) return false;
      if (exId && String(r.id) === exId) return false;
      if (ex && r.username && String(r.username).toLowerCase() === ex) return false;
      if (r.is_private && !r.invite_link && !r.id) return false;
      return true;
    })
    .slice(0, limit);
}

function catalogHref(s) {
  if (s && s.is_private && s.id) return '/p/' + encodeURIComponent(s.id);
  if (s && s.username) return '/c/' + encodeURIComponent(s.username);
  if (s && s.id) return '/p/' + encodeURIComponent(s.id);
  return '#';
}

function cardHtml(s, forceTop) {
  const isTop = !!forceTop || isActiveTop(s);
  const isPrivate = !!(s && s.is_private);
  const display =
    s.display_name ||
    (isPrivate ? 'Приватный канал' : '@' + (s.username || ''));
  const sn = escapeHtml(display);
  const href = catalogHref(s);
  const av = cardAvatar(s.avatar_url, display, isPrivate);
  const topBadge = isTop ? '<span class="sim-top-badge">Топ</span>' : '';
  const privMark = isPrivate ? ' · Приват' : '';
  const cls = isTop ? 'sim-card sim-card-top' : 'sim-card';
  return (
    '<a class="' +
    cls +
    '" href="' +
    escapeHtml(href) +
    '">' +
    '<div class="sim-av">' +
    av +
    '</div>' +
    '<div class="sim-name">' +
    sn +
    '</div>' +
    '<div class="sim-type">' +
    escapeHtml(typeLabel(s.type)) +
    (isTop ? ' · Топ' : '') +
    privMark +
    '</div>' +
    topBadge +
    '</a>'
  );
}

function renderNotFound(res, label) {
  const html =
    '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Не найдено — ' +
    escapeHtml(SITE_NAME) +
    '</title><meta name="robots" content="noindex, follow">' +
    '<style>body{font-family:system-ui,sans-serif;background:#f7f5f0;text-align:center;padding:40px}' +
    'a{color:#2c5f4e}.box{max-width:480px;margin:40px auto;background:#fff;border:1px solid #e8e4dc;' +
    'border-radius:16px;padding:32px}</style></head><body><div class="box"><h1>Не найдено</h1>' +
    '<p>Запись «' +
    escapeHtml(label || '') +
    '» отсутствует.</p><p><a href="/">← На главную</a></p></div></body></html>';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=60');
  return res.status(404).send(html);
}

async function handler(req, res) {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return res.status(405).send('Method not allowed');
    }

    const q = req.query || {};
    const idParam = String(q.id || '').trim();
    const username = normalizeUsername(q.username || q.u || '');

    let item = null;
    if (idParam) {
      item = await fetchItemById(idParam);
    } else if (username && username.length >= 3) {
      item = await fetchItemByUsername(username);
    }

    if (!item) {
      return renderNotFound(res, idParam || username);
    }

    const isPrivate = !!item.is_private;
    const name =
      item.display_name ||
      (isPrivate ? 'Приватный канал' : '@' + (item.username || ''));
    const desc = item.description || '';
    const cat = item.category || 'Разное';
    const type = typeLabel(item.type);
    const tgLink =
      isPrivate && item.invite_link
        ? item.invite_link
        : item.username
          ? 'https://t.me/' + item.username
          : item.invite_link || '/';
    const avatar = item.avatar_url || '';
    const pageUrl =
      isPrivate || !item.username
        ? SITE_URL + '/p/' + encodeURIComponent(item.id)
        : SITE_URL + '/c/' + encodeURIComponent(item.username);
    const created = item.created_at
      ? new Date(item.created_at).toLocaleDateString('ru-RU')
      : '';
    const itemIsTop = isActiveTop(item);

    const pair = await Promise.all([
      fetchSimilar(item.category, item.username || '', item.id, 8),
      fetchTopItems(item.username || '', item.id, 8)
    ]);
    const similar = pair[0] || [];
    const topItems = pair[1] || [];

    const metaDesc = truncate(
      desc ||
        (isPrivate ? 'Приватный ' : '') +
          type +
          ' «' +
          name +
          '» в каталоге ' +
          SITE_NAME +
          '. Категория: ' +
          cat +
          '.',
      160
    );
    const pageTitle = truncate(
      name +
        ' — ' +
        (isPrivate ? 'приватный ' : '') +
        type +
        ' в каталоге ' +
        SITE_NAME,
      70
    );

    let similarHtml = '';
    if (similar.length) {
      similarHtml =
        '<section class="similar"><h2>Похожие в категории «' +
        escapeHtml(cat) +
        '»</h2><div class="sim-grid">' +
        similar
          .map(function (s) {
            return cardHtml(s, isActiveTop(s));
          })
          .join('') +
        '</div></section>';
    }

    let topHtml = '';
    if (topItems.length) {
      topHtml =
        '<section class="similar top-section-page"><h2>Топ в каталоге</h2>' +
        '<p class="top-hint">Выделенные размещения — сейчас в Топе на главной</p>' +
        '<div class="sim-grid">' +
        topItems
          .map(function (s) {
            return cardHtml(s, true);
          })
          .join('') +
        '</div></section>';
    }

    const avatarBlock = heroAvatar(avatar, name, isPrivate);

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: name,
      description: metaDesc,
      url: pageUrl,
      isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE_URL }
    };

    const html =
      '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>' +
      escapeHtml(pageTitle) +
      '</title>' +
      '<meta name="description" content="' +
      escapeHtml(metaDesc) +
      '">' +
      '<meta name="robots" content="index, follow">' +
      '<link rel="canonical" href="' +
      escapeHtml(pageUrl) +
      '">' +
      '<meta property="og:type" content="website">' +
      '<meta property="og:locale" content="ru_RU">' +
      '<meta property="og:site_name" content="' +
      escapeHtml(SITE_NAME) +
      '">' +
      '<meta property="og:title" content="' +
      escapeHtml(pageTitle) +
      '">' +
      '<meta property="og:description" content="' +
      escapeHtml(metaDesc) +
      '">' +
      '<meta property="og:url" content="' +
      escapeHtml(pageUrl) +
      '">' +
      '<meta name="theme-color" content="#2c5f4e">' +
      '<link rel="icon" href="/favicon.svg" type="image/svg+xml">' +
      '<script type="application/ld+json">' +
      JSON.stringify(jsonLd).replace(/</g, '\\u003c') +
      '</script>' +
      '<style>' +
      ':root{--bg:#f7f5f0;--card:#fff;--text:#1a1a1a;--muted:#6b6b6b;--border:#e8e4dc;--accent:#2c5f4e;--soft:#f3f0ea;--top-bg:#fffcf5;--top-border:#e0d0a8;--top-text:#7a5c20}' +
      '*{box-sizing:border-box;margin:0;padding:0}' +
      'body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.55;min-height:100vh;padding:24px 16px 48px}' +
      '.wrap{max-width:720px;margin:0 auto}' +
      '.nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;font-size:.9rem}' +
      '.nav a{color:var(--accent);text-decoration:none;font-weight:600}' +
      '.crumbs{color:var(--muted);font-size:.82rem;margin-bottom:16px}' +
      '.crumbs a{color:var(--muted)}' +
      '.card{background:var(--card);border:1px solid var(--border);border-radius:20px;padding:28px 24px;box-shadow:0 4px 20px rgba(0,0,0,.04)}' +
      '.card.is-top{border-color:var(--top-border);background:linear-gradient(180deg,#fffcf5 0%,#fff 55%)}' +
      '.hero{display:flex;gap:20px;align-items:center;margin-bottom:20px}' +
      '.hero-avatar{width:96px;height:96px;border-radius:50%;object-fit:cover;border:3px solid #fff;box-shadow:0 4px 14px rgba(0,0,0,.1);flex-shrink:0}' +
      '.hero-avatar.fallback{display:flex;align-items:center;justify-content:center;background:var(--accent);color:#fff;font-size:2rem;font-weight:700}' +
      '.hero-avatar.fallback.eye-slash{background:#5a6570;color:#e8ecf0}' +
      'h1{font-size:1.75rem;line-height:1.25;margin-bottom:6px}' +
      '.badges{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:4px}' +
      '.badge{font-size:.72rem;font-weight:600;text-transform:uppercase;padding:4px 10px;border-radius:8px;background:var(--soft);color:var(--muted);border:1px solid var(--border)}' +
      '.badge.accent{background:#e8f0ed;color:var(--accent);border-color:#c5d9d0}' +
      '.badge.top{background:#f5efe0;color:var(--top-text);border-color:var(--top-border)}' +
      '.badge.private{background:#f0e8f5;color:#6b4a7a;border-color:#d4c4e0}' +
      '.username{color:var(--muted);font-size:.95rem;margin-bottom:16px}' +
      '.desc{font-size:1.02rem;color:#333;margin-bottom:22px;white-space:pre-wrap;word-break:break-word}' +
      '.actions{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:8px}' +
      '.btn{display:inline-flex;align-items:center;justify-content:center;padding:12px 20px;border-radius:12px;font-weight:600;font-size:.95rem;text-decoration:none}' +
      '.btn-primary{background:var(--accent);color:#fff}' +
      '.btn-ghost{background:var(--soft);color:var(--text);border:1px solid var(--border)}' +
      '.meta-line{margin-top:18px;padding-top:16px;border-top:1px solid var(--border);font-size:.82rem;color:var(--muted)}' +
      '.similar{margin-top:32px}' +
      '.similar h2{font-size:1.25rem;margin-bottom:8px}' +
      '.top-hint{font-size:.85rem;color:var(--top-text);margin:-2px 0 14px}' +
      '.sim-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px}' +
      '.sim-card{position:relative;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px 12px;text-decoration:none;color:var(--text);text-align:center}' +
      '.sim-card-top{background:var(--top-bg);border-color:var(--top-border)}' +
      '.sim-top-badge{position:absolute;top:8px;right:8px;font-size:.62rem;font-weight:700;text-transform:uppercase;padding:2px 7px;border-radius:6px;background:#f5efe0;color:var(--top-text);border:1px solid var(--top-border)}' +
      '.sim-av{width:48px;height:48px;margin:0 auto 8px;border-radius:50%;overflow:hidden;background:var(--accent)}' +
      '.sim-av img{width:100%;height:100%;object-fit:cover}' +
      '.sim-av .ph{display:flex;width:100%;height:100%;align-items:center;justify-content:center;color:#fff;font-weight:700}' +
      '.sim-av .ph-eye{display:flex;width:100%;height:100%;align-items:center;justify-content:center;color:#e8ecf0;background:#5a6570}' +
      '.sim-av .ph-eye svg{width:22px;height:22px}' +
      '.sim-name{font-weight:600;font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.sim-type{font-size:.72rem;color:var(--muted);margin-top:2px}' +
      'footer{margin-top:40px;text-align:center;font-size:.8rem;color:var(--muted)}' +
      'footer a{color:var(--muted)}' +
      '@media(max-width:520px){.hero{flex-direction:column;text-align:center}.badges,.actions{justify-content:center}}' +
      '</style></head><body><div class="wrap">' +
      '<div class="nav"><a href="/">← ' +
      escapeHtml(SITE_NAME) +
      '</a><a href="/#add">Добавить канал</a></div>' +
      '<nav class="crumbs"><a href="/">Главная</a> · <a href="/?cat=' +
      encodeURIComponent(cat) +
      '">' +
      escapeHtml(cat) +
      '</a> · <span>' +
      escapeHtml(name) +
      '</span></nav>' +
      '<article class="card' +
      (itemIsTop ? ' is-top' : '') +
      '"><div class="hero">' +
      avatarBlock +
      '<div><div class="badges">' +
      '<span class="badge accent">' +
      escapeHtml(type) +
      '</span><span class="badge">' +
      escapeHtml(cat) +
      '</span>' +
      (isPrivate ? '<span class="badge private">Приватный</span>' : '') +
      (itemIsTop ? '<span class="badge top">Топ</span>' : '') +
      '</div><h1>' +
      escapeHtml(name) +
      '</h1><div class="username">' +
      (isPrivate
        ? 'Приватная ссылка-приглашение'
        : '@' + escapeHtml(item.username || '')) +
      '</div></div></div>' +
      (desc
        ? '<div class="desc">' + escapeHtml(desc) + '</div>'
        : '<div class="desc" style="color:var(--muted)">Описание пока не указано.</div>') +
      '<div class="actions">' +
      '<a class="btn btn-primary" href="' +
      escapeHtml(tgLink) +
      '" rel="noopener nofollow" target="_blank">' +
      (isPrivate ? 'Вступить в Telegram' : 'Открыть в Telegram') +
      '</a>' +
      '<a class="btn btn-ghost" href="/">Смотреть каталог</a></div>' +
      '<div class="meta-line">Страница в каталоге ' +
      escapeHtml(SITE_NAME) +
      (created ? ' · добавлено ' + escapeHtml(created) : '') +
      ' · не является официальной страницей Telegram</div></article>' +
      topHtml +
      similarHtml +
      '<footer><a href="/">' +
      escapeHtml(SITE_NAME) +
      '</a> — каталог Telegram-каналов, чатов и ботов</footer>' +
      '</div></body></html>';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return res.status(200).send(html);
  } catch (e) {
    console.error('channel-page error', e);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res
      .status(500)
      .send(
        '<h1>Ошибка</h1><p>' +
          escapeHtml((e && e.message) || 'unknown') +
          '</p><p><a href="/">На главную</a></p>'
      );
  }
}

export default handler;
