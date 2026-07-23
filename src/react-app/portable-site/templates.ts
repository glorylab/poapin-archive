import type { PortableSiteManifest } from "./types";

const POAP_IN = "https://poap.in";
const REPOSITORY = "https://github.com/glorylab/poapin-archive";

export function buildIndexHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <meta name="robots" content="noindex,nofollow">
    <meta name="referrer" content="no-referrer">
    <meta name="description" content="A portable personal POAP archive.">
    <title>Personal POAP archive</title>
    <link rel="stylesheet" href="./assets/site.css">
    <script src="./assets/site.js" defer></script>
  </head>
  <body>
    <div class="page-shell">
      <header class="site-header">
        <a class="wordmark" href="#overview" aria-label="Personal POAP archive home">
          <span class="wordmark__mark" aria-hidden="true">P</span>
          <span>Personal POAP archive</span>
        </a>
        <nav class="source-links" aria-label="Project links">
          <a href="${POAP_IN}" target="_blank" rel="noopener noreferrer">Browse poap.in</a>
          <a href="${REPOSITORY}" target="_blank" rel="noopener noreferrer">Open source on GitHub</a>
        </nav>
      </header>

      <main>
        <section class="hero" aria-labelledby="site-title">
          <p class="eyebrow">A portable history</p>
          <h1 id="site-title">POAPs, collections, and moments—kept together.</h1>
          <p class="hero__address" id="owner-address">Reading the archive manifest…</p>
          <p class="hero__copy">
            This is a self-contained structured-data snapshot. The page has no account
            connection, analytics, or remote database; archived media remains click-to-load.
          </p>
        </section>

        <nav class="tabs" aria-label="Archive sections">
          <a href="#overview" data-tab="overview">Overview</a>
          <a href="#poaps" data-tab="poaps">POAPs</a>
          <a href="#collections" data-tab="collections">Collections</a>
          <a href="#owned" data-tab="owned">Historically owned</a>
          <a href="#moments" data-tab="moments">Moments</a>
        </nav>

        <section class="view" id="archive-view" aria-live="polite">
          <div class="loading-card" role="status">Reading manifest…</div>
        </section>
      </main>

      <footer>
        <p>Made portable by <a href="${POAP_IN}">poap.in</a>.</p>
        <a href="${REPOSITORY}">Source code and data notes</a>
      </footer>
    </div>
  </body>
</html>
`;
}

export function buildSiteCss(): string {
  return `:root {
  color: #f6f1e8;
  background: #0c0b0f;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
  --ink: #f6f1e8;
  --muted: #aaa3b3;
  --line: rgba(246, 241, 232, 0.13);
  --panel: rgba(31, 28, 36, 0.82);
  --gold: #e7bb65;
  --violet: #9f8cff;
}

