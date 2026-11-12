// GET /api/catalog
// Порционная выдача каталога — без выгрузки всех строк и без пачки запросов по категориям.
// Query:
//   mode=list|top|recent   (default list)
//   page=1
//   limit=20               (max 40)
//   type=channel|chat|bot
//   category=...
//   q=поисковая строка

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_KEY = (
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''
).trim();

// Без длинного description — основной эконом на Egress (на карточках хватает названия)
const ITEMS_SELECT =
  'id,type,username,invite_link,is_private,display_name,category,is_top,top_until,avatar_url,source,created_at,violation_note,violation_until';

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

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
  // если категорий мало — добить по порядку
  if (out.length < limit) {
    for (let i = 0; i < rows.length && out.length < limit; i++) {
      const it = rows[i];
      if (it && it.id && !used[String(it.id)]) {
        used[String(it.id)] = true;
        out.push(it);
      }
    }
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
      // только username + display_name (без description — меньше CPU и трафика)
      parts.push(
        'or=(username.ilike.' +
          encodeURIComponent(pattern) +
          ',display_name.ilike.' +
          encodeURIComponent(pattern) +
          ')'
      );
    }
  }
  return parts.length ? '&' + parts.join('&') : '';
}

async function sbRange(pathAndQuery, from, to, opts) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    const err = new Error('Supabase env missing');
    err.status = 500;
    throw err;
  }
  opts = opts || {};
  // count=exact на каждый запрос дороже; для списка достаточно planned/estimated
  const prefer = opts.countExact ? 'count=exact' : 'count=planned';
  const url = SUPABASE_URL + '/rest/v1/' + pathAndQuery;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      Accept: 'application/json',
      Prefer: prefer,
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
  // Дольше кэш на CDN — меньше повторных ударов в PostgREST
  res.setHeader(
    'Cache-Control',
    'public, s-maxage=120, stale-while-revalidate=600, max-age=60'
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

    // mode=list — ОДИН (максимум два) запрос к PostgREST, без 30+ запросов по категориям
    const page = clampInt(req.query && req.query.page, 1, 5000, 1);
    const limit = clampInt(req.query && req.query.limit, 1, 40, 20);
    const qParams = req.query || {};
    const hasCategory = !!(
      qParams.category &&
      String(qParams.category).trim() &&
      String(qParams.category).trim() !== 'all'
    );
    const hasQ = !!(qParams.q && String(qParams.q).trim());
    const typeFilter = (qParams.type || '').trim();
    const filter = buildFilterQuery(qParams);

    // Главная без фильтра: берём пул свежих и перемешиваем по категориям на сервере
    if (!hasCategory && !hasQ && page === 1) {
      const poolSize = Math.min(120, Math.max(limit * 6, 60));
      let q =
        'items?select=' + ITEMS_SELECT + '&order=created_at.desc';
      if (typeFilter === 'channel' || typeFilter === 'chat' || typeFilter === 'bot') {
        q += '&type=eq.' + encodeURIComponent(typeFilter);
      }
      const pack = await sbRange(q, 0, poolSize - 1, { countExact: false });
      const mixed = diversifyByCategory(pack.rows || [], limit);
      const hasMore =
        typeof pack.total === 'number' ? pack.total > limit : (pack.rows || []).length >= poolSize;
      return res.status(200).json({
        ok: true,
        mode: 'list',
        page: 1,
        limit: limit,
        total: pack.total,
        hasMore: hasMore,
        items: mixed
      });
    }

    // Обычная пагинация (категория / поиск / страница 2+)
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    let q = 'items?select=' + ITEMS_SELECT + filter + '&order=created_at.desc';
    // exact count только на первой странице с фильтром — для «всего найдено»
    const pack = await sbRange(q, from, to, { countExact: page === 1 });
    const rows = pack.rows || [];
    const total = pack.total;
    const hasMore =
      typeof total === 'number' ? to + 1 < total : rows.length >= limit;

    return res.status(200).json({
      ok: true,
      mode: 'list',
      page: page,
      limit: limit,
      total: total,
      hasMore: hasMore,
      items: rows
    });
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    return res.status(status).json({
      ok: false,
      error: (e && e.message) || 'catalog error'
    });
  }
};
