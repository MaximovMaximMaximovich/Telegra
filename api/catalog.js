// GET /api/catalog
// Порционная выдача каталога — без выгрузки всех 15k строк каждому гостю.
// Query:
//   mode=list|top|recent   (default list)
//   page=1
//   limit=20               (max 50)
//   type=channel|chat|bot
//   category=...
//   q=поисковая строка

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_KEY = (
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''
).trim();

const ITEMS_SELECT =
  'id,type,username,invite_link,is_private,display_name,description,category,is_top,top_until,avatar_url,source,created_at';

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Равномерно перемешать записи по категориям (круг по категориям). */
function diversifyByCategory(rows, limit) {
  if (!rows || !rows.length || limit <= 0) return [];
  const buckets = Object.create(null);
  const order = [];
  for (let i = 0; i < rows.length; i++) {
    const it = rows[i];
    if (!it) continue;
    const c = String((it.category || 'Разное').trim() || 'Разное');
    if (!buckets[c]) {
      buckets[c] = [];
      order.push(c);
    }
    buckets[c].push(it);
  }
  // лёгкая ротация порядка категорий раз в час
  if (order.length > 1) {
    const shift = Math.floor(Date.now() / (60 * 60 * 1000)) % order.length;
    for (let s = 0; s < shift; s++) order.push(order.shift());
  }
  const out = [];
  const used = Object.create(null);
  let guard = 0;
  while (out.length < limit && guard < limit * 80) {
    guard++;
    let added = false;
    for (let oi = 0; oi < order.length; oi++) {
      const c = order[oi];
      const bucket = buckets[c];
      while (bucket.length && used[String(bucket[0].id)]) bucket.shift();
      if (bucket.length && out.length < limit) {
        const it = bucket.shift();
        used[String(it.id)] = true;
        out.push(it);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}

function buildFilterQuery(params) {
  const parts = [];
  const type = (params.type || '').trim();
  if (type === 'channel' || type === 'chat' || type === 'bot') {
    parts.push('type=eq.' + encodeURIComponent(type));
  }
  let category = (params.category || '').trim();
  if (category && category !== 'all' && category !== 'Все') {
    if (category === 'Для взрослых 18+' || category === 'Для взрослых') {
      parts.push(
        'or=(category.eq.' +
          encodeURIComponent('Для взрослых 18+') +
          ',category.eq.' +
          encodeURIComponent('Для взрослых') +
          ')'
      );
    } else {
      parts.push('category=eq.' + encodeURIComponent(category));
    }
  }
  const q = (params.q || '').trim();
  if (q) {
    const safe = q.replace(/[%(),]/g, ' ').slice(0, 80);
    if (safe) {
      const pattern = '*' + safe + '*';
      parts.push(
        'or=(username.ilike.' +
          encodeURIComponent(pattern) +
          ',display_name.ilike.' +
          encodeURIComponent(pattern) +
          ',description.ilike.' +
          encodeURIComponent(pattern) +
          ')'
      );
    }
  }
  return parts.length ? '&' + parts.join('&') : '';
}

async function sbRange(pathAndQuery, from, to) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    const err = new Error('Supabase env missing');
    err.status = 500;
    throw err;
  }
  const url = SUPABASE_URL + '/rest/v1/' + pathAndQuery;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      Accept: 'application/json',
      Prefer: 'count=exact',
      Range: from + '-' + to
    }
  });
  if (!res.ok) {
    const t = await res.text().catch(function () {
      return '';
    });
    const err = new Error('Supabase HTTP ' + res.status + (t ? ': ' + t.slice(0, 160) : ''));
    err.status = res.status;
    throw err;
  }
  let total = null;
  const cr = res.headers.get('content-range') || '';
  const m = /\/(\d+|\*)\s*$/.exec(cr);
  if (m && m[1] !== '*') total = parseInt(m[1], 10);
  const data = await res.json();
  return { rows: Array.isArray(data) ? data : [], total: total };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  // CDN/браузер: меньше повторных ударов в Supabase
  res.setHeader(
    'Cache-Control',
    'public, s-maxage=60, stale-while-revalidate=180, max-age=30'
  );

  try {
    const mode = String((req.query && req.query.mode) || 'list').toLowerCase();

    if (mode === 'top') {
      const limit = clampInt(req.query && req.query.limit, 1, 40, 24);
      const { rows } = await sbRange(
        'items?select=' +
          ITEMS_SELECT +
          '&is_top=eq.true&order=top_until.desc.nullslast',
        0,
        limit - 1
      );
      const now = Date.now();
      const items = rows.filter(function (it) {
        if (!it.top_until) return !!it.is_top;
        return new Date(it.top_until).getTime() > now;
      });
      return res.status(200).json({ ok: true, mode: 'top', items: items });
    }

    if (mode === 'recent') {
      const limit = clampInt(req.query && req.query.limit, 1, 40, 20);
      const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const { rows } = await sbRange(
        'items?select=' +
          ITEMS_SELECT +
          '&source=eq.user&created_at=gte.' +
          encodeURIComponent(since) +
          '&order=created_at.desc',
        0,
        limit - 1
      );
      return res.status(200).json({ ok: true, mode: 'recent', items: rows });
    }

    // mode=list
    const page = clampInt(req.query && req.query.page, 1, 5000, 1);
    const limit = clampInt(req.query && req.query.limit, 1, 50, 20);
    const qParams = req.query || {};
    const hasCategory = !!(qParams.category && String(qParams.category).trim() && String(qParams.category).trim() !== 'all');
    const hasQ = !!(qParams.q && String(qParams.q).trim());
    // Без фильтра по категории/поиску — перемешиваем категории, чтобы на главной не было 20 из одной
    const wantDiverse = !hasCategory && !hasQ;
    const filter = buildFilterQuery(qParams);
    const path =
      'items?select=' + ITEMS_SELECT + filter + '&order=created_at.desc';

    let rows;
    let total;
    if (wantDiverse) {
      // Берём расширенное окно свежих записей и набираем limit из разных категорий
      const poolSize = Math.min(300, Math.max(limit * 12, 80));
      const poolFrom = (page - 1) * poolSize;
      const poolTo = poolFrom + poolSize - 1;
      const pack = await sbRange(path, poolFrom, poolTo);
      total = pack.total;
      rows = diversifyByCategory(pack.rows, limit);
    } else {
      const from = (page - 1) * limit;
      const to = from + limit - 1;
      const pack = await sbRange(path, from, to);
      rows = pack.rows;
      total = pack.total;
    }

    const fromIdx = (page - 1) * limit;
    const toIdx = fromIdx + limit - 1;
    const totalNum = typeof total === 'number' ? total : fromIdx + rows.length;
    const hasMore =
      typeof total === 'number' ? toIdx + 1 < total : rows.length >= limit;

    return res.status(200).json({
      ok: true,
      mode: 'list',
      page: page,
      limit: limit,
      total: totalNum,
      hasMore: hasMore,
      diversified: wantDiverse,
      items: rows
    });
  } catch (e) {
    console.error('catalog api', e);
    return res.status(e.status && e.status >= 400 ? e.status : 500).json({
      ok: false,
      error: e.message || 'catalog failed'
    });
  }
};
