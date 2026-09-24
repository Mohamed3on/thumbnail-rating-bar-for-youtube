/**
 * Instagram Network Hook (MAIN world, document_start)
 *
 * Captures IG's own GraphQL / api/v1 responses + the SSR JSON in the initial
 * HTML, extracts {shortcode, likes, comments, liked} tuples (`liked`: you've
 * liked the post), and hands them to the content script via two channels
 * (covers the boot-time race where captures happen before the content script
 * attaches its listener):
 *   1. Accumulates everything into a `<script id="igrb-data">` JSON buffer
 *      that the content script drains on startup.
 *   2. Dispatches a `CustomEvent` with the new items serialized as a JSON
 *      string in `detail` (strings cross worlds reliably; raw objects do not).
 *
 * It also reads the suggestions responses for mutuals.js, which sorts Discover
 * People by mutual followers and lists the best of them on the home page, and
 * makes that request on its behalf there, where IG doesn't.
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
          liked: node.has_liked === true,
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
    const likes = text.includes('like_count') || text.includes('edge_liked_by') || text.includes('edge_media_preview_like');
    const suggestions = text.includes('suggested_users');
    if (!likes && !suggestions) return;
    let json;
    try { json = JSON.parse(text); }
    catch (e) { console.warn('[igrb] response parse failed:', e); return; }
    if (suggestions) collectSuggested(json);
    if (!likes) return;
    const items = [];
    walk(json, items, new WeakSet());
    emit(items);
  }

  // /explore/people/ arrives as a single response holding every suggestion, each
  // carrying the "Followed by marcusolivix and 12 more" line its row renders. That
  // sentence is the only count IG gives — nothing in the payload is a number — and
  // it comes two ways ("and 12 more", "+ 45 more"), so both are read here. The
  // facepile is what says whether there are mutuals at all, which the "Suggested
  // for you" rows have none of, and it doesn't go through English to say it.
  const MORE = /(?:and|\+) ([\d.,]+[KM]?) more$/;
  const suggested = {}; // username → { m: mutual followers, pk, n: full name, pic, c: "Followed by…", who: a mutual's username, face: their picture }

  const scale = (s) => parseFloat(s.replace(/,/g, '')) * (/K$/i.test(s) ? 1e3 : /M$/i.test(s) ? 1e6 : 1);

  function collectSuggested(json) {
    const list = json?.suggested_users?.suggestions;
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const user = item?.user;
      if (!user?.username) continue;
      const more = item.social_context?.match(MORE);
      const face = item.social_context_facepile_users?.[0];
      // The named account is the +1 the sentence leaves implicit.
      suggested[user.username] = { m: face ? 1 + (more ? scale(more[1]) : 0) : 0, pk: user.pk_id ?? user.pk, n: user.full_name, pic: user.profile_pic_url, c: item.social_context, who: face?.username, face: face?.profile_pic_url };
    }
    announceSuggested();
  }

  // The suggestions can land before the content script is listening, so it can ask.
  function announceSuggested() {
    document.dispatchEvent(new CustomEvent('igrb-suggested', { detail: JSON.stringify(suggested) }));
  }

  document.addEventListener('igrb-suggested-ask', announceSuggested);

  // The home page requests no suggestions of its own, so mutuals.js asks for them
  // here: IG's own Discover People request, which the hooked fetch below then
  // hands to collectSuggested like any other.
  document.addEventListener('igrb-suggested-fetch', () => {
    // A fresh batch, not a running total.
    for (const name in suggested) delete suggested[name];
    fetch('/api/v1/discover/ayml/', {
      method: 'POST',
      headers: {
        'x-ig-app-id': '936619743392459',
        'x-asbd-id': '359341',
        'x-requested-with': 'XMLHttpRequest',
        'x-csrftoken': document.cookie.match(/(?:^|; )csrftoken=([^;]*)/)?.[1],
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'max_id=%5B%5D&max_number_to_display=30&module=discover_people&paginate=true',
    }).catch((e) => console.warn('[igrb] suggestions request failed:', e));
  });

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
