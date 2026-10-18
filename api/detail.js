import { load } from 'cheerio';

/*
  Environment Variable (semua opsional):
  - SOKUJA_BASE      : domain sumber, default https://x6.sokuja.uk (ganti kalau mirror berubah)
  - PROXY_URL        : URL Cloudflare Worker proxy (menerima ?slug=xxx, mengembalikan HTML)
  - SCRAPER_KEY      : API key ScraperAPI
  - SCRAPER_PREMIUM  : "1" -> tambahkan premium=true (proxy residensial, kredit lebih besar)
  - SCRAPER_RENDER   : "1" -> tambahkan render=true (render JS, kredit lebih besar)

  Urutan percobaan: PROXY_URL -> SCRAPER_KEY -> direct.
  Kalau satu jalur kena 403/503/challenge Cloudflare, otomatis lanjut ke jalur berikutnya.

  Contoh: /api/detail?slug=tsuihou-sareta-tensei-juukishi-wa-game-chishiki-de-musou-suru-subtitle-indonesia
  Tambah &debug=1 untuk melihat jalur mana yang dicoba dan statusnya.
*/
const BASE = (process.env.SOKUJA_BASE || 'https://x6.sokuja.uk').replace(/\/+$/, '');
const TIMEOUT_MS = 15000;

// header navigasi langsung (bukan same-origin) supaya mirip browser asli
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'max-age=0',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1'
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const isChallenge = (html = '') =>
  /Just a moment|challenge-platform|cf-chl|cf_chl_opt/i.test(html.slice(0, 4000));

const strategies = () => {
  const list = [];
  if (process.env.PROXY_URL) list.push('proxy');
  if (process.env.SCRAPER_KEY) list.push('scraperapi');
  list.push('direct');
  return list;
};

const requestVia = (via, slug, signal) => {
  const target = `${BASE}/anime/${slug}/`;

  if (via === 'proxy') {
    return fetch(`${process.env.PROXY_URL}?slug=${encodeURIComponent(slug)}`, { signal });
  }

  if (via === 'scraperapi') {
    const p = new URLSearchParams({ api_key: process.env.SCRAPER_KEY, url: target });
    if (process.env.SCRAPER_PREMIUM === '1') p.set('premium', 'true');
    if (process.env.SCRAPER_RENDER === '1') p.set('render', 'true');
    return fetch(`https://api.scraperapi.com/?${p.toString()}`, { signal });
  }

  return fetch(target, { headers: { ...HEADERS, Referer: `${BASE}/` }, signal });
};

// coba tiap jalur; 5xx/timeout dicoba ulang 1x, 403/503/challenge langsung pindah jalur
const fetchHtml = async (slug) => {
  const attempts = [];

  for (const via of strategies()) {
    for (let tries = 0; tries < 2; tries++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

      try {
        const r = await requestVia(via, slug, ctrl.signal);
        const server = r.headers.get('server') || '';
        const html = await r.text();
        const challenge = isChallenge(html);
        attempts.push({ via, status: r.status, server, challenge });

        if (r.ok && !challenge) return { ok: true, html, via, attempts };

        console.log('sokuja detail', via, r.status, 'server:', server, 'challenge:', challenge, 'body:', html.slice(0, 200));

        const retryable = r.status >= 500 && r.status !== 503 && !challenge;
        if (!retryable) break;
      } catch (e) {
        attempts.push({ via, status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message });
        console.log('sokuja detail', via, 'error:', e.message);
      } finally {
        clearTimeout(timer);
      }

      await sleep(400);
    }
  }

  return { ok: false, attempts };
};

const clean = (s = '') => s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

