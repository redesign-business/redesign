import assert from "node:assert/strict";
import {
  DISCOVERY_AREAS,
  DISCOVERY_CATEGORIES,
  collectPlaces,
  discoveredBusinessSlug,
  discoveryMatrix,
  existingOrPendingVerification,
  groupFunnel,
  isEmailEligible,
  runPool,
  splitBounds,
  type Bounds,
  type Place,
} from "./discovery.js";

const bounds: Bounds = {
  low: { latitude: 0, longitude: 0 },
  high: { latitude: 4, longitude: 4 },
};

assert.deepEqual(splitBounds(bounds), [
  { low: { latitude: 0, longitude: 0 }, high: { latitude: 2, longitude: 2 } },
  { low: { latitude: 0, longitude: 2 }, high: { latitude: 2, longitude: 4 } },
  { low: { latitude: 2, longitude: 0 }, high: { latitude: 4, longitude: 2 } },
  { low: { latitude: 2, longitude: 2 }, high: { latitude: 4, longitude: 4 } },
]);

let searches = 0;
const saturated = Array.from({ length: 60 }, (_, index): Place => ({ id: `root-${index}` }));
const found = await collectPlaces(bounds, async (cell) => {
  searches += 1;
  if (cell === bounds) return saturated;
  return [{ id: "duplicate" }, { id: `child-${cell.low.latitude}-${cell.low.longitude}` }];
}, { maxDepth: 2, maxCells: 10, minSpan: 0.1 });
assert.equal(searches, 5);
assert.equal(found.places.length, 65);
assert.equal(found.saturatedCells, 0);

assert.equal(isEmailEligible("verified", false), true);
assert.equal(isEmailEligible("verified", true), true);
assert.equal(isEmailEligible("invalid", true), false);
assert.equal(discoveredBusinessSlug("Acme Builders", "place-1"), discoveredBusinessSlug("Acme Builders", "place-1"));

const matrix = discoveryMatrix();
assert.equal(matrix.length, 171);
assert.equal(new Set(matrix.map(({ category, area }) => `${category}\0${area}`)).size, 171);
assert.equal(DISCOVERY_CATEGORIES.length, 19);
assert.equal(DISCOVERY_AREAS.length, 9);

let active = 0;
let peakActive = 0;
const completed: number[] = [];
await runPool([1, 2, 3, 4, 5], 2, async (value) => {
  active += 1;
  peakActive = Math.max(peakActive, active);
  await new Promise((resolve) => setTimeout(resolve, value === 1 ? 10 : 1));
  completed.push(value);
  active -= 1;
});
assert.equal(peakActive, 2);
assert.deepEqual(completed.sort(), [1, 2, 3, 4, 5]);

const realFetch = globalThis.fetch;
const verificationMethods: string[] = [];
globalThis.fetch = (async (_input, init) => {
  verificationMethods.push(init?.method ?? "GET");
  return Response.json(verificationMethods.length === 1
    ? { verification_status: "pending", catch_all: "pending" }
    : { verification_status: "verified", catch_all: true });
}) as typeof fetch;
try {
  assert.deepEqual(await existingOrPendingVerification("hello@example.com", "pending", null, "key"), {
    verification_status: "verified",
    catch_all: true,
  });
  assert.deepEqual(verificationMethods, ["POST", "GET"]);
} finally {
  globalThis.fetch = realFetch;
}

const overallRow = { category: null, area: null, total: 2, withWebsite: 1, verifiedEmail: 1, verifiedCatchAll: 0, contactForm: 0, contactable: 1, invalidEmail: 0, websitePercent: 50, verifiedEmailPercent: 50, contactFormPercent: 0, contactablePercent: 50 };
const categoryRow = { ...overallRow, category: "builders", total: 1, websitePercent: 100, verifiedEmailPercent: 100, contactablePercent: 100 };
const areaRow = { ...categoryRow, category: null, area: "Reno" };
const combinationRow = { ...categoryRow, area: "Reno" };
assert.deepEqual(groupFunnel([overallRow, categoryRow, areaRow, combinationRow]), {
  overall: overallRow,
  byCategory: [categoryRow],
  byArea: [areaRow],
  byCombination: [combinationRow],
});
assert.deepEqual(groupFunnel([], [{ category: "builders", area: "Reno" }]).byCombination, [{
  category: "builders",
  area: "Reno",
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
}]);
