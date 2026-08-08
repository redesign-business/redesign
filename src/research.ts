import { createHash } from "node:crypto";
import { extname } from "node:path";
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import TurndownService from "turndown";

export type ResearchFile = {
  path: string;
  content: Buffer;
};

export type ContactInfo = {
  email?: string;
  contactFormUrl?: string;
  phone?: string;
  contactMethods: ContactMethod[];
};

export type ContactMethod = {
  type: "email" | "contact_form" | "phone";
  value: string;
};

export function validLinkTargets(pageUrls: string[], contactMethods: ContactMethod[]) {
  return [...new Set([
    "/",
    ...pageUrls,
    ...contactMethods.map(({ type, value }) => type === "email" ? `mailto:${value}` : type === "phone" ? `tel:${value}` : value),
  ])];
}

export function invalidPageLinks(page: string, validTargets: string[]) {
  const ids = new Set([...page.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]));
  const constants = new Map([...page.matchAll(/\bconst\s+(\w+)\s*=\s*["']([^"']+)["']/g)].map((match) => [match[1], match[2]]));
  const targets = [
    ...page.matchAll(/\b(?:url|href)\s*:\s*["'`]([^"'`]+)["'`]/g),
    ...page.matchAll(/\bhref\s*=\s*["']([^"']+)["']/g),
  ].map((match) => match[1].replace(/\$\{(\w+)}/g, (reference, name) => constants.get(name) ?? reference));
  const allowed = new Set(validTargets);
  return [...new Set(targets.filter((target) => target !== "/" && !(target.startsWith("#") && ids.has(target.slice(1))) && !allowed.has(target)))];
}

export function extractOutreachProof(markdown: string) {
  const section = markdown.match(/(?:^|\n)## Outreach\s*\n([\s\S]*?)(?=\n## |\s*$)/)?.[1] ?? "";
  const proof = section.match(/^(?:[-*]|\d+\.)\s+(.+)$/gm)?.map((line) => {
    const sentence = line.replace(/^(?:[-*]|\d+\.)\s+/, "").trim();
    return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
  }) ?? [];
  if (proof.length !== 3) {
    throw new Error("proof.md must begin with an Outreach section containing exactly three one-line sentences");
  }
  return proof;
}

type PageData = {
  url: string;
  title: string;
  markdown: string;
};

type ImageData = {
  id: string;
  pageUrl: string;
  pageTitle?: string;
  sourceUrl: string;
  localPath: string;
  src: string;
  alt?: string;
  title?: string;
  nearestHeading?: string;
  context?: string;
  linkHref?: string;
  linkText?: string;
  role?: "logo";
  contentType?: string;
  bytes: number;
};

type ImageCandidate = Omit<ImageData, "id" | "localPath" | "src" | "contentType" | "bytes">;

const maxPages = Number(process.env.REDESIGN_RESEARCH_MAX_PAGES ?? 40);
const maxImagesPerPage = Number(process.env.REDESIGN_RESEARCH_MAX_IMAGES_PER_PAGE ?? 40);
const fetchTimeoutMs = Number(process.env.REDESIGN_RESEARCH_FETCH_TIMEOUT_MS ?? 10_000);
const minImageBytes = Number(process.env.REDESIGN_RESEARCH_MIN_IMAGE_BYTES ?? 1_000);

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});

export async function collectResearch(site: string, workdir: string): Promise<{ files: ResearchFile[]; contactInfo: ContactInfo }> {
  const { pages, discoveredLinks, imageCandidates, contactInfo } = await crawlSite(site, maxPages, true);
  const images = (await downloadImages(dedupeImages(imageCandidates)))
    .sort((left, right) => Number(right.role === "logo") - Number(left.role === "logo"))
    .map((image, index) => ({
      ...image,
      id: `img_${String(index + 1).padStart(3, "0")}`,
      src: `/${image.localPath.replace(/^public\//, "")}`,
    }));
  return {
    contactInfo,
    files: [
      {
        path: `${workdir}/raw.md`,
        content: Buffer.from(rawMarkdown(site, pages, images)),
      },
      {
        path: `${workdir}/public/images/manifest.json`,
        content: Buffer.from(`${JSON.stringify({ sourceUrl: site, images }, null, 2)}\n`),
      },
      {
        path: `${workdir}/.redesign/valid-links.json`,
        content: Buffer.from(`${JSON.stringify({ targets: validLinkTargets(discoveredLinks, contactInfo.contactMethods) }, null, 2)}\n`),
      },
      ...images.map((image) => ({
        path: `${workdir}/${image.localPath}`,
        content: imageContent.get(image.localPath) ?? Buffer.alloc(0),
      })),
    ],
  };
}

export async function collectContactInfo(site: string): Promise<ContactInfo> {
  // ponytail: five pages covers the homepage and prioritized contact links; increase only if misses become measurable.
  return (await crawlSite(site, 5, false)).contactInfo;
}

async function crawlSite(site: string, pageLimit: number, collectAssets: boolean) {
  let origin = new URL(site).origin;
  const seen = new Set<string>();
  const queue = [site];
  const pages: PageData[] = [];
  const discoveredLinks = new Set([site]);
  const imageCandidates: ImageCandidate[] = [];
  const contactMethods = new Map<string, ContactMethod>();

  while (queue.length && pages.length < pageLimit) {
    const url = queue.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const fetched = await fetchHtml(url);
    if (!fetched) continue;
    const { html, url: pageUrl } = fetched;
    seen.add(pageUrl);
    if (pages.length === 0) origin = new URL(pageUrl).origin;

    const page = collectAssets ? htmlToMarkdown(pageUrl, html) : { url: pageUrl, title: "", markdown: "" };
    pages.push(page);

    const $ = cheerio.load(html);
    $("script, style, noscript").remove();
    for (const method of inspectContactMethods($, pageUrl)) contactMethods.set(`${method.type}\0${method.value}`, method);
    const links = sameDomainLinks($, pageUrl, origin)
      .sort((left, right) => Number(!hasContactIntent(left)) - Number(!hasContactIntent(right)));
    for (const href of links) discoveredLinks.add(href);
    for (const href of links) {
      if (!seen.has(href) && !queue.includes(href) && pages.length + queue.length < pageLimit) {
        queue.push(href);
      }
    }
    if (collectAssets) imageCandidates.push(...imageUrls($, pageUrl, page.title).slice(0, maxImagesPerPage));
  }

  return { pages, discoveredLinks: [...discoveredLinks], imageCandidates, contactInfo: summarizeContactMethods([...contactMethods.values()], origin) };
}

export function extractContactInfo(html: string, pageUrl: string): ContactInfo {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  return summarizeContactMethods(inspectContactMethods($, pageUrl), new URL(pageUrl).origin);
}

function inspectContactMethods($: cheerio.CheerioAPI, pageUrl: string): ContactMethod[] {
  const methods: ContactMethod[] = [];
  $("a[href^='mailto:' i]").each((_, element) => {
    for (const email of emailAddresses(($(element).attr("href") ?? "").slice(7).split("?")[0] ?? "")) {
      methods.push({ type: "email", value: email });
    }
  });
  $("a[href^='tel:' i]").each((_, element) => {
    for (const phone of phoneNumbers(($(element).attr("href") ?? "").slice(4))) methods.push({ type: "phone", value: phone });
  });
  const visible = $.root().find("*").contents()
    .filter((_, node) => node.type === "text")
    .map((_, node) => $(node).text())
    .get()
    .join(" ");
  for (const email of emailAddresses(visible)) methods.push({ type: "email", value: email });
  for (const phone of phoneNumbers(visible)) methods.push({ type: "phone", value: phone });
  if ($("form").toArray().some((form) => isContactForm($, form, pageUrl))) methods.push({ type: "contact_form", value: pageUrl });
  return [...new Map(methods.map((method) => [`${method.type}\0${method.value}`, method])).values()];
}

function emailAddresses(value: string) {
  try {
    return [...decodeURIComponent(value).matchAll(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}(?=$|[^a-z])/gi)]
      .map(([email]) => email.toLowerCase())
      .filter((email) => !/@(?:example\.(?:com|org|net)|example\.test)$/i.test(email))
      .filter((email) => !/^(?:example|your-?email|email)@/i.test(email));
  } catch {
    return [];
  }
}

