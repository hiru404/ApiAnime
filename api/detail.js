import { load } from 'cheerio';

const BASE = 'https://animasu.love';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
  'Referer': `${BASE}/`
};

const clean = (s = '') => s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

// https://animasu.love/genre/harem/ -> harem
const slugFromUrl = (href = '') => {
  try {
    const parts = new URL(href, BASE).pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  } catch {
    return '';
  }
};

// teks span tanpa label <b>Label:</b>
const valueOf = ($, span) => {
  const c = $(span).clone();
  c.find('b').first().remove();
  return clean(c.text());
};

// daftar link (genre, studio, musim) -> [{ name, slug }]
const linksOf = ($, span) =>
  $(span).find('a[rel="tag"]').map((_, a) => ({
    name: clean($(a).text()),
    slug: slugFromUrl($(a).attr('href'))
  })).get().filter(x => x.name);

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const send = (code, obj) => res.status(code).send(JSON.stringify(obj, null, 2));

  const slug = String(req.query.slug || '').trim().toLowerCase();
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return send(400, {
      status: 'error',
      creator: 'hiru404',
      message: 'Parameter ?slug= wajib diisi dan hanya boleh huruf kecil, angka, dan tanda minus.'
    });
  }

  try {
    const r = await fetch(`${BASE}/anime/${slug}/`, { headers: HEADERS });

    if (!r.ok) {
      const body = (await r.text()).slice(0, 300);
      console.log('animasu detail', r.status, 'server:', r.headers.get('server'), 'body:', body);

      const blocked = r.status === 403 || r.status === 503;
      return send(r.status, {
        status: 'error',
        creator: 'hiru404',
        message: blocked
          ? `Sumber membalas ${r.status}. Kemungkinan permintaan diblokir (Cloudflare/IP datacenter).`
          : `Sumber membalas ${r.status}`
      });
    }

    const $ = load(await r.text());
    const big = $('.bigcontent').first();
    if (!big.length) {
      return send(502, {
        status: 'error',
        creator: 'hiru404',
        message: 'Detail anime tidak ditemukan. Struktur halaman Animasu mungkin berubah.'
      });
    }

    const title = clean(big.find('h1[itemprop="headline"], h1').first().text()).replace(/\s*Sub Indo$/i, '');
    const alt_title = clean(big.find('.alter').first().text());
    const poster =
      big.find('.thumb img').first().attr('src') ||
      big.find('.thumb meta[itemprop="url"]').attr('content') ||
      '';
    const description = clean(big.find('.sepele').first().text());

    // sinopsis asli (kalau ada di luar .bigcontent)
    const synopsis = clean($('.synp .entry-content, .synp').first().text());

    // info dari .spe, dipetakan berdasarkan label <b>
    const info = {};
    big.find('.spe > span').each((_, el) => {
      const label = clean($(el).find('b').first().text()).replace(/:$/, '').toLowerCase();
      if (!label) return;

      if (label === 'genre') info.genres = linksOf($, el);
      else if (label === 'studio') info.studio = linksOf($, el);
      else if (label === 'musim') info.season = linksOf($, el)[0] || null;
      else if (label === 'status') info.status = valueOf($, el);
      else if (label === 'rilis') info.released = valueOf($, el);
      else if (label === 'jenis') info.type = valueOf($, el);
      else if (label === 'episode') info.total_episode = valueOf($, el);
      else if (label === 'durasi') info.duration = valueOf($, el);
      else if (label === 'diposting') info.posted_by = valueOf($, el);
      else if (label === 'diupdate') info.updated = valueOf($, el);
    });

    const ratingText = clean(big.find('.rating strong').first().text());
    const ratingNum = parseFloat((ratingText.match(/[\d.]+/) || [''])[0]);
    const rating = Number.isNaN(ratingNum) ? null : ratingNum;

    const id = big.find('.bookmark').attr('data-id') || '';
    const dateModified = big.find('time[itemprop="dateModified"]').attr('datetime') || '';

    // daftar episode
    const episodes = [];
    $('.lchx').each((_, el) => {
      const a = $(el).find('a').first();
      const href = a.attr('href') || '';
      const epTitle = clean(a.text());
      const epSlug = slugFromUrl(href);
      if (!epTitle || !epSlug) return;
      episodes.push({ title: epTitle, slug: epSlug });
    });

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    send(200, {
      status: 'success',
      creator: 'hiru404',
      source: 'Animasu',
      detail: {
        id,
        title,
        slug,
        alt_title,
        poster,
        rating,
        description,
        synopsis,
        ...info,
        updated_at: dateModified,
        episodes
      }
    });
  } catch (e) {
    send(500, { status: 'error', creator: 'hiru404', message: e.message });
  }
}
