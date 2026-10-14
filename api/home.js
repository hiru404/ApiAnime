import { load } from 'cheerio';

const BASE = 'https://animasu.love';

// https://animasu.love/anime/gensou-suikoden/ -> gensou-suikoden
const slugFromUrl = (href = '') => {
  try {
    const parts = new URL(href, BASE).pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  } catch {
    return '';
  }
};

const clean = (s = '') => s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

// parse semua kartu .bs di dalam satu blok .listupd
function parseItems($, box) {
  const list = [];
  $(box).find('.bs').each((_, el) => {
    const item = $(el);
    const a = item.find('a').first();
    const slug = slugFromUrl(a.attr('href'));

    const title = clean(item.find('.tt').first().text()) || clean(item.find('img').attr('alt'));
    if (!title || !slug) return;

    const img = item.find('img').first();
    const poster = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src') || '';

    list.push({
      title,
      slug,
      poster,
      episode: clean(item.find('.epx').first().text()),
      status_or_day: clean(item.find('.sb').first().text()),
      type: clean(item.find('.typez').first().text())
    });
  });
  return list;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const send = (code, obj) => res.status(code).send(JSON.stringify(obj, null, 2));

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  try {
    const url = page === 1 ? `${BASE}/` : `${BASE}/page/${page}/`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) {
      return send(r.status, { status: 'error', creator: 'hiru404', message: `Sumber membalas ${r.status}` });
    }

    const $ = load(await r.text());

    // blok pertama = ongoing (listupd_custompage), blok berikutnya = recent
    const boxes = $('.listupd');
    let ongoing = [];
    let recent = [];

    const custom = $('.listupd_custompage').first();
    if (custom.length) {
      ongoing = parseItems($, custom);
      boxes.each((_, el) => {
        if (recent.length) return;
        if ($(el).is('.listupd_custompage')) return;
        const items = parseItems($, el);
        if (items.length) recent = items;
      });
    } else {
      // fallback kalau class custompage tidak ada
      if (boxes.length > 0) ongoing = parseItems($, boxes.eq(0));
      if (boxes.length > 1) recent = parseItems($, boxes.eq(1));
    }

    if (ongoing.length === 0 && recent.length === 0) {
      return send(502, {
        status: 'error',
        creator: 'hiru404',
        message: 'Daftar anime tidak ditemukan. Struktur halaman Animasu mungkin berubah atau halaman tidak ada.'
      });
    }

    const hasNext = $('.pagination a.next, .hpage a.r, a.next.page-numbers').length > 0;

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    send(200, {
      status: 'success',
      creator: 'hiru404',
      source: 'Animasu',
      ongoing,
      recent,
      pagination: {
        hasNext,
        hasPrev: page > 1,
        currentPage: page
      }
    });
  } catch (e) {
    send(500, { status: 'error', creator: 'hiru404', message: e.message });
  }
}
