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
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = "https://v1.samehadaku.how/daftar-anime/";
const OUTPUT_FILE = path.join(__dirname, "samehadaku.json");

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
  for (let i = 1; i <= 5