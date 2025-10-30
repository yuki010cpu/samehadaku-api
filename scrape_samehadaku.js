/**
 * scrape_samehadaku.js
 * Node.js script: Scrape semua daftar anime dari https://v1.samehadaku.how/
 * - Menggunakan Axios untuk HTTP requests
 * - Menggunakan Cheerio untuk parsing HTML
 * - Menyimpan hasil ke samehadaku.json
 * - Opsional: jalankan `node scrape_samehadaku.js serve` untuk expose /anime via Express
 *
 * Catatan: situs bisa berubah struktur -> script mengandung beberapa fallback selector
 *
import axios from "axios";
import * as cheerio from "cheerio";
import express from "express";
import fs from "fs";
// ====== Konfigurasi ======
const BASE = 'https://v1.samehadaku.how';
const START_LIST = `${BASE}/daftar-anime/`; // halaman daftar awal
const OUTPUT_FILE = path.resolve(process.cwd(), 'samehadaku.json');
const REQUEST_DELAY_MS = 1000; // delay antar request (ubah sesuai kebutuhan)
const MAX_RETRIES = 3; // retry saat request gagal

// Helper: delay
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper: fetch dengan retry dan try...catch
async function fetchHtml(url, attempt = 1) {
  try {
    console.log(`GET ${url} (attempt ${attempt})`);
    const resp = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; x86_64) Node.js scraper',
        Accept: 'text/html,application/xhtml+xml'
      },
      timeout: 20000
    });
    return resp.data;
  } catch (err) {
    console.error(`Error fetching ${url} (attempt ${attempt}): ${err.message}`);
    if (attempt < MAX_RETRIES) {
      await delay(REQUEST_DELAY_MS * 1.5);
      return fetchHtml(url, attempt + 1);
    } else {
      // return null on repeated failure
      return null;
    }
  }
}

/**
 * Detect pagination scheme and iterate through pages until no more pages.
 * Heuristik:
 * - Cari link rel="next"
 * - Cari anchor dengan teks 'Next' / 'Selanjutnya' / class 'nextpostslink'
 * - Coba pattern ?page=N atau /page/N/
 * - Jika tidak ada, berhenti ketika halaman list tidak menambah item baru
 */
async function collectListPageUrls(startUrl) {
  const pages = [startUrl];
  const visited = new Set(pages);

  for (let i = 0; i < pages.length; i++) {
    const url = pages[i];
    try {
      const html = await fetchHtml(url);
      if (!html) continue;

      const $ = cheerio.load(html);

      // 1) rel="next"
      const relNext = $('link[rel="next"]').attr('href');
      if (relNext && !visited.has(relNext)) {
        pages.push(relNext);
        visited.add(relNext);
        continue;
      }

      // 2) anchor with "next" text or class nextpostslink
      const nextAnchor = $('a.next, a.nextpostslink, a[rel="next"]').filter(function () {
        const t = $(this).text().trim().toLowerCase();
        return t.includes('next') || t.includes('selanjutnya') || t.includes('›') || t.includes('→');
      }).first();
      if (nextAnchor && nextAnchor.attr('href')) {
        const href = nextAnchor.attr('href');
        if (!visited.has(href)) {
          pages.push(href);
          visited.add(href);
          continue;
        }
      }

      // 3) look for numeric pagination links: /page/X or ?page=X
      // find highest page number from pagination anchors
      const pageAnchors = $('a').map((i, el) => $(el).attr('href')).get()
        .filter(Boolean)
        .filter(href => (href.match(/\/page\/\d+\/?/) || href.match(/[?&]page=\d+/)));
      if (pageAnchors.length) {
        // try to construct incremental pages using pattern of one example
        const sample = pageAnchors[0];
        // try /page/N/ pattern
        const m1 = sample.match(/(\/page\/)(\d+)(\/?)/);
        if (m1) {
          // find max page number from anchors
          const nums = pageAnchors.map(h => {
            const m = h.match(/\/page\/(\d+)\/?/);
            return m ? parseInt(m[1], 10) : null;
          }).filter(Boolean);
          const max = Math.max(...nums);
          // add pages 1..max
          for (let p = 1; p <= max; p++) {
            const candidate = sample.replace(/\/page\/\d+\/?/, `/page/${p}/`);
            if (!visited.has(candidate)) {
              pages.push(candidate);
              visited.add(candidate);
            }
          }
          continue;
        }
        // try ?page=N
        const m2 = sample.match(/([?&]page=)(\d+)/);
        if (m2) {
          const nums = pageAnchors.map(h => {
            const m = h.match(/[?&]page=(\d+)/);
            return m ? parseInt(m[1], 10) : null;
          }).filter(Boolean);
          const max = Math.max(...nums);
          for (let p = 1; p <= max; p++) {
            const candidate = sample.replace(/[?&]page=\d+/, (m2[1] + p));
            if (!visited.has(candidate)) {
              pages.push(candidate);
              visited.add(candidate);
            }
          }
          continue;
        }
      }

      // If we reach here and no next found, assume single page or last page
      console.log(`No explicit next detected on ${url}. Assuming pagination exhausted.`);
    } catch (err) {
      console.error(`Error parsing pagination on ${url}: ${err.message}`);
    } finally {
      await delay(REQUEST_DELAY_MS);
    }
  }

  // normalize unique pages
  const unique = Array.from(new Set(pages));
  console.log(`Detected ${unique.length} list pages.`);
  return unique;
}

