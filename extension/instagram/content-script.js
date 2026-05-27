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
const FOCUS_DURATION_MS = 2500;
const LOG = '[igrb]';

const cache = new Map();
let cacheDirty = false;
let currentShortcode = null;

function extractShortcode(href) {
  if (!href) return null;
  const m = href.match(POST_HREF_REGEX);
  return m ? m[2] : null;
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

// IG's API code is always the URL shortcode optionally followed by extra chars
// (legacy posts: exact 11-char match; new format: ~28-char with the 11-char
// shortcode as prefix). One-directional `startsWith` is therefore safe; the
// reverse direction would let an API code that happens to be a prefix of a
// longer rendered shortcode collide with an unrelated post.
function findLinkByApiCode(apiCode) {
  for (const link of document.querySelectorAll(POST_LINK_SELECTOR)) {
    const domSc = extractShortcode(link.getAttribute('href'));
    if (domSc && apiCode.startsWith(domSc)) return link;
  }
  return null;
}

// Rank only over posts currently rendered as links in the DOM. This naturally
// excludes (a) cache entries from other profiles, (b) "suggested" / sidebar
// shortcodes that come through GraphQL but never get a visible link, and
// (c) posts virtualized far enough off-screen that we couldn't scroll to them
// anyway. As the user scrolls, IG renders new links and the rank expands.
function getRanked() {
  const domShortcodes = new Set();
  for (const link of document.querySelectorAll(POST_LINK_SELECTOR)) {
    const sc = extractShortcode(link.getAttribute('href'));
    if (sc) domShortcodes.add(sc);
  }
  if (!domShortcodes.size) return [];
  const out = [];
  for (const [apiCode, data] of cache) {
    for (const domSc of domShortcodes) {
      if (apiCode.startsWith(domSc)) {
        out.push({ shortcode: apiCode, likes: data.likes });
        break;
      }
    }
  }
  return out.sort((a, b) => b.likes - a.likes);
}

// Focus state — tracked by shortcode so we can re-apply the class + label after
// IG re-renders the post's parent (virtualization + batch loads remove them).
let focusedShortcode = null;
let focusedLabel = null;
let focusTimer = null;
const focusObserver = new MutationObserver(() => applyFocusToDOM());

function applyFocusToDOM() {
  if (!focusedShortcode) return;
  const link = findLinkByApiCode(focusedShortcode);
  if (!link) return;
  const host = link.parentElement || link;
  if (!host.classList.contains(FOCUS_CLASS)) host.classList.add(FOCUS_CLASS);

  let lbl = host.querySelector(':scope > .igrb-focus-label');
  if (!lbl) {
    lbl = document.createElement('div');
    lbl.className = 'igrb-focus-label';
    host.appendChild(lbl);
  }
  if (lbl.textContent !== focusedLabel) lbl.textContent = focusedLabel;
}

function clearAllFocus() {
  document.querySelectorAll('.' + FOCUS_CLASS).forEach((el) => el.classList.remove(FOCUS_CLASS));
  document.querySelectorAll('.igrb-focus-label').forEach((el) => el.remove());
}

function setFocus(apiShortcode, label) {
  clearAllFocus();
  if (focusTimer) clearTimeout(focusTimer);
  focusedShortcode = apiShortcode;
  focusedLabel = label;
  applyFocusToDOM();
  focusObserver.observe(document.body, { childList: true, subtree: true });
  focusTimer = setTimeout(() => {
    focusObserver.disconnect();
    focusedShortcode = null;
    focusedLabel = null;
    clearAllFocus();
  }, FOCUS_DURATION_MS);
}

function cycleToRank(direction) {
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

  const link = findLinkByApiCode(target.shortcode);
  if (link) link.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Set focus even if link not yet in DOM — the observer will apply the class
  // once IG renders it after our scroll lands.
  setFocus(target.shortcode, `#${idx + 1} · ❤ ${target.likes}`);
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
  if (e.key !== ']' && e.key !== '[') return;
  e.preventDefault();
  cycleToRank(e.key === ']' ? 'forward' : 'backward');
});

drainBuffer();
// Tell page-script it can stop re-serializing the buffer tag — live events
// are now flowing through the addEventListener above.
document.documentElement.dataset.igrbDrained = '1';
console.log(LOG, 'ready @', location.pathname, '— cache:', cache.size);
