/**
 * Instagram Highest-Liked Cycler
 *
 * Listens for IG's own GraphQL/api responses (piped from page-script.js) and
 * builds a cache of {shortcode → likes/comments}. Press `]` / `[` to scroll
 * between the highest-liked posts currently rendered in the DOM. We filter
 * through DOM links so cross-profile cache entries and "suggested" posts
 * embedded in GraphQL responses (which have likes but no rendered link) can't
 * pollute the ranking and cause cycling to silently no-op on phantom items.
 */

const CACHE_KEY = 'igrb_cache';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const POST_HREF_REGEX = /\/(p|reel|tv)\/([A-Za-z0-9_-]+)/;
const POST_LINK_SELECTOR = 'a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]';
const FOCUS_CLASS = 'igrb-focused';
const LOG = '[igrb]';

const cache = new Map();
let cacheDirty = false;
let currentShortcode = null;

// Per-feed rank state. `offsets` remembers each post's absolute document Y the
// first time we see it rendered, so cycling can scroll back to a post even after
// IG virtualizes its tile out of the grid. Keyed by the 11-char DOM shortcode and
// cleared whenever the path changes (different profile / tab → different feed).
const offsets = new Map();
let feedKey = location.pathname;

function extractShortcode(href) {
  if (!href) return null;
  const m = href.match(POST_HREF_REGEX);
  return m ? m[2] : null;
}

// 2 340 454 → "2.3M", 529 824 → "530K". Mirrors IG's own like-count formatting.
function formatLikes(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(n);
}

chrome.storage.local.get(CACHE_KEY, (result) => {
  const stored = result?.[CACHE_KEY];
  if (!stored) return;
  const now = Date.now();
  // drainBuffer / live ingestion may have already populated cache with fresher
  // data before this async callback fired — never overwrite that.
  for (const [sc, entry] of Object.entries(stored)) {
    if (cache.has(sc)) continue;
    if (now - entry.ts < CACHE_TTL_MS) cache.set(sc, entry);
  }
  console.log(LOG, 'hydrated', cache.size, 'entries from storage');
});

setInterval(() => {
  if (!cacheDirty) return;
  cacheDirty = false;
  const obj = {};
  for (const [k, v] of cache) obj[k] = v;
  chrome.storage.local.set({ [CACHE_KEY]: obj }).catch((e) => {
    console.warn(LOG, 'storage.set failed:', e);
    cacheDirty = true;
  });
}, 5000);

function ingestItems(items) {
  if (!Array.isArray(items) || !items.length) return;
  const ts = Date.now();
  let added = 0;
  for (const item of items) {
    if (!item || typeof item.shortcode !== 'string') continue;
    const prev = cache.get(item.shortcode);
    if (prev && prev.likes === item.likes && prev.comments === item.comments) continue;
    cache.set(item.shortcode, { likes: item.likes, comments: item.comments, ts });
    added++;
  }
  if (added) {
    cacheDirty = true;
    console.log(LOG, 'ingested', added, '/', items.length, '— cache:', cache.size);
  }
}

function drainBuffer() {
  const tag = document.getElementById('igrb-data');
  if (!tag?.textContent) return;
  try { ingestItems(JSON.parse(tag.textContent)); }
  catch (e) { console.warn(LOG, 'drainBuffer parse failed:', e); }
}

document.addEventListener('igrb-data', (e) => {
  try { ingestItems(JSON.parse(e.detail)); }
  catch (err) { console.warn(LOG, 'event parse failed:', err); }
});

function findLinkByShortcode(sc) {
  for (const link of document.querySelectorAll(POST_LINK_SELECTOR)) {
    if (extractShortcode(link.getAttribute('href')) === sc) return link;
  }
  return null;
}

// Record the absolute Y of every grid link we haven't seen before. Capturing on
// first sight (rather than at rank time) keeps a post rankable — and scrollable-to
// — after IG virtualizes its tile away. A path change means we've moved to a
// different feed, so the old positions are void.
function captureOffsets() {
  if (location.pathname !== feedKey) {
    feedKey = location.pathname;
    offsets.clear();
    currentShortcode = null;
    clearFocus();
  }
  const pageY = window.scrollY;
  for (const link of document.querySelectorAll(POST_LINK_SELECTOR)) {
    const sc = extractShortcode(link.getAttribute('href'));
    if (sc && !offsets.has(sc)) offsets.set(sc, link.getBoundingClientRect().top + pageY);
  }
}

let captureTimer = null;
function scheduleCapture() {
  if (captureTimer) return;
  captureTimer = setTimeout(() => { captureTimer = null; captureOffsets(); }, 200);
}

