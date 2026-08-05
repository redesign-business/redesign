import { createHash } from "node:crypto";
import {
  listBusinessesForDiscoveryQualification,
  listDiscoveryFunnel,
  recordBusinessDiscovery,
  upsertDiscoveredBusiness,
  updateBusinessDiscoveryContactInfo,
  type DiscoveredBusinessRecord,
  type DiscoveryFunnelRow,
} from "./db.js";
import { collectContactInfo } from "./research.js";

export type Bounds = {
  low: { latitude: number; longitude: number };
  high: { latitude: number; longitude: number };
};

export type Place = {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  businessStatus?: string;
  websiteUri?: string;
};

type Verification = {
  verification_status: "pending" | "verified" | "invalid";
  catch_all?: boolean | "pending";
};

type DiscoveryResult = {
  queries: number;
  uniqueBusinesses: number;
  failedBusinesses: number;
  saturatedCells: number;
  overall: DiscoveryFunnelRow | null;
  byCategory: DiscoveryFunnelRow[];
  byArea: DiscoveryFunnelRow[];
  byCombination: DiscoveryFunnelRow[];
};

type DiscoveryQuery = { category: string; area: string };

export const DISCOVERY_CATEGORIES = [
  "custom home builders",
  "home remodelers",
  "general contractors",
  "residential architects",
  "interior designers",
  "landscape design-build firms",
  "roofing contractors",
  "HVAC contractors",
  "plumbing contractors",
  "electrical contractors",
  "law firms",
  "wealth management firms",
  "financial advisors",
  "commercial real estate firms",
  "dentists",
  "orthodontists",
  "medical spas",
  "plastic surgeons",
  "wedding venues",
] as const;

export const DISCOVERY_AREAS = [
  "Incline Village, Nevada",
  "Reno, Nevada",
  "Sparks, Nevada",
  "Carson City, Nevada",
  "Minden, Nevada",
  "Gardnerville, Nevada",
  "Truckee, California",
  "Tahoe City, California",
  "South Lake Tahoe, California",
] as const;

const GOOGLE_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const INSTANTLY_VERIFICATION_URL = "https://api.instantly.ai/api/v2/email-verification";
const MAX_RESULTS_PER_CELL = 60;
const MAX_SEARCH_DEPTH = 5;
const MAX_SEARCH_CELLS = 256;
const MIN_CELL_SPAN_DEGREES = 0.002;

export function splitBounds(bounds: Bounds): Bounds[] {
  const middle = {
    latitude: (bounds.low.latitude + bounds.high.latitude) / 2,
    longitude: (bounds.low.longitude + bounds.high.longitude) / 2,
  };
  return [
    { low: bounds.low, high: middle },
    { low: { latitude: bounds.low.latitude, longitude: middle.longitude }, high: { latitude: middle.latitude, longitude: bounds.high.longitude } },
    { low: { latitude: middle.latitude, longitude: bounds.low.longitude }, high: { latitude: bounds.high.latitude, longitude: middle.longitude } },
    { low: middle, high: bounds.high },
  ];
}

export async function collectPlaces(
  bounds: Bounds,
  searchCell: (cell: Bounds) => Promise<Place[]>,
  limits = { maxDepth: MAX_SEARCH_DEPTH, maxCells: MAX_SEARCH_CELLS, minSpan: MIN_CELL_SPAN_DEGREES },
) {
  const places = new Map<string, Place>();
  let searchedCells = 0;
  let saturatedCells = 0;

  async function visit(cell: Bounds, depth: number): Promise<void> {
    searchedCells += 1;
    if (searchedCells > limits.maxCells) throw new Error(`Google Places search exceeded ${limits.maxCells} cells`);
    const results = await searchCell(cell);
    for (const place of results) if (place.id) places.set(place.id, place);
    if (results.length < MAX_RESULTS_PER_CELL) return;

    const latitudeSpan = cell.high.latitude - cell.low.latitude;
    const longitudeSpan = cell.high.longitude - cell.low.longitude;
    if (depth >= limits.maxDepth || Math.min(latitudeSpan, longitudeSpan) <= limits.minSpan) {
      saturatedCells += 1;
      return;
    }
    for (const child of splitBounds(cell)) await visit(child, depth + 1);
  }

  await visit(bounds, 0);
  return { places: [...places.values()], saturatedCells };
}

export function isEmailEligible(verificationStatus: string | null, _catchAll: boolean | null) {
  return verificationStatus === "verified";
}

export function discoveredBusinessSlug(name: string, placeId: string) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "business";
  return `${base}-${createHash("sha256").update(placeId).digest("hex").slice(0, 8)}`;
}