/**
 * Parse a "list page" and extract basic anime entries:
 * returns array of { title, url, image (optional) }
 * Uses multiple fallback selectors based on common WP themes.
 */
function parseListPageForAnimes(html, pageUrl) {
  const $ = cheerio.load(html);
  const results = [];

  // candidate selectors where list items of anime might be
  const selectors = [
    '.post', '.animelist', '.anime-list .anime', '.list-anime .anime', '.daftar-anime .item', // generic
    '.post .thumb', '.artikel .post', '.entry .post' // fallback
  ];

  // Try to find article-like nodes
  let nodes = [];
  // common pattern: articles with class "post" and inside anchor to post
  nodes = $('article, .post, .entry').filter(function () {
    // filter those that contain link to anime page
    return $(this).find('a').filter((i, el) => {
      const href = $(el).attr('href') || '';
      return href.includes('/anime/') || href.includes('/judul/');
    }).length > 0;
  }).toArray();

  if (!nodes.length) {
    // fallback: find anchors on page that link to /anime/ and treat them as items
    const anchors = $('a').filter((i, el) => {
      const href = $(el).attr('href') || '';
      return href.includes('/anime/') && $(el).find('img').length > 0;
    }).toArray();

    anchors.forEach(a => {
      try {
        const $a = $(a);
        const href = $a.attr('href');
        const title = $a.attr('title') || $a.find('img').attr('alt') || $a.find('img').attr('title') || $a.text().trim();
        const img = $a.find('img').attr('src') || $a.find('img').attr('data-src') || null;
        if (href) {
          results.push({ title: title || null, url: href, image: img });
        }
      } catch (e) { /* ignore */ }
    });

    return results;
  }

  // Parse each node
  nodes.forEach(node => {
    try {
      const el = $(node);
      // find first anchor that looks like a link to anime page
      const anchor = el.find('a').filter((i, ael) => {
        const href = $(ael).attr('href') || '';
        return href.includes('/anime/') || href.includes('/judul/') || href.includes('/anime-');
      }).first();
      const href = anchor.attr('href') || null;
      let title = anchor.attr('title') || anchor.text().trim();
      if (!title) title = el.find('h2, h3, .title').first().text().trim();
      // image: try inside node
      let img = el.find('img').attr('src') || el.find('img').attr('data-src') || anchor.find('img').attr('src') || null;
      // fallback: meta og:image if single post
      if (!img) {
        const metaOg = $('meta[property="og:image"]').attr('content');
        img = metaOg || null;
      }
      if (href) {
        results.push({ title: title || null, url: href, image: img });
      }
    } catch (err) {
      console.error('Error parsing list node:', err.message);
    }
  });

  return results;
}

/**
 * Parse anime detail page to gather:
 * - title, image, genre[], status, synopsis, episodes[]
 *
 * For episodes: will try to find episode list on anime page OR if site lists episodes on separate page,
 * it will follow links to collect episodes. For simplicity, we attempt to parse episode links on anime page.
 */
