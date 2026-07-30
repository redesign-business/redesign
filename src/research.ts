import { createHash } from "node:crypto";
import { extname } from "node:path";
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import TurndownService from "turndown";

export type ResearchFile = {
  path: string;
  content: Buffer;
};

type PageData = {
  url: string;
  title: string;
  markdown: string;
};

type ImageData = {
  pageUrl: string;
  pageTitle?: string;
  sourceUrl: string;
  localPath: string;
  alt?: string;
  title?: string;
  nearestHeading?: string;
  context?: string;
  linkHref?: string;
  linkText?: string;
  contentType?: string;
  bytes: number;
};

type ImageCandidate = {
  pageUrl: string;
  pageTitle?: string;
  sourceUrl: string;
  alt?: string;
  title?: string;
  nearestHeading?: string;
  context?: string;
  linkHref?: string;
  linkText?: string;
};

const maxPages = Number(process.env.REDESIGN_RESEARCH_MAX_PAGES ?? 40);
const maxImagesPerPage = Number(process.env.REDESIGN_RESEARCH_MAX_IMAGES_PER_PAGE ?? 40);
const fetchTimeoutMs = Number(process.env.REDESIGN_RESEARCH_FETCH_TIMEOUT_MS ?? 10_000);
const minImageBytes = Number(process.env.REDESIGN_RESEARCH_MIN_IMAGE_BYTES ?? 1_000);

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});

export async function collectResearchFiles(site: string, workdir: string): Promise<ResearchFile[]> {
  const origin = new URL(site).origin;
  const seen = new Set<string>();
  const queue = [site];
  const pages: PageData[] = [];
  const imageCandidates: ImageCandidate[] = [];

  while (queue.length && pages.length < maxPages) {
    const url = queue.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const html = await fetchHtml(url);
    if (!html) continue;

    const page = htmlToMarkdown(url, html);
    pages.push(page);

    const $ = cheerio.load(html);
    $("script, style, noscript").remove();
    for (const href of sameDomainLinks($, url, origin)) {
      if (!seen.has(href) && !queue.includes(href) && pages.length + queue.length < maxPages) {
        queue.push(href);
      }
    }
    imageCandidates.push(...imageUrls($, url, page.title).slice(0, maxImagesPerPage));
  }

  const images = await downloadImages(dedupeImages(imageCandidates));
  return [
    {
      path: `${workdir}/raw.md`,
      content: Buffer.from(rawMarkdown(site, pages, images)),
    },
    {
      path: `${workdir}/public/images/manifest.json`,
      content: Buffer.from(`${JSON.stringify({ sourceUrl: site, images }, null, 2)}\n`),
    },
    ...images.map((image) => ({
      path: `${workdir}/${image.localPath}`,
      content: imageContent.get(image.localPath) ?? Buffer.alloc(0),
    })),
  ];
}

export function normalizeSameDomainUrl(value: string, baseUrl: string, origin: string) {
  try {
    const url = new URL(value, baseUrl);
    if (url.origin !== origin) return undefined;
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    if (/\.(avif|css|gif|ico|jpe?g|js|json|pdf|png|svg|webp|xml|zip)$/i.test(url.pathname)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function parseSrcset(value: string, baseUrl: string) {
  return value
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .map((url) => absoluteUrl(url, baseUrl))
    .filter((url): url is string => Boolean(url));
}

async function fetchHtml(url: string) {
  const response = await fetchWithTimeout(url);
  if (!response?.ok) return undefined;
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) return undefined;
  return response.text();
}

async function fetchWithTimeout(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "redesign-research-bot/0.1",
        accept: "text/html,application/xhtml+xml,image/*,*/*;q=0.8",
      },
    });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function htmlToMarkdown(url: string, html: string): PageData {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  const title = $("title").first().text().trim();
  const body = $("body").html() ?? html;
  return {
    url,
    title,
    markdown: turndown.turndown(body).replace(/\n{3,}/g, "\n\n").trim(),
  };
}

function sameDomainLinks($: cheerio.CheerioAPI, pageUrl: string, origin: string) {
  return [...new Set($("a[href]")
    .map((_, element) => normalizeSameDomainUrl($(element).attr("href") ?? "", pageUrl, origin))
    .get()
    .filter((url): url is string => Boolean(url)))];
}

