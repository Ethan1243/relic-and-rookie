/**
 * Relic & Rookie — graded-price proxy worker
 *
 * Calls PokemonPriceTracker (key-gated) and returns normalized PSA / CGC / BGS
 * grades for a given Pokemon TCG API card id. The frontend hits this worker
 * instead of the upstream API so the key stays on the server.
 *
 * Endpoints
 *   GET /price?cardId=me3-16     -> { cardId, grades: {"PSA 9": 12.34, ...}, source, fetched }
 *   GET /debug?cardId=me3-16     -> raw upstream JSON (use once to inspect shape)
 *   GET /health                  -> { ok: true }
 *
 * Required secret env var
 *   PPT_API_KEY   — your PokemonPriceTracker bearer token
 *
 * Optional env var
 *   ALLOWED_ORIGIN — CORS origin to allow (e.g. "https://ethan1243.github.io").
 *                    Defaults to "*". Set this once the site is wired up.
 *
 * Caches successful responses at the Cloudflare edge for 24h so repeat lookups
 * of the same card don't burn the upstream daily quota.
 */

const PPT_BASE = "https://www.pokemonpricetracker.com/api/v2";
const CACHE_TTL_SECONDS = 60 * 60 * 24; // 24 hours

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || "*";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, origin, 405);
    }

    if (url.pathname === "/health") {
      return json({ ok: true, hasKey: Boolean(env.PPT_API_KEY) }, origin);
    }

    const cardId = url.searchParams.get("cardId");
    if (!cardId || !/^[A-Za-z0-9-]+$/.test(cardId)) {
      return json({ error: "invalid or missing cardId" }, origin, 400);
    }

    if (!env.PPT_API_KEY) {
      return json({ error: "PPT_API_KEY secret not configured on this worker" }, origin, 500);
    }

    // Debug passthrough — returns raw upstream JSON
    if (url.pathname === "/debug") {
      const upstream = await callUpstream(cardId, env.PPT_API_KEY);
      const body = await safeJson(upstream);
      return json({ status: upstream.status, body }, origin, upstream.ok ? 200 : 502);
    }

    if (url.pathname !== "/price") {
      return json({ error: "not found" }, origin, 404);
    }

    // Edge cache
    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}/price?cardId=${encodeURIComponent(cardId)}`, { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    try {
      const upstream = await callUpstream(cardId, env.PPT_API_KEY);

      if (!upstream.ok) {
        const detail = (await upstream.text()).slice(0, 500);
        return json({ error: "upstream failed", status: upstream.status, detail }, origin, 502);
      }

      const data = await upstream.json();
      const grades = extractGrades(data);

      const body = {
        cardId,
        source: "pokemonpricetracker",
        fetched: new Date().toISOString(),
        grades
      };
      const response = json(body, origin, 200, CACHE_TTL_SECONDS);
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (e) {
      return json({ error: "worker error", detail: String(e && e.message || e) }, origin, 500);
    }
  }
};

async function callUpstream(cardId, apiKey) {
  // PokemonPriceTracker's documented endpoint is /api/v2/cards with filters
  // and an includeEbay flag for graded sales. We pass the API card id directly.
  const url = `${PPT_BASE}/cards?id=${encodeURIComponent(cardId)}&includeEbay=true`;
  return fetch(url, {
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json",
      "User-Agent": "relic-and-rookie-worker/1.0"
    },
    cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true }
  });
}

/**
 * Normalize whatever shape PokemonPriceTracker returns into:
 *   { "PSA 9": 12.34, "PSA 10": 56.78, "CGC 10": 99.99, ... }
 *
 * The upstream shape isn't fully documented, so this tries several plausible
 * locations. If your response doesn't match, hit /debug?cardId=... and adjust
 * extractGrades accordingly.
 */
function extractGrades(data) {
  const card = pickCard(data);
  if (!card) return {};

  const candidates = [
    card.gradedPrices,
    card.graded,
    card.gradedSales,
    card.prices && card.prices.graded,
    card.ebay && card.ebay.graded,
    card.psaPrices,
    card.history && card.history.graded
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const grades = {};
    for (const [key, value] of Object.entries(candidate)) {
      const price = pickPrice(value);
      const grade = normalizeGradeName(key);
      if (grade && typeof price === "number" && isFinite(price)) {
        grades[grade] = round2(price);
      }
    }
    if (Object.keys(grades).length) return grades;
  }
  return {};
}

function pickCard(data) {
  if (!data) return null;
  if (Array.isArray(data.cards) && data.cards[0]) return data.cards[0];
  if (Array.isArray(data.data) && data.data[0]) return data.data[0];
  if (data.card) return data.card;
  if (data.id || data.name) return data;
  return null;
}

function pickPrice(value) {
  if (typeof value === "number") return value;
  if (!value || typeof value !== "object") return null;
  return value.price ?? value.average ?? value.mid ?? value.market ?? value.median ?? null;
}

function normalizeGradeName(key) {
  // Accept "psa10", "PSA 10", "psa_10", "PSA10", "psa-9.5", "BGS 9", "CGC 10" etc.
  const m = String(key).match(/(psa|bgs|cgc|sgc)\s*[_\s-]?\s*(\d{1,2}(?:\.\d)?)/i);
  if (!m) return null;
  return `${m[1].toUpperCase()} ${m[2]}`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(body, origin, status = 200, cacheSeconds = 0) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(origin)
  };
  if (cacheSeconds > 0) {
    headers["Cache-Control"] = `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}`;
  }
  return new Response(JSON.stringify(body), { status, headers });
}

async function safeJson(res) {
  try { return await res.json(); }
  catch (e) {
    const text = await res.text().catch(() => "");
    return { _raw: text.slice(0, 1000), _parseError: String(e && e.message || e) };
  }
}