* { box-sizing: border-box; }
html { min-width: 300px; background: #0c0b0f; scroll-behavior: smooth; }
body {
  min-height: 100vh;
  margin: 0;
  background:
    radial-gradient(circle at 12% 8%, rgba(104, 79, 172, 0.22), transparent 32rem),
    radial-gradient(circle at 88% 16%, rgba(231, 187, 101, 0.12), transparent 28rem),
    linear-gradient(180deg, #121016 0%, #0c0b0f 70%);
}
a { color: inherit; text-underline-offset: 0.22em; }
button { font: inherit; }
.page-shell { width: min(1180px, calc(100% - 32px)); margin: 0 auto; }
.site-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  min-height: 76px;
  border-bottom: 1px solid var(--line);
}
.wordmark { display: inline-flex; align-items: center; gap: 11px; text-decoration: none; font-weight: 720; }
.wordmark__mark {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border: 1px solid rgba(231, 187, 101, 0.55);
  border-radius: 50%;
  color: var(--gold);
  font-family: Georgia, serif;
}
.source-links { display: flex; flex-wrap: wrap; gap: 18px; color: var(--muted); font-size: 0.88rem; }
.source-links a:hover, footer a:hover { color: var(--ink); }
.hero { max-width: 870px; padding: clamp(58px, 9vw, 112px) 0 56px; }
.eyebrow {
  margin: 0 0 18px;
  color: var(--gold);
  font-size: 0.75rem;
  font-weight: 760;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}
h1 {
  max-width: 820px;
  margin: 0;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(2.6rem, 7vw, 6.35rem);
  font-weight: 400;
  letter-spacing: -0.055em;
  line-height: 0.96;
}
.hero__address {
  width: fit-content;
  max-width: 100%;
  margin: 34px 0 0;
  padding: 8px 12px;
  overflow-wrap: anywhere;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: #d8d1df;
  background: rgba(255, 255, 255, 0.035);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.78rem;
}
.hero__copy { max-width: 620px; margin: 22px 0 0; color: var(--muted); font-size: 1.03rem; line-height: 1.65; }
.tabs {
  position: sticky;
  z-index: 5;
  top: 0;
  display: flex;
  gap: 5px;
  overflow-x: auto;
  padding: 11px 0;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  background: rgba(12, 11, 15, 0.92);
  backdrop-filter: blur(18px);
}
.tabs a {
  flex: 0 0 auto;
  padding: 9px 13px;
  border-radius: 999px;
  color: var(--muted);
  font-size: 0.86rem;
  text-decoration: none;
}
.tabs a[aria-current="page"] { color: #17131c; background: var(--gold); }
.view { min-height: 440px; padding: 42px 0 84px; }
.section-heading { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
.section-heading h2 { margin: 0; font-family: Georgia, serif; font-size: clamp(2rem, 4vw, 3.6rem); font-weight: 400; }
.section-heading p { margin: 0; color: var(--muted); }
.summary-grid, .card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
  gap: 14px;
}
.metric, .card, .loading-card, .empty-card, .error-card {
  border: 1px solid var(--line);
  border-radius: 18px;
  background: var(--panel);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.16);
}
.metric { min-height: 148px; padding: 22px; }
.metric span { display: block; color: var(--muted); font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; }
.metric strong { display: block; margin-top: 22px; font-family: Georgia, serif; font-size: 2.5rem; font-weight: 400; }
.card { min-width: 0; padding: 18px; }
.card h3 { margin: 0; font-family: Georgia, serif; font-size: 1.35rem; font-weight: 400; line-height: 1.15; }
.card p { color: var(--muted); line-height: 1.5; }
.card a { overflow-wrap: anywhere; color: #d8ceff; }
.card__meta { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 14px; }
.pill { padding: 5px 8px; border: 1px solid var(--line); border-radius: 999px; color: #c8c0cf; font-size: 0.72rem; }
.record-details { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px; }
.record-details summary { color: var(--gold); cursor: pointer; font-size: 0.76rem; }
.record-details pre {
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: #c8c0cf;
  font: 0.7rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.media-action {
  width: 100%;
  margin-top: 16px;
  padding: 10px 12px;
  border: 1px solid rgba(159, 140, 255, 0.4);
  border-radius: 10px;
  color: #ddd6ff;
  background: rgba(159, 140, 255, 0.09);
  cursor: pointer;
}
.media-action:hover { background: rgba(159, 140, 255, 0.17); }
.dataset-toolbar, .dataset-pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 9px;
  margin: 14px 0;
}
.dataset-toolbar input, .dataset-pager input {
  min-height: 42px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 0 12px;
  color: var(--ink);
  background: rgba(255, 255, 255, 0.05);
}
.dataset-toolbar input { flex: 1 1 240px; }
.dataset-pager input { width: 82px; }
.dataset-control {
  min-height: 42px;
  padding: 0 15px;
  border: 1px solid rgba(231, 187, 101, 0.42);
  border-radius: 10px;
  color: var(--gold);
  background: rgba(231, 187, 101, 0.08);
  cursor: pointer;
}
.dataset-control:hover { background: rgba(231, 187, 101, 0.15); }
.dataset-control:disabled { cursor: not-allowed; opacity: 0.42; }
.dataset-status { margin-right: auto; color: var(--muted); font-size: 0.78rem; }
.media-frame { margin: 14px 0 0; }
.media-frame img, .media-frame video { display: block; width: 100%; max-height: 430px; border-radius: 12px; object-fit: contain; background: #08070a; }
.media-frame audio { display: block; width: 100%; }
.dataset-group + .dataset-group { margin-top: 44px; }
.dataset-group h3 { margin: 0 0 14px; color: var(--gold); font-size: 0.76rem; letter-spacing: 0.13em; text-transform: uppercase; }
.loading-card, .empty-card, .error-card { padding: 28px; color: var(--muted); }
.error-card { color: #ffb8b8; border-color: rgba(255, 120, 120, 0.3); }
footer {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  padding: 28px 0 42px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 0.84rem;
}
footer p { margin: 0; }
@media (max-width: 700px) {
  .site-header, footer { align-items: flex-start; flex-direction: column; justify-content: center; }
  .site-header { padding: 18px 0; }
  .source-links { gap: 10px 16px; }
  .hero { padding-top: 62px; }
  .section-heading { align-items: flex-start; flex-direction: column; }
}
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
`;
}

export function buildSiteJs(): string {
  return `(() => {
  "use strict";

  const manifestUrl = "./manifest.json";
  const view = document.querySelector("#archive-view");
  const address = document.querySelector("#owner-address");
  const tabLinks = Array.from(document.querySelectorAll("[data-tab]"));
  const dataCache = new Map();
  const fileIndex = new Map();
  const pageSize = 48;
  let manifest;
  let routeEpoch = 0;

  const manifestPromise = fetch(manifestUrl, { headers: { Accept: "application/json" } })
    .then((response) => {
      if (!response.ok) throw new Error("Could not read manifest.json");
      return response.json();
    })
    .then((value) => {
      validateManifest(value);
      manifest = value;
      value.files.forEach((file) => fileIndex.set(file.path, file));
      address.textContent = value.address;
      document.title = "POAP archive · " + shortAddress(value.address);
      return value;
    });

  window.addEventListener("hashchange", route);
  view.addEventListener("click", (event) => {
    const pageButton = event.target.closest("[data-page-dataset]");
    if (pageButton) {
      changePage(
        pageButton.dataset.pageDataset,
        Number(pageButton.dataset.pageDirection || 0),
        pageButton.dataset.pageAction || "",
      );
      return;
    }
    const searchButton = event.target.closest("[data-search-dataset]");
    if (searchButton) {
      searchDataset(
        searchButton.dataset.searchDataset,
        searchButton.dataset.searchAction || "search",
      );
      return;
    }
    const button = event.target.closest("[data-media-url]");
    if (!button) return;
    mountMedia(button);
  });
  view.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const pageInput = event.target.closest("[data-page-input]");
    if (pageInput) {
      event.preventDefault();
      changePage(pageInput.dataset.pageInput, 0, "go");
      return;
    }
    const searchInput = event.target.closest("[data-search-input]");
    if (searchInput) {
      event.preventDefault();
      searchDataset(searchInput.dataset.searchInput, "search");
    }
  });

  route();

  async function route() {
    const epoch = ++routeEpoch;
    const current = (location.hash || "#overview").slice(1);
    const routeName = ["overview", "poaps", "collections", "owned", "moments"].includes(current)
      ? current
      : "overview";
    tabLinks.forEach((link) => {
      if (link.dataset.tab === routeName) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    view.innerHTML = '<div class="loading-card" role="status">Reading archive…</div>';
    try {
      const currentManifest = await manifestPromise;
      if (epoch !== routeEpoch) return;
      if (routeName === "overview") renderOverview(currentManifest);
      else await renderTab(routeName, currentManifest, epoch);
    } catch (error) {
      if (epoch === routeEpoch) renderError(error);
    }
  }

  function renderOverview(currentManifest) {
    const counts = currentManifest.counts;
    view.replaceChildren(
      heading("Overview", "Only manifest.json was loaded for this page."),
      grid([
        metric("Tokens held", counts.holdings),
        metric("Public Drop details", counts.uniqueDrops),
        metric("Unavailable Drop details", counts.unavailableDropReferences),
        metric("Related collections", counts.collectionProfiles),
        metric("Historically owned", counts.ownedCollections),
        metric("Authored moments", counts.publicAuthoredMoments),
        metric("Tagged moments", counts.publicTaggedMoments),
        metric("Public capsules", counts.ownedCapsules),
      ], "summary-grid"),
    );
  }

  async function renderTab(tab, currentManifest, epoch) {
    const datasets = currentManifest.datasets.filter((dataset) => dataset.tab === tab);
    const loaded = await Promise.all(
      datasets.map(async (dataset) => {
        const state = datasetState(dataset);
        return { state, items: await currentPageItems(state) };
      }),
    );
    const titles = {
      poaps: ["POAPs", "Artwork stays dormant until you choose to load it."],
      collections: ["Collections", "Collections connected to the POAP drops in this export."],
      owned: ["Historically owned collections", "Complete public segments for collections whose archived owner field matches this address; this does not prove current control."],
      moments: ["Moments and capsules", "Authored and tagged public Moments stay separate; media remains click-to-load."],
    };
    const content = document.createDocumentFragment();
    content.append(heading(titles[tab][0], titles[tab][1]));
    if (loaded.every(({ state }) => state.count === 0)) {
      content.append(message("Nothing was exported for this section.", "empty-card"));
    } else {
      loaded.forEach(({ state, items }) => {
        if (state.count === 0) return;
        const group = element("section", "dataset-group");
        const total = state.matches ? state.matches.length : state.count;
        group.append(element("h3", "", state.label + " · " + state.count));
        group.append(datasetToolbar(state));
        if (items.length === 0) {
          group.append(message("No records match this search.", "empty-card"));
        }
        group.append(
          grid(
            items.map((item) => renderRecord(state.id, item)),
            "card-grid",
          ),
        );
        group.append(datasetPager(state, total));
        content.append(group);
      });
    }
    if (epoch === routeEpoch) view.replaceChildren(content);
  }

  function datasetState(dataset) {
    if (dataCache.has(dataset.id)) return dataCache.get(dataset.id);
    const chunkCounts = dataset.paths.map((path) => {
      const file = fileIndex.get(path);
      if (!file || !Number.isSafeInteger(file.count) || file.count < 0) {
        throw new Error(path + " is missing record-count metadata.");
      }
      return file.count;
    });
    if (chunkCounts.reduce((total, count) => total + count, 0) !== dataset.count) {
      throw new Error(dataset.id + " chunk counts do not match manifest.json.");
    }
    const state = {
      ...dataset,
      chunkCounts,
      chunks: new Map(),
      page: 0,
      query: "",
      matches: null,
    };
    dataCache.set(dataset.id, state);
    return state;
  }

  async function loadChunk(dataset, index) {
    if (dataset.chunks.has(index)) return dataset.chunks.get(index);
    const path = dataset.paths[index];
    if (!path) throw new Error("Portable archive chunk index is out of range.");
    const body = await verifiedJson(path);
    if (
      body.schemaVersion !== "poapin-portable-data-v1" ||
      body.dataset !== dataset.id ||
      body.address !== manifest.address ||
      !sameJson(body.snapshotIds, manifest.snapshotIds) ||
      !sameJson(body.sources, manifest.sources) ||
      !body.chunk ||
      body.chunk.index !== index + 1 ||
      body.chunk.total !== dataset.paths.length ||
      body.count !== dataset.chunkCounts[index] ||
      !Array.isArray(body.items) ||
      body.items.length !== body.count
    ) {
      throw new Error(path + " does not belong to this portable archive.");
    }
    dataset.chunks.set(index, body.items);
    return body.items;
  }

  async function currentPageItems(dataset) {
    const source = dataset.matches;
    const start = dataset.page * pageSize;
    const end = start + pageSize;
    if (source) return source.slice(start, end);
    const items = [];
    let chunkStart = 0;
    for (let index = 0; index < dataset.paths.length; index += 1) {
      const chunkEnd = chunkStart + dataset.chunkCounts[index];
      if (chunkEnd > start && chunkStart < end) {
        const chunk = await loadChunk(dataset, index);
        items.push(
          ...chunk.slice(
            Math.max(0, start - chunkStart),
            Math.min(chunk.length, end - chunkStart),
          ),
        );
      }
      if (chunkStart >= end) break;
      chunkStart = chunkEnd;
    }
    return items;
  }

  async function changePage(datasetId, direction, action) {
    try {
      const dataset = dataCache.get(datasetId);
      if (!dataset) return;
      const total = dataset.matches ? dataset.matches.length : dataset.count;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      if (action === "go") {
        const input = view.querySelector('[data-page-input="' + datasetId + '"]');
        const requested = Number(input?.value);
        if (Number.isFinite(requested)) {
          dataset.page = Math.max(0, Math.min(pages - 1, Math.trunc(requested) - 1));
        }
      } else {
        dataset.page = Math.max(0, Math.min(pages - 1, dataset.page + direction));
      }
      await route();
    } catch (error) {
      renderError(error);
    }
  }

  async function searchDataset(datasetId, action) {
    try {
      const dataset = dataCache.get(datasetId);
      if (!dataset) return;
      const input = view.querySelector('[data-search-input="' + datasetId + '"]');
      const query = action === "clear" ? "" : String(input?.value || "").trim().slice(0, 120);
      dataset.query = query;
      dataset.page = 0;
      if (!query) {
        dataset.matches = null;
      } else {
        view.setAttribute("aria-busy", "true");
        const all = [];
        for (let index = 0; index < dataset.paths.length; index += 1) {
          all.push(...await loadChunk(dataset, index));
        }
        const normalized = query.toLocaleLowerCase("en-US");
        dataset.matches = all.filter((item) =>
          JSON.stringify(item).toLocaleLowerCase("en-US").includes(normalized),
        );
      }
      await route();
    } catch (error) {
      renderError(error);
    } finally {
      view.removeAttribute("aria-busy");
    }
  }

  function datasetToolbar(dataset) {
    const toolbar = element("div", "dataset-toolbar");
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "Search every archived field";
    input.value = dataset.query;
    input.dataset.searchInput = dataset.id;
    input.setAttribute("aria-label", "Search " + dataset.label);
    const search = control("Search", "searchDataset", dataset.id);
    search.dataset.searchAction = "search";
    const clear = control("Clear", "searchDataset", dataset.id);
    clear.dataset.searchAction = "clear";
    clear.disabled = !dataset.query;
    toolbar.append(input, search, clear);
    return toolbar;
  }

  function datasetPager(dataset, total) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    dataset.page = Math.max(0, Math.min(dataset.page, pages - 1));
    const start = total === 0 ? 0 : dataset.page * pageSize + 1;
    const end = Math.min(total, (dataset.page + 1) * pageSize);
    const pager = element("div", "dataset-pager");
    pager.append(element("span", "dataset-status", start + "–" + end + " of " + total));
    const previous = control("Previous", "pageDataset", dataset.id);
    previous.dataset.pageDirection = "-1";
    previous.disabled = dataset.page === 0;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.max = String(pages);
    input.value = String(dataset.page + 1);
    input.dataset.pageInput = dataset.id;
    input.setAttribute("aria-label", "Page number");
    const go = control("Go", "pageDataset", dataset.id);
    go.dataset.pageAction = "go";
    const next = control("Next", "pageDataset", dataset.id);
    next.dataset.pageDirection = "1";
    next.disabled = dataset.page + 1 >= pages;
    pager.append(previous, input, element("span", "", "of " + pages), go, next);
    return pager;
  }

  function control(label, dataName, datasetId) {
    const button = element("button", "dataset-control", label);
    button.type = "button";
    button.dataset[dataName] = datasetId;
    return button;
  }

  function renderRecord(datasetId, item) {
    if (datasetId === "holdings") return holdingCard(item);
    if (datasetId === "drops") return dropCard(item);
    if (datasetId === "unavailable-drop-references") return unavailableDropCard(item);
    if (datasetId === "collection-profiles") return collectionCard(item);
    if (datasetId === "held-drop-memberships") return membershipCard(item);
    if (datasetId === "authored-moment-associations") {
      return momentAssociationCard(item, "Authored");
    }
    if (datasetId === "tagged-moment-associations") {
      return momentAssociationCard(item, "Tagged");
    }
    if (datasetId === "owned-collections") return ownedCollectionCard(item);
    if (datasetId === "moments" || datasetId === "moments-authored") {
      return momentCard(item, "Authored");
    }
    if (datasetId === "moments-tagged") return momentCard(item, "Tagged");
    if (datasetId === "capsules") return capsuleCard(item);
    return genericCard(item);
  }

  function holdingCard(item) {
    const card = element("article", "card");
    card.append(element("h3", "", "Token " + item.poapId));
    card.append(
      element(
        "p",
        "",
        "Drop " + item.dropId + " · source " + (item.sourceUid || "not recorded"),
      ),
    );
    card.append(meta([
      item.network || "",
      item.mintedOn ? "Minted " + item.mintedOn : "",
      item.transferCount !== undefined ? item.transferCount + " transfers" : "",
    ]));
    return withArchiveFields(card, item);
  }

  function dropCard(item) {
    const card = element("article", "card");
    card.append(element("h3", "", item.title || "Drop " + item.dropId));
    card.append(element("p", "", item.description || "No public Drop description archived."));
    card.append(meta([
      item.year ? String(item.year) : "",
      item.city || item.country || "",
      item.dropId !== undefined ? "Drop " + item.dropId : "",
    ]));
    if (item.hasArtwork !== false && item.imageUrl) {
      card.append(mediaButton("Load archived artwork", item.imageUrl, "image", ""));
    }
    return withArchiveFields(card, item);
  }

  function unavailableDropCard(item) {
    const card = element("article", "card");
    card.append(element("h3", "", "Drop " + item.dropId));
    card.append(
      element(
        "p",
        "",
        "No public Drop detail was available in this archive snapshot. This may be a private or missing record.",
      ),
    );
    card.append(meta(["Reference preserved", "No private fields exported"]));
    return withArchiveFields(card, item);
  }

  function collectionCard(profile) {
    const collection = profile.collection || {};
    const card = element("article", "card");
    card.append(element("h3", "", collection.title || "Untitled collection"));
    card.append(element("p", "", collection.description || "No description archived."));
    card.append(meta([
      collection.type || "",
      collection.itemCount !== undefined ? collection.itemCount + " items" : "",
      collection.isVerified ? "Verified" : "",
    ]));
    const mediaUrl = collection.logoUrl || collection.bannerUrl ||
      (profile.media || []).find((entry) => entry.eligibleForPublish && entry.objectUrl)?.objectUrl;
    if (mediaUrl) card.append(mediaButton("Load collection media", mediaUrl, "image", ""));
    return withArchiveFields(card, profile);
  }

  function membershipCard(item) {
    const card = element("article", "card");
    const collection = item.collection || {};
    card.append(element("h3", "", collection.title || "Collection membership"));
    card.append(element("p", "", "Matched drops: " + (item.matchedDropIds || []).join(", ")));
    return withArchiveFields(card, item);
  }

  function momentAssociationCard(item, relation) {
    const card = element("article", "card");
    card.append(element("h3", "", "Collection " + item.collectionId));
    card.append(
      element(
        "p",
        "",
        (item.momentIds || []).length +
          " public " +
          relation.toLocaleLowerCase("en-US") +
          " Moments are associated through archived Drop membership.",
      ),
    );
    card.append(meta([relation + " Moment relationship"]));
    return withArchiveFields(card, item);
  }

  function ownedCollectionCard(item) {
    const profile = item.profile || {};
    const collection = profile.collection || {};
    const card = element("article", "card");
    card.append(element("h3", "", collection.title || "Owned collection"));
    card.append(element("p", "", collection.description || "Complete public export included."));
    card.append(meta([
      item.collectionId !== undefined ? "Collection " + item.collectionId : "",
      item.manifest?.counts?.items !== undefined ? item.manifest.counts.items + " items" : "",
    ]));
    const mediaUrl = collection.logoUrl || collection.bannerUrl;
    if (mediaUrl) card.append(mediaButton("Load collection media", mediaUrl, "image", ""));
    return withArchiveFields(card, item);
  }

  function momentCard(item, relation) {
    const card = element("article", "card");
    card.append(element("h3", "", item.displayId || "Moment " + item.momentId));
    card.append(element("p", "", item.description || "No description archived."));
    card.append(meta([
      relation,
      item.createdOn || "",
      item.mediaCount !== undefined ? item.mediaCount + " media" : "",
      item.mediaPreservationState || "",
      (item.dropIds || []).length ? "Drops " + item.dropIds.join(", ") : "",
      (item.collectionIds || []).length ? "Collections " + item.collectionIds.join(", ") : "",
    ]));
    (item.links || []).forEach((link) => {
      const anchor = safeExternalLink(link.url, link.title || link.url || "Archived link");
      if (anchor) card.append(anchor);
      if (link.imageUrl) {
        card.append(mediaButton("Load link preview", link.imageUrl, "image", ""));
      }
    });
    if ((item.userTags || []).length) {
      card.append(
        element(
          "p",
          "",
          "Tagged people: " +
            item.userTags.map((tag) => tag.ens || tag.address || "unnamed").join(", "),
        ),
      );
    }
    (item.capsules || []).forEach((capsule) => {
      card.append(
        element(
          "p",
          "",
          "Capsule: " + (capsule.title || capsule.externalId || capsule.capsuleId),
        ),
      );
      if (capsule.imageUrl) {
        card.append(mediaButton("Load capsule image", capsule.imageUrl, "image", ""));
      }
    });
    (item.media || []).forEach((media, index) => {
      if (!media.url) return;
      card.append(mediaButton(
        "Load " + (media.kind || "media") + " " + (index + 1),
        media.url,
        media.kind || "other",
        media.mimeType || "",
      ));
    });
    return withArchiveFields(card, item);
  }

  function capsuleCard(item) {
    const card = element("article", "card");
    card.append(element("h3", "", item.title || item.externalId || "Capsule " + item.capsuleId));
    card.append(element("p", "", item.description || "No public Capsule description archived."));
    card.append(meta([item.createdOn || "", item.owner ? "Owner " + item.owner : ""]));
    const link = safeExternalLink(item.url, "Open archived Capsule URL");
    if (link) card.append(link);
    if (item.imageUrl) card.append(mediaButton("Load capsule image", item.imageUrl, "image", ""));
    return withArchiveFields(card, item);
  }

  function genericCard(item) {
    const card = element("article", "card");
    const title = item.drop?.title || item.artistId || item.suggestionId || item.dropId || "Record";
    card.append(element("h3", "", String(title)));
    card.append(element("p", "", "Open Archived fields for the complete preserved record."));
    return withArchiveFields(card, item);
  }

  function withArchiveFields(card, item) {
    const details = element("details", "record-details");
    details.append(element("summary", "", "Archived fields"));
    details.append(element("pre", "", JSON.stringify(item, null, 2)));
    card.append(details);
    return card;
  }

  function safeExternalLink(value, label) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
      const anchor = element("a", "", label);
      anchor.href = parsed.href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      return anchor;
    } catch {
      return null;
    }
  }

  function mediaButton(label, url, kind, mimeType) {
    const button = element("button", "media-action", label);
    button.type = "button";
    button.dataset.mediaUrl = url;
    button.dataset.mediaKind = kind;
    button.dataset.mediaMime = mimeType;
    return button;
  }

  function mountMedia(button) {
    const url = safeMediaUrl(button.dataset.mediaUrl);
    if (!url) {
      button.textContent = "Media URL is unavailable";
      button.disabled = true;
      return;
    }
    const kind = button.dataset.mediaKind;
    const frame = element("figure", "media-frame");
    let media;
    if (kind === "image") {
      media = document.createElement("img");
      media.alt = "";
      media.loading = "lazy";
      media.decoding = "async";
      media.src = url;
    } else if (kind === "video" || kind === "audio") {
      media = document.createElement(kind);
      media.controls = true;
      media.preload = "none";
      const source = document.createElement("source");
      source.src = url;
      if (button.dataset.mediaMime) source.type = button.dataset.mediaMime;
      media.append(source);
    } else {
      const link = element("a", "", "Open media");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      media = link;
    }
    frame.append(media);
    button.replaceWith(frame);
  }

  function safeMediaUrl(value) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
    } catch {
      return "";
    }
  }

  function heading(title, copy) {
    const wrapper = element("div", "section-heading");
    wrapper.append(element("h2", "", title), element("p", "", copy));
    return wrapper;
  }

  function metric(label, value) {
    const card = element("article", "metric");
    card.append(element("span", "", label), element("strong", "", String(value)));
    return card;
  }

  function meta(values) {
    const wrapper = element("div", "card__meta");
    values.filter(Boolean).forEach((value) => wrapper.append(element("span", "pill", value)));
    return wrapper;
  }

  function grid(children, className) {
    const wrapper = element("div", className);
    children.forEach((child) => wrapper.append(child));
    return wrapper;
  }

  function message(copy, className) {
    return element("div", className, copy);
  }

  function validateManifest(value) {
    if (
      !value ||
      value.schemaVersion !== "poapin-portable-site-v1" ||
      !/^0x[0-9a-f]{40}$/.test(value.address || "") ||
      !value.snapshotIds ||
      !value.sources ||
      !value.sources.collections?.releaseId ||
      !value.sources.moments?.releaseId ||
      !/^[0-9a-f]{64}$/.test(value.sources.moments?.sourceDatabaseSha256 || "") ||
      !/^[0-9a-f]{64}$/.test(value.sources.moments?.buildManifestSha256 || "") ||
      !sameJson(value.snapshotIds, {
        holdings: value.sources.holdings?.snapshotId,
        collections: value.sources.collections?.snapshotId,
        moments: value.sources.moments?.snapshotId,
      }) ||
      !Array.isArray(value.datasets) ||
      !Array.isArray(value.files)
    ) {
      throw new Error("manifest.json is not a supported POAPin portable archive.");
    }
    const paths = new Set();
    value.files.forEach((file) => {
      if (
        !file ||
        typeof file.path !== "string" ||
        paths.has(file.path) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        !/^[0-9a-f]{64}$/.test(file.sha256 || "")
      ) {
        throw new Error("manifest.json contains invalid file integrity metadata.");
      }
      paths.add(file.path);
    });
    value.datasets.forEach((dataset) => {
      if (
        !dataset ||
        typeof dataset.id !== "string" ||
        !Number.isSafeInteger(dataset.count) ||
        dataset.count < 0 ||
        !Array.isArray(dataset.paths) ||
        dataset.paths.some((path) => !paths.has(path))
      ) {
        throw new Error("manifest.json contains an invalid dataset.");
      }
    });
  }

  async function verifiedJson(path) {
    const expected = fileIndex.get(path);
    if (!expected) throw new Error(path + " is not declared by manifest.json.");
    const response = await fetch("./" + path, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("Could not read " + path);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== expected.bytes) {
      throw new Error(path + " failed its byte-length check.");
    }
    if (await sha256Hex(bytes) !== expected.sha256) {
      throw new Error(path + " failed its SHA-256 check.");
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error(path + " is not valid JSON.");
    }
  }

  async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }

  function sameJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function renderError(error) {
    const copy = error instanceof Error ? error.message : "The portable archive could not be read.";
    view.replaceChildren(message(copy, "error-card"));
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function shortAddress(value) {
    return value.length > 14 ? value.slice(0, 8) + "…" + value.slice(-6) : value;
  }
})();
`;
}

export function buildReadme(manifest: PortableSiteManifest): string {
  return `# Personal POAP archive

