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

async function fetchItem(username) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const qs =
    'select=id,username,type,display_name,description,category,avatar_url,is_private,invite_link,is_top,top_until,created_at' +
    '&username=eq.' + encodeURIComponent(username) +
    '&is_private=eq.false' +
    '&limit=1';
  const res = await fetch(SUPABASE_URL + '/rest/v1/items?' + qs, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      Accept: 'application/json'
    }
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function fetchSimilar(category, username, limit) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !category) return [];
  const qs =
    'select=username,display_name,type,avatar_url,category' +
    '&category=eq.' + encodeURIComponent(category) +
    '&username=neq.' + encodeURIComponent(username) +
    '&is_private=eq.false' +
    '&order=created_at.desc' +
    '&limit=' + (limit || 6);
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/items?' + qs, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        Accept: 'application/json'
      }
    });
    if (!res.ok) return [];
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    return [];
  }
}

function renderNotFound(res, username) {
  const title = 'Канал не найден — ' + SITE_NAME;
  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="robots" content="noindex, follow">
  <link rel="canonical" href="${escapeHtml(SITE_URL)}/">
  <style>
    body{font-family:system-ui,sans-serif;background:#f7f5f0;color:#1a1a1a;margin:0;padding:40px 20px;text-align:center}
    a{color:#2c5f4e}
    .box{max-width:480px;margin:40px auto;background:#fff;border:1px solid #e8e4dc;border-radius:16px;padding:32px}
  </style>
</head>
<body>
  <div class="box">
    <h1>Не найдено</h1>
    <p>Запись «${escapeHtml(username || '')}» в каталоге отсутствует или скрыта.</p>
    <p><a href="/">← На главную Телегра</a></p>
  </div>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  return res.status(404).send(html);
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).send('Method not allowed');
  }

  const username = normalizeUsername(
    (req.query && (req.query.username || req.query.u)) || ''
  );

  if (!username || username.length < 3) {
    return renderNotFound(res, username);
  }

  let item;
  try {
    item = await fetchItem(username);
  } catch (e) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(502).send('<h1>Временная ошибка</h1><p><a href="/">На главную</a></p>');
  }

  if (!item || !item.username) {
    return renderNotFound(res, username);
  }

  const similar = await fetchSimilar(item.category, item.username, 6);

  const name = item.display_name || ('@' + item.username);
  const desc = item.description || '';
  const cat = item.category || 'Разное';
  const type = typeLabel(item.type);
  const tgLink = item.is_private && item.invite_link
    ? item.invite_link
    : ('https://t.me/' + item.username);
  const avatar = item.avatar_url || '';
  const pageUrl = SITE_URL + '/c/' + encodeURIComponent(item.username);
  const created = item.created_at
    ? new Date(item.created_at).toLocaleDateString('ru-RU')
    : '';

  const metaDesc = truncate(
    (desc || (type + ' «' + name + '» в каталоге ' + SITE_NAME + '. Категория: ' + cat + '.')) ,
    160
  );
  const pageTitle = truncate(name + ' — ' + type + ' в каталоге ' + SITE_NAME, 70);

  const similarHtml = similar.length
    ? `<section class="similar">
        <h2>Похожие в категории «${escapeHtml(cat)}»</h2>
        <div class="sim-grid">
          ${similar.map(function (s) {
            const sn = escapeHtml(s.display_name || ('@' + s.username));
            const su = encodeURIComponent(s.username || '');
            const av = s.avatar_url
              ? `<img src="${escapeHtml(s.avatar_url)}" alt="" width="40" height="40" loading="lazy" referrerpolicy="no-referrer">`
              : `<span class="ph">${escapeHtml((s.display_name || s.username || '?')[0] || '?')}</span>`;
            return `<a class="sim-card" href="/c/${su}">
              <div class="sim-av">${av}</div>
              <div class="sim-name">${sn}</div>
              <div class="sim-type">${escapeHtml(typeLabel(s.type))}</div>
            </a>`;
          }).join('')}
        </div>
      </section>`
    : '';

  const avatarBlock = avatar
    ? `<img class="hero-avatar" src="${escapeHtml(avatar)}" alt="${escapeHtml(name)}" width="96" height="96" referrerpolicy="no-referrer">`
    : `<div class="hero-avatar fallback">${escapeHtml((name.replace(/^@/, '')[0] || '?').toUpperCase())}</div>`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: name,
    description: metaDesc,
    url: pageUrl,
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE_URL },
    about: {
      '@type': 'Thing',
      name: name,
      description: truncate(desc, 300),
      url: tgLink
    }
  };

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(metaDesc)}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${escapeHtml(pageUrl)}">

  <meta property="og:type" content="website">
  <meta property="og:locale" content="ru_RU">
  <meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">
  <meta property="og:title" content="${escapeHtml(pageTitle)}">
  <meta property="og:description" content="${escapeHtml(metaDesc)}">
  <meta property="og:url" content="${escapeHtml(pageUrl)}">
  ${avatar ? `<meta property="og:image" content="${escapeHtml(avatar)}">` : ''}

  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${escapeHtml(pageTitle)}">
  <meta name="twitter:description" content="${escapeHtml(metaDesc)}">

  <meta name="theme-color" content="#2c5f4e">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">

  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>

  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Playfair+Display:wght@600;700&display=swap');
    :root {
      --bg: #f7f5f0; --card: #fff; --text: #1a1a1a; --muted: #6b6b6b;
      --border: #e8e4dc; --accent: #2c5f4e; --soft: #f3f0ea;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Inter, system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.55;
      min-height: 100vh;
      padding: 24px 16px 48px;
    }
    .wrap { max-width: 720px; margin: 0 auto; }
    .nav {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 24px; font-size: 0.9rem;
    }
    .nav a { color: var(--accent); text-decoration: none; font-weight: 600; }
    .nav a:hover { text-decoration: underline; }
    .crumbs { color: var(--muted); font-size: 0.82rem; margin-bottom: 16px; }
    .crumbs a { color: var(--muted); }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 28px 24px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.04);
    }
    .hero {
      display: flex; gap: 20px; align-items: center; margin-bottom: 20px;
    }
    .hero-avatar {
      width: 96px; height: 96px; border-radius: 50%;
      object-fit: cover; border: 3px solid #fff;
      box-shadow: 0 4px 14px rgba(0,0,0,0.1); flex-shrink: 0;
    }
    .hero-avatar.fallback {
      display: flex; align-items: center; justify-content: center;
      background: var(--accent); color: #fff; font-size: 2rem; font-weight: 700;
    }
    h1 {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 1.75rem; line-height: 1.25; margin-bottom: 6px;
    }
    .badges { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
    .badge {
      font-size: 0.72rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.03em; padding: 4px 10px; border-radius: 8px;
      background: var(--soft); color: var(--muted); border: 1px solid var(--border);
    }
    .badge.accent { background: #e8f0ed; color: var(--accent); border-color: #c5d9d0; }
    .username { color: var(--muted); font-size: 0.95rem; margin-bottom: 16px; }
    .desc {
      font-size: 1.02rem; color: #333; margin-bottom: 22px;
      white-space: pre-wrap; word-break: break-word;
    }
    .desc:empty { display: none; }
    .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 8px; }
    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 12px 20px; border-radius: 12px; font-weight: 600;
      font-size: 0.95rem; text-decoration: none; border: none; cursor: pointer;
    }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { filter: brightness(1.05); }
    .btn-ghost {
      background: var(--soft); color: var(--text); border: 1px solid var(--border);
    }
    .meta-line {
      margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border);
      font-size: 0.82rem; color: var(--muted);
    }
    .similar { margin-top: 32px; }
    .similar h2 {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 1.25rem; margin-bottom: 14px;
    }
    .sim-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px;
    }
    .sim-card {
      background: var(--card); border: 1px solid var(--border); border-radius: 14px;
      padding: 14px 12px; text-decoration: none; color: var(--text);
      text-align: center; transition: box-shadow 0.15s, transform 0.15s;
    }
    .sim-card:hover { box-shadow: 0 6px 16px rgba(0,0,0,0.06); transform: translateY(-2px); }
    .sim-av {
      width: 48px; height: 48px; margin: 0 auto 8px; border-radius: 50%;
      overflow: hidden; background: var(--accent);
    }
    .sim-av img { width: 100%; height: 100%; object-fit: cover; }
    .sim-av .ph {
      display: flex; width: 100%; height: 100%; align-items: center; justify-content: center;
      color: #fff; font-weight: 700;
    }
    .sim-name {
      font-weight: 600; font-size: 0.88rem;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sim-type { font-size: 0.72rem; color: var(--muted); margin-top: 2px; }
    footer {
      margin-top: 40px; text-align: center; font-size: 0.8rem; color: var(--muted);
    }
    footer a { color: var(--muted); }
    @media (max-width: 520px) {
      .hero { flex-direction: column; text-align: center; }
      .badges { justify-content: center; }
      .actions { justify-content: center; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="nav">
      <a href="/">← ${escapeHtml(SITE_NAME)}</a>
      <a href="/#add">Добавить канал</a>
    </div>

    <nav class="crumbs" aria-label="Навигация">
      <a href="/">Главная</a> ·
      <a href="/?cat=${encodeURIComponent(cat)}">${escapeHtml(cat)}</a> ·
      <span>${escapeHtml(name)}</span>
    </nav>

    <article class="card">
      <div class="hero">
        ${avatarBlock}
        <div>
          <div class="badges">
            <span class="badge accent">${escapeHtml(type)}</span>
            <span class="badge">${escapeHtml(cat)}</span>
            ${item.is_top ? '<span class="badge">Топ</span>' : ''}
          </div>
          <h1>${escapeHtml(name)}</h1>
          <div class="username">@${escapeHtml(item.username)}</div>
        </div>
      </div>

      ${desc ? `<div class="desc">${escapeHtml(desc)}</div>` : '<div class="desc" style="color:var(--muted)">Описание пока не указано.</div>'}

      <div class="actions">
        <a class="btn btn-primary" href="${escapeHtml(tgLink)}" rel="noopener nofollow" target="_blank">
          Открыть в Telegram
        </a>
        <a class="btn btn-ghost" href="/">Смотреть каталог</a>
      </div>

      <div class="meta-line">
        Страница в каталоге ${escapeHtml(SITE_NAME)}
        ${created ? ' · добавлено ' + escapeHtml(created) : ''}
        · не является официальной страницей Telegram
      </div>
    </article>

    ${similarHtml}

    <footer>
      <a href="/">${escapeHtml(SITE_NAME)}</a> — каталог Telegram-каналов, чатов и ботов
    </footer>
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return res.status(200).send(html);
}
