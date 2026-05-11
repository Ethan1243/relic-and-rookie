# Price proxy worker

A tiny Cloudflare Worker that holds a PokemonPriceTracker API key server-side
and exposes a normalized graded-price endpoint to the storefront.

## Deploy via Cloudflare dashboard (no CLI needed)

1. Get a PokemonPriceTracker API key
   - Sign up at https://www.pokemonpricetracker.com/api (free, no card)
   - Copy your API key from the dashboard

2. Create the worker
   - Go to https://dash.cloudflare.com -> Workers & Pages -> Create application -> Create Worker
   - Name it something like `relic-rookie-prices` and click Deploy
   - Click "Edit code"
   - Replace the default `worker.js` contents with the entire contents of `price-proxy.js`
   - Click "Save and Deploy"

3. Add the API key as a secret
   - Back on the worker overview, click Settings -> Variables and Secrets
   - Add variable: type **Secret**, name `PPT_API_KEY`, value = your PokemonPriceTracker key
   - (Optional, recommended later) Add variable: type **Plaintext**, name `ALLOWED_ORIGIN`, value `https://ethan1243.github.io`

4. Copy the worker URL
   - It looks like `https://relic-rookie-prices.<your-subdomain>.workers.dev`
   - Paste that URL back to Claude — the frontend will be wired up to call it

## Test it

Once deployed, hit these in a browser tab to verify:

- `https://<your-worker-url>/health` -> `{"ok": true, "hasKey": true}`
- `https://<your-worker-url>/price?cardId=sv4pt5-223` -> `{"cardId":"sv4pt5-223","grades":{"PSA 9":...,"PSA 10":...}, ...}`
- `https://<your-worker-url>/debug?cardId=sv4pt5-223` -> raw upstream response (useful if `grades` comes back empty — paste this back to Claude and the parser can be adjusted)

## Cost / limits

- Cloudflare Workers free tier: 100,000 requests/day
- PokemonPriceTracker free tier: 100 API calls/day
- The worker edge-caches each card's response for 24 hours, so repeated views
  of the same card don't burn the upstream quota.