export async function discoverBusinesses(category: string, area: string): Promise<DiscoveryResult> {
  return discoverQueries([{ category, area }]);
}

export function discoveryMatrix(): DiscoveryQuery[] {
  return DISCOVERY_CATEGORIES.flatMap((category) => DISCOVERY_AREAS.map((area) => ({ category, area })));
}

export async function discoverBusinessMatrix(): Promise<DiscoveryResult> {
  return discoverQueries(discoveryMatrix());
}

async function discoverQueries(queries: DiscoveryQuery[]): Promise<DiscoveryResult> {
  const googleApiKey = requiredEnv("GOOGLE_MAPS_API_KEY");
  const instantlyApiKey = requiredEnv("INSTANTLY_API_KEY");
  const areaBounds = new Map<string, Bounds>();
  const candidates = new Map<string, DiscoveredBusinessRecord>();
  let saturatedCells = 0;

  for (const [index, query] of queries.entries()) {
    let bounds = areaBounds.get(query.area);
    if (!bounds) {
      bounds = await geocodeArea(query.area, googleApiKey);
      areaBounds.set(query.area, bounds);
    }
    const found = await collectPlaces(bounds, (cell) => searchPlaces(query.category, cell, googleApiKey));
    saturatedCells += found.saturatedCells;
    for (const place of found.places) {
      let business = candidates.get(place.id);
      if (!business) {
        const name = place.displayName?.text?.trim() || place.id;
        business = await upsertDiscoveredBusiness({
          googlePlaceId: place.id,
          googleBusinessStatus: place.businessStatus,
          name,
          slug: discoveredBusinessSlug(name, place.id),
          website: httpUrl(place.websiteUri),
          address: place.formattedAddress,
        });
        candidates.set(place.id, business);
      }
      await recordBusinessDiscovery(business.id, query.category, query.area);
    }
    console.log(`[${index + 1}/${queries.length}] ${query.category} in ${query.area}: ${found.places.length}`);
  }

  const failedBusinesses = await qualifyBusinesses([...candidates.values()], instantlyApiKey);

  const funnel = await listDiscoveryFunnel();
  return {
    queries: queries.length,
    uniqueBusinesses: candidates.size,
    failedBusinesses,
    saturatedCells,
    ...groupFunnel(funnel, queries),
  };
}

export async function qualifyDiscoveredBusinesses() {
  const businesses = await listBusinessesForDiscoveryQualification();
  const failedBusinesses = await qualifyBusinesses(businesses, requiredEnv("INSTANTLY_API_KEY"));
  return {
    businesses: businesses.length,
    failedBusinesses,
    ...groupFunnel(await listDiscoveryFunnel()),
  };
}

async function qualifyBusinesses(businesses: DiscoveredBusinessRecord[], instantlyApiKey: string) {
  let failedBusinesses = 0;
  let completed = 0;
  // ponytail: one hundred independent domains keep this broad pilot practical; add adaptive throttling only if failures show it is needed.
  await runPool(businesses, 100, async (business) => {
      try {
        await qualifyBusiness(business, instantlyApiKey);
      } catch (error) {
        failedBusinesses += 1;
        console.error(`${business.name}: ${error instanceof Error ? error.message : error}`);
      } finally {
        completed += 1;
        if (completed % 25 === 0 || completed === businesses.length) console.log(`Qualified ${completed}/${businesses.length} businesses`);
      }
  });
  return failedBusinesses;
}

export async function runPool<T>(items: T[], concurrency: number, task: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await task(item);
    }
  }));
}

async function qualifyBusiness(business: DiscoveredBusinessRecord, instantlyApiKey: string) {
  if (business.googleBusinessStatus === "CLOSED_PERMANENTLY" || !business.website) return;
  if (business.contactCheckedAt) {
    if (!business.email || business.emailVerificationStatus === "verified" || business.emailVerificationStatus === "invalid") return;
    const verification = await existingOrPendingVerification(
      business.email,
      business.emailVerificationStatus ?? "pending",
      business.emailCatchAll,
      instantlyApiKey,
    );
    await updateBusinessDiscoveryContactInfo(business.id, {
      email: business.email,
      emailVerificationStatus: verification.verification_status,
      emailCatchAll: verification.catch_all === true ? true : verification.catch_all === false ? false : null,
    });
    return;
  }

  const contact = await collectContactInfo(business.website);
  const email = contact.email ?? business.email ?? undefined;
  const contactFormUrl = contact.contactFormUrl ?? business.contactFormUrl ?? undefined;
  if (!email) {
    await updateBusinessDiscoveryContactInfo(business.id, { contactFormUrl });
    return;
  }

  const verification = business.email === email && business.emailVerificationStatus
    ? await existingOrPendingVerification(email, business.emailVerificationStatus, business.emailCatchAll, instantlyApiKey)
    : await createVerification(email, instantlyApiKey);
  const emailCatchAll = verification.catch_all === true ? true : verification.catch_all === false ? false : null;
  await updateBusinessDiscoveryContactInfo(business.id, {
    email,
    contactFormUrl,
    emailVerificationStatus: verification.verification_status,
    emailCatchAll,
  });
}

