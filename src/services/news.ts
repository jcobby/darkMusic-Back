/**
 * Ghana music / hip-hop news aggregator. Pulls a handful of Ghanaian
 * entertainment + African-music RSS feeds, normalises + de-dupes them, sorts by
 * date and files each item into one of three buckets (news / hip-hop / new
 * releases). Results are cached in-memory so the feeds are hit at most once per
 * TTL. Everything is best-effort: a feed that fails is skipped, never throwing.
 *
 * No XML dependency — RSS 2.0 <item> blocks are regular enough to parse by hand.
 */

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  date: string | null; // ISO
  image: string | null;
  category: "news" | "hiphop" | "release";
}

export interface NewsData {
  updatedAt: string;
  news: NewsItem[];
  hiphop: NewsItem[];
  releases: NewsItem[];
}

interface Feed {
  url: string;
  source: string;
}

// Validated as returning parseable RSS (2026-07). Any that break are skipped.
// Every item is filtered to music-related content regardless of source.
const FEEDS: Feed[] = [
  { url: "https://notjustok.com/feed/", source: "NotJustOk" },
  { url: "https://ameyawdebrah.com/feed/", source: "Ameyaw Debrah" },
  { url: "https://zionfelix.net/feed/", source: "ZionFelix" },
  { url: "https://www.myjoyonline.com/feed/", source: "MyJoyOnline" },
  { url: "https://3news.com/feed/", source: "3News" },
];

const TTL_MS = 20 * 60 * 1000; // refresh feeds at most every 20 min
const PER_BUCKET = 12;

const MUSIC =
  /\b(music|song|single|album|ep|mixtape|track|rap|rapper|hip[\s-]?hop|hiplife|afrobeats?|drill|amapiano|artiste|musician|singer|vgma|tgma|grammy|feat\.?|ft\.?|produced by|new release)\b/i;
// Lyric-dump pages ("X Lyrics by Y") flood some feeds and aren't headlines.
const EXCLUDE = /\blyrics\b/i;
const HIPHOP =
  /\b(hip[\s-]?hop|rap|rapper|drill|freestyle|cypher|bars|verse|emcee|sarkodie|medikal|black sherif|kwesi arthur)\b/i;
const RELEASE =
  /\b(new (song|single|track|ep|album|video|project|mixtape)|drops?|releases?|unveils?|premieres?|out now|listen to|watch the (video|visuals?)|returns with|album|single|mixtape|\bep\b)\b/i;

/** Strip CDATA + tags and decode the common HTML entities feeds use. */
function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;|&#8217;|&rsquo;/g, "’")
    .replace(/&#8216;|&lsquo;/g, "‘")
    .replace(/&#8220;|&ldquo;/g, "“")
    .replace(/&#8221;|&rdquo;/g, "”")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/&#8230;|&hellip;/g, "…")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function field(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : null;
}

function extractImage(block: string): string | null {
  // Require http(s) so lazy-load base64 placeholders are skipped.
  const media = block.match(/<media:(?:content|thumbnail)[^>]*\surl="(https?:[^"]+)"/i);
  if (media) return media[1];
  const enc = block.match(/<enclosure[^>]*\surl="(https?:[^"]+)"[^>]*type="image[^"]*"/i);
  if (enc) return enc[1];
  const img = block.match(/<img[^>]*\ssrc="(https?:[^"]+)"/i);
  if (img) return img[1];
  return null;
}

function categorize(text: string): NewsItem["category"] {
  // Hip-hop first so rap headlines fill their own section; other music drops
  // fall through to "release"; everything else is general music news.
  if (HIPHOP.test(text)) return "hiphop";
  if (RELEASE.test(text)) return "release";
  return "news";
}

async function fetchFeed(feed: Feed): Promise<NewsItem[]> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DarkYardBot/1.0)" },
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const xml = await res.text();
    const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];

    const items: NewsItem[] = [];
    for (const block of blocks) {
      const rawTitle = field(block, "title");
      const rawLink = field(block, "link");
      if (!rawTitle || !rawLink) continue;
      const title = decode(rawTitle);
      const link = decode(rawLink);
      if (!title || !/^https?:\/\//i.test(link)) continue;
      if (EXCLUDE.test(title)) continue; // skip lyric-dump pages

      const desc = decode(field(block, "description") ?? field(block, "content:encoded") ?? "");
      if (!MUSIC.test(`${title} ${desc}`)) continue; // keep music-related items only

      const pub = field(block, "pubDate");
      const date = pub ? new Date(pub.trim()) : null;
      items.push({
        title,
        link,
        source: feed.source,
        date: date && !isNaN(date.getTime()) ? date.toISOString() : null,
        image: extractImage(block),
        category: categorize(`${title} ${desc}`),
      });
    }
    return items;
  } catch {
    return []; // timeout / network / parse issue — skip this feed
  }
}

let cache: { at: number; data: NewsData } | null = null;

async function build(): Promise<NewsData> {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const all: NewsItem[] = [];
  for (const r of results) if (r.status === "fulfilled") all.push(...r.value);

  // De-dupe by normalised title (same story across sources) and by link.
  const seen = new Set<string>();
  const unique = all.filter((it) => {
    const key = it.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key) || seen.has(it.link)) return false;
    seen.add(key);
    seen.add(it.link);
    return true;
  });

  // Newest first; undated items sink to the bottom.
  unique.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  const bucket = (c: NewsItem["category"]) =>
    unique.filter((it) => it.category === c).slice(0, PER_BUCKET);

  return {
    updatedAt: new Date().toISOString(),
    news: bucket("news"),
    hiphop: bucket("hiphop"),
    releases: bucket("release"),
  };
}

/** Cached aggregate of Ghana music/hip-hop/new-release headlines. */
export async function getNews(): Promise<NewsData> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const data = await build();
  const total = data.news.length + data.hiphop.length + data.releases.length;
  // If every feed failed but we have a previous snapshot, keep serving it.
  if (total === 0 && cache) return cache.data;
  cache = { at: Date.now(), data };
  return data;
}