function phoneNumbers(value: string) {
  return [...value.matchAll(/(?:\+?1[\s.(\-]*)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.\-]*\d{3}[\s.\-]*\d{4}(?:\s*(?:x|ext\.?|extension)\s*\d+)?/gi)]
    .map(([phone]) => normalizePhone(phone))
    .filter((phone): phone is string => Boolean(phone));
}

export function normalizePhone(value: string) {
  const [number, extension] = value.toLowerCase().split(/\s*(?:x|ext\.?|extension)\s*/);
  const digits = number.replace(/\D/g, "");
  const normalized = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : undefined;
  return normalized && extension ? `${normalized}x${extension.replace(/\D/g, "")}` : normalized;
}

function summarizeContactMethods(contactMethods: ContactMethod[], origin: string): ContactInfo {
  const emails = contactMethods.filter((method) => method.type === "email").map((method) => method.value);
  const host = new URL(origin).hostname.toLowerCase().replace(/^www\./, "");
  const email = emails.find((value) => {
    const domain = value.split("@")[1] ?? "";
    return host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`);
  }) ?? emails[0];
  return {
    email,
    contactFormUrl: contactMethods.find((method) => method.type === "contact_form")?.value,
    phone: contactMethods.find((method) => method.type === "phone")?.value,
    contactMethods,
  };
}

function isContactForm($: cheerio.CheerioAPI, form: Element, pageUrl: string) {
  const $form = $(form);
  const fields = $form.find("input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select");
  const fieldLabels = fields.toArray().map((field) => ["name", "placeholder", "aria-label"]
    .map((attribute) => $(field).attr(attribute))
    .filter(Boolean)
    .join(" "))
    .join(" ");
  const description = `${$form.attr("id") ?? ""} ${$form.attr("class") ?? ""} ${$form.attr("action") ?? ""} ${fieldLabels} ${$form.text()}`;
  const hasReplyField = /email|phone|message/i.test(fieldLabels);
  return fields.length >= 2 && (hasContactIntent(description) || (hasContactIntent(new URL(pageUrl).pathname) && hasReplyField));
}

function hasContactIntent(value: string) {
  return /contact|quote|estimate|consult|inquir|get[-_ ]?in[-_ ]?touch|request[-_ ]?(?:service|quote|estimate)|start[-_ ]?(?:a[-_ ]?)?project/i.test(value);
}

export function normalizeSameDomainUrl(value: string, baseUrl: string, origin: string) {
  try {
    const url = new URL(value, baseUrl);
    if (url.origin !== origin) return undefined;
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    if (!isDocumentUrl(url)) return undefined;
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
  return { html: await response.text(), url: response.url };
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

function imageUrls($: cheerio.CheerioAPI, pageUrl: string, pageTitle: string | undefined): ImageCandidate[] {
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

function isDocumentUrl(url: URL) {
  return !/\.(avif|css|gif|ico|jpe?g|js|json|pdf|png|svg|webp|xml|zip)$/i.test(url.pathname);
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

async function downloadImages(images: ImageCandidate[]): Promise<Array<Omit<ImageData, "id" | "src">>> {
  imageContent.clear();
  const downloaded: Array<Omit<ImageData, "id" | "src">> = [];

  for (const image of images) {
    const response = await fetchWithTimeout(image.sourceUrl);
    if (!response?.ok) continue;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) continue;

    const buffer = Buffer.from(await response.arrayBuffer());
    const likelyLogo = isLikelyLogo(image);
    if (buffer.byteLength < minImageBytes && !likelyLogo) continue;
    const localPath = `public/images/${imageFilename(image.sourceUrl, contentType, buffer)}`;
    if (imageContent.has(localPath)) continue;

    imageContent.set(localPath, buffer);
    downloaded.push({
      ...image,
      localPath,
      role: likelyLogo ? "logo" : undefined,
      contentType,
      bytes: buffer.byteLength,
    });
  }

  return downloaded;
}

export function isLikelyLogo(image: { sourceUrl: string; alt?: string; title?: string }) {
  return /(?:^|[^a-z])(logo|brandmark|wordmark)(?:[^a-z]|$)/i.test([image.sourceUrl, image.alt, image.title].filter(Boolean).join(" "));
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
    "# Raw site scrape",
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