function imageUrls($: cheerio.CheerioAPI, pageUrl: string, pageTitle?: string): ImageCandidate[] {
  const images: ImageCandidate[] = [];

  $("img").each((_, element) => {
    const alt = textAttr($, element, "alt");
    const title = textAttr($, element, "title");
    const context = imageContext($, element, pageUrl);
    for (const attr of ["src", "data-src", "data-lazy-src"]) {
      const sourceUrl = absoluteUrl($(element).attr(attr), pageUrl);
      if (sourceUrl) images.push({ pageUrl, pageTitle, sourceUrl, alt, title, ...context });
    }
    for (const attr of ["srcset", "data-srcset"]) {
      for (const sourceUrl of parseSrcset($(element).attr(attr) ?? "", pageUrl)) {
        images.push({ pageUrl, pageTitle, sourceUrl, alt, title, ...context });
      }
    }
  });

  $("source[srcset]").each((_, element) => {
    for (const sourceUrl of parseSrcset($(element).attr("srcset") ?? "", pageUrl)) {
      images.push({ pageUrl, pageTitle, sourceUrl, ...imageContext($, element, pageUrl) });
    }
  });

  for (const selector of [
    'meta[property="og:image"]',
    'meta[name="twitter:image"]',
  ]) {
    const sourceUrl = absoluteUrl($(selector).attr("content"), pageUrl);
    if (sourceUrl) images.push({ pageUrl, pageTitle, sourceUrl, context: "Social preview image for this page." });
  }

  return images;
}

function imageContext($: cheerio.CheerioAPI, element: Element, pageUrl: string) {
  const $element = $(element);
  const containerText = $element.parents("figure, article, section, li, div, main, body")
    .toArray()
    .map((parent) => conciseText($(parent).text()))
    .find((text) => text && text.length > 20);
  const link = $element.closest("a[href]");
  return {
    nearestHeading: nearestHeading($, $element),
    context: containerText,
    linkHref: absoluteUrl(link.attr("href"), pageUrl) ?? link.attr("href"),
    linkText: conciseText(link.text()),
  };
}

function nearestHeading($: cheerio.CheerioAPI, element: cheerio.Cheerio<Element>) {
  for (const node of [element[0], ...element.parents().toArray()]) {
    const previous = $(node).prevAll("h1,h2,h3,h4,h5,h6").first().text();
    if (previous) return conciseText(previous);
  }

  const parentHeading = element.parents().toArray()
    .map((parent) => $(parent).children("h1,h2,h3,h4,h5,h6").first().text())
    .find(Boolean);
  if (parentHeading) return conciseText(parentHeading);

  const section = element.closest("section, article, main, body");
  return conciseText(section.find("h1,h2,h3,h4,h5,h6").first().text());
}

function conciseText(value: string | undefined, maxLength = 500) {
  const text = value
    ?.replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function absoluteUrl(value: string | undefined, baseUrl: string) {
  if (!value || value.startsWith("data:")) return undefined;
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function textAttr($: cheerio.CheerioAPI, element: Element, attr: string) {
  return $(element).attr(attr)?.replace(/\s+/g, " ").trim() || undefined;
}

function dedupeImages(images: ImageCandidate[]) {
  const seen = new Set<string>();
  return images.filter((image) => {
    const key = imageKey(image.sourceUrl);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function imageKey(sourceUrl: string) {
  const url = new URL(sourceUrl);
  return `${url.origin}${url.pathname}`.toLowerCase();
}

const imageContent = new Map<string, Buffer>();

async function downloadImages(images: ImageCandidate[]): Promise<ImageData[]> {
  imageContent.clear();
  const downloaded: ImageData[] = [];

  for (const image of images) {
    const response = await fetchWithTimeout(image.sourceUrl);
    if (!response?.ok) continue;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) continue;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength < minImageBytes) continue;
    const localPath = `public/images/${imageFilename(image.sourceUrl, contentType, buffer)}`;
    if (imageContent.has(localPath)) continue;

    imageContent.set(localPath, buffer);
    downloaded.push({
      ...image,
      localPath,
      contentType,
      bytes: buffer.byteLength,
    });
  }

  return downloaded;
}

function imageFilename(sourceUrl: string, contentType: string, buffer: Buffer) {
  const url = new URL(sourceUrl);
  const basename = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "image")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-|-$/g, "");
  const extension = extname(basename) || extensionForContentType(contentType);
  const stem = (extension ? basename.slice(0, -extension.length) : basename) || "image";
  const hash = createHash("sha1").update(buffer).digest("hex").slice(0, 10);
  return `${stem.slice(0, 80)}-${hash}${extension || ".img"}`;
}

function extensionForContentType(contentType: string) {
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  if (type === "image/jpeg") return ".jpg";
  if (type === "image/png") return ".png";
  if (type === "image/webp") return ".webp";
  if (type === "image/gif") return ".gif";
  if (type === "image/svg+xml") return ".svg";
  if (type === "image/avif") return ".avif";
  return "";
}

function rawMarkdown(site: string, pages: PageData[], images: ImageData[]) {
  return [
    `# Raw site scrape`,
    "",
    `Source URL: ${site}`,
    `Fetched pages: ${pages.length}`,
    `Downloaded images: ${images.length}`,
    "",
    "## Images",
    "",
    "See `public/images/manifest.json` for image source URLs and page context.",
    "",
    ...pages.flatMap((page) => [
      `## Page: ${page.title || page.url}`,
      "",
      `URL: ${page.url}`,
      "",
      page.markdown,
      "",
    ]),
  ].join("\n");
}