async function parseAnimeDetail(anime) {
  const out = {
    title: anime.title || null,
    url: anime.url || null,
    image: anime.image || null,
    genre: [],
    status: null,
    synopsis: null,
    episodes: []
  };

  if (!anime.url) return out;

  try {
    const html = await fetchHtml(anime.url);
    if (!html) return out;

    const $ = cheerio.load(html);

    // Title: many themes: h1.entry-title or .post-title
    const titleSel = $('h1.entry-title, .entry-title, .post-title, h1.title').first().text().trim();
    if (titleSel) out.title = titleSel;

    // Image: try og:image, thumbnail selectors
    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage) out.image = ogImage;
    if (!out.image) {
      const imgSel = $('.post-thumbnail img, .thumb img, .entry img').first().attr('src');
      if (imgSel) out.image = imgSel;
    }

    // Genre: look for labels/links with rel=tag or anchor text 'Genre', or inside ".genre"
    const genreEls = $('.genre, .genres, .tag, a[rel="tag"]').first().find('a, span');
    if (genreEls && genreEls.length) {
      out.genre = [];
      genreEls.each((i, g) => {
        const txt = $(g).text().trim();
        if (txt) out.genre.push(txt);
      });
    } else {
      // fallback: search for "Genre" label in page content
      const text = $('.post-content, .entry-content').text();
      const genreMatch = text && text.match(/Genre[s]?:\s*([^\n\r]+)/i);
      if (genreMatch && genreMatch[1]) {
        out.genre = genreMatch[1].split(',').map(s => s.trim()).filter(Boolean);
      }
    }

    // Status: search for "Status" label or kata ongoing/complete
    const contentText = $('.post-content, .entry-content').text() || '';
    const statusMatch = contentText.match(/Status\s*[:\-]?\s*([A-Za-z\/\s]+)/i);
    if (statusMatch && statusMatch[1]) {
      out.status = statusMatch[1].trim();
    } else {
      // try to infer from page (kata Ongoing / Completed)
      const small = $('small, .status, .anime-status').text();
      if (small && /ongoing|on going|berlangsung/i.test(small)) out.status = 'Ongoing';
      else if (small && /complete|completed|selesai/i.test(small)) out.status = 'Completed';
    }

    // Synopsis: try .sinopsis, .entry-content p:first-of-type, meta description
    const sinop = $('.sinopsis, .sinopsis p, .entry-content .sinopsis, .entry-content p').first().text().trim();
    if (sinop) out.synopsis = sinop;
    else {
      const metaDesc = $('meta[name="description"]').attr('content');
      if (metaDesc) out.synopsis = metaDesc;
      else {
        // fallback: first paragraph in content
        const firstP = $('.entry-content p').first().text().trim();
        if (firstP) out.synopsis = firstP;
      }
    }

    // Episodes: try to find episode list on this page
    // Patterns: .episode-list a, .eps a, .daftar-episode a, .episode a
    const epAnchors = $('.episode-list a, .eps a, .daftar-episode a, .episode a, .entry-content a')
      .filter((i, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text() || '';
        // heuristics: link text contains 'Episode' or 'ep' or 'Sub' or pattern /-episode-/
        return /episode|ep|sub/i.test(text) || /episode|ep-|ep_/.test(href) || href.match(/\/\d{4,}[-_]/);
      }).toArray();

    // Deduplicate anchors by href
    const epMap = new Map();
    epAnchors.forEach(a => {
      const $a = $(a);
      const href = $a.attr('href');
      if (!href) return;
      if (!epMap.has(href)) {
        const title = $a.text().trim() || $a.attr('title') || null;
        epMap.set(href, { title, url: href });
      }
    });

    // If no episode anchors found, try to find links that look like episode pages via href pattern
    if (!epMap.size) {
      $('a').each((i, a) => {
        const href = $(a).attr('href') || '';
        const text = $(a).text() || '';
        if (href.includes('-episode-') || href.match(/episode-?\d+/i) || text.match(/episode\s*\d+/i)) {
          if (!epMap.has(href)) {
            epMap.set(href, { title: text.trim() || null, url: href });
          }
        }
      });
    }

    // Convert epMap to array and optionally fetch each episode detail (release_date + download links)
    const epList = Array.from(epMap.values());

    // Option: limit episodes if ridiculously many? (we keep all)
    for (let ep of epList) {
      // retrieve episode page
      try {
        await delay(REQUEST_DELAY_MS); // delay between episode requests
        const epHtml = await fetchHtml(ep.url);
        if (!epHtml) {
          out.episodes.push({
            title: ep.title,
            url: ep.url,
            release_date: null,
            downloads: []
          });
          continue;
        }
        const $$ = cheerio.load(epHtml);

        // Title: try h1 or title tag
        let epTitle = $$('h1.entry-title, h1.title, .post-title').first().text().trim();
        if (!epTitle) epTitle = ep.title || $$('title').text().trim();

        // Release date: try time tag, .post-date, meta property article:published_time
        let release = $$('time, .post-date, .date').first().text().trim();
        if (!release) {
          const metaPub = $$('meta[property="article:published_time"]').attr('content');
          if (metaPub) release = metaPub;
        }
        // Normalize release date simple: try to match YYYY-MM-DD else keep raw
        let releaseDate = null;
        if (release) {
          const m = release.match(/(\d{4}-\d{2}-\d{2})/);
          if (m) releaseDate = m[1];
          else releaseDate = release.trim();
        }

        // Downloads: find anchors that likely point to download hosters (contains 'download', 'gdrive', 'drive', 'zippyshare', 'gofile', 'dl', '.mp4')
        const downloadAnchors = $$('a').filter((i, ael) => {
          const href = $$(ael).attr('href') || '';
          const txt = $$(ael).text() || '';
          return /(download|gdrive|drive.google|zippyshare|gofile|dl\.|mp4|uploadfiles|download\.php)/i.test(href + txt);
        }).toArray();

        const downloads = [];
        downloadAnchors.forEach(ael => {
          const href = $$(ael).attr('href');
          if (href && href.startsWith('http')) downloads.push(href);
        });

        // Additional: sometimes download links are inside javascript or iframe src
        // collect iframe src
        $$('iframe').each((i, ifr) => {
          const s = $$(ifr).attr('src');
          if (s && s.startsWith('http')) downloads.push(s);
        });

        // dedupe downloads
        const uniqDownloads = Array.from(new Set(downloads));

        out.episodes.push({
          title: epTitle || null,
          url: ep.url,
          release_date: releaseDate,
          downloads: uniqDownloads
        });

      } catch (errEp) {
        console.error(`Error parsing episode ${ep.url}: ${errEp.message}`);
        out.episodes.push({
          title: ep.title || null,
          url: ep.url,
          release_date: null,
          downloads: []
        });
      }
    }

  } catch (err) {
    console.error(`Error parsing anime detail ${anime.url}: ${err.message}`);
  } finally {
    await delay(REQUEST_DELAY_MS);
  }

  return out;
}

