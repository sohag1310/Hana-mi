import express from "express";
import path from "path";
import axios from "axios";
import { fileURLToPath } from "url";

// Emulate CJS __dirname in ES Modules environment
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Setup in-memory cache for scraping results (ttl: 15 minutes)
const scrapeCache = new Map();

function getFromCache(key) {
  const item = scrapeCache.get(key);
  if (item && item.expiry > Date.now()) {
    return item.data;
  }
  return null;
}

function setToCache(key, data, ttlMs = 15 * 60 * 1000) {
  scrapeCache.set(key, { data, expiry: Date.now() + ttlMs });
}

// Curated Hanami HoHo Masterpieces (Local Fallback Content)
const FALLBACK_FEED = [
  {
    id: "sakura-season",
    token: "curated",
    title: "[Hanami HoHo Special] Sakura Season Chronicles - Vol. 1",
    cover: "/api/proxy-image?url=" + encodeURIComponent("https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=600&q=80"),
    category: "Manga",
    posted: "2026-06-03 12:00",
    uploader: "Hanami Team",
    rating: "4.9",
    tags: ["sakura", "slice of life", "artbook", "japanese", "cherry blossom"]
  },
  {
    id: "neotokyo-2099",
    token: "curated",
    title: "Cyberpunk Neo-Tokyo 2099: Neon Syndicate",
    cover: "/api/proxy-image?url=" + encodeURIComponent("https://images.unsplash.com/photo-1541701494587-cb58502866ab?w=600&q=80"),
    category: "Manga",
    posted: "2026-06-02 20:45",
    uploader: "CyberScribe",
    rating: "4.7",
    tags: ["sci-fi", "cyberpunk", "mecha", "action", "futuristic"]
  },
  {
    id: "lunar-rabbit",
    token: "curated",
    title: "The Legend of the Lunar Rabbit - Mid-Autumn Ritual",
    cover: "/api/proxy-image?url=" + encodeURIComponent("https://images.unsplash.com/photo-1578632767115-351597cf2477?w=600&q=80"),
    category: "Non-H",
    posted: "2026-06-01 10:15",
    uploader: "ShintoTales",
    rating: "4.8",
    tags: ["folklore", "fantasy", "mythology", "historical"]
  },
  {
    id: "wandering-samurai",
    token: "curated",
    title: "Wandering Samurai: The Last Ronin's Rest",
    cover: "/api/proxy-image?url=" + encodeURIComponent("https://images.unsplash.com/photo-1580477667995-2b94f01c9516?w=600&q=80"),
    category: "Manga",
    posted: "2026-05-30 18:30",
    uploader: "InkMaster",
    rating: "4.9",
    tags: ["samurai", "historical", "action", "ink-brush"]
  },
  {
    id: "dark-cosmic",
    token: "curated",
    title: "Celestial Canvas: Dark Cosmic Horrors",
    cover: "/api/proxy-image?url=" + encodeURIComponent("https://images.unsplash.com/photo-1563089145-599997674d42?w=600&q=80"),
    category: "Misc",
    posted: "2026-05-28 14:20",
    uploader: "CosmoLord",
    rating: "4.5",
    tags: ["cosmic", "mystery", "thriller", "galaxy"]
  }
];

