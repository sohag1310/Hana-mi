import express from "express";
import path from "path";
import axios from "axios";
import * as cheerio from "cheerio";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import multer from "multer";
import AdmZip from "adm-zip";

const app = express();
const PORT = 3000;

// Set view engine
app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "views"));

app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));

// Local custom manga uploads directory setup
const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use("/uploads", express.static(uploadsDir));

const dbPath = path.join(uploadsDir, "db.json");
if (!fs.existsSync(dbPath)) {
  fs.writeFileSync(dbPath, "[]", "utf-8");
}

// Multer multi-part storage setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const uploadEnv = multer({ storage });
const uploadFields = uploadEnv.fields([
  { name: "cover", maxCount: 1 },
  { name: "zipFile", maxCount: 1 }
]);

// In-memory cache for scraping results (ttl: 15 minutes)
interface CacheItem<T> {
  data: T;
  expiry: number;
}
const scrapeCache = new Map<string, CacheItem<any>>();

function getFromCache<T>(key: string): T | null {
  const item = scrapeCache.get(key);
  if (item && item.expiry > Date.now()) {
    return item.data as T;
  }
  return null;
}

function setToCache<T>(key: string, data: T, ttlMs = 15 * 60 * 1000): void {
  scrapeCache.set(key, { data, expiry: Date.now() + ttlMs });
}

// User-Agent and headers
const SCRAPE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Referer": "https://hentaifox.com/"
};

// Filter unwanted banner/pixel images
const badKeywords = [
  "spacer", "pixel", "blank", "tracking", "analytics", "ad-", "-ad-", "advertisement",
  "transparent", "clear", "favicon", "logo", "icon", "banner", "spinner", "loader", "loading"
];

function isBadImage(src: string): boolean {
  if (!src) return true;
  const lower = src.toLowerCase();
  return badKeywords.some(keyword => lower.includes(keyword));
}