// Rank over every post seen on this feed (filtered to those we have likes for),
// not just the handful IG currently renders — otherwise the rendered window's max
// masquerades as the global #1 and the true top post vanishes the moment it
// scrolls out of the DOM. Suggested / cross-profile cache entries are excluded
// for free: they never get a rendered link, so they never enter `offsets`.
function getRanked() {
  // Canonicalize keys to their 11-char shortcode prefix before matching: both the
  // cache and the grid href can carry IG's longer ~40-char `code` instead of the
  // shortcode (the long form shows up in private-profile links). The shortcode is
  // always the prefix, so slice BOTH sides — slicing only the cache (the prior
  // bug) left long-code offsets keys unmatchable and silently emptied the ranking.
  const likesByShortcode = new Map();
  for (const [apiCode, data] of cache) {
    const sc = apiCode.slice(0, 11);
    if (!likesByShortcode.has(sc)) likesByShortcode.set(sc, data.likes);
  }
  const out = [];
  for (const [sc, offset] of offsets) {
    const likes = likesByShortcode.get(sc.slice(0, 11));
    if (likes != null) out.push({ shortcode: sc, likes, offset });
  }
  return out.sort((a, b) => b.likes - a.likes);
}

// Focus state — tracked by shortcode so we can re-apply the class + label after
// IG re-renders the post's parent (virtualization + batch loads remove them). The
// highlight persists until the next cycle, so the observer stays live; coalesce
// its callback to one re-apply per frame to stay cheap on IG's busy DOM.
let focusedShortcode = null;
let focusedLabelHTML = null;
let focusedHost = null;
let applyScheduled = false;
const focusObserver = new MutationObserver(() => {
  if (applyScheduled) return;
  applyScheduled = true;
  requestAnimationFrame(() => { applyScheduled = false; applyFocusToDOM(); });
});

function applyFocusToDOM() {
  if (!focusedShortcode) return;
  // Fast path: while the highlighted tile is still on screen there's nothing to
  // do, so skip re-scanning the DOM on every mutation. We only re-resolve once IG
  // virtualizes the tile away (host detached / our label stripped) and re-renders.
  if (focusedHost && focusedHost.isConnected && focusedHost.querySelector(':scope > .igrb-focus-label')) return;
  const link = findLinkByShortcode(focusedShortcode);
  if (!link) return;
  focusedHost = link.parentElement || link;
  focusedHost.classList.add(FOCUS_CLASS);
  const lbl = document.createElement('div');
  lbl.className = 'igrb-focus-label';
  lbl.innerHTML = focusedLabelHTML;
  focusedHost.appendChild(lbl);
}

function clearAllFocus() {
  document.querySelectorAll('.' + FOCUS_CLASS).forEach((el) => el.classList.remove(FOCUS_CLASS));
  document.querySelectorAll('.igrb-focus-label').forEach((el) => el.remove());
}

function clearFocus() {
  focusObserver.disconnect();
  focusedShortcode = null;
  focusedHost = null;
  clearAllFocus();
}

function setFocus(shortcode, rank, likes) {
  clearAllFocus();
  focusedShortcode = shortcode;
  focusedHost = null;
  focusedLabelHTML =
    `<span class="igrb-rank">#${rank}</span>` +
    `<span class="igrb-likes"><span class="igrb-heart">♥</span>${formatLikes(likes)}</span>`;
  applyFocusToDOM();
  focusObserver.observe(document.body, { childList: true, subtree: true });
}

function cycleToRank(direction) {
  captureOffsets();
  const ranked = getRanked();
  if (!ranked.length) {
    console.log(LOG, 'cycle', direction, '— no ranked items (cache:', cache.size, ')');
    return;
  }

  let idx = ranked.findIndex((p) => p.shortcode === currentShortcode);
  idx =
    direction === 'forward'
      ? Math.min(idx + 1, ranked.length - 1)
      : Math.max(idx - 1, 0);

  const target = ranked[idx];
  currentShortcode = target.shortcode;
  console.log(LOG, direction, '→ #' + (idx + 1) + '/' + ranked.length, '❤', target.likes);

  const link = findLinkByShortcode(target.shortcode);
  if (link) {
    link.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    // Virtualized out of the grid — smooth-scroll to its remembered position; the
    // observer applies the highlight once IG renders the tile there.
    window.scrollTo({ top: Math.max(0, target.offset - window.innerHeight / 2), behavior: 'smooth' });
  }
  // Set focus even if link not yet in DOM — the observer will apply the class
  // once IG renders it after our scroll lands.
  setFocus(target.shortcode, idx + 1, target.likes);
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
  if (e.key !== ']' && e.key !== '[') return;
  e.preventDefault();
  cycleToRank(e.key === ']' ? 'forward' : 'backward');
});

drainBuffer();
// Remember positions as the user scrolls, plus once shortly after load to grab
// the initial grid (incl. pinned posts) before any scroll happens.
window.addEventListener('scroll', scheduleCapture, { passive: true });
setTimeout(captureOffsets, 1500);
// Tell page-script it can stop re-serializing the buffer tag — live events
// are now flowing through the addEventListener above.
document.documentElement.dataset.igrbDrained = '1';
console.log(LOG, 'ready @', location.pathname, '— cache:', cache.size);