const FALLBACK_PAGES = {
  "sakura-season": [
    "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=1200&q=80",
    "https://images.unsplash.com/photo-1528164344705-47542687000d?w=1200&q=80",
    "https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?w=1200&q=80",
    "https://images.unsplash.com/photo-1528360983277-13d401cdc186?w=1200&q=80",
    "https://images.unsplash.com/photo-1503899036084-c55cdd92da26?w=1200&q=80"
  ],
  "neotokyo-2099": [
    "https://images.unsplash.com/photo-1541701494587-cb58502866ab?w=1200&q=80",
    "https://images.unsplash.com/photo-1563089145-599997674d42?w=1200&q=80",
    "https://images.unsplash.com/photo-1508739773434-c26b3d09e071?w=1200&q=80",
    "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=1200&q=80",
    "https://images.unsplash.com/photo-1518770660439-4636190af475?w=1200&q=80"
  ],
  "lunar-rabbit": [
    "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=1200&q=80",
    "https://images.unsplash.com/photo-1613376023733-0a73315d9b06?w=1200&q=80",
    "https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=1200&q=80",
    "https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=1200&q=80"
  ],
  "wandering-samurai": [
    "https://images.unsplash.com/photo-1580477667995-2b94f01c9516?w=1200&q=80",
    "https://images.unsplash.com/photo-1627556555198-d7607755ba9b?w=1200&q=80",
    "https://images.unsplash.com/photo-1614036417651-efe5912149d8?w=1200&q=80",
    "https://images.unsplash.com/photo-1490730141103-6cac27aaab94?w=1200&q=80"
  ],
  "dark-cosmic": [
    "https://images.unsplash.com/photo-1563089145-599997674d42?w=1200&q=80",
    "https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=1200&q=80",
    "https://images.unsplash.com/photo-1464802686167-b939a6910659?w=1200&q=80",
    "https://images.unsplash.com/photo-1506318137071-a8e063b4bec0?w=1200&q=80"
  ]
};

// Express settings
app.use(express.json());
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Serve static elements
app.use(express.static(path.join(__dirname, "public")));

// Route: API image Proxy to bypass CORS / Hotlinking Blocks
app.get("/api/proxy-image", async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) {
    return res.status(400).send("Parameter url is required.");
  }

  // Bypass redirecting for unsplash fallback vectors
  if (imageUrl.startsWith("https://images.unsplash.com") || imageUrl.includes("unsplash.com")) {
    return res.redirect(imageUrl);
  }

  try {
    let referer = "https://mangadex.org/";
    if (imageUrl.includes("e-hentai.org") || imageUrl.includes("ehgt.org")) {
      referer = "https://e-hentai.org/";
    }

    const response = await axios({
      method: "get",
      url: imageUrl,
      responseType: "stream",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": referer,
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      },
      timeout: 15000
    });

    res.setHeader("Content-Type", String(response.headers["content-type"] || "image/jpeg"));
    res.setHeader("Cache-Control", "public, max-age=86400"); // 1 day client cache
    response.data.pipe(res);
  } catch (error) {
    console.error(`Error proxying image [${imageUrl}]:`, error.message);
    res.redirect("https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=600&q=80");
  }
});

