import express from "express";
import path from "path";
import axios from "axios";
import * as cheerio from "cheerio";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Setup viewing engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Server static files if needed
app.use(express.static(path.join(__dirname, "public")));

// Setup in-memory cache for scraping results (ttl: 10 minutes)
const cache = new Map();
function getFromCache(key) {
  const item = cache.get(key);
  if (item && item.expiry > Date.now()) {
    return item.data;
  }
  return null;
}
function setToCache(key, data, ttlMs = 10 * 60 * 1000) {
  cache.set(key, { data, expiry: Date.now() + ttlMs });
}

// User-Agent and headers to imitate a human desktop browser
const SCRAPE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "max-age=0",
  "Upgrade-Insecure-Requests": "1"
};

// Filter out structural bad images like spacer pixels, tracking gifs etc.
const BAD_KEYWORDS = [
  "spacer", "pixel", "blank", "tracking", "analytics", "ad-", "favicon", 
  "logo", "icon", "banner", "spinner", "loader", "loading", "transparent"
];

function isBadImage(src) {
  if (!src) return true;
  const lowerSrc = src.toLowerCase();
  
  if (BAD_KEYWORDS.some(keyword => lowerSrc.includes(keyword))) {
    return true;
  }
  
  if (lowerSrc.endsWith(".gif") && (lowerSrc.includes("pixel") || lowerSrc.includes("clear") || lowerSrc.includes("trans"))) {
    return true;
  }
  
  return false;
}

