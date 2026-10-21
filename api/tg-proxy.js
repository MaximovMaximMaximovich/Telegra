export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const target = req.query.url;

  if (!target) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Разрешаем только Telegram
  if (!['t.me', 'telegram.me', 'www.t.me'].includes(targetUrl.hostname)) {
    return res.status(403).json({ error: 'Only t.me links allowed' });
  }

  try {
    const upstream = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TelegraBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
    });

    const html = await upstream.text();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=600');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    return res.status(upstream.status).send(html);
  } catch (err) {
    return res.status(502).json({ error: 'Proxy error', message: err.message });
  }
}