This folder is a complete, read-only personal archive generated by [poap.in](${POAP_IN}).
The archive code is open source at [glorylab/poapin-archive](${REPOSITORY}).

Address: \`${manifest.address}\`

## What is included

- ${manifest.counts.holdings} token-level POAP holdings and ${manifest.counts.uniqueDrops} available Drop records
- ${manifest.counts.unavailableDropReferences} referenced Drop IDs without public details (private and missing are intentionally indistinguishable)
- ${manifest.counts.collectionProfiles} related collection profiles
- ${manifest.counts.heldDropMemberships} formal held-Drop → Collection memberships
- ${manifest.counts.authoredMomentAssociations} authored-Moment → Collection associations
- ${manifest.counts.ownedCollections} fully exported historically owned collections
- ${manifest.counts.publicAuthoredMoments} public authored moments
- ${manifest.counts.publicTaggedMoments} public moments that tag this address
- ${manifest.counts.ownedCapsules} public Capsules whose archived owner matched this address

“Historically owned” means the archived Collection owner field matched this exact address at the
snapshot. It is kept separate from Collections that merely contain a held Drop or are associated
with an authored Moment, and it does not prove current control.

Open \`index.html\` through a static web server. The page first reads only \`manifest.json\`;
each section loads one JSON chunk at a time and shows records in small pages. Archived media URLs
remain in the data, but media is requested only after a visitor clicks its load button.

## Integrity and portability

\`manifest.json\` records the UTF-8 byte length, record count, and SHA-256 digest for every
other generated file; \`checksums.sha256\` is convenient for standard checksum tools. All paths
are relative. No account connection, API, database, build
step, or server runtime is required.

See \`DEPLOY.md\` for direct-upload instructions and \`prompts/\` for agent-ready deployment
prompts. Keep the entire folder together when moving or deploying it.
`;
}