// Extract actual high-resolution media URLs bypassing placeholders
function getBestImageSrc(el: any): string {
  if (!el) return "";
  const attrs = ["data-src", "data-lazy-src", "data-original", "data-cfsrc", "srcset", "src"];
  for (const attr of attrs) {
    let val = el.attr(attr);
    if (val && typeof val === "string") {
      val = val.trim();
      if (!val) continue;

      if (attr === "srcset") {
        const parts = val.split(",");
        if (parts.length > 0) {
          const first = parts[0].trim().split(/\s+/)[0];
          if (first && !isBadImage(first)) val = first;
        }
      }

      if (val.startsWith("data:image/") || val.includes("placeholder") || val.includes("spacer.gif")) {
        continue;
      }
      if (val.startsWith("//")) {
        val = "https:" + val;
      }
      return val.replace(/^['"]|['"]$/g, "").trim();
    }
  }
  return el.attr("src") || "";
}

// Try to decode base64 Urls
function getDecodedMangaUrl(id: string): string | null {
  try {
    const decoded = Buffer.from(id, "base64url").toString("utf-8");
    if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
      return decoded;
    }
  } catch (err) {}
  return null;
}

// MangaDex Live Feeder (failsafe, reliable, fast)
async function fetchMangaDexFeed(page: number = 1, search: string = ""): Promise<any[]> {
  try {
    const limit = 20;
    const offset = (page - 1) * limit;
    let url = `https://api.mangadex.org/manga?limit=${limit}&offset=${offset}&includes[]=cover_art&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic`;
    if (search) {
      url += `&title=${encodeURIComponent(search)}`;
    }
    console.log(`[MANGADEX SCRAPE] Requesting: ${url}`);
    const response = await axios.get(url, { timeout: 8000 });
    const items = response.data.data || [];
    const galleries: any[] = [];
    for (const item of items) {
      const id = item.id;
      const title = item.attributes.title.en || item.attributes.title.ja || Object.values(item.attributes.title)[0] || "Live Manga";
      
      const coverArtRel = item.relationships.find((r: any) => r.type === "cover_art");
      let cover = "";
      if (coverArtRel && coverArtRel.attributes) {
        const fileName = coverArtRel.attributes.fileName;
        cover = `https://uploads.mangadex.org/covers/${id}/${fileName}.256.jpg`;
      } else {
        cover = "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=300&q=80";
      }

      let category = "Manga";
      const tags: string[] = [];
      if (item.attributes.publicationDemographic) {
        category = item.attributes.publicationDemographic.charAt(0).toUpperCase() + item.attributes.publicationDemographic.slice(1);
      }
      (item.attributes.tags || []).forEach((t: any) => {
        if (t.attributes && t.attributes.name && t.attributes.name.en) {
          tags.push(t.attributes.name.en);
        }
      });

      galleries.push({
        id,
        token: "mangadex",
        title,
        cover: `/api/proxy?url=${encodeURIComponent(cover)}`,
        category: category || "Manga",
        posted: "Recently Updated",
        uploader: "MangaDex Community",
        rating: (4.4 + (Math.abs(title.charCodeAt(0) || 0) % 6) * 0.1).toFixed(1),
        tags: tags.slice(0, 4)
      });
    }
    return galleries;
  } catch (err: any) {
    console.error("[MANGADEX SCRAPE ERROR]", err.message);
    return [];
  }
}

// Dedicated Scraper Helper with high-performing fallbacks
async function fetchNovelCrowFeed(page: number = 1, search: string = ""): Promise<any[]> {
  try {
    const url = search 
      ? (page > 1 ? `https://novelcrow.com/page/${page}/?s=${encodeURIComponent(search)}` : `https://novelcrow.com/?s=${encodeURIComponent(search)}`)
      : (page > 1 ? `https://novelcrow.com/page/${page}/` : `https://novelcrow.com/`);
      
    console.log(`[SCRAPER] Scraping NovelCrow: ${url}`);
    const response = await axios.get(url, { headers: SCRAPE_HEADERS, timeout: 4000 });
    const $ = cheerio.load(response.data);
    const galleries: any[] = [];
    
    $(".post-item, .comic-grid-item, .manga-item, article").each((_, element) => {
      const el = $(element);
      const titleLinkEl = el.find(".post-title a, .comic-title a, a").first();
      let title = titleLinkEl.text().trim();
      let link = titleLinkEl.attr("href") || "";
      const imgEl = el.find("img").first();
      let cover = getBestImageSrc(imgEl);
      
      if (!title && imgEl.attr("alt")) {
        title = imgEl.attr("alt")?.trim() || "";
      }
      
      if (title && link && cover) {
        const id = Buffer.from(link).toString("base64url");
        galleries.push({
          id,
          token: "novelcrow",
          title,
          cover: `/api/proxy?url=${encodeURIComponent(cover)}`,
          category: "Comic",
          posted: "Live Scraped",
          uploader: "NovelCrow",
          rating: "4.8",
          tags: ["NovelCrow", "Comic"]
        });
      }
    });

    if (galleries.length > 0) return galleries;
    throw new Error("Empty homepage/search response on NovelCrow");
  } catch (err: any) {
    console.log(`[SCRAPER FALLBACK] NovelCrow failed (${err.message}). Activating Hentaifox layout...`);
    
    try {
      const url = search
        ? `https://hentaifox.com/search/?q=${encodeURIComponent(search)}&page=${page}`
        : (page > 1 ? `https://hentaifox.com/pag/${page}/` : `https://hentaifox.com/`);

      console.log(`[FALLBACK SCRAPE] Querying Hentaifox: ${url}`);
      const response = await axios.get(url, { headers: SCRAPE_HEADERS, timeout: 6000 });
      const $ = cheerio.load(response.data);
      const galleries: any[] = [];

      $(".thumb").each((_, element) => {
        const el = $(element);
        const titleLinkEl = el.find(".caption a, a").last();
        const title = titleLinkEl.text().trim();
        const link = titleLinkEl.attr("href") || el.find("a").attr("href") || "";
        const imgEl = el.find("img");
        let cover = imgEl.attr("data-src") || imgEl.attr("src") || "";

        if (title && link && cover) {
          const match = link.match(/\/gallery\/(\d+)\//);
          const id = match ? match[1] : Buffer.from("https://hentaifox.com" + link).toString("base64url");
          
          galleries.push({
            id,
            token: "hentaifox",
            title,
            cover: `/api/proxy?url=${encodeURIComponent(cover)}`,
            category: "Hentai Doujin",
            posted: "Recently Scraped",
            uploader: "Hentaifox",
            rating: (4.4 + (Math.abs(title.charCodeAt(0) || 0) % 6) * 0.1).toFixed(1),
            tags: ["Scraped", "Doujinshi"]
          });
        }
      });

      if (galleries.length > 0) return galleries;
      throw new Error("Empty homepage/search response on Hentaifox");
    } catch (hErr: any) {
      console.log(`[SCRAPER ULTIMATE FALLBACK] Hentaifox failed (${hErr.message}). Querying MangaDex...`);
      return fetchMangaDexFeed(page, search);
    }
  }
}

// API: Feed endpoint
app.get("/api/manga/feed", async (req, res) => {
  const search = (req.query.search as string || "").trim();
  const pageNo = parseInt(req.query.page as string || "0", 10) + 1; // 1-indexed for scraper
  const cacheKey = `feed_${search || "default"}_p${pageNo}`;

  const cached = getFromCache<any[]>(cacheKey);
  if (cached) {
    return res.json({ success: true, source: "cache", galleries: cached });
  }

  try {
    let galleries = await fetchNovelCrowFeed(pageNo, search);

    // Merge manual uploads at the very top of page 1
    if (pageNo === 1 && !search) {
      let manualList: any[] = [];
      try {
        if (fs.existsSync(dbPath)) {
          manualList = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
        }
      } catch (e) {}
      galleries = [...manualList, ...galleries];
    }

    setToCache(cacheKey, galleries, 5 * 60 * 1000); // 5 minutes cache
    return res.json({ success: true, source: "live", galleries });
  } catch (err: any) {
    console.error("Feed error:", err.message, "Activating dynamic live scraper fallback feed...");
    
    try {
      const galleries = await fetchMangaDexFeed(pageNo, search);
      return res.json({
        success: true,
        source: "live",
        galleries
      });
    } catch (fallbackErr: any) {
      console.error("Ultimate live fallback failed:", fallbackErr.message);
      return res.json({
        success: false,
        error: "All live scraping options are offline or unavailable."
      });
    }
  }
});

// API: Image Proxy (pipes images under standard headers with fallback retry strategy)
app.get("/api/proxy", async (req, res) => {
  const imageUrl = req.query.url as string;
  if (!imageUrl) {
    return res.status(400).send("No image URL provided");
  }

  let targetUrl = imageUrl.trim().replace(/^['"]|['"]$/g, "");
  if (targetUrl.startsWith("//")) {
    targetUrl = "https:" + targetUrl;
  }

  async function attemptProxy(url: string, tryFallback = true): Promise<boolean> {
    try {
      const origin = new URL(url).origin;
      const referer = url.includes("hentaifox.com") ? "https://hentaifox.com/" : origin;
      const response = await axios.get(url, {
        responseType: "stream",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": referer,
          "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
        },
        timeout: 10000
      });

      if (response.headers["content-type"]) {
        res.setHeader("Content-Type", response.headers["content-type"] as any);
      }
      res.setHeader("Cache-Control", "public, max-age=86450");
      response.data.pipe(res);
      return true;
    } catch (err: any) {
      if (tryFallback && err.response && err.response.status === 404) {
        const extMatch = url.match(/\.([a-zA-Z0-9]+)$/);
        if (extMatch) {
          const originalExt = extMatch[1].toLowerCase();
          const alternatives = ["jpg", "png", "webp"].filter(e => e !== originalExt);
          for (const altExt of alternatives) {
            const fallbackUrl = url.replace(/\.[a-zA-Z0-9]+$/, `.${altExt}`);
            console.log(`[PROXY FALLBACK] 404 detected. Retrying with alternative extension: ${fallbackUrl}`);
            const success = await attemptProxy(fallbackUrl, false);
            if (success) return true;
          }
        }
      }
      return false;
    }
  }

  const ok = await attemptProxy(targetUrl, true);
  if (!ok) {
    res.status(502).send("Proxy failed to resolve image.");
  }
});

// API: Page Image Source meta translator
app.get("/api/manga/page-image-src", (req, res) => {
  const pageUrl = req.query.url as string;
  if (!pageUrl) {
    return res.status(400).json({ success: false, error: "No page URL provided" });
  }

  if (pageUrl.startsWith("/api/proxy") || pageUrl.startsWith("/uploads")) {
    return res.json({ success: true, src: pageUrl });
  }

  const proxiedUrl = `/api/proxy?url=${encodeURIComponent(pageUrl)}`;
  return res.json({ success: true, src: proxiedUrl });
});

// API: Get scraped pages & chapter list
app.get("/api/manga/:id/:token/pages", async (req, res) => {
  const { id, token } = req.params;
  const pageNo = parseInt(req.query.p as string || "0", 10);

  // 0. Live MangaDex integration for pages & chapter list
  if (token === "mangadex" || id.match(/^[0-9a-fA-F-]{36}$/)) {
    try {
      const chaptersUrl = `https://api.mangadex.org/manga/${id}/feed?limit=100&translatedLanguage[]=en&order[chapter]=asc&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic`;
      const chResponse = await axios.get(chaptersUrl, { timeout: 8000 });
      const chData = chResponse.data.data || [];
      
      let selectedChapterId = "";
      const chapters = chData.map((ch: any, idx: number) => {
        const num = ch.attributes.chapter || String(idx + 1);
        const title = ch.attributes.title || `Chapter ${num}`;
        if (!selectedChapterId && ch.id) {
          selectedChapterId = ch.id;
        }
        return {
          index: idx,
          id: ch.id,
          chapter: num,
          title: title
        };
      });

      if (chapters.length === 0) {
        const rawChaptersUrl = `https://api.mangadex.org/manga/${id}/feed?limit=100&order[chapter]=asc&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic`;
        const rawChResponse = await axios.get(rawChaptersUrl, { timeout: 8000 });
        const rawChData = rawChResponse.data.data || [];
        rawChData.forEach((ch: any, idx: number) => {
          const num = ch.attributes.chapter || String(idx + 1);
          const title = ch.attributes.title || `Chapter ${num}`;
          if (!selectedChapterId && ch.id) {
            selectedChapterId = ch.id;
          }
          chapters.push({
            index: idx,
            id: ch.id,
            chapter: num,
            title: title
          });
        });
      }

      if (chapters.length === 0) {
        chapters.push({
          index: 0,
          id: "mock-chapter-id",
          chapter: "1",
          title: "Chapter 1"
        });
      }

      const activeChapterIndex = pageNo >= 0 && pageNo < chapters.length ? pageNo : 0;
      const targetChapterId = chapters[activeChapterIndex]?.id || selectedChapterId;
      let pages: any[] = [];

      if (targetChapterId && targetChapterId !== "mock-chapter-id") {
        try {
          const pagesUrl = `https://api.mangadex.org/at-home/server/${targetChapterId}`;
          const pagesResponse = await axios.get(pagesUrl, { timeout: 8000 });
          const json = pagesResponse.data;
          const host = json.baseUrl;
          const hash = json.chapter.hash;
          const dataFiles = json.chapter.data || [];
          
          pages = dataFiles.map((name: string, idx: number) => {
            const pageUrl = `${host}/data/${hash}/${name}`;
            return {
              index: idx + 1,
              url: `/api/proxy?url=${encodeURIComponent(pageUrl)}`
            };
          });
        } catch (pageErr: any) {
          console.error("MangaDex pages error:", pageErr.message);
        }
      }

      if (pages.length === 0) {
        pages = [
          { index: 1, url: "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=800&q=80" },
          { index: 2, url: "https://images.unsplash.com/photo-1541562232579-512a21360020?w=800&q=80" }
        ];
      }

      return res.json({
        success: true,
        mangaId: id,
        title: "Live Active Manga",
        category: "Manga",
        posted: "Recently Updated",
        uploader: "MangaDex Community",
        tags: ["Live", "Manga", "Action"],
        pages,
        chapters,
        currentChapterIndex: activeChapterIndex,
        totalChapters: chapters.length
      });
    } catch (err: any) {
      console.error("MangaDex pages api failed:", err.message);
    }
  }

  // 1. Direct manual upload check
  let manualMangaList: any[] = [];
  try {
    if (fs.existsSync(dbPath)) {
      manualMangaList = JSON.parse(await fs.promises.readFile(dbPath, "utf-8"));
    }
  } catch (e) {}

  const matchedManual = manualMangaList.find(m => {
    return m.id.toLowerCase() === id.toLowerCase() ||
           m.id.toLowerCase() === `local-${id.toLowerCase()}` ||
           `local-${m.id.toLowerCase()}` === id.toLowerCase();
  });

  if (matchedManual) {
    let chapterIndex = pageNo;
    if (chapterIndex < 0 || chapterIndex >= matchedManual.chapters.length) {
      chapterIndex = 0;
    }
    const selectedChapter = matchedManual.chapters[chapterIndex];
    if (selectedChapter) {
      const mappedChapters = matchedManual.chapters.map((ch: any) => ({
        index: ch.index,
        id: ch.id,
        chapter: ch.chapter,
        title: ch.title || ""
      }));
      return res.json({
        success: true,
        title: matchedManual.title,
        category: matchedManual.category || "Hentai Doujin",
        posted: matchedManual.posted,
        uploader: matchedManual.uploader,
        tags: matchedManual.tags || [],
        pages: selectedChapter.pages,
        chapters: mappedChapters,
        currentChapterIndex: chapterIndex,
        totalChapters: mappedChapters.length
      });
    }
  }

  // 2. Direct Scraper pipeline (tries Hentaifox numeric IDs or Base64Url decoded URLs)
  try {
    // If id starts with local- but not in manualMangaList, return 404
    if (id.startsWith("local-") || token === "manual") {
      return res.status(404).json({ success: false, error: "Local manga not found." });
    }

    let targetUrl = "";
    if (id.match(/^\d+$/)) {
      targetUrl = `https://hentaifox.com/gallery/${id}/`;
    } else {
      const decoded = getDecodedMangaUrl(id);
      if (decoded) targetUrl = decoded;
    }

    if (targetUrl && (targetUrl.startsWith("http://") || targetUrl.startsWith("https://"))) {
      const response = await axios.get(targetUrl, { headers: SCRAPE_HEADERS, timeout: 6000 });
      const $ = cheerio.load(response.data);

      const title = $(".info h1").text().trim() || $("h1").first().text().trim() || "Scraped Masterpiece";
      
      const tags: string[] = [];
      $(".tags li a").each((_, tagEl) => {
        const text = $(tagEl).text().replace(/\d+$/, "").trim();
        if (text) tags.push(text);
      });
      if (tags.length === 0) tags.push("Scraped");

      const pages: any[] = [];
      if (targetUrl.includes("hentaifox.com")) {
        let extMap: Record<string, string> = {};
        try {
          let g_th_text = "";
          $("script").each((_, el) => {
            const html = $(el).html() || "";
            if (html.includes("g_th")) {
              g_th_text = html;
            }
          });
          if (g_th_text) {
            let jsonStr = "";
            const matchParseJSON = g_th_text.match(/parseJSON\s*\(\s*'(.*?)'\s*\)/s);
            if (matchParseJSON) {
              jsonStr = matchParseJSON[1];
            } else {
              const matchParseJSONDouble = g_th_text.match(/parseJSON\s*\(\s*"(.*?)"\s*\)/s);
              if (matchParseJSONDouble) {
                jsonStr = matchParseJSONDouble[1];
              } else {
                const matchDirectAssign = g_th_text.match(/g_th\s*=\s*(\{.*?\})/s);
                if (matchDirectAssign) {
                  jsonStr = matchDirectAssign[1];
                }
              }
            }

            if (jsonStr) {
              if (jsonStr.includes('\\"')) {
                jsonStr = jsonStr.replace(/\\"/g, '"');
              }
              if (jsonStr.includes("\\'")) {
                jsonStr = jsonStr.replace(/\\'/g, "'");
              }
              const parsed = JSON.parse(jsonStr);
              for (const [pageKey, value] of Object.entries(parsed)) {
                if (value && (Array.isArray(value) || typeof value === "string")) {
                  let typeChar = "";
                  if (Array.isArray(value)) {
                    typeChar = String(value[0]);
                  } else if (typeof value === "string") {
                    typeChar = value.split(",")[0];
                  }
                  
                  let ext = "jpg";
                  if (typeChar === "w") ext = "webp";
                  else if (typeChar === "p") ext = "png";
                  else if (typeChar === "j") ext = "jpg";
                  extMap[pageKey] = ext;
                }
              }
            }
          }
        } catch (e) {
          console.error("Failed to parse Hentaifox page extension map:", e);
        }

        // Reconstruct full page arrays sequentially by extracting bases from cover/thumbnail urls
        let firstThumb = "";
        $(".g_thumb img").each((_, imgEl) => {
          let src = $(imgEl).attr("data-src") || $(imgEl).attr("src") || "";
          if (src && !firstThumb) {
            firstThumb = src;
          }
        });
        if (!firstThumb) {
          firstThumb = $(".cover img").attr("data-src") || $(".cover img").attr("src") || "";
        }

        let baseDir = "";
        if (firstThumb) {
          const matchThumb = firstThumb.match(/^(.*?)\/([0-9]+)t\.[a-zA-Z0-9]+$/i);
          if (matchThumb) {
            baseDir = matchThumb[1];
          } else {
            baseDir = firstThumb.replace(/\/(cover|thumb|1)\.[a-zA-Z0-9]+$/i, "");
          }
        }

        const pageKeys = Object.keys(extMap).map(k => parseInt(k, 10)).filter(n => !isNaN(n));
        const maxPageFromMap = pageKeys.length > 0 ? Math.max(...pageKeys) : 0;
        const thumbCount = $(".g_thumb img").length;
        let finalMaxPage = Math.max(maxPageFromMap, thumbCount);

        let infoPagesText = "";
        $(".info div, .info p").each((_, matchEl) => {
          const text = $(matchEl).text();
          if (text.includes("Pages:") || text.includes("pages")) {
            infoPagesText = text;
          }
        });
        if (infoPagesText) {
          const pageMatch = infoPagesText.match(/(?:Pages:|pages)\s*(\d+)/i);
          if (pageMatch) {
            const num = parseInt(pageMatch[1], 10);
            if (!isNaN(num) && num > finalMaxPage) {
              finalMaxPage = num;
            }
          }
        }

        if (finalMaxPage > 0 && baseDir) {
          for (let i = 1; i <= finalMaxPage; i++) {
            const ext = extMap[String(i)] || "jpg";
            const fullRes = `${baseDir}/${i}.${ext}`;
            pages.push({
              index: i,
              url: `/api/proxy?url=${encodeURIComponent(fullRes)}`
            });
          }
        } else {
          $(".g_thumb img").each((idx, imgEl) => {
            let src = $(imgEl).attr("data-src") || $(imgEl).attr("src") || "";
            if (src) {
              const pageNum = String(idx + 1);
              let ext = extMap[pageNum] || "jpg";
              const fullRes = src.replace(/\/([0-9]+)t\.[a-zA-Z0-9]+$/i, `/$1.${ext}`);
              pages.push({
                index: idx + 1,
                url: `/api/proxy?url=${encodeURIComponent(fullRes)}`
              });
            }
          });
        }
      } else {
        $(".entry-content img, .reader-area-images img").each((_, imgEl) => {
          const src = getBestImageSrc($(imgEl));
          if (src && !isBadImage(src)) {
            pages.push({
              index: pages.length + 1,
              url: `/api/proxy?url=${encodeURIComponent(src)}`
            });
          }
        });
      }

      if (pages.length === 0) {
        $("img").each((_, imgEl) => {
          const el = $(imgEl);
          let src = getBestImageSrc(el);
          const w = el.attr("width");
          const h = el.attr("height");
          
          if (src && !isBadImage(src)) {
            if (w && parseInt(w, 10) < 100) return;
            if (h && parseInt(h, 10) < 100) return;

            pages.push({
              index: pages.length + 1,
              url: `/api/proxy?url=${encodeURIComponent(src)}`
            });
          }
        });
      }

      if (pages.length > 0) {
        return res.json({
          success: true,
          mangaId: id,
          title,
          category: "Comic",
          posted: "Recently Scraped",
          uploader: "Hentaifox",
          tags,
          pages,
          chapters: [{ index: 0, id: `ch-1`, chapter: "1", title: "Chapter 1" }],
          currentChapterIndex: 0,
          totalChapters: 1
        });
      }
    }
  } catch (err: any) {
    console.error("Dynamical reader API failed:", err.message);
  }

  return res.status(404).json({ success: false, error: "Details for this manga are currently offline or unavailable." });
});

// GET: Server-rendered reader view
app.get("/manga/:id", async (req, res) => {
  const { id } = req.params;
  const pageNo = parseInt(req.query.p as string || "0", 10);

  // 0. MangaDex API integration for chapters & pages (Server-rendered view fallback)
  const isMangaDex = id.match(/^[0-9a-fA-F-]{36}$/) || req.query.t === "mangadex";
  if (isMangaDex) {
    try {
      const chaptersUrl = `https://api.mangadex.org/manga/${id}/feed?limit=100&translatedLanguage[]=en&order[chapter]=asc&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic`;
      const chResponse = await axios.get(chaptersUrl, { timeout: 8000 });
      const chData = chResponse.data.data || [];
      
      let selectedChapterId = "";
      const chapters = chData.map((ch: any, idx: number) => {
        const num = ch.attributes.chapter || String(idx + 1);
        const title = ch.attributes.title || `Chapter ${num}`;
        if (!selectedChapterId && ch.id) {
          selectedChapterId = ch.id;
        }
        return {
          index: idx,
          id: ch.id,
          chapter: num,
          title: title
        };
      });

      if (chapters.length === 0) {
        const rawChaptersUrl = `https://api.mangadex.org/manga/${id}/feed?limit=100&order[chapter]=asc&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic`;
        const rawChResponse = await axios.get(rawChaptersUrl, { timeout: 8000 });
        const rawChData = rawChResponse.data.data || [];
        rawChData.forEach((ch: any, idx: number) => {
          const num = ch.attributes.chapter || String(idx + 1);
          const title = ch.attributes.title || `Chapter ${num}`;
          if (!selectedChapterId && ch.id) {
            selectedChapterId = ch.id;
          }
          chapters.push({
            index: idx,
            id: ch.id,
            chapter: num,
            title: title
          });
        });
      }

      if (chapters.length === 0) {
        chapters.push({
          index: 0,
          id: "mock-chapter-id",
          chapter: "1",
          title: "Chapter 1"
        });
      }

      const activeChapterIndex = pageNo >= 0 && pageNo < chapters.length ? pageNo : 0;
      const targetChapterId = chapters[activeChapterIndex]?.id || selectedChapterId;
      let pages: any[] = [];

      if (targetChapterId && targetChapterId !== "mock-chapter-id") {
        try {
          const pagesUrl = `https://api.mangadex.org/at-home/server/${targetChapterId}`;
          const pagesResponse = await axios.get(pagesUrl, { timeout: 8000 });
          const json = pagesResponse.data;
          const host = json.baseUrl;
          const hash = json.chapter.hash;
          const dataFiles = json.chapter.data || [];
          
          pages = dataFiles.map((name: string, idx: number) => {
            const pageUrl = `${host}/data/${hash}/${name}`;
            return {
              index: idx + 1,
              url: `/api/proxy?url=${encodeURIComponent(pageUrl)}`
            };
          });
        } catch (pageErr: any) {
          console.error("MangaDex EJS pages error:", pageErr.message);
        }
      }

      if (pages.length === 0) {
        pages = [
          { index: 1, url: "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=800&q=80" },
          { index: 2, url: "https://images.unsplash.com/photo-1541562232579-512a21360020?w=800&q=80" }
        ];
      }

      return res.render("reader.ejs", {
        mangaId: id,
        title: "Live Active Manga",
        category: "Manga",
        posted: "Recently Updated",
        uploader: "MangaDex Community",
        tags: ["Live", "Manga", "Action"],
        pages,
        chapters,
        currentChapterIndex: activeChapterIndex
      });
    } catch (err: any) {
      console.error("MangaDex chapters EJS fetch error:", err.message);
    }
  }

  // 1. Direct manual upload checkout
  let manualMangaList: any[] = [];
  try {
    if (fs.existsSync(dbPath)) {
      manualMangaList = JSON.parse(await fs.promises.readFile(dbPath, "utf-8"));
    }
  } catch (e) {}

  const matchedManual = manualMangaList.find(m => {
    return m.id.toLowerCase() === id.toLowerCase() ||
           m.id.toLowerCase() === `local-${id.toLowerCase()}` ||
           `local-${m.id.toLowerCase()}` === id.toLowerCase();
  });

  if (matchedManual) {
    let chapterIndex = pageNo;
    if (chapterIndex < 0 || chapterIndex >= matchedManual.chapters.length) {
      chapterIndex = 0;
    }
    const selectedChapter = matchedManual.chapters[chapterIndex];
    if (selectedChapter) {
      const mappedChapters = matchedManual.chapters.map((ch: any) => ({
        index: ch.index,
        id: ch.id,
        chapter: ch.chapter,
        title: ch.title || ""
      }));
      return res.render("reader.ejs", {
        mangaId: matchedManual.id,
        title: matchedManual.title,
        category: matchedManual.category || "Hentai Doujin",
        posted: matchedManual.posted,
        uploader: matchedManual.uploader,
        tags: matchedManual.tags || [],
        pages: selectedChapter.pages,
        chapters: mappedChapters,
        currentChapterIndex: chapterIndex
      });
    }
  }

  // 2. Direct Scraper pipeline (tries Hentaifox numeric IDs or Base64Url decoded URLs)
  try {
    let targetUrl = "";
    if (id.match(/^\d+$/)) {
      targetUrl = `https://hentaifox.com/gallery/${id}/`;
    } else {
      const decoded = getDecodedMangaUrl(id);
      if (decoded) targetUrl = decoded;
    }

    if (targetUrl && (targetUrl.startsWith("http://") || targetUrl.startsWith("https://"))) {
      const response = await axios.get(targetUrl, { headers: SCRAPE_HEADERS, timeout: 6000 });
      const $ = cheerio.load(response.data);

      const title = $(".info h1").text().trim() || $("h1").first().text().trim() || "Scraped Masterpiece";
      
      const tags: string[] = [];
      $(".tags li a").each((_, tagEl) => {
        const text = $(tagEl).text().replace(/\d+$/, "").trim();
        if (text) tags.push(text);
      });
      if (tags.length === 0) tags.push("Scraped");

      const pages: any[] = [];
      if (targetUrl.includes("hentaifox.com")) {
        // Parse g_th extension map from script tags
        let extMap: Record<string, string> = {};
        try {
          let g_th_text = "";
          $("script").each((_, el) => {
            const html = $(el).html() || "";
            if (html.includes("g_th")) {
              g_th_text = html;
            }
          });
          if (g_th_text) {
            let jsonStr = "";
            const matchParseJSON = g_th_text.match(/parseJSON\s*\(\s*'(.*?)'\s*\)/s);
            if (matchParseJSON) {
              jsonStr = matchParseJSON[1];
            } else {
              const matchParseJSONDouble = g_th_text.match(/parseJSON\s*\(\s*"(.*?)"\s*\)/s);
              if (matchParseJSONDouble) {
                jsonStr = matchParseJSONDouble[1];
              } else {
                const matchDirectAssign = g_th_text.match(/g_th\s*=\s*(\{.*?\})/s);
                if (matchDirectAssign) {
                  jsonStr = matchDirectAssign[1];
                }
              }
            }

            if (jsonStr) {
              if (jsonStr.includes('\\"')) {
                jsonStr = jsonStr.replace(/\\"/g, '"');
              }
              if (jsonStr.includes("\\'")) {
                jsonStr = jsonStr.replace(/\\'/g, "'");
              }
              const parsed = JSON.parse(jsonStr);
              for (const [pageKey, value] of Object.entries(parsed)) {
                if (value && (Array.isArray(value) || typeof value === "string")) {
                  let typeChar = "";
                  if (Array.isArray(value)) {
                    typeChar = String(value[0]);
                  } else if (typeof value === "string") {
                    typeChar = value.split(",")[0];
                  }
                  
                  let ext = "jpg";
                  if (typeChar === "w") ext = "webp";
                  else if (typeChar === "p") ext = "png";
                  else if (typeChar === "j") ext = "jpg";
                  extMap[pageKey] = ext;
                }
              }
            }
          }
        } catch (e) {
          console.error("Failed to parse Hentaifox page extension map:", e);
        }

        // Reconstruct full page arrays sequentially by extracting bases from cover/thumbnail urls
        let firstThumb = "";
        $(".g_thumb img").each((_, imgEl) => {
          let src = $(imgEl).attr("data-src") || $(imgEl).attr("src") || "";
          if (src && !firstThumb) {
            firstThumb = src;
          }
        });
        if (!firstThumb) {
          firstThumb = $(".cover img").attr("data-src") || $(".cover img").attr("src") || "";
        }

        let baseDir = "";
        if (firstThumb) {
          const matchThumb = firstThumb.match(/^(.*?)\/([0-9]+)t\.[a-zA-Z0-9]+$/i);
          if (matchThumb) {
            baseDir = matchThumb[1];
          } else {
            baseDir = firstThumb.replace(/\/(cover|thumb|1)\.[a-zA-Z0-9]+$/i, "");
          }
        }

        const pageKeys = Object.keys(extMap).map(k => parseInt(k, 10)).filter(n => !isNaN(n));
        const maxPageFromMap = pageKeys.length > 0 ? Math.max(...pageKeys) : 0;
        const thumbCount = $(".g_thumb img").length;
        let finalMaxPage = Math.max(maxPageFromMap, thumbCount);

        let infoPagesText = "";
        $(".info div, .info p").each((_, matchEl) => {
          const text = $(matchEl).text();
          if (text.includes("Pages:") || text.includes("pages")) {
            infoPagesText = text;
          }
        });
        if (infoPagesText) {
          const pageMatch = infoPagesText.match(/(?:Pages:|pages)\s*(\d+)/i);
          if (pageMatch) {
            const num = parseInt(pageMatch[1], 10);
            if (!isNaN(num) && num > finalMaxPage) {
              finalMaxPage = num;
            }
          }
        }

        if (finalMaxPage > 0 && baseDir) {
          for (let i = 1; i <= finalMaxPage; i++) {
            const ext = extMap[String(i)] || "jpg";
            const fullRes = `${baseDir}/${i}.${ext}`;
            pages.push({
              index: i,
              url: `/api/proxy?url=${encodeURIComponent(fullRes)}`
            });
          }
        } else {
          $(".g_thumb img").each((idx, imgEl) => {
            let src = $(imgEl).attr("data-src") || $(imgEl).attr("src") || "";
            if (src) {
              const pageNum = String(idx + 1);
              let ext = extMap[pageNum] || "jpg";
              // Replace e.g., '1t.jpg' or '1t.png' with '1.webp' or similar correct extension
              const fullRes = src.replace(/\/([0-9]+)t\.[a-zA-Z0-9]+$/i, `/$1.${ext}`);
              pages.push({
                index: idx + 1,
                url: `/api/proxy?url=${encodeURIComponent(fullRes)}`
              });
            }
          });
        }
      } else {
        $(".entry-content img, .reader-area-images img").each((_, imgEl) => {
          const src = getBestImageSrc($(imgEl));
          if (src && !isBadImage(src)) {
            pages.push({
              index: pages.length + 1,
              url: `/api/proxy?url=${encodeURIComponent(src)}`
            });
          }
        });
      }

      if (pages.length > 0) {
        return res.render("reader.ejs", {
          mangaId: id,
          title,
          category: "Comic",
          posted: "Recently Scraped",
          uploader: "Hentaifox",
          tags,
          pages,
          chapters: [{ index: 0, id: `ch-1`, chapter: "1", title: "Chapter 1" }],
          currentChapterIndex: 0
        });
      }
    }
  } catch (err: any) {
    console.error("Dynamical reader parse failed:", err.message);
  }

  return res.status(404).send("Details for this manga are currently offline or unavailable.");
});

// POST: Admin portal manual manga zip upload handler
app.post("/api/secret/upload", uploadFields, async (req: any, res: any) => {
  const { password, title, chapter } = req.body;

  if (password !== "9221") {
    return res.status(403).json({ success: false, error: "Access Denied: Invalid Security Code" });
  }
  if (!title || !chapter) {
    return res.status(400).json({ success: false, error: "Title and Chapter fields are required" });
  }

  const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
  const coverFiles = files?.cover || [];
  const zipFile = files?.zipFile?.[0];

  if (!zipFile) {
    return res.status(400).json({ success: false, error: "ZIP pages archive is required" });
  }

  try {
    let mangaDb: any[] = [];
    if (fs.existsSync(dbPath)) {
      mangaDb = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
    }

    const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const mangaId = `local-${slug}`;
    const dateStr = new Date().toISOString().substring(0, 10);

    let coverUrl = "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=600&q=80";
    if (coverFiles.length > 0) {
      coverUrl = `/uploads/${coverFiles[0].filename}`;
    }

    let manga = mangaDb.find(m => m.id === mangaId);
    if (!manga) {
      manga = {
        id: mangaId,
        token: "manual",
        title: title.trim(),
        cover: coverUrl,
        category: "Local",
        posted: dateStr,
        uploader: "Local Admin",
        rating: "5.0",
        tags: ["HD", "Local"],
        chapters: []
      };
      mangaDb.push(manga);
    } else if (coverFiles.length > 0) {
      manga.cover = coverUrl;
    }

    const chapterNumStr = String(chapter).trim();
    const chapterSlug = chapterNumStr.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const extrFolder = path.join(uploadsDir, slug, chapterSlug);
    fs.mkdirSync(extrFolder, { recursive: true });

    // Zip Unpack Operation
    const zip = new AdmZip(zipFile.path);
    const zipEntries = zip.getEntries();
    const extractedPages: string[] = [];

    for (const entry of zipEntries) {
      if (entry.isDirectory) continue;
      const entryExt = path.extname(entry.name).toLowerCase();
      const filename = path.basename(entry.name);

      if (filename.startsWith("._") || entry.entryName.includes("__MACOSX") ||
          ![".jpg", ".jpeg", ".png", ".webp", ".gif", ".jfif"].includes(entryExt)) {
        continue;
      }

      const targetPath = path.join(extrFolder, filename);
      fs.writeFileSync(targetPath, entry.getData());
      extractedPages.push(filename);
    }

    try {
      fs.unlinkSync(zipFile.path);
    } catch (e) {}

    if (extractedPages.length === 0) {
      throw new Error("No valid images (.jpg, .png, .webp, .gif) found inside the uploaded ZIP");
    }

    const sortedPages = extractedPages.sort((a, b) => {
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
    });

    const pagesArray = sortedPages.map((filename, idx) => ({
      index: idx + 1,
      url: `/uploads/${slug}/${chapterSlug}/${filename}`
    }));

    let existingChIdx = manga.chapters.findIndex((c: any) => c.chapter === chapterNumStr);
    const chapterPayload = {
      index: existingChIdx >= 0 ? existingChIdx : manga.chapters.length,
      id: `ch-${chapterNumStr}`,
      chapter: chapterNumStr,
      title: `Chapter ${chapterNumStr}`,
      pages: pagesArray
    };

    if (existingChIdx >= 0) {
      manga.chapters[existingChIdx] = chapterPayload;
    } else {
      manga.chapters.push(chapterPayload);
    }

    manga.chapters.sort((a: any, b: any) => parseFloat(a.chapter) - parseFloat(b.chapter));
    manga.chapters.forEach((ch: any, idx: number) => { ch.index = idx; });

    fs.writeFileSync(dbPath, JSON.stringify(mangaDb, null, 2), "utf-8");
    return res.json({ success: true, mangaId, title: manga.title });
  } catch (err: any) {
    console.error("ZIP Upload error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Serve direct views in dev and production
app.get("/", (req, res) => {
  res.render("index.ejs");
});
app.get("/ejs", (req, res) => {
  res.render("index.ejs");
});

// Launch Server
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[SERVER] Portal running successfully at http://localhost:${PORT}`);
  });
}

startServer();
