(function () {
  const FREE_SHIPPING_THRESHOLD = 75;
  const SHIPPING_COST = 9.95;
  const STORAGE_KEY = "rr_cart_v3";
  const WATCH_KEY = "rr_watchlist_v1";
  const THEME_KEY = "rr_theme";
  const PAGE_SIZE = 24;
  const API_BASE = "https://api.pokemontcg.io/v2";

  // PSA grade multipliers applied to raw market price.
  // These are typical industry estimates, not real graded sales.
  const PSA_MULTIPLIERS = [
    { grade: "PSA 6", mult: 1.4 },
    { grade: "PSA 7", mult: 2.0 },
    { grade: "PSA 8", mult: 3.2 },
    { grade: "PSA 9", mult: 5.5 },
    { grade: "PSA 10", mult: 12.0 }
  ];

  const RAW_CONDITIONS = [
    { key: "low", label: "Lightly Played" },
    { key: "mid", label: "Near Mint (mid)" },
    { key: "market", label: "Market" },
    { key: "high", label: "High" }
  ];

  const state = {
    cart: loadCart(),
    watchlist: loadWatchlist(),
    page: 1,
    query: "",
    setId: "",
    rarity: "",
    type: "",
    supertype: "",
    hpMin: "",
    hpMax: "",
    sort: "-set.releaseDate,number",
    watchlistOnly: false,
    sets: [],
    rarities: [],
    types: [],
    lastReqId: 0,
    activeCard: null,
    activeVariant: null,
    activeInventory: null,
    inventoryCards: {}  // keyed by card id -> normalized card
  };

  // ---- Persistence ----
  function loadCart() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function persistCart() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.cart));
  }
  function loadWatchlist() {
    try {
      const raw = localStorage.getItem(WATCH_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function persistWatchlist() {
    localStorage.setItem(WATCH_KEY, JSON.stringify(state.watchlist));
  }

  // ---- Helpers ----
  function formatMoney(n) {
    if (n == null || isNaN(n)) return "—";
    return "$" + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function escapeText(s) {
    return String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }
  function escapeAttr(s) {
    return String(s == null ? "" : s).replace(/["&<>]/g, c => ({ "\"": "&quot;", "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  function variantLabel(key) {
    return ({
      normal: "Normal",
      holofoil: "Holofoil",
      reverseHolofoil: "Reverse Holo",
      "1stEditionHolofoil": "1st Edition Holo",
      "1stEditionNormal": "1st Edition",
      unlimitedHolofoil: "Unlimited Holo"
    })[key] || key;
  }

  // ---- API ----
  async function fetchSets() {
    const res = await fetch(`${API_BASE}/sets?orderBy=-releaseDate&pageSize=500`);
    const data = await res.json();
    return (data.data || []).map(s => ({ id: s.id, name: `${s.name} (${s.series})` }));
  }

  async function fetchRarities() {
    const res = await fetch(`${API_BASE}/rarities`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.data || [];
  }

  async function fetchTypes() {
    const res = await fetch(`${API_BASE}/types`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.data || [];
  }

  async function fetchCards({ query, setId, rarity, type, supertype, hpMin, hpMax, sort, page }) {
    const parts = [];
    if (query) parts.push(`name:"*${query.replace(/"/g, "")}*"`);
    if (setId) parts.push(`set.id:${setId}`);
    if (rarity) parts.push(`rarity:"${rarity.replace(/"/g, "")}"`);
    if (type) parts.push(`types:${type}`);
    if (supertype) parts.push(`supertype:"${supertype.replace(/"/g, "")}"`);
    if (hpMin || hpMax) {
      const lo = hpMin || "*";
      const hi = hpMax || "*";
      parts.push(`hp:[${lo} TO ${hi}]`);
    }
    const q = parts.join(" ");
    const url = new URL(`${API_BASE}/cards`);
    if (q) url.searchParams.set("q", q);
    url.searchParams.set("page", String(page));
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    url.searchParams.set("orderBy", sort || "-set.releaseDate,number");
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error("Pokemon API error");
    return res.json();
  }

  async function fetchCardById(id) {
    const res = await fetch(`${API_BASE}/cards/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.data ? normalizeCard(data.data) : null;
  }

  function normalizeCard(c) {
    const tcg = (c.tcgplayer && c.tcgplayer.prices) || {};
    const cm = (c.cardmarket && c.cardmarket.prices) || null;
    const variants = Object.keys(tcg).map(k => ({
      key: k,
      label: variantLabel(k),
      prices: tcg[k]
    }));
    const primary = variants.find(v => typeof (v.prices.market || v.prices.mid) === "number" && (v.prices.market || v.prices.mid) > 0) || variants[0];
    const primaryPrice = primary && (primary.prices.market || primary.prices.mid) || null;
    return {
      id: c.id,
      name: c.name,
      setName: c.set && c.set.name,
      setSeries: c.set && c.set.series,
      number: c.number,
      rarity: c.rarity || "",
      artist: c.artist || "",
      types: (c.types || []).join(" · "),
      hp: c.hp,
      image: c.images && (c.images.small || c.images.large),
      imageLarge: c.images && (c.images.large || c.images.small),
      variants,
      primaryVariant: primary && primary.key,
      primaryPrice,
      cardmarket: cm
    };
  }

  // ---- Inventory (from the binder) ----
  async function renderBinder() {
    const grid = document.getElementById("binder-grid");
    const loading = document.getElementById("binder-loading");
    const empty = document.getElementById("binder-empty");
    const items = (window.INVENTORY || []).filter(i => i.qty > 0);

    if (!items.length) {
      loading.hidden = true;
      empty.hidden = false;
      return;
    }

    grid.innerHTML = items.map(() =>
      `<article class="card"><div class="card-image-wrap"><div class="card-img-placeholder">Loading…</div></div><div class="card-body"><div class="card-title">Loading…</div></div></article>`
    ).join("");

    const fetched = await Promise.all(items.map(async i => {
      const card = await fetchCardById(i.id).catch(() => null);
      return card ? { ...i, card } : null;
    }));

    loading.hidden = true;
    const valid = fetched.filter(Boolean);
    valid.forEach(entry => { state.inventoryCards[entry.id] = entry.card; });

    if (!valid.length) {
      grid.innerHTML = "";
      empty.hidden = false;
      empty.textContent = "Couldn't load inventory cards.";
      return;
    }

    grid.innerHTML = valid.map(inventoryCardHTML).join("");
    attachInventoryHandlers(valid);
  }

  function inventoryCardHTML(entry) {
    const c = entry.card;
    const rarity = c.rarity ? `<span class="tag rarity">${escapeText(c.rarity)}</span>` : "";
    const binderTag = `<span class="binder-tag">Binder</span>`;
    const img = c.image
      ? `<img src="${escapeAttr(c.image)}" alt="${escapeAttr(c.name)}" loading="lazy" />`
      : `<div class="card-img-placeholder">${escapeText(c.name)}</div>`;
    const watched = !!state.watchlist[c.id];
    const heart = `<button class="heart-btn ${watched ? "active" : ""}" data-watch="${escapeAttr(c.id)}" aria-label="${watched ? "Remove from" : "Add to"} watchlist">♥</button>`;
    const meta = `${c.setName || ""}${c.number ? " · #" + c.number : ""}`;
    const qtyLabel = entry.qty > 1 ? ` · ${entry.qty} available` : "";
    return `
      <article class="card" data-inv-id="${escapeAttr(c.id)}">
        <div class="card-image-wrap">${rarity}${binderTag}${heart}${img}</div>
        <div class="card-body">
          <h3 class="card-title">${escapeText(c.name)}</h3>
          <div class="card-meta">${escapeText(meta)}</div>
          <div class="condition-row">
            <span class="condition-pill">${escapeText(entry.condition || "Near Mint")}</span>
            <span class="qty-pill">${qtyLabel ? qtyLabel.slice(3) : "In stock"}</span>
          </div>
          <div class="card-foot">
            <div class="price">${formatMoney(entry.askingPrice)}</div>
            <button class="view-btn" data-inv-view="${escapeAttr(c.id)}">View</button>
          </div>
        </div>
      </article>
    `;
  }

  function attachInventoryHandlers(entries) {
    const lookup = Object.fromEntries(entries.map(e => [e.id, e]));
    document.querySelectorAll("#binder-grid .card").forEach(el => {
      const id = el.dataset.invId;
      el.addEventListener("click", () => openDetail(lookup[id].card, lookup[id]));
    });
    document.querySelectorAll("#binder-grid .view-btn").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const entry = lookup[btn.dataset.invView];
        openDetail(entry.card, entry);
      });
    });
    document.querySelectorAll("#binder-grid .heart-btn").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const id = btn.dataset.watch;
        const entry = lookup[id];
        toggleWatch(entry.card, btn);
      });
    });
  }

  // ---- Catalog rendering ----
  function renderTabs() { /* removed; single-game */ }

  async function populateSetFilter() {
    const select = document.getElementById("set-select");
    select.innerHTML = `<option value="">Loading sets…</option>`;
    let sets = [];
    try {
      if (!state.sets.length) state.sets = await fetchSets();
      sets = state.sets;
    } catch (e) { console.error(e); }
    select.innerHTML = `<option value="">All sets</option>` +
      sets.map(s => `<option value="${escapeAttr(s.id)}">${escapeText(s.name)}</option>`).join("");
    select.value = state.setId;
  }

  async function populateChips() {
    const typeRow = document.getElementById("type-chips");
    const rarityRow = document.getElementById("rarity-chips");
    try {
      if (!state.types.length || !state.rarities.length) {
        const [types, rarities] = await Promise.all([fetchTypes(), fetchRarities()]);
        state.types = types;
        state.rarities = rarities;
      }
    } catch (e) { console.error(e); }

    typeRow.innerHTML =
      `<button class="chip ${state.type === "" ? "active" : ""}" data-kind="type" data-value="">All</button>` +
      state.types.map(t =>
        `<button class="chip type-${escapeAttr(t)} ${state.type === t ? "active" : ""}" data-kind="type" data-value="${escapeAttr(t)}">${escapeText(t)}</button>`
      ).join("");

    rarityRow.innerHTML =
      `<button class="chip ${state.rarity === "" ? "active" : ""}" data-kind="rarity" data-value="">All</button>` +
      state.rarities.map(r =>
        `<button class="chip ${state.rarity === r ? "active" : ""}" data-kind="rarity" data-value="${escapeAttr(r)}">${escapeText(r)}</button>`
      ).join("");

    document.querySelectorAll(".chip").forEach(c => {
      c.addEventListener("click", () => {
        const kind = c.dataset.kind;
        const value = c.dataset.value;
        if (kind === "type") state.type = value;
        if (kind === "rarity") state.rarity = value;
        state.page = 1;
        // Re-render chip active states without refetching the chip lists
        document.querySelectorAll(`.chip[data-kind="${kind}"]`).forEach(other => {
          other.classList.toggle("active", other.dataset.value === value);
        });
        loadCards();
      });
    });
  }

  async function loadCards() {
    const grid = document.getElementById("card-grid");
    const loading = document.getElementById("card-loading");
    const empty = document.getElementById("card-empty");
    const meta = document.getElementById("result-meta");
    const pageInfo = document.getElementById("page-info");
    const prev = document.getElementById("page-prev");
    const next = document.getElementById("page-next");

    grid.innerHTML = "";
    empty.hidden = true;
    loading.hidden = false;
    meta.textContent = "";

    const reqId = ++state.lastReqId;
    try {
      let cards, total;
      if (state.watchlistOnly) {
        const all = Object.values(state.watchlist);
        let filtered = all;
        const q = state.query.trim().toLowerCase();
        if (q) filtered = filtered.filter(w => (w.name || "").toLowerCase().includes(q));
        if (state.setId) filtered = filtered.filter(w => w.setId === state.setId);
        if (state.rarity) filtered = filtered.filter(w => (w.rarity || "") === state.rarity);
        total = filtered.length;
        // Re-fetch full card by id so we have variants/prices for the detail modal
        const start = (state.page - 1) * PAGE_SIZE;
        const slice = filtered.slice(start, start + PAGE_SIZE);
        const fetched = await Promise.all(slice.map(w => fetchCardById(w.id).catch(() => null)));
        cards = fetched.filter(Boolean);
      } else {
        const data = await fetchCards({
          query: state.query.trim(),
          setId: state.setId,
          rarity: state.rarity,
          type: state.type,
          supertype: state.supertype,
          hpMin: state.hpMin,
          hpMax: state.hpMax,
          sort: state.sort,
          page: state.page
        });
        if (reqId !== state.lastReqId) return;
        cards = (data.data || []).map(normalizeCard);
        total = data.totalCount || cards.length;
      }

      if (reqId !== state.lastReqId) return;
      loading.hidden = true;

      if (!cards.length) {
        empty.hidden = false;
        meta.textContent = "0 results";
        pageInfo.textContent = `Page 1`;
        prev.disabled = true;
        next.disabled = true;
        return;
      }
      grid.innerHTML = cards.map(cardHTML).join("");
      attachCardHandlers(cards);
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      meta.textContent = `${total.toLocaleString()} card${total === 1 ? "" : "s"}`;
      pageInfo.textContent = `Page ${state.page} of ${totalPages.toLocaleString()}`;
      prev.disabled = state.page <= 1;
      next.disabled = state.page >= totalPages;
    } catch (e) {
      if (reqId !== state.lastReqId) return;
      console.error(e);
      loading.hidden = true;
      empty.hidden = false;
      empty.textContent = "Couldn't load cards. The card API may be rate-limited — try again in a moment.";
    }
  }

  function cardHTML(c) {
    const rarity = c.rarity ? `<span class="tag rarity">${escapeText(c.rarity)}</span>` : "";
    const img = c.image
      ? `<img src="${escapeAttr(c.image)}" alt="${escapeAttr(c.name)}" loading="lazy" />`
      : `<div class="card-img-placeholder">${escapeText(c.name)}</div>`;
    const watched = !!state.watchlist[c.id];
    const heart = `<button class="heart-btn ${watched ? "active" : ""}" data-watch="${escapeAttr(c.id)}" aria-label="${watched ? "Remove from" : "Add to"} watchlist">♥</button>`;
    const priceClass = c.primaryPrice ? "price" : "price muted";
    const priceLabel = c.primaryPrice ? formatMoney(c.primaryPrice) : "Price pending";
    const meta = `${c.setName || ""}${c.number ? " · #" + c.number : ""}`;
    return `
      <article class="card" data-card-id="${escapeAttr(c.id)}">
        <div class="card-image-wrap">${rarity}${heart}${img}</div>
        <div class="card-body">
          <h3 class="card-title">${escapeText(c.name)}</h3>
          <div class="card-meta">${escapeText(meta)}</div>
          <div class="card-foot">
            <div class="${priceClass}">${escapeText(priceLabel)}</div>
            <button class="view-btn" data-id="${escapeAttr(c.id)}">View</button>
          </div>
        </div>
      </article>
    `;
  }

  function attachCardHandlers(cards) {
    const lookup = Object.fromEntries(cards.map(c => [c.id, c]));
    document.querySelectorAll("#card-grid .card").forEach(el => {
      const id = el.dataset.cardId;
      el.addEventListener("click", () => openDetail(lookup[id]));
    });
    document.querySelectorAll("#card-grid .view-btn").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        openDetail(lookup[btn.dataset.id]);
      });
    });
    document.querySelectorAll("#card-grid .heart-btn").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        toggleWatch(lookup[btn.dataset.watch], btn);
      });
    });
  }

  // ---- Detail modal ----
  function openDetail(card, inventoryEntry) {
    if (!card) return;
    state.activeCard = card;
    state.activeInventory = inventoryEntry || null;
    state.activeVariant = card.primaryVariant || (card.variants[0] && card.variants[0].key) || null;

    document.getElementById("detail-set").textContent =
      `${card.setName || "—"}${card.setSeries ? " · " + card.setSeries : ""}`;
    document.getElementById("detail-name").textContent = card.name;
    const metaParts = [];
    if (card.number) metaParts.push(`#${card.number}`);
    if (card.rarity) metaParts.push(card.rarity);
    if (card.types) metaParts.push(card.types);
    if (card.hp) metaParts.push(`${card.hp} HP`);
    if (card.artist) metaParts.push(`Illus. ${card.artist}`);
    document.getElementById("detail-meta").textContent = metaParts.join(" · ");

    const img = document.getElementById("detail-image");
    const fallback = document.getElementById("detail-image-fallback");
    if (card.imageLarge) {
      img.src = card.imageLarge;
      img.alt = card.name;
      img.hidden = false;
      fallback.hidden = true;
    } else {
      img.hidden = true;
      fallback.hidden = false;
      fallback.textContent = card.name;
    }

    renderVariantTabs();
    renderVariantContent();
    syncDetailWatch();

    document.getElementById("detail-modal").classList.add("open");
    document.getElementById("overlay").hidden = false;
  }

  function renderVariantTabs() {
    const card = state.activeCard;
    const wrap = document.getElementById("detail-variants");
    if (!card.variants.length) {
      wrap.innerHTML = "";
      return;
    }
    wrap.innerHTML = card.variants.map(v =>
      `<button class="variant-tab ${v.key === state.activeVariant ? "active" : ""}" data-variant="${escapeAttr(v.key)}">${escapeText(v.label)}</button>`
    ).join("");
    wrap.querySelectorAll(".variant-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        state.activeVariant = btn.dataset.variant;
        renderVariantTabs();
        renderVariantContent();
      });
    });
  }

  function activeVariantPrices() {
    const card = state.activeCard;
    if (!card) return null;
    const v = card.variants.find(x => x.key === state.activeVariant);
    return v ? v.prices : null;
  }

  function renderVariantContent() {
    const prices = activeVariantPrices() || {};
    const market = prices.market || prices.mid || null;

    // Raw price table
    const rawBody = document.querySelector("#raw-table tbody");
    rawBody.innerHTML = RAW_CONDITIONS.map(c => {
      const v = prices[c.key];
      return `<tr><td>${escapeText(c.label)}</td><td>${v ? formatMoney(v) : "—"}</td></tr>`;
    }).join("");

    // PSA estimate table
    const psaBody = document.querySelector("#psa-table tbody");
    psaBody.innerHTML = PSA_MULTIPLIERS.map(p => {
      const est = market ? market * p.mult : null;
      return `<tr><td>${escapeText(p.grade)}</td><td>${est ? formatMoney(est) : "—"}</td><td>${p.mult.toFixed(1)}×</td></tr>`;
    }).join("");

    // Buy now price + handler
    const inv = state.activeInventory;
    const buyPrice = inv ? inv.askingPrice : market;
    const priceEl = document.getElementById("detail-price");
    priceEl.textContent = buyPrice ? formatMoney(buyPrice) : "—";

    const addBtn = document.getElementById("detail-add");
    addBtn.disabled = !buyPrice;
    addBtn.onclick = () => {
      const card = state.activeCard;
      if (!card || !buyPrice) return;
      const variantKey = state.activeVariant;
      const cartKey = inv
        ? `inv-${card.id}`
        : `pkm-${card.id}--${variantKey}`;
      addToCart({
        id: cartKey,
        name: card.name,
        meta: `${card.setName || ""}${card.number ? " · #" + card.number : ""}`,
        variant: inv ? `From the Binder · ${inv.condition || "Near Mint"}` : variantLabel(variantKey),
        price: buyPrice,
        image: card.image
      });
      flashButton(addBtn, "Added");
    };

    renderBinderStrip(inv, market);
    drawChart(market, state.activeCard.cardmarket);
    renderExternalLinks(state.activeCard);
  }

  function renderBinderStrip(inv, market) {
    const wrap = document.getElementById("detail-binder-strip");
    if (!wrap) return;
    if (!inv) {
      wrap.hidden = true;
      wrap.innerHTML = "";
      return;
    }
    const diff = market && inv.askingPrice
      ? (inv.askingPrice - market)
      : null;
    const diffLabel = diff == null
      ? ""
      : (diff <= 0 ? `${formatMoney(Math.abs(diff))} under market` : `${formatMoney(diff)} over market`);
    wrap.hidden = false;
    wrap.innerHTML = `
      <span class="strip-label">From the Binder</span>
      <span class="strip-price">${formatMoney(inv.askingPrice)}</span>
      <span class="condition-pill">${escapeText(inv.condition || "Near Mint")}</span>
      <span class="strip-meta">${inv.qty} available${diffLabel ? " · " + escapeText(diffLabel) : ""}</span>
    `;
  }

  function renderExternalLinks(card) {
    const wrap = document.getElementById("external-links");
    const baseQuery = [card.name, "pokemon", card.setName, card.number ? `${card.number}` : ""]
      .filter(Boolean).join(" ");
    const ebay = (extra) => {
      const q = encodeURIComponent(`${baseQuery}${extra ? " " + extra : ""}`);
      // _sacat=183454 = Trading Card Singles; LH_Sold=1 + LH_Complete=1 = sold listings only
      return `https://www.ebay.com/sch/i.html?_nkw=${q}&_sacat=183454&LH_Sold=1&LH_Complete=1`;
    };
    const ebayLive = () => {
      const q = encodeURIComponent(baseQuery);
      return `https://www.ebay.com/sch/i.html?_nkw=${q}&_sacat=183454`;
    };
    const psa = () => {
      // PSA's public pop report search
      const q = encodeURIComponent(card.name);
      return `https://www.psacard.com/pop?text=${q}`;
    };
    const links = [
      { label: "eBay — sold (raw)", url: ebay("") },
      { label: "eBay — sold PSA 9", url: ebay("PSA 9") },
      { label: "eBay — sold PSA 10", url: ebay("PSA 10") },
      { label: "eBay — active listings", url: ebayLive() },
      { label: "PSA pop report", url: psa() }
    ];
    wrap.innerHTML = links.map(l =>
      `<a class="external-link" href="${escapeAttr(l.url)}" target="_blank" rel="noopener noreferrer">${escapeText(l.label)} <span class="ext-arrow">↗</span></a>`
    ).join("");
  }

  // ---- Price history chart (inline SVG) ----
  function drawChart(currentPrice, cardmarket) {
    const svg = document.getElementById("price-chart");
    svg.innerHTML = "";
    const trendSource = document.getElementById("trend-source");

    if (!currentPrice) {
      trendSource.textContent = "No data available";
      svg.innerHTML = `<text x="300" y="110" text-anchor="middle" class="chart-axis-text">No price data</text>`;
      return;
    }

    const points = buildHistory(currentPrice, cardmarket);
    trendSource.textContent = cardmarket && (cardmarket.avg30 || cardmarket.avg7)
      ? "Anchored to Cardmarket 1/7/30-day averages"
      : "Modeled trend (no Cardmarket history)";

    const W = 600, H = 220, PADL = 48, PADR = 12, PADT = 12, PADB = 28;
    const innerW = W - PADL - PADR;
    const innerH = H - PADT - PADB;
    const min = Math.min(...points.map(p => p.y));
    const max = Math.max(...points.map(p => p.y));
    const range = Math.max(max - min, 0.01);
    // Pad y-range slightly
    const yMin = min - range * 0.1;
    const yMax = max + range * 0.1;
    const yRange = yMax - yMin;

    const xAt = i => PADL + (i / (points.length - 1)) * innerW;
    const yAt = v => PADT + innerH - ((v - yMin) / yRange) * innerH;

    // Gridlines (5 horizontal)
    let grid = "";
    for (let i = 0; i <= 4; i++) {
      const y = PADT + (i / 4) * innerH;
      const value = yMax - (i / 4) * yRange;
      grid += `<line class="chart-grid-line" x1="${PADL}" y1="${y}" x2="${W - PADR}" y2="${y}" />`;
      grid += `<text class="chart-axis-text" x="${PADL - 6}" y="${y + 3}" text-anchor="end">${formatMoney(value)}</text>`;
    }

    // Area path
    let area = `M ${xAt(0)} ${yAt(yMin)} `;
    points.forEach((p, i) => { area += `L ${xAt(i)} ${yAt(p.y)} `; });
    area += `L ${xAt(points.length - 1)} ${yAt(yMin)} Z`;

    // Line path
    let line = "";
    points.forEach((p, i) => {
      line += `${i === 0 ? "M" : "L"} ${xAt(i)} ${yAt(p.y)} `;
    });

    // X axis labels (start, middle, end)
    const labels = [
      { idx: 0, text: "30d ago" },
      { idx: Math.floor(points.length / 2), text: "15d ago" },
      { idx: points.length - 1, text: "Today" }
    ];
    let xAxis = "";
    labels.forEach(l => {
      xAxis += `<text class="chart-axis-text" x="${xAt(l.idx)}" y="${H - 8}" text-anchor="middle">${l.text}</text>`;
    });

    // Last point dot
    const lastX = xAt(points.length - 1);
    const lastY = yAt(points[points.length - 1].y);

    svg.innerHTML = `
      ${grid}
      <path class="chart-area" d="${area}" />
      <path class="chart-line" d="${line}" />
      <circle class="chart-dot" cx="${lastX}" cy="${lastY}" r="3.5" />
      ${xAxis}
    `;
  }

  function buildHistory(current, cardmarket) {
    // 30 daily points ending at `current`.
    // If Cardmarket avg1/7/30 exist, anchor the curve at days 0, 23, 29 to those values.
    const days = 30;
    const points = new Array(days).fill(0).map((_, i) => ({ x: i, y: current }));
    const seed = (current * 100) | 0;
    const rand = mulberry32(seed);

    const anchor = (idx, value) => { if (value && value > 0) points[idx].y = value; };
    if (cardmarket) {
      anchor(0, cardmarket.avg30);     // 30 days ago
      anchor(days - 8, cardmarket.avg7); // ~7 days ago
      anchor(days - 2, cardmarket.avg1); // ~1 day ago
    } else {
      // Synthesize a starting point: drift +/- 15% from current
      points[0].y = current * (0.85 + rand() * 0.3);
    }
    points[days - 1].y = current;

    // Interpolate between anchors and add small noise
    const anchorIdx = points
      .map((p, i) => ({ i, set: p.y !== current || i === days - 1 || i === 0 }))
      .filter(a => a.set || (cardmarket && (a.i === 0 || a.i === days - 8 || a.i === days - 2)))
      .map(a => a.i);
    const sortedAnchors = Array.from(new Set([0, days - 1, ...anchorIdx])).sort((a, b) => a - b);

    for (let k = 0; k < sortedAnchors.length - 1; k++) {
      const a = sortedAnchors[k];
      const b = sortedAnchors[k + 1];
      const ay = points[a].y;
      const by = points[b].y;
      for (let i = a + 1; i < b; i++) {
        const t = (i - a) / (b - a);
        const base = ay + (by - ay) * t;
        const noise = (rand() - 0.5) * Math.max(0.04, range01(ay, by)) * 0.18;
        points[i].y = Math.max(0.01, base * (1 + noise));
      }
    }
    return points;
  }

  function range01(a, b) {
    const m = (a + b) / 2;
    return m > 0 ? Math.abs(b - a) / m : 0.1;
  }

  // Seeded RNG so identical prices produce identical charts within a session
  function mulberry32(a) {
    return function () {
      let t = (a += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function closeDetail() {
    document.getElementById("detail-modal").classList.remove("open");
    document.getElementById("overlay").hidden = true;
  }

  // ---- Cart ----
  function addToCart(product) {
    const existing = state.cart[product.id];
    state.cart[product.id] = {
      qty: (existing && existing.qty || 0) + 1,
      name: product.name,
      meta: product.meta,
      variant: product.variant,
      price: product.price,
      image: product.image || null
    };
    persistCart();
    renderCart();
  }

  function setQty(id, qty) {
    if (qty <= 0) delete state.cart[id];
    else state.cart[id].qty = qty;
    persistCart();
    renderCart();
  }

  function cartLines() {
    return Object.entries(state.cart).map(([id, entry]) => ({ id, ...entry }));
  }

  function subtotal() {
    return cartLines().reduce((s, l) => s + (l.price || 0) * l.qty, 0);
  }

  function shipping(sub) {
    if (sub === 0) return 0;
    return sub >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_COST;
  }

  function totalItems() {
    return cartLines().reduce((s, l) => s + l.qty, 0);
  }

  function renderCart() {
    const itemsEl = document.getElementById("cart-items");
    const subtotalEl = document.getElementById("cart-subtotal");
    const countEl = document.getElementById("cart-count");
    const checkoutBtn = document.getElementById("checkout-button");

    const lines = cartLines();
    countEl.textContent = totalItems();

    if (lines.length === 0) {
      itemsEl.innerHTML = `<div class="cart-empty">Your cart is empty.<br/>Find something worth keeping.</div>`;
      checkoutBtn.disabled = true;
    } else {
      itemsEl.innerHTML = lines.map(l => {
        const thumb = l.image
          ? `<img src="${escapeAttr(l.image)}" alt="" />`
          : escapeText(l.name.split(/\s+/).slice(0, 3).map(w => w[0]).join(""));
        const variant = l.variant ? `<div class="cart-item-variant">${escapeText(l.variant)}</div>` : "";
        return `
          <div class="cart-item">
            <div class="cart-item-thumb">${thumb}</div>
            <div class="cart-item-info">
              <div class="cart-item-name">${escapeText(l.name)}</div>
              ${variant}
              <div class="cart-item-controls">
                <button class="qty-btn" data-action="dec" data-id="${escapeAttr(l.id)}">−</button>
                <span>${l.qty}</span>
                <button class="qty-btn" data-action="inc" data-id="${escapeAttr(l.id)}">+</button>
              </div>
              <button class="remove-link" data-action="remove" data-id="${escapeAttr(l.id)}">Remove</button>
            </div>
            <div class="cart-item-price">${formatMoney((l.price || 0) * l.qty)}</div>
          </div>
        `;
      }).join("");
      checkoutBtn.disabled = false;
    }

    subtotalEl.textContent = formatMoney(subtotal());

    itemsEl.querySelectorAll("[data-action]").forEach(el => {
      el.addEventListener("click", () => {
        const id = el.dataset.id;
        const current = state.cart[id] && state.cart[id].qty || 0;
        if (el.dataset.action === "inc") setQty(id, current + 1);
        if (el.dataset.action === "dec") setQty(id, current - 1);
        if (el.dataset.action === "remove") setQty(id, 0);
      });
    });
  }

  // ---- Watchlist ----
  function toggleWatch(card, btn) {
    if (!card) return;
    if (state.watchlist[card.id]) {
      delete state.watchlist[card.id];
    } else {
      state.watchlist[card.id] = {
        id: card.id,
        name: card.name,
        setName: card.setName,
        setId: card.setId,
        number: card.number,
        rarity: card.rarity,
        image: card.image,
        lastPrice: card.primaryPrice,
        addedAt: Date.now()
      };
    }
    persistWatchlist();
    if (btn) btn.classList.toggle("active", !!state.watchlist[card.id]);
    // Sync the detail-modal watch button if this is the active card
    if (state.activeCard && state.activeCard.id === card.id) syncDetailWatch();
    // Sync any other heart buttons on the same card in the grid
    document.querySelectorAll(`#card-grid .heart-btn[data-watch="${cssEsc(card.id)}"]`).forEach(b => {
      b.classList.toggle("active", !!state.watchlist[card.id]);
    });
    renderWatchCount();
    renderWatchDrawer();
  }

  function cssEsc(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, ch => "\\" + ch);
  }

  function syncDetailWatch() {
    const btn = document.getElementById("detail-watch");
    const label = document.getElementById("detail-watch-label");
    const card = state.activeCard;
    if (!btn || !card) return;
    const watched = !!state.watchlist[card.id];
    btn.classList.toggle("active", watched);
    label.textContent = watched ? "Watching" : "Watch";
  }

  function renderWatchCount() {
    document.getElementById("watch-count").textContent = Object.keys(state.watchlist).length;
  }

  function renderWatchDrawer() {
    const itemsEl = document.getElementById("watch-items");
    const list = Object.values(state.watchlist).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

    if (list.length === 0) {
      itemsEl.innerHTML = `<div class="cart-empty">Nothing on your watchlist yet.<br/>Tap the ♥ on any card to save it.</div>`;
      return;
    }
    itemsEl.innerHTML = list.map(w => {
      const thumb = w.image
        ? `<img src="${escapeAttr(w.image)}" alt="" />`
        : escapeText((w.name || "").split(/\s+/).slice(0, 3).map(s => s[0]).join(""));
      const meta = `${w.setName || ""}${w.number ? " · #" + w.number : ""}`;
      const price = w.lastPrice ? formatMoney(w.lastPrice) : "—";
      return `
        <div class="cart-item">
          <div class="cart-item-thumb">${thumb}</div>
          <div class="cart-item-info">
            <div class="cart-item-name">${escapeText(w.name)}</div>
            <div class="cart-item-variant">${escapeText(meta)}</div>
            <div class="cart-item-controls">
              <button class="qty-btn" data-watch-view="${escapeAttr(w.id)}" title="View">View</button>
              <button class="remove-link" data-watch-remove="${escapeAttr(w.id)}">Remove</button>
            </div>
          </div>
          <div class="cart-item-price">${price}</div>
        </div>
      `;
    }).join("");

    itemsEl.querySelectorAll("[data-watch-view]").forEach(b => {
      b.addEventListener("click", async () => {
        const id = b.dataset.watchView;
        closeWatchDrawer();
        const card = await fetchCardById(id);
        if (card) openDetail(card);
      });
    });
    itemsEl.querySelectorAll("[data-watch-remove]").forEach(b => {
      b.addEventListener("click", () => {
        const id = b.dataset.watchRemove;
        delete state.watchlist[id];
        persistWatchlist();
        renderWatchCount();
        renderWatchDrawer();
        // Update heart icons currently in the grid
        document.querySelectorAll(`#card-grid .heart-btn[data-watch="${cssEsc(id)}"]`).forEach(h => h.classList.remove("active"));
        if (state.watchlistOnly) loadCards();
      });
    });
  }

  function openWatchDrawer() {
    renderWatchDrawer();
    document.getElementById("watch-drawer").classList.add("open");
    document.getElementById("overlay").hidden = false;
  }
  function closeWatchDrawer() {
    document.getElementById("watch-drawer").classList.remove("open");
    if (!document.getElementById("detail-modal").classList.contains("open")
        && !document.getElementById("cart-drawer").classList.contains("open")) {
      document.getElementById("overlay").hidden = true;
    }
  }

  function flashButton(btn, label) {
    const original = btn.textContent;
    btn.textContent = label || "Added";
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 900);
  }

  function openCart() {
    document.getElementById("cart-drawer").classList.add("open");
    document.getElementById("overlay").hidden = false;
  }
  function closeCart() {
    document.getElementById("cart-drawer").classList.remove("open");
    if (!document.getElementById("detail-modal").classList.contains("open")) {
      document.getElementById("overlay").hidden = true;
    }
  }

  function openCheckout() {
    document.getElementById("checkout-form").hidden = false;
    document.getElementById("checkout-success").hidden = true;
    document.getElementById("checkout-modal").classList.add("open");
    updateCheckoutSummary();
  }
  function closeCheckout() {
    document.getElementById("checkout-modal").classList.remove("open");
  }
  function updateCheckoutSummary() {
    const sub = subtotal();
    const ship = shipping(sub);
    document.getElementById("summary-items").textContent = formatMoney(sub);
    document.getElementById("summary-shipping").textContent =
      ship === 0 && sub > 0 ? "Free" : formatMoney(ship);
    document.getElementById("summary-total").textContent = formatMoney(sub + ship);
  }

  function handleCheckoutSubmit(e) {
    e.preventDefault();
    const form = e.currentTarget;
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const formData = new FormData(form);
    const email = formData.get("email");

    console.log("Order placed (demo)", {
      customer: Object.fromEntries(formData.entries()),
      items: cartLines(),
      subtotal: subtotal(),
      shipping: shipping(subtotal()),
      total: subtotal() + shipping(subtotal())
    });

    document.getElementById("success-email").textContent = email;
    document.getElementById("checkout-form").hidden = true;
    document.getElementById("checkout-success").hidden = false;

    state.cart = {};
    persistCart();
    renderCart();
  }

  // ---- Theme ----
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }
  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    applyTheme(current === "dark" ? "light" : "dark");
    // Re-render chart if open so it picks up the new colors
    if (document.getElementById("detail-modal").classList.contains("open")) {
      renderVariantContent();
    }
  }

  // ---- Event wiring ----
  function bindEvents() {
    document.getElementById("cart-button").addEventListener("click", openCart);
    document.getElementById("cart-close").addEventListener("click", closeCart);
    document.getElementById("watch-button").addEventListener("click", openWatchDrawer);
    document.getElementById("watch-close").addEventListener("click", closeWatchDrawer);
    document.getElementById("watch-show-only").addEventListener("click", () => {
      state.watchlistOnly = true;
      state.page = 1;
      const btn = document.getElementById("watchlist-only");
      btn.setAttribute("aria-pressed", "true");
      closeWatchDrawer();
      loadCards();
      window.scrollTo({ top: document.getElementById("cards").offsetTop - 20, behavior: "smooth" });
    });
    document.getElementById("detail-watch").addEventListener("click", () => {
      if (state.activeCard) toggleWatch(state.activeCard);
    });
    document.getElementById("overlay").addEventListener("click", () => {
      closeCart();
      closeWatchDrawer();
      closeDetail();
    });
    document.getElementById("checkout-button").addEventListener("click", () => {
      closeCart();
      openCheckout();
    });
    document.getElementById("checkout-close").addEventListener("click", closeCheckout);
    document.getElementById("checkout-form").addEventListener("submit", handleCheckoutSubmit);
    document.getElementById("success-close").addEventListener("click", closeCheckout);

    document.getElementById("detail-close").addEventListener("click", closeDetail);
    document.getElementById("theme-toggle").addEventListener("click", toggleTheme);

    const searchInput = document.getElementById("search-input");
    searchInput.addEventListener("input", debounce(() => {
      state.query = searchInput.value;
      state.page = 1;
      loadCards();
    }, 300));

    document.getElementById("set-select").addEventListener("change", e => {
      state.setId = e.target.value;
      state.page = 1;
      loadCards();
    });

    document.getElementById("sort-select").addEventListener("change", e => {
      state.sort = e.target.value;
      state.page = 1;
      loadCards();
    });

    const advancedToggleBtn = document.getElementById("advanced-toggle");
    const advancedPanel = document.getElementById("advanced-panel");
    advancedToggleBtn.addEventListener("click", () => {
      const isOpen = !advancedPanel.hidden;
      advancedPanel.hidden = isOpen;
      advancedToggleBtn.setAttribute("aria-expanded", String(!isOpen));
    });

    const advancedDebounced = debounce(() => { state.page = 1; loadCards(); }, 350);
    document.getElementById("supertype-select").addEventListener("change", e => {
      state.supertype = e.target.value;
      state.page = 1;
      loadCards();
    });
    document.getElementById("hp-min").addEventListener("input", e => {
      state.hpMin = e.target.value.trim();
      advancedDebounced();
    });
    document.getElementById("hp-max").addEventListener("input", e => {
      state.hpMax = e.target.value.trim();
      advancedDebounced();
    });
    document.getElementById("advanced-clear").addEventListener("click", () => {
      state.supertype = "";
      state.hpMin = "";
      state.hpMax = "";
      document.getElementById("supertype-select").value = "";
      document.getElementById("hp-min").value = "";
      document.getElementById("hp-max").value = "";
      state.page = 1;
      loadCards();
    });

    const watchOnlyBtn = document.getElementById("watchlist-only");
    watchOnlyBtn.addEventListener("click", () => {
      state.watchlistOnly = !state.watchlistOnly;
      watchOnlyBtn.setAttribute("aria-pressed", String(state.watchlistOnly));
      state.page = 1;
      loadCards();
    });

    document.getElementById("page-prev").addEventListener("click", () => {
      if (state.page > 1) {
        state.page--;
        loadCards();
        window.scrollTo({ top: document.getElementById("cards").offsetTop - 20, behavior: "smooth" });
      }
    });
    document.getElementById("page-next").addEventListener("click", () => {
      state.page++;
      loadCards();
      window.scrollTo({ top: document.getElementById("cards").offsetTop - 20, behavior: "smooth" });
    });

    document.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        closeCart();
        closeWatchDrawer();
        closeCheckout();
        closeDetail();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    document.getElementById("year").textContent = new Date().getFullYear();
    renderCart();
    renderWatchCount();
    bindEvents();
    renderBinder();
    await Promise.all([populateSetFilter(), populateChips()]);
    loadCards();
  });
})();