// Extract actual high-resolution media URLs bypassing lazy loaded placeholders
function getBestImageSrc(el) {
  if (!el) return "";
  
  const attributes = [
    "data-src",
    "data-lazy-src",
    "data-original",
    "data-cfsrc",
    "data-srcset",
    "srcset",
    "src"
  ];

  for (const attr of attributes) {
    let val = el.attr(attr);
    if (val && typeof val === "string") {
      val = val.trim();
      if (!val) continue;

      if (attr === "srcset" || attr === "data-srcset") {
        const parts = val.split(",");
        if (parts.length > 0) {
          const firstPart = parts[0].trim().split(/\s+/)[0];
          if (firstPart && !isBadImage(firstPart)) {
            val = firstPart;
          } else {
            continue;
          }
        }
      }

      const isPlaceholder = 
        val.startsWith("data:image/") || 
        val.includes("placeholder") || 
        val.includes("spacer.gif") || 
        val.includes("blank.gif") || 
        val.includes("blank.png") || 
        val.includes("spinner.gif") || 
        val.includes("trans.gif") || 
        val.endsWith("/1x1.png") || 
        val.endsWith("/1x1.gif") || 
        val.endsWith("/space.png");

      if (isPlaceholder) {
        continue;
      }

      if (val.startsWith("//")) {
        val = "https:" + val;
      }

      val = val.replace(/^['"]|['"]$/g, "").trim();
      return val;
    }
  }

  const fallbackSrc = el.attr("src") || "";
  return fallbackSrc.startsWith("//") ? "https:" + fallbackSrc : fallbackSrc;
}

// Helper to decode base64url manga details URLs
function getDecodedUrl(id) {
  try {
    const decoded = Buffer.from(id, "base64url").toString("utf-8");
    if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
      return decoded;
    }
  } catch (err) {}
  return null;
}

// API/PROXIER: Image Proxy Route to bypass HTTP 403 hotlinking restrictions
app.get("/api/proxy", async (req, res) => {
  let imageUrl = req.query.url;
  if (!imageUrl || typeof imageUrl !== "string") {
    return res.status(400).send("Image URL is required");
  }

  // Clean and sanitize the URL parameter, strip spacing, quotes, and invalid characters
  let targetUrl = imageUrl.trim().replace(/^['"]|['"]$/g, "");
  if (targetUrl.startsWith("//")) {
    targetUrl = "https:" + targetUrl;
  }

  try {
    const response = await axios({
      method: "get",
      url: targetUrl,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://novelcrow.com/",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      },
      responseType: "stream",
      timeout: 10000
    });

    // Copy Content-Type and Cache-Control headers
    const contentType = response.headers["content-type"];
    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }
    const cacheControl = response.headers["cache-control"];
    res.setHeader("Cache-Control", cacheControl || "public, max-age=86400");

    response.data.pipe(res);
  } catch (err) {
    console.error(`Proxy failure for image URL [${targetUrl}]:`, err.message);
    res.status(502).send("Failed to proxy image: " + err.message);
  }
});

// ROUTE: Main Listing Homepage (Scrape grid catalog)
app.get("/", async (req, res) => {
  const page = parseInt(req.query.page || "1", 10);
  const search = req.query.search || "";
  const cacheKey = `feed_p${page}_s_${search}`;

  const cachedFeed = getFromCache(cacheKey);
  if (cachedFeed) {
    return res.render("index", { comics: cachedFeed, page, search, error: null });
  }

  try {
    let targetUrl = page > 1 ? `https://novelcrow.com/page/${page}/` : `https://novelcrow.com/`;
    if (search) {
      targetUrl = `https://novelcrow.com/?s=${encodeURIComponent(search)}`;
    }

    console.log(`[SCRAPER] Crawling listing feed from: ${targetUrl}`);
    const response = await axios.get(targetUrl, {
      headers: SCRAPE_HEADERS,
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    const comics = [];

    // Select each comic grid container item
    $(".post-item, .comic-grid-item, .entry-card, article").each((_, element) => {
      const el = $(element);

      // Extract details links and title
      const titleLinkEl = el.find(".post-title a, h2.entry-title a, .comic-title a, a").first();
      let title = titleLinkEl.text().trim();
      let link = titleLinkEl.attr("href") || "";

      // Extract cover image bypassing lazy layouts
      const imgEl = el.find(".post-thumbnail img, .comic-cover img, .entry-thumb img, img").first();
      let cover = getBestImageSrc(imgEl);

      if (!title && imgEl.attr("alt")) {
        title = imgEl.attr("alt").trim();
      }

      if (title && link && cover) {
        // base64url encode the actual target link as the secure dynamic ID
        const encodedId = Buffer.from(link).toString("base64url");
        comics.push({
          id: encodedId,
          title,
          cover: `/api/proxy?url=${encodeURIComponent(cover)}`,
          originalLink: link,
          rating: (4.2 + (Math.abs(title.charCodeAt(0) || 0) % 8) * 0.1).toFixed(1)
        });
      }
    });

    setToCache(cacheKey, comics);
    return res.render("index", { comics, page, search, error: null });

  } catch (err) {
    console.error("Scraping Main Listing Feed Failed:", err.message);
    return res.render("index", { 
      comics: [], 
      page, 
      search, 
      error: "Could not fetch dynamic catalog from source. Please try again later." 
    });
  }
});

// ROUTE: Inner Reader Page (Scrape reading pages sequentially)
app.get("/comic/:id", async (req, res) => {
  const { id } = req.params;
  const decodedUrl = getDecodedUrl(id);

  if (!decodedUrl) {
    return res.redirect("/");
  }

  const cacheKey = `reader_${id}`;
  const cachedPages = getFromCache(cacheKey);
  if (cachedPages) {
    return res.render("reader", { 
      title: cachedPages.title, 
      pages: cachedPages.pages, 
      originalUrl: decodedUrl 
    });
  }

  try {
    console.log(`[SCRAPER] Crawling inner reader page: ${decodedUrl}`);
    const response = await axios.get(decodedUrl, {
      headers: SCRAPE_HEADERS,
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    
    // Extract title
    let title = $(".entry-title, .comic-title, h1").first().text().trim();
    if (!title) {
      title = "Dynamic Scraped Chapter";
    }

    const pages = [];
    
    // Select image files inside target reader containers
    $(".entry-content img, .reader-area-images img, .reader-images img, article img").each((_, imgEl) => {
      const el = $(imgEl);
      let src = getBestImageSrc(el);

      if (src && !isBadImage(src)) {
        pages.push({
          index: pages.length + 1,
          url: `/api/proxy?url=${encodeURIComponent(src)}`
        });
      }
    });

    // Smart fallback: scrape alternative img containers if specific container targets failed
    if (pages.length === 0) {
      $("img").each((_, imgEl) => {
        const el = $(imgEl);
        let src = getBestImageSrc(el);
        const w = el.attr("width");
        const h = el.attr("height");
        
        // Skip small layout assets, icons, logos, etc.
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

    const payload = { title, pages };
    setToCache(cacheKey, payload);

    return res.render("reader", { title, pages, originalUrl: decodedUrl });

  } catch (err) {
    console.error(`Scraping Inner Reader Page [${decodedUrl}] Failed:`, err.message);
    return res.redirect("/");
  }
});

// Fire up server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[SERVER] Production scraper portal online at http://localhost:${PORT}`);
});