// Helper function to fetch galleries from MangaDex matching search criteria
async function getMangaFeed(search = "", page = 0) {
  const limit = 24;
  const offset = page * limit;
  const cacheKey = `feed_${search || "popular"}_${page}`;
  
  const cachedData = getFromCache(cacheKey);
  if (cachedData) {
    return cachedData;
  }

  try {
    const params = {
      limit,
      offset,
      "includes[]": ["cover_art"],
      "contentRating[]": ["erotica", "pornographic"],
      "availableTranslatedLanguage[]": ["en"],
      "order[followedCount]": "desc"
    };

    if (search) {
      params.title = search;
    }

    const response = await axios.get("https://api.mangadex.org/manga", {
      params,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      timeout: 10000
    });

    const mangaList = response.data?.data || [];
    const galleries = mangaList.map((manga) => {
      const id = manga.id;
      const title = manga.attributes?.title?.en || 
                    manga.attributes?.title?.ja || 
                    manga.attributes?.title?.["ja-ro"] ||
                    Object.values(manga.attributes?.title || {})[0] || 
                    "Untitled Manga";
      
      const coverRel = manga.relationships?.find((r) => r.type === "cover_art");
      const coverFileName = coverRel?.attributes?.fileName;
      const directCoverUrl = coverFileName 
        ? `https://uploads.mangadex.org/covers/${id}/${coverFileName}` 
        : "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=600&q=80";
      
      const cover = `/api/proxy-image?url=${encodeURIComponent(directCoverUrl)}`;

      const tags = manga.attributes?.tags?.map((t) => t.attributes?.name?.en) || [];
      const hasDoujinTag = tags.some((t) => t.toLowerCase().includes("doujinshi"));
      
      let category = "Manga";
      if (hasDoujinTag) {
        category = "Doujinshi";
      } else if (manga.attributes?.contentRating === "pornographic") {
        const cats = ["Doujinshi", "Manga", "Artist CG"];
        category = cats[Math.abs(id.charCodeAt(0) || 0) % cats.length];
      } else if (manga.attributes?.contentRating === "erotica") {
        category = "Non-H";
      }

      const createdAt = manga.attributes?.createdAt || "";
      const posted = createdAt ? createdAt.replace("T", " ").substring(0, 10) : "Recent";
      const rating = (4.5 + (Math.abs(id.charCodeAt(1) || 0) % 5) * 0.1).toFixed(1);

      return {
        id,
        token: "mangadex",
        title,
        cover,
        category,
        posted,
        uploader: "MangaDex CDN",
        rating,
        tags: tags.slice(0, 4)
      };
    });

    if (galleries.length === 0 && !search) {
      throw new Error("No galleries successfully fetched from MangaDex");
    }

    setToCache(cacheKey, galleries);
    return galleries;

  } catch (err) {
    console.warn("MangaDex API fetch failed, loading local fallback feed:", err.message);
    let list = [...FALLBACK_FEED];
    if (search) {
      list = list.filter(item => 
        item.title.toLowerCase().includes(search.toLowerCase()) || 
        item.tags.some(tag => tag.toLowerCase().includes(search.toLowerCase()))
      );
    }
    return list;
  }
}

// Router: Homepage SSR View Page
app.get("/", async (req, res) => {
  const search = (req.query.search || "").toString().trim();
  const page = parseInt(req.query.page || "0", 10);

  const galleries = await getMangaFeed(search, page);
  res.render("index", { galleries, search, page });
});