export function buildDeployGuide(): string {
  return `# Deploy this portable archive

Deploy the **contents of this folder**, with \`index.html\` at the published root. If you
received a ZIP, extract it first unless the destination explicitly accepts a ZIP upload.
Do not rewrite the relative paths under \`assets/\` or \`data/\`.

## Direct upload

1. **Cloudflare Drop (recommended):** open <https://www.cloudflare.com/drop/> and upload this ZIP
   or the extracted folder. Keep the private Claim URL secret and finish claiming the deployment
   within 60 minutes; merely opening that URL is not enough.
2. **Vercel Drop:** sign in at <https://vercel.com/drop>, upload this ZIP or the extracted folder,
   select a Team and project name, then deploy.
3. **Filebase Sites:** extract the ZIP, open Sites in Filebase Console, create a Site, and upload
   the entire folder. Filebase Sites accepts a folder or CAR, not this transport ZIP.
4. **Internet Computer (advanced):** publish the extracted folder with an ICP asset canister only
   after reviewing the identity, cycles, canister, and update implications.

After deployment, open the root URL and check Overview, POAPs, Collections, Historically owned,
and Moments. Media should remain dormant until its button is clicked.

## Agent-assisted deployment

Copy the matching file from \`prompts/\` into your coding agent. Replace optional placeholders
such as \`YOUR_DOMAIN\` only when you want a custom domain. Never paste provider tokens into a
prompt; use the provider's authorization flow or local secret storage.

Project links: [poap.in](${POAP_IN}) · [GitHub](${REPOSITORY})
`;
}