export function groupFunnel(rows: DiscoveryFunnelRow[], expected: DiscoveryQuery[] = []) {
  const byCategory = rows.filter((row) => row.category !== null && row.area === null);
  const byArea = rows.filter((row) => row.category === null && row.area !== null);
  const byCombination = rows.filter((row) => row.category !== null && row.area !== null);
  for (const query of expected) {
    if (!byCategory.some((row) => row.category === query.category)) byCategory.push(emptyFunnelRow(query.category, null));
    if (!byArea.some((row) => row.area === query.area)) byArea.push(emptyFunnelRow(null, query.area));
    if (!byCombination.some((row) => row.category === query.category && row.area === query.area)) {
      byCombination.push(emptyFunnelRow(query.category, query.area));
    }
  }
  return {
    overall: rows.find((row) => row.category === null && row.area === null) ?? null,
    byCategory,
    byArea,
    byCombination,
  };
}

function emptyFunnelRow(category: string | null, area: string | null): DiscoveryFunnelRow {
  return {
    category,
    area,
    total: 0,
    withWebsite: 0,
    verifiedEmail: 0,
    verifiedCatchAll: 0,
    contactForm: 0,
    contactable: 0,
    invalidEmail: 0,
    websitePercent: 0,
    verifiedEmailPercent: 0,
    contactFormPercent: 0,
    contactablePercent: 0,
  };
}

async function geocodeArea(area: string, apiKey: string): Promise<Bounds> {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", area);
  url.searchParams.set("key", apiKey);
  const response = await requestJson<{
    status: string;
    error_message?: string;
    results?: Array<{ geometry?: { bounds?: GoogleBounds; viewport?: GoogleBounds } }>;
  }>(url, {}, "Google Geocoding");
  const geometry = response.results?.[0]?.geometry;
  const bounds = geometry?.bounds ?? geometry?.viewport;
  if (response.status !== "OK" || !bounds) throw new Error(response.error_message ?? `Google could not resolve area: ${area}`);
  return {
    low: { latitude: bounds.southwest.lat, longitude: bounds.southwest.lng },
    high: { latitude: bounds.northeast.lat, longitude: bounds.northeast.lng },
  };
}

type GoogleBounds = {
  southwest: { lat: number; lng: number };
  northeast: { lat: number; lng: number };
};

async function searchPlaces(category: string, bounds: Bounds, apiKey: string) {
  const places: Place[] = [];
  let pageToken: string | undefined;
  do {
    const response = await requestJson<{ places?: Place[]; nextPageToken?: string }>(GOOGLE_TEXT_SEARCH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.businessStatus,places.websiteUri,nextPageToken",
      },
      body: JSON.stringify({
        textQuery: category,
        pageSize: 20,
        pageToken,
        includePureServiceAreaBusinesses: true,
        locationRestriction: { rectangle: bounds },
      }),
    }, "Google Places");
    places.push(...(response.places ?? []));
    pageToken = response.nextPageToken;
  } while (pageToken && places.length < MAX_RESULTS_PER_CELL);
  return places.slice(0, MAX_RESULTS_PER_CELL);
}

export async function existingOrPendingVerification(
  email: string,
  status: string,
  catchAll: boolean | null,
  apiKey: string,
): Promise<Verification> {
  if (status === "verified" || status === "invalid") {
    return { verification_status: status, catch_all: catchAll ?? undefined };
  }
  return createVerification(email, apiKey);
}

async function createVerification(email: string, apiKey: string) {
  const verification = await instantlyRequest<Verification>("", apiKey, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  return verification.verification_status === "pending" ? pollVerification(email, apiKey) : verification;
}

async function pollVerification(email: string, apiKey: string): Promise<Verification> {
  let verification: Verification = { verification_status: "pending", catch_all: "pending" };
  for (let attempt = 0; attempt < 15 && verification.verification_status === "pending"; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 2_000));
    verification = await instantlyRequest<Verification>(`/${encodeURIComponent(email)}`, apiKey);
  }
  return verification;
}

function instantlyRequest<T>(path: string, apiKey: string, init: RequestInit = {}) {
  return requestJson<T>(`${INSTANTLY_VERIFICATION_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...init.headers,
    },
  }, "Instantly email verification");
}

async function requestJson<T>(url: string | URL, init: RequestInit, label: string): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function httpUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
