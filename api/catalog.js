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
  'id,type,username,invite_link,is_private,display_name,description,category,is_top,top_until,avatar_url,source,created_at,violation_note,violation_until';

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Категории для микса на главной (если в БД есть записи). */
const MIX_CATEGORIES = [
  'Новости и СМИ', 'Развлечения и юмор', 'Бизнес и стартапы', 'Криптовалюта',
  'Здоровье и спорт', 'Игры и приложения', 'Музыка', 'Фильмы и сериалы',
  'Технологии', 'Нейросети и AI', 'Путешествия', 'Еда и напитки',
  'Мода и красота', 'Психология', 'Программирование', 'Образование',
  'Наука и образование', 'Авто, мото, техника', 'Аниме', 'Знакомства',
  'Инвестиции и финансы', 'Маркетплейсы', 'Работа', 'Поиск работы, вакансии',
  'Футбол, хоккей', 'Телеграм', 'Халява и скидки', 'Стихи и цитаты',
  'Мотивация и саморазвитие', 'Разное', 'Чаты', 'Блоги'
];

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
  return out;
}

/** Явно тянем по 1–2 записи из многих категорий — иначе «свежие 300» часто из одной. */
async function fetchMixedCategoryList(typeFilter, limit, page) {
  const perCat = 2;
  // ротация старта списка категорий
  const shift = (Math.floor(Date.now() / (30 * 60 * 1000)) + (page - 1) * 7) % MIX_CATEGORIES.length;
  const cats = MIX_CATEGORIES.slice(shift).concat(MIX_CATEGORIES.slice(0, shift));

  const jobs = [];
  for (let i = 0; i < cats.length; i++) {
    const cat = cats[i];
    let q =
      'items?select=' +
      ITEMS_SELECT +
      '&category=eq.' +
      encodeURIComponent(cat) +
      '&order=created_at.desc';
    if (typeFilter === 'channel' || typeFilter === 'chat' || typeFilter === 'bot') {
      q += '&type=eq.' + encodeURIComponent(typeFilter);
    }
    jobs.push(
      sbRange(q, 0, perCat - 1).then(function (pack) {
        return pack.rows || [];
      }).catch(function () {
        return [];
      })
    );
  }
  const batches = await Promise.all(jobs);
  const merged = [];
  const used = Object.create(null);
  // round-robin from category batches
  let maxLen = 0;
  for (let b = 0; b < batches.length; b++) {
    if (batches[b].length > maxLen) maxLen = batches[b].length;
  }
  for (let row = 0; row < maxLen; row++) {
    for (let b = 0; b < batches.length; b++) {
      if (row < batches[b].length) {
        const it = batches[b][row];
        if (it && it.id && !used[String(it.id)]) {
          used[String(it.id)] = true;
          merged.push(it);
        }
      }
    }
  }
  // если мало — добить свежими любыми
  if (merged.length < limit) {
    let q =
      'items?select=' + ITEMS_SELECT + '&order=created_at.desc';
    if (typeFilter === 'channel' || typeFilter === 'chat' || typeFilter === 'bot') {
      q += '&type=eq.' + encodeURIComponent(typeFilter);
    }
    const pack = await sbRange(q, 0, Math.max(80, limit * 4) - 1);
    const extra = diversifyByCategory(pack.rows || [], limit * 2);
    for (let i = 0; i < extra.length && merged.length < limit; i++) {
      const it = extra[i];
      if (it && it.id && !used[String(it.id)]) {
        used[String(it.id)] = true;
        merged.push(it);
      }
    }
  }
  // страница: сдвиг окна по уже смешанному списку
  const start = ((page - 1) * limit) % Math.max(merged.length, 1);
  const out = [];
  for (let i = 0; i < limit && i < merged.length; i++) {
    out.push(merged[(start + i) % merged.length]);
  }
  // total для hasMore — общий count без фильтра категории
  let totalHint = null;
  try {
    let q2 = 'items?select=id';
    if (typeFilter === 'channel' || typeFilter === 'chat' || typeFilter === 'bot') {
      q2 += '&type=eq.' + encodeURIComponent(typeFilter);
    }
    const pack2 = await sbRange(q2, 0, 0);
    totalHint = pack2.total;
  } catch (e) {}
  return { rows: out, total: totalHint };
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
    const typeFilter = (qParams.type || '').trim();
    // Без категории и поиска — микс из разных категорий (не «20 свежих из одной»)
    const wantDiverse = !hasCategory && !hasQ;
    const filter = buildFilterQuery(qParams);
    const path =
      'items?select=' + ITEMS_SELECT + filter + '&order=created_at.desc';

    let rows;
    let total;
    if (wantDiverse) {
      const mixed = await fetchMixedCategoryList(typeFilter, limit, page);
      rows = mixed.rows || [];
      total = mixed.total;
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
