/**
 * scrape_samehadaku.js
 * Node.js script: Scrape semua daftar anime dari https://v1.samehadaku.how/
 * - Menggunakan Axios (fetch API)
 * - Menggunakan Cheerio (versi ESM)
 * - Menyimpan hasil ke samehadaku.json
 * - Jalankan `node scrape_samehadaku.js serve` untuk expose /anime via Express
 */

import fs from "fs";
import axios from "axios";
import * as cheerio from "cheerio";
import express from "express";

const BASE_URL = "https://v1.samehadaku.how/daftar-anime/";
const OUTPUT_FILE = "samehadaku.json";

/** Fungsi scrape halaman tertentu */
async function scrapePage(page) {
  const url = `${BASE_URL}?page=${page}`;
  console.log(`📄 Scraping halaman ${page}: ${url}`);

  try {
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);
    const results = [];

    $(".animepost").each((_, el) => {
      const title = $(el).find(".title h4 a").text().trim();
      const link = $(el).find(".title h4 a").attr("href");
      const image = $(el).find("img").attr("src");
      const status = $(el).find(".status").text().trim();
      const score = $(el).find(".score").text().trim();
      const year = parseInt($(el).find(".epztipe").text().match(/\d{4}/)?.[0]) || null;

      if (year && year >= 2020) {
        results.push({ title, link, image, status, score, year });
      }
    });

    return results;
  } catch (err) {
    console.error("❌ Error scraping:", err.message);
    return [];
  }
}

/** Scrape semua halaman */
async function scrapeAll() {
  const allAnime = [];
  for (let i = 1; i <= 5; i++) {
    const pageData = await scrapePage(i);
    if (pageData.length === 0) break;
    allAnime.push(...pageData);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allAnime, null, 2));
  console.log(`✅ Scraping selesai! Total anime disimpan: ${allAnime.length}`);
}

/** Mode server */
function serveMode() {
  const app = express();
  const port = process.env.PORT || 3000;

  app.get("/anime", (req, res) => {
    try {
      const data = fs.readFileSync(OUTPUT_FILE);
      res.json(JSON.parse(data));
    } catch {
      res.status(500).json({ error: "File belum tersedia. Jalankan scraping dulu." });
    }
  });

  app.listen(port, () => console.log(`🚀 Server berjalan di port ${port}`));
}

/** Main */
if (process.argv.includes("serve")) {
  serveMode();
} else {
  scrapeAll();
}