export function buildAgentPrompts(manifest: PortableSiteManifest): Record<string, string> {
  const shortAddress = manifest.address.slice(2, 10);
  const compatibilityDate = manifest.generatedAt?.slice(0, 10) ?? "2026-07-23";
  const context = `This folder is a generated, pure-static personal POAP archive for ${manifest.address}.
It already contains index.html, relative assets, data chunks, manifest.json, README.md, and DEPLOY.md.
Do not introduce a framework, server runtime, database, analytics, wallet connection, or build step.
Preserve every relative path. Do not fetch or copy remote POAP/Moment media during deployment.
Keep the visible links to ${POAP_IN} and ${REPOSITORY}.
Verify manifest file sizes and SHA-256 digests before publishing. Never print or commit credentials.`;

  return {
    "prompts/cloudflare.md": `# Deploy with Cloudflare

${context}

Confirm that index.html is at the extracted folder root. Use Wrangler 4.102.0 or newer. If this
environment is not signed in to Cloudflare, run:

\`npm exec --yes wrangler@latest -- deploy --assets <site-directory> --name poap-${shortAddress} --temporary --compatibility-date ${compatibilityDate}\`

If Cloudflare OAuth or API credentials are already available, remove \`--temporary\` and deploy
normally. Request the homepage and verify HTTP 200, hash navigation, dormant media, and the two
fixed project links. Return the workers.dev URL. For a temporary deployment, return the Claim URL
only to the user and remind them to complete the claim within 60 minutes. Treat that Claim URL as
a bearer credential: never write it to code, README files, analytics, commits, logs, or public
messages. If \`YOUR_DOMAIN\` is requested, attach it only after the preview works.
`,
    "prompts/vercel.md": `# Deploy with Vercel

${context}

Confirm that index.html is at the extracted folder root. Use the latest Vercel CLI. If this
environment is not signed in, run \`npx vercel@latest login\` and give the user the device
authorization URL and code so they can approve it from another browser; never ask them to paste
an access token into chat. After authorization, run:

\`npx vercel@latest --cwd <site-directory> --yes --prod\`

Verify HTTP 200, relative assets, hash navigation, dormant media, and the two fixed project links.
Do not commit the \`.vercel\` directory or credentials. If \`YOUR_DOMAIN\` is requested, attach it
only after the generated deployment works. Return the production vercel.app URL.
`,
    "prompts/filebase.md": `# Deploy with Filebase Sites

${context}

Use the user's authorized Filebase Console session. Open Sites, create a Site with an available
lowercase name based on \`poap-${shortAddress}\`, select “Upload now”, and upload the entire
extracted folder. Filebase Sites accepts a folder or CAR, not the transport ZIP. Wait for the
myfilebase.site address, then verify the homepage, hash navigation, dormant media, and fixed
project links. Return the public URL and available CID/deployment details. Do not claim that the
remote media is stored inside the Site: it intentionally references media.poap.in. Do not claim
that a pin is permanent. Configure \`YOUR_DOMAIN\` only if requested and supported by the plan.
`,
    "prompts/icp.md": `# Deploy to the Internet Computer

${context}

Prepare to deploy the extracted folder as static assets on the Internet Computer. First show the
user the selected dfx identity, target network, estimated cycles, canister creation/update
implications, and exact commands. Wait for explicit approval before spending cycles or creating a
canister. Keep index.html at the asset root, preserve content types, and do not add server-side
logic. Verify the manifest, relative assets, hash tabs, dormant media, and fixed project links.
Never expose seed phrases, PEM files, identities, or wallet credentials. Configure
\`YOUR_DOMAIN\` only after the canister URL works. Return the canister identifier and public URL.
`,
  };
}