// Main routine
async function main() {
  try {
    console.log('Starting scraping samehadaku...');

    // 1) collect pagination/list pages
    const listPages = await collectListPageUrls(START_LIST);

    // 2) for each list page, parse anime items
    const animeEntries = [];
    const seenUrls = new Set();

    for (let lp of listPages) {
      try {
        const html = await fetchHtml(lp);
        if (!html) continue;
        const items = parseListPageForAnimes(html, lp);
        for (let it of items) {
          // normalize / resolve relative URLs
          if (it.url && it.url.startsWith('/')) it.url = BASE + it.url;
          if (it.image && it.image.startsWith('/')) it.image = BASE + it.image;
          if (it.url && !seenUrls.has(it.url)) {
            animeEntries.push(it);
            seenUrls.add(it.url);
          }
        }
      } catch (err) {
        console.error(`Error parsing list page ${lp}: ${err.message}`);
      } finally {
        await delay(REQUEST_DELAY_MS);
      }
    }

    console.log(`Found ${animeEntries.length} anime entries from list pages.`);

    // 3) For each anime, fetch detail page and parse more info
    const final = [];
    let idx = 0;
    for (let anime of animeEntries) {
      idx++;
      console.log(`Parsing anime ${idx}/${animeEntries.length}: ${anime.title}`);
      try {
        const detailed = await parseAnimeDetail(anime);
        final.push(detailed);
      } catch (err) {
        console.error(`Unhandled error for ${anime.url}: ${err.message}`);
      } finally {
        // small delay already inside parseAnimeDetail, but keep extra safety
        await delay(REQUEST_DELAY_MS / 2);
      }
    }

    // 4) Save to JSON
    try {
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(final, null, 2), 'utf-8');
      console.log(`Saved ${final.length} items to ${OUTPUT_FILE}`);
    } catch (err) {
      console.error('Error writing JSON file:', err.message);
    }

    return final;

  } catch (err) {
    console.error('Fatal error in main:', err.message);
    return [];
  }
}

// If script called with "serve", start express after scraping (or read file if exists)
async function serveMode() {
  let data;
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
    } catch (e) {
      data = await main();
    }
  } else {
    data = await main();
  }

  const app = express();
  app.get('/anime', (req, res) => {
    res.json(data);
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Express server running at http://localhost:${port}/anime`);
  });
}

// CLI entry
(async () => {
  const arg = process.argv[2];
  if (arg === 'serve') {
    await serveMode();
  } else {
    await main();
  }
})();
