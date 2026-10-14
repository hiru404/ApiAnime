import { load } from 'cheerio';

const BASE = 'https://animasu.love';

const clean = (s = '') => s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

const slugFromUrl = (href = '') => {
  try {
    const parts = new URL(href, BASE).pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  } catch {
    return '';
  }
};

// value <option> = base64 dari tag <iframe ...>, decode lalu ambil src-nya
const iframeSrc = (b64 = '') => {
  try {
    const html = Buffer.from(b64, 'base64').toString('utf8');
    const src = load(html)('iframe').first().attr('src') || '';
    if (src.startsWith('//')) return 'https:' + src;
    return src.replace(/&amp;/g, '&');
  } catch {
    return '';
  }
};

const navLink = ($, selector) => {
  const a = $(selector).first();
  const href = a.attr('href');
  if (!href) return null;
  return { slug: slugFromUrl(href), title: clean(a.text()) };
};

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const send = (code, obj) => res.status(code).send(JSON.stringify(obj, null, 2));

  // slug episode, contoh: nonton-chitose-kun-wa-ramune-bin-no-naka-part-2-episode-1
  const slug = String(req.query.slug || '').trim().toLowerCase();
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return send(400, { status: 'error', creator: 'hiru404', message: 'Parameter ?slug= (slug episode) wajib diisi dan hanya boleh huruf kecil, angka, dan tanda minus.' });
  }

  try {
    const r = await fetch(`${BASE}/${slug}/`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) {
      return send(r.status, { status: 'error', creator: 'hiru404', message: `Sumber membalas ${r.status}` });
    }

    const $ = load(await r.text());

    const servers = $('select.mirror option').map((_, o) => {
      const value = $(o).attr('value') || '';
      if (!value) return null; // lewati "Pilih Server/Kualitas"
      return {
        name: clean($(o).text()),
        index: parseInt($(o).attr('data-index'), 10) || null,
        url: iframeSrc(value)
      };
    }).get().filter(s => s.url);

    if (servers.length === 0) {
      return send(502, { status: 'error', creator: 'hiru404', message: 'Server stream tidak ditemukan. Struktur halaman Animasu mungkin berubah atau episode belum tersedia.' });
    }

    const title = clean($('h1.entry-title, h1[itemprop="headline"], h1').first().text());

    const animeA = $('.naveps .nvsc a').first();
    const anime_slug = slugFromUrl(animeA.attr('href'));

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    send(200, {
      status: 'success',
      creator: 'hiru404',
      source: 'Animasu',
      episode: {
        title,
        slug,
        anime_slug,
        servers,
        prev: navLink($, '.naveps a[rel="prev"]'),
        next: navLink($, '.naveps a[rel="next"]')
      }
    });
  } catch (e) {
    send(500, { status: 'error', creator: 'hiru404', message: e.message });
  }
}