// bersihkan karakter CJK nyasar di sinopsis (mis. "meng攻略")
const fixText = (s = '') =>
  s.replace(/meng[\u3400-\u9fff]+/gi, 'menaklukkan')
    .replace(/[\u3400-\u9fff]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

// /genre/harem/ -> harem
const slugFromUrl = (href = '') => {
  try {
    const parts = new URL(href, BASE).pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  } catch {
    return '';
  }
};

// /_next/image/?url=%2Fuploads%2F...webp&w=3840&q=75 -> https://x6.sokuja.uk/uploads/...webp
const imgUrl = (src = '') => {
  if (!src) return '';
  try {
    const u = new URL(src, BASE);
    if (u.pathname.startsWith('/_next/image')) {
      const orig = u.searchParams.get('url');
      if (orig) return new URL(orig, BASE).href;
    }
    return u.href;
  } catch {
    return '';
  }
};

// cari <h2> berdasarkan teksnya
const sectionOf = ($, re) => {
  const h2 = $('h2').filter((_, el) => re.test(clean($(el).text()))).first();
  return h2.length ? h2 : null;
};

// daftar link di dalam <dd> -> [{ name, slug }]
const linksOf = ($, dd) =>
  $(dd).find('a').map((_, a) => ({
    name: clean($(a).text()).replace(/,$/, ''),
    slug: slugFromUrl($(a).attr('href'))
  })).get().filter(x => x.name);

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const send = (code, obj) => res.status(code).send(JSON.stringify(obj, null, 2));

  const slug = String(req.query.slug || '').trim().toLowerCase();
  const debug = String(req.query.debug || '') === '1';

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return send(400, {
      status: 'error',
      creator: 'hiru404',
      message: 'Parameter ?slug= wajib diisi dan hanya boleh huruf kecil, angka, dan tanda minus.'
    });
  }

  try {
    const result = await fetchHtml(slug);

    if (!result.ok) {
      const last = result.attempts[result.attempts.length - 1] || {};
      const blocked = result.attempts.some(a => a.status === 403 || a.status === 503 || a.challenge);
      const code = blocked ? (last.status === 503 ? 503 : 403) : (last.status || 502);
      const tried = result.attempts.map(a => a.via).filter((v, i, arr) => arr.indexOf(v) === i);

      return send(code, {
        status: 'error',
        creator: 'hiru404',
        message: blocked
          ? `Sumber memblokir permintaan (Cloudflare). Jalur dicoba: ${tried.join(', ')}. Pasang PROXY_URL atau SCRAPER_KEY (opsional SCRAPER_PREMIUM=1) lalu redeploy.`
          : `Sumber tidak bisa diakses (status ${last.status || 'timeout'}). Jalur dicoba: ${tried.join(', ')}.`,
        ...(debug ? { attempts: result.attempts } : {})
      });
    }

    const $ = load(result.html);
    const main = $('#main-content').first().length ? $('#main-content').first() : $('body');
    const h1 = main.find('h1').first();
    if (!h1.length) {
      return send(502, {
        status: 'error',
        creator: 'hiru404',
        message: 'Detail anime tidak ditemukan. Struktur halaman Sokuja mungkin berubah.',
        ...(debug ? { attempts: result.attempts } : {})
      });
    }

    // ===== judul =====
    const title = clean(h1.text()).replace(/\s*Subtitle Indonesia$/i, '');
    const alt_title = clean(h1.next('p').text());

    // ===== gambar =====
    const banner = imgUrl(main.find('img').first().attr('src'));
    const poster = imgUrl(main.find('.flex-shrink-0 img').first().attr('src')) || banner;

    // ===== badge di poster (TV / Ongoing) & jumlah bookmark =====
    const badges = main.find('.flex-shrink-0 .absolute span').map((_, el) => clean($(el).text())).get();
    const bookmarkBtn = main.find('button').filter((_, el) => /Bookmark/i.test($(el).text())).first();
    const bookmarks = parseInt(clean(bookmarkBtn.find('span').last().text()), 10);

    // ===== rating =====
    const ratingText = main.find('span.text-2xl').map((_, el) => clean($(el).text())).get()
      .find(t => /^\d+(\.\d+)?$/.test(t));
    const rating = ratingText ? parseFloat(ratingText) : null;

    // ===== genre =====
    const genres = main.find('a[href^="/genre/"]').map((_, a) => ({
      name: clean($(a).text()),
      slug: slugFromUrl($(a).attr('href'))
    })).get();

    // ===== informasi anime (dl > div > dt + dd) =====
    const info = {};
    main.find('dl > div').each((_, el) => {
      const label = clean($(el).find('dt').first().text()).toLowerCase();
      const dd = $(el).find('dd').first();
      if (!label || !dd.length) return;

      const text = clean(dd.text());
      const hasLinks = dd.find('a').length > 0;

      if (label === 'status') info.status = text;
      else if (label === 'tipe') info.type = text;
      else if (label === 'tahun') info.year = text;
      else if (label === 'musim') info.season = linksOf($, dd)[0] || null;
      else if (label === 'episode') info.total_episode = text;
      else if (label === 'subtitle') info.subtitle = text;
      else if (label === 'fansub') info.fansub = text;
      else if (label === 'studio') info.studio = hasLinks ? linksOf($, dd) : text;
      else if (label === 'sutradara') info.directors = hasLinks ? linksOf($, dd) : text;
      else if (label === 'produser') info.producers = hasLinks ? linksOf($, dd) : text;
    });

    // ===== sinopsis =====
    const synH2 = sectionOf($, /^Sinopsis/i);
    const synopsis = synH2
      ? synH2.parent().find('.prose p').map((_, p) => fixText(clean($(p).text()))).get().filter(Boolean).join('\n\n')
      : '';

    // ===== galeri =====
    const galH2 = sectionOf($, /^Galeri/i);
    const gallery = galH2
      ? galH2.parent().find('img').map((_, i) => imgUrl($(i).attr('src'))).get().filter(Boolean)
      : [];

    // ===== pemeran =====
    const cast = main.find('a[href^="/cast/"]').map((_, a) => ({
      name: clean($(a).text()),
      slug: slugFromUrl($(a).attr('href'))
    })).get();

    // ===== daftar episode =====
    const epH2 = sectionOf($, /^Daftar Episode/i);
    const epScope = epH2 ? epH2.closest('div').parent() : main;
    const episodes = [];
    const seen = new Set();
    epScope.find('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const epSlug = slugFromUrl(href);
      const m = epSlug.match(/-episode-(\d+(?:-\d+)?)(?:-|$)/i);
      if (!m || seen.has(epSlug)) return;
      seen.add(epSlug);

      const spans = $(el).find('span');
      const epTitle = clean(spans.first().text()) || clean($(el).text());
      const released = clean(spans.last().text());
      episodes.push({
        number: m[1].replace('-', '.'),
        title: epTitle,
        slug: epSlug,
        url: new URL(href, BASE).href,
        released: released !== epTitle ? released : ''
      });
    });

    // ===== anime terkait =====
    const relH2 = sectionOf($, /^Anime Terkait/i);
    const related = relH2
      ? relH2.parent().find('a[href^="/anime/"]').map((_, a) => {
          const el = $(a);
          const spans = el.find('span');
          const rr = parseFloat((clean(spans.eq(1).text()).match(/[\d.]+/) || [''])[0]);
          return {
            title: clean(el.find('h3').text()),
            slug: slugFromUrl(el.attr('href')),
            poster: imgUrl(el.find('img').attr('src')),
            type: clean(spans.eq(0).text()),
            rating: Number.isNaN(rr) ? null : rr,
            year: clean(el.find('p').last().text())
          };
        }).get()
      : [];

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    send(200, {
      status: 'success',
      creator: 'hiru404',
      source: 'Sokuja',
      ...(debug ? { via: result.via, attempts: result.attempts } : {}),
      detail: {
        title,
        slug,
        url: `${BASE}/anime/${slug}/`,
        alt_title,
        poster,
        banner,
        rating,
        bookmarks: Number.isNaN(bookmarks) ? null : bookmarks,
        badges,
        genres,
        ...info,
        synopsis,
        gallery,
        cast,
        episodes_available: episodes.length,
        episodes,
        related
      }
    });
  } catch (e) {
    send(500, { status: 'error', creator: 'hiru404', message: e.message });
  }
}
