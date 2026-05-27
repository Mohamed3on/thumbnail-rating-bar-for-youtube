/**
 * Instagram Network Hook (MAIN world, document_start)
 *
 * Captures IG's own GraphQL / api/v1 responses + the SSR JSON in the initial
 * HTML, extracts {shortcode, likes, comments} tuples, and hands them to the
 * content script via two channels (covers the boot-time race where captures
 * happen before the content script attaches its listener):
 *   1. Accumulates everything into a `<script id="igrb-data">` JSON buffer
 *      that the content script drains on startup.
 *   2. Dispatches a `CustomEvent` with the new items serialized as a JSON
 *      string in `detail` (strings cross worlds reliably; raw objects do not).
 */

(() => {
  // IG URL shortcodes are 11 chars; API responses may append extra encoding so
  // the canonical `code` field can run up to ~60. Anything shorter than 11 is
  // a non-shortcode field (e.g. `code: "en_US"` on a localization node) that
  // would otherwise pollute the cache with phantom keys.
  const SHORTCODE_RE = /^[A-Za-z0-9_-]{11,60}$/;
  const buffer = []; // page-world accumulator
  let bufferTag = null;

  function ensureTag() {
    if (bufferTag && bufferTag.isConnected) return bufferTag;
    bufferTag = document.getElementById('igrb-data');
    if (!bufferTag) {
      bufferTag = document.createElement('script');
      bufferTag.id = 'igrb-data';
      bufferTag.type = 'application/json';
      (document.head || document.documentElement).appendChild(bufferTag);
    }
    return bufferTag;
  }

  function walk(node, out, seen) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);

    const sc = typeof node.code === 'string' && SHORTCODE_RE.test(node.code)
      ? node.code
      : typeof node.shortcode === 'string' && SHORTCODE_RE.test(node.shortcode)
        ? node.shortcode
        : null;

    if (sc) {
      const likes = typeof node.like_count === 'number'
        ? node.like_count
        : node.edge_liked_by?.count ?? node.edge_media_preview_like?.count;
      if (typeof likes === 'number') {
        out.push({
          shortcode: sc,
          likes,
          comments: typeof node.comment_count === 'number'
            ? node.comment_count
            : node.edge_media_to_comment?.count ?? 0,
        });
      }
    }

    if (Array.isArray(node)) {
      for (const item of node) walk(item, out, seen);
    } else {
      for (const key in node) walk(node[key], out, seen);
    }
  }

  function emit(items) {
    if (!items.length) return;
    // The buffer tag is only consulted by the content script's one-shot
    // drainBuffer at document_end. After that signal fires, every later emit
    // flows through the CustomEvent below, so growing + re-stringifying the
    // buffer would be O(N²) dead work over a long browse.
    if (!document.documentElement.dataset.igrbDrained) {
      buffer.push(...items);
      try { ensureTag().textContent = JSON.stringify(buffer); }
      catch (e) { console.warn('[igrb] buffer write failed:', e); }
    }
    document.dispatchEvent(new CustomEvent('igrb-data', { detail: JSON.stringify(items) }));
  }

  function dispatch(text) {
    if (!text || text.length < 50) return;
    if (!text.includes('like_count') && !text.includes('edge_liked_by') && !text.includes('edge_media_preview_like')) return;
    let json;
    try { json = JSON.parse(text); }
    catch (e) { console.warn('[igrb] response parse failed:', e); return; }
    const items = [];
    walk(json, items, new WeakSet());
    emit(items);
  }

  function scanInitialScripts() {
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      if (script.id === 'igrb-data') continue;
      dispatch(script.textContent);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanInitialScripts, { once: true });
  } else {
    scanInitialScripts();
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    if (url && (url.includes('/graphql/query') || url.includes('/api/v1/'))) {
      res.clone().text().then(dispatch).catch((e) => {
        console.warn('[igrb] fetch capture failed:', url, e);
      });
    }
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__igrbUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const url = this.__igrbUrl;
    if (url && (url.includes('/graphql/query') || url.includes('/api/v1/'))) {
      this.addEventListener('load', () => {
        try { dispatch(this.responseText); }
        catch (e) { console.warn('[igrb] xhr capture failed:', url, e); }
      });
    }
    return origSend.apply(this, arguments);
  };
})();
