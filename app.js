(function () {
  const FREE_SHIPPING_THRESHOLD = 75;
  const SHIPPING_COST = 9.95;
  const STORAGE_KEY = "rr_cart_v2";
  const PAGE_SIZE = 24;

  // ---- State ----
  const state = {
    cart: loadCart(),
    game: "pokemon",
    page: 1,
    query: "",
    setId: "",
    pokemonSets: [],
    magicSets: [],
    yugiohArchetypes: [],
    lastReqId: 0
  };

  function loadCart() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function persistCart() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.cart));
  }

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

  // ---- API adapters ----
  // Each adapter exposes: fetchSets(), fetchCards({query, setId, page}) -> {cards, total}
  // and normalizes results into a common shape:
  // { id, name, meta, setName, rarity, image, price, priceLabel }

  const pokemonApi = {
    base: "https://api.pokemontcg.io/v2",
    async fetchSets() {
      const res = await fetch(`${this.base}/sets?orderBy=-releaseDate&pageSize=500`);
      const data = await res.json();
      return (data.data || []).map(s => ({ id: s.id, name: `${s.name} (${s.series})` }));
    },
    async fetchCards({ query, setId, page }) {
      const parts = [];
      if (query) parts.push(`name:"*${query.replace(/"/g, "")}*"`);
      if (setId) parts.push(`set.id:${setId}`);
      const q = parts.join(" ");
      const url = new URL(`${this.base}/cards`);
      if (q) url.searchParams.set("q", q);
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", String(PAGE_SIZE));
      url.searchParams.set("orderBy", "-set.releaseDate,number");
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error("Pokemon API error");
      const data = await res.json();
      const cards = (data.data || []).map(c => {
        const tcg = c.tcgplayer && c.tcgplayer.prices;
        const prices = tcg ? Object.values(tcg) : [];
        const market = prices
          .map(p => p && (p.market || p.mid))
          .find(x => typeof x === "number" && x > 0);
        return {
          id: `pkm-${c.id}`,
          name: c.name,
          meta: `${c.set && c.set.name ? c.set.name : ""}${c.number ? " · #" + c.number : ""}`,
          setName: c.set && c.set.name,
          rarity: c.rarity || "",
          image: c.images && (c.images.small || c.images.large),
          price: market || null,
          priceLabel: market ? formatMoney(market) : "Market price pending"
        };
      });
      return { cards, total: data.totalCount || cards.length };
    }
  };

  const magicApi = {
    base: "https://api.scryfall.com",
    async fetchSets() {
      const res = await fetch(`${this.base}/sets`);
      const data = await res.json();
      return (data.data || [])
        .filter(s => s.card_count > 0 && (s.set_type === "core" || s.set_type === "expansion" || s.set_type === "masters" || s.set_type === "draft_innovation" || s.set_type === "commander"))
        .sort((a, b) => (b.released_at || "").localeCompare(a.released_at || ""))
        .map(s => ({ id: s.code, name: `${s.name} (${(s.released_at || "").slice(0, 4)})` }));
    },
    async fetchCards({ query, setId, page }) {
      // Scryfall paginates with `page` query param at 175 results/page max. We page client-side
      // through their results to respect our PAGE_SIZE.
      const parts = [];
      if (query) parts.push(query);
      if (setId) parts.push(`set:${setId}`);
      if (!parts.length) parts.push("year>=1993"); // browse-all fallback
      const q = parts.join(" ");
      // Scryfall page param returns 175/page. Translate our page to a slice.
      const scryPageSize = 175;
      const scryPage = Math.floor(((page - 1) * PAGE_SIZE) / scryPageSize) + 1;
      const sliceOffset = ((page - 1) * PAGE_SIZE) % scryPageSize;
      const url = new URL(`${this.base}/cards/search`);
      url.searchParams.set("q", q);
      url.searchParams.set("unique", "prints");
      url.searchParams.set("page", String(scryPage));
      const res = await fetch(url.toString());
      if (res.status === 404) return { cards: [], total: 0 };
      if (!res.ok) throw new Error("Scryfall error");
      const data = await res.json();
      const total = data.total_cards || (data.data || []).length;
      const slice = (data.data || []).slice(sliceOffset, sliceOffset + PAGE_SIZE);
      const cards = slice.map(c => {
        const usd = c.prices && (c.prices.usd || c.prices.usd_foil || c.prices.usd_etched);
        const img = (c.image_uris && c.image_uris.small)
          || (c.card_faces && c.card_faces[0] && c.card_faces[0].image_uris && c.card_faces[0].image_uris.small);
        const price = usd ? parseFloat(usd) : null;
        return {
          id: `mtg-${c.id}`,
          name: c.name,
          meta: `${c.set_name || ""}${c.collector_number ? " · #" + c.collector_number : ""}`,
          setName: c.set_name,
          rarity: c.rarity || "",
          image: img,
          price,
          priceLabel: price ? formatMoney(price) : "Market price pending"
        };
      });
      return { cards, total };
    }
  };

  const yugiohApi = {
    base: "https://db.ygoprodeck.com/api/v7",
    cache: { all: null, fetchedAt: 0 },
    async loadAll() {
      const FRESH = 1000 * 60 * 30;
      if (this.cache.all && Date.now() - this.cache.fetchedAt < FRESH) return this.cache.all;
      const res = await fetch(`${this.base}/cardinfo.php?num=2000&offset=0`);
      if (!res.ok) throw new Error("YGOPRODeck error");
      const data = await res.json();
      this.cache.all = data.data || [];
      this.cache.fetchedAt = Date.now();
      return this.cache.all;
    },
    async fetchSets() {
      // YGOPRODeck has many archetypes; we use them as a filter proxy for "set/theme".
      const res = await fetch(`${this.base}/archetypes.php`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data || []).slice(0, 200).map(a => ({ id: a.archetype_name, name: a.archetype_name }));
    },
    async fetchCards({ query, setId, page }) {
      const url = new URL(`${this.base}/cardinfo.php`);
      if (query) url.searchParams.set("fname", query);
      if (setId) url.searchParams.set("archetype", setId);
      url.searchParams.set("num", String(PAGE_SIZE));
      url.searchParams.set("offset", String((page - 1) * PAGE_SIZE));
      const res = await fetch(url.toString());
      if (res.status === 400) return { cards: [], total: 0 };
      if (!res.ok) throw new Error("YGOPRODeck error");
      const data = await res.json();
      const total = (data.meta && data.meta.total_rows) || (data.data || []).length;
      const cards = (data.data || []).map(c => {
        const tcgPrice = c.card_prices && c.card_prices[0] && parseFloat(c.card_prices[0].tcgplayer_price);
        const img = c.card_images && c.card_images[0] && (c.card_images[0].image_url_small || c.card_images[0].image_url);
        const price = tcgPrice > 0 ? tcgPrice : null;
        return {
          id: `ygo-${c.id}`,
          name: c.name,
          meta: `${c.type || ""}${c.archetype ? " · " + c.archetype : ""}`,
          setName: c.archetype || c.type,
          rarity: c.rarity || "",
          image: img,
          price,
          priceLabel: price ? formatMoney(price) : "Market price pending"
        };
      });
      return { cards, total };
    }
  };

  const apis = { pokemon: pokemonApi, magic: magicApi, yugioh: yugiohApi };

  // ---- Rendering ----

  function renderTabs() {
    document.querySelectorAll(".tab").forEach(tab => {
      tab.classList.toggle("active", tab.dataset.game === state.game);
    });
  }

  async function populateSetFilter() {
    const select = document.getElementById("set-select");
    select.innerHTML = `<option value="">Loading…</option>`;
    let sets = [];
    try {
      if (state.game === "pokemon") {
        if (!state.pokemonSets.length) state.pokemonSets = await pokemonApi.fetchSets();
        sets = state.pokemonSets;
      } else if (state.game === "magic") {
        if (!state.magicSets.length) state.magicSets = await magicApi.fetchSets();
        sets = state.magicSets;
      } else if (state.game === "yugioh") {
        if (!state.yugiohArchetypes.length) state.yugiohArchetypes = await yugiohApi.fetchSets();
        sets = state.yugiohArchetypes;
      }
    } catch (e) {
      console.error(e);
    }
    const label = state.game === "yugioh" ? "All archetypes" : "All sets";
    select.innerHTML = `<option value="">${label}</option>` +
      sets.map(s => `<option value="${escapeAttr(s.id)}">${escapeText(s.name)}</option>`).join("");
    select.value = state.setId;
  }

  function escapeText(s) {
    return String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }
  function escapeAttr(s) {
    return String(s).replace(/["&<>]/g, c => ({ "\"": "&quot;", "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
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

    const api = apis[state.game];
    const reqId = ++state.lastReqId;
    try {
      const { cards, total } = await api.fetchCards({
        query: state.query.trim(),
        setId: state.setId,
        page: state.page
      });
      // Discard if a newer request was issued
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
      attachAddHandlers(cards);
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
    const priceClass = c.price ? "price" : "price muted";
    const buyDisabled = c.price ? "" : "disabled";
    return `
      <article class="card" data-card-id="${escapeAttr(c.id)}">
        <div class="card-image-wrap">${rarity}${img}</div>
        <div class="card-body">
          <h3 class="card-title">${escapeText(c.name)}</h3>
          <div class="card-meta">${escapeText(c.meta || "")}</div>
          <div class="card-foot">
            <div class="${priceClass}">${escapeText(c.priceLabel)}</div>
            <button class="add-btn" data-id="${escapeAttr(c.id)}" ${buyDisabled}>Add</button>
          </div>
        </div>
      </article>
    `;
  }

  function attachAddHandlers(cards) {
    const lookup = Object.fromEntries(cards.map(c => [c.id, c]));
    document.querySelectorAll("#card-grid .add-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const card = lookup[btn.dataset.id];
        if (!card || !card.price) return;
        addToCart({
          id: card.id,
          name: card.name,
          meta: card.meta,
          price: card.price,
          image: card.image
        });
        flashButton(btn);
      });
    });
  }

  // ---- Curated (non-card) items ----
  function renderCurated() {
    const grids = document.querySelectorAll(".grid-curated[data-curated]");
    grids.forEach(grid => {
      const cat = grid.dataset.curated;
      const items = (window.CURATED_PRODUCTS || []).filter(p => p.category === cat);
      grid.innerHTML = items.map(curatedCardHTML).join("");
    });
    document.querySelectorAll(".grid-curated .add-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const p = (window.CURATED_PRODUCTS || []).find(x => x.id === id);
        if (!p) return;
        addToCart({ id: p.id, name: p.name, meta: p.meta, price: p.price, image: null });
        flashButton(btn);
      });
    });
  }

  function curatedCardHTML(p) {
    const initials = p.name.split(/\s+/).slice(0, 3).map(w => w[0]).join("");
    const tag = p.tag ? `<span class="tag">${escapeText(p.tag)}</span>` : "";
    return `
      <article class="card">
        <div class="card-img-placeholder">${tag}${initials}</div>
        <div class="card-body">
          <h3 class="card-title">${escapeText(p.name)}</h3>
          <div class="card-meta">${escapeText(p.meta)}</div>
          <div class="card-foot">
            <div class="price">${formatMoney(p.price)}</div>
            <button class="add-btn" data-id="${escapeAttr(p.id)}">Add to cart</button>
          </div>
        </div>
      </article>
    `;
  }

  function flashButton(btn) {
    const original = btn.textContent;
    btn.textContent = "Added";
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original;
      // Re-enable based on whether item has a price (always true if it was added)
      btn.disabled = false;
    }, 900);
  }

  // ---- Cart ----
  // Cart stores snapshots: { id: { qty, name, meta, price, image } }
  function addToCart(product) {
    const existing = state.cart[product.id];
    state.cart[product.id] = {
      qty: (existing && existing.qty || 0) + 1,
      name: product.name,
      meta: product.meta,
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
        return `
          <div class="cart-item">
            <div class="cart-item-thumb">${thumb}</div>
            <div class="cart-item-info">
              <div class="cart-item-name">${escapeText(l.name)}</div>
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

  function openCart() {
    document.getElementById("cart-drawer").classList.add("open");
    document.getElementById("overlay").hidden = false;
  }
  function closeCart() {
    document.getElementById("cart-drawer").classList.remove("open");
    document.getElementById("overlay").hidden = true;
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

    // Demo: in production, POST to your server which creates a Stripe
    // PaymentIntent (or Checkout Session) and returns a client secret.
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

  // ---- Event wiring ----
  function bindEvents() {
    document.getElementById("cart-button").addEventListener("click", openCart);
    document.getElementById("cart-close").addEventListener("click", closeCart);
    document.getElementById("overlay").addEventListener("click", closeCart);
    document.getElementById("checkout-button").addEventListener("click", () => {
      closeCart();
      openCheckout();
    });
    document.getElementById("checkout-close").addEventListener("click", closeCheckout);
    document.getElementById("checkout-form").addEventListener("submit", handleCheckoutSubmit);
    document.getElementById("success-close").addEventListener("click", closeCheckout);

    document.querySelectorAll(".tab").forEach(tab => {
      tab.addEventListener("click", () => {
        if (tab.dataset.game === state.game) return;
        state.game = tab.dataset.game;
        state.page = 1;
        state.query = "";
        state.setId = "";
        document.getElementById("search-input").value = "";
        renderTabs();
        populateSetFilter();
        loadCards();
      });
    });

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

    document.getElementById("page-prev").addEventListener("click", () => {
      if (state.page > 1) { state.page--; loadCards(); window.scrollTo({ top: document.getElementById("cards").offsetTop - 20, behavior: "smooth" }); }
    });
    document.getElementById("page-next").addEventListener("click", () => {
      state.page++;
      loadCards();
      window.scrollTo({ top: document.getElementById("cards").offsetTop - 20, behavior: "smooth" });
    });

    document.addEventListener("keydown", e => {
      if (e.key === "Escape") { closeCart(); closeCheckout(); }
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    document.getElementById("year").textContent = new Date().getFullYear();
    renderTabs();
    renderCurated();
    renderCart();
    bindEvents();
    await populateSetFilter();
    loadCards();
  });
})();