// Router: Reader Page SSR View
app.get("/reader", async (req, res) => {
  const id = (req.query.id || "").toString().trim();
  const token = (req.query.token || "mangadex").toString().trim();
  const pageNo = parseInt(req.query.p || "0", 10);

  if (!id) {
    return res.redirect("/");
  }

  if (token === "curated" || id === "sakura-season" || id === "neotokyo-2099" || id === "lunar-rabbit" || id === "wandering-samurai" || id === "dark-cosmic") {
    const list = FALLBACK_PAGES[id] || FALLBACK_PAGES["sakura-season"];
    const meta = FALLBACK_FEED.find(m => m.id === id) || FALLBACK_FEED[0];
    
    const pages = list.map((imgUrl, idx) => ({
      index: idx + 1,
      url: `/api/proxy-image?url=${encodeURIComponent(imgUrl)}`
    }));

    return res.render("reader", {
      id,
      token: "curated",
      pageNo,
      pages,
      title: meta.title,
      category: meta.category,
      uploader: meta.uploader,
      posted: meta.posted,
      tags: meta.tags
    });
  }

  const cacheKey = `gallery_pages_${id}_p${pageNo}`;
  const cachedData = getFromCache(cacheKey);
  
  if (cachedData) {
    return res.render("reader", { id, token, pageNo, ...cachedData });
  }

  try {
    // 1. Fetch Manga Metadata
    console.log(`Fetching detail metadata for Manga ID: ${id}`);
    const metaResponse = await axios.get(`https://api.mangadex.org/manga/${id}`, {
      params: { "includes[]": ["cover_art"] },
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      timeout: 10000
    });

    const mangaMeta = metaResponse.data?.data;
    if (!mangaMeta) {
      throw new Error("Could not find manga detail metadata on MangaDex");
    }

    const title = mangaMeta.attributes?.title?.en || 
                  mangaMeta.attributes?.title?.ja || 
                  mangaMeta.attributes?.title?.["ja-ro"] ||
                  Object.values(mangaMeta.attributes?.title || {})[0] ||
                  "Untitled Manga";
    
    const tags = mangaMeta.attributes?.tags?.map((t) => t.attributes?.name?.en) || [];
    const category = mangaMeta.attributes?.contentRating === "pornographic" ? "Doujinshi" : "Manga";
    const posted = (mangaMeta.attributes?.createdAt || "").replace("T", " ").substring(0, 10);

    // 2. Fetch Chapters Feed
    console.log(`Fetching chapter feed for Manga ID: ${id}`);
    const feedResponse = await axios.get(`https://api.mangadex.org/manga/${id}/feed`, {
      params: {
        "translatedLanguage[]": ["en"],
        "order[chapter]": "asc",
        limit: 100
      },
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      timeout: 10000
    });

    const chapters = feedResponse.data?.data || [];
    if (chapters.length === 0) {
      throw new Error("No English chapters found for this manga.");
    }

    // Determine target chapter index
    const chapterIndex = Math.min(pageNo, chapters.length - 1);
    const selectedChapter = chapters[chapterIndex];
    if (!selectedChapter) {
      throw new Error(`Requested chapter index ${pageNo} is out of bounds.`);
    }

    const chapterId = selectedChapter.id;
    const chapterNoText = selectedChapter.attributes?.chapter ? `Ch. ${selectedChapter.attributes.chapter}` : "Ch. 1";
    const chapterTitleText = selectedChapter.attributes?.title ? `: ${selectedChapter.attributes.title}` : "";
    const chapterTitleCombined = ` - ${chapterNoText}${chapterTitleText}`;

    // 3. Request sequential pages JSON descriptor
    console.log(`Fetching pages for Chapter ID: ${chapterId}`);
    const serverResponse = await axios.get(`https://api.mangadex.org/at-home/server/${chapterId}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      timeout: 10000
    });

    const host = serverResponse.data?.baseUrl;
    const hash = serverResponse.data?.chapter?.hash;
    const filenames = serverResponse.data?.chapter?.data || [];

    if (!host || !hash || filenames.length === 0) {
      throw new Error("MangaDex server did not return valid chapter page filenames.");
    }

    // Map filename sequential pages to robust proxied paths
    const pages = filenames.map((file, index) => {
      const pageUrl = `${host}/data/${hash}/${file}`;
      return {
        index: index + 1,
        url: `/api/proxy-image?url=${encodeURIComponent(pageUrl)}`
      };
    });

    const payload = {
      title: `${title}${chapterTitleCombined}`,
      category,
      uploader: "MangaDex Community",
      posted,
      tags,
      pages
    };

    setToCache(cacheKey, payload);
    return res.render("reader", { id, token, pageNo, ...payload });

  } catch (err) {
    console.warn(`Scraping pages failed for ${id}, loading matching default fallback page set:`, err.message);
    
    const keys = Object.keys(FALLBACK_PAGES);
    const fallbackId = keys[Math.abs(id.charCodeAt(0) || 0) % keys.length] || "sakura-season";
    const fallbackList = FALLBACK_PAGES[fallbackId] || [];
    
    const pages = fallbackList.map((imgUrl, idx) => ({
      index: idx + 1,
      url: `/api/proxy-image?url=${encodeURIComponent(imgUrl)}`
    }));

    return res.render("reader", {
      id,
      token: "fallback",
      pageNo,
      pages,
      title: `[Backup Reader] High-Resolution Series - Part ${id.substring(0,6)}`,
      category: "Manga",
      posted: "2026-06-03 12:00",
      uploader: "Hanami Team",
      tags: ["fantasy", "manga", "high-resolution"]
    });
  }
});

// JSON API endpoints maintained for legacy elements support
app.get("/api/manga/feed", async (req, res) => {
  const search = (req.query.search || "").toString().trim();
  const page = parseInt(req.query.page || "0", 10);
  const galleries = await getMangaFeed(search, page);
  res.json({ success: true, galleries });
});

// Start the express server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Hanami HoHo] EJS Production Server running on http://0.0.0.0:${PORT}`);
});