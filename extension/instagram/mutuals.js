/**
 * Instagram suggestions, ranked by mutuals
 *
 * /explore/people/ comes back in IG's own order, so an account a dozen people you
 * follow already follow can sit below one nobody you know does. This reorders the
 * list by that count, which page-script.js reads off the suggestions response IG
 * already made — one request carries the whole page, so this costs nothing.
 *
 * Rows are matched to their count by the username in their links rather than by
 * the "Followed by…" line they render, so a row IG gave no such line ("Suggested
 * for you") still takes part, as 0, instead of being stranded mid-list.
 *
 * The home page's "Suggested for you" rail gets the same ranking: IG's five picks
 * are hidden and the suggestions with the most mutuals take their place, Follow
 * button included. That page requests no suggestions itself, so page-script.js is
 * asked for them at most hourly, and the latest batch is kept per account in
 * chrome.storage.local under `igmu:<uid>` as { t, users: { username: {…} } }.
 */
(() => {
  const cookie = (name) => document.cookie.match(`(?:^|; )${name}=([^;]*)`)?.[1];
  const uid = cookie('ds_user_id');
  if (!uid) return;

  const PATH = '/explore/people';
  const KEY = `igmu:${uid}`;
  const FRESH_MS = 60 * 60 * 1000;
  const HEADERS = { 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest', 'x-asbd-id': '359341' };
  const ROW_PX = 60; // IG's rail rows

  const users = new Map(); // username → { m: mutual followers, pk, n: full name, pic, c: "Followed by…", who, face }
  let updated = 0; // when the current batch arrived
  let asked = 0; // when page-script was last asked for one, so a failure isn't retried on every render
  let queued = false;

  const username = (link) => link.pathname.match(/^\/([A-Za-z0-9._]+)\/$/)?.[1];

  function h(tag, props, ...children) {
    const el = Object.assign(document.createElement(tag), props);
    el.append(...children.flat().filter(Boolean));
    return el;
  }

  // Followed accounts are left out so they don't come back on the next visit.
  function save() {
    chrome.storage.local.set({ [KEY]: { t: updated, users: Object.fromEntries([...users].filter(([, u]) => !u.followed)) } });
  }

  // The rows carry no stable class, so anchor on the links IG gives each suggestion
  // and work outwards: the nearest parent that two rows' links share is the list,
  // and a row is the child of that list holding one of them. Avatar and name both
  // link out, so each row turns up twice — hence keying the result by row.
  function collect() {
    const links = [];
    for (const link of document.querySelectorAll('a[href^="/"]')) {
      const name = username(link);
      if (users.has(name)) links.push([link, name]);
    }
    // Two links from the same row would meet at the row, not the list.
    const other = links.find(([, name]) => name !== links[0]?.[1]);
    if (!other) return null;
    let list = links[0][0];
    while (list && !list.contains(other[0])) list = list.parentElement;
    if (!list || list === document.body) return null;
    const rows = new Map();
    for (const [link, name] of links) {
      if (!list.contains(link)) continue; // a suggestion rail elsewhere on the page
      let row = link;
      while (row.parentElement !== list) row = row.parentElement;
      rows.set(row, users.get(name).m);
    }
    return { list, rows };
  }

  function sort() {
    if (!location.pathname.startsWith(PATH)) return;
    const found = collect();
    if (!found) return;
    const { list, rows } = found;
    const order = [...list.children];
    // Sorting is stable, so equal counts keep the order IG ranked them in.
    const sorted = [...order].sort((a, b) => (rows.get(b) ?? 0) - (rows.get(a) ?? 0));
    // Rewriting an order that's already right would retrigger the observer forever.
    if (sorted.every((row, i) => row === order[i])) return;
    // Every row moves, so park them all against whatever followed the last one and
    // the block lands back where it was, with any loader below it left alone.
    const end = order[order.length - 1].nextSibling;
    for (const row of sorted) list.insertBefore(row, end);
  }

  // IG's rail is a header ("Suggested for you", "See all") over a list of rows that
  // link avatar and name to the profile. Ours go into that same list so its spacing
  // carries over, and IG's rows are hidden inline, which its re-renders leave be.
  function rail() {
    if (location.pathname !== '/') return;
    const names = (el) => new Set([...el.querySelectorAll('a[href^="/"]')].map(username).filter(Boolean));
    let box = document.querySelector('a[href="/explore/people/"]');
    while (box && box !== document.body && names(box).size < 2) box = box.parentElement;
    const list = box && box !== document.body && [...box.children].find((el) => names(el).size);
    if (!list) return;
    if (Date.now() - Math.max(updated, asked) > FRESH_MS) {
      asked = Date.now();
      document.dispatchEvent(new CustomEvent('igrb-suggested-fetch'));
    }
    if (!users.size) return;
    let ours = list.querySelector('.igmu-rail');
    if (!ours) list.append(ours = h('div', { className: 'igmu-rail' }));
    for (const row of list.children) if (row !== ours) row.style.display = 'none';
    // As many as fit: the rail is fixed to the viewport and doesn't scroll.
    const fit = Math.min(10, Math.max(5, Math.floor((innerHeight - list.getBoundingClientRect().top) / ROW_PX)));
    const top = [...users].sort(([, a], [, b]) => b.m - a.m).slice(0, fit);
    // The observer fires for this write too, so only rebuild when the ranking changed.
    const key = top.map(([name]) => name).join(' ');
    if (ours.dataset.key === key) return;
    ours.dataset.key = key;
    ours.replaceChildren(...top.map(row));
  }

  function row([name, u]) {
    const btn = h('button', { type: 'button', className: 'igmu-follow', disabled: !!u.followed, onclick: () => follow(u, btn) }, u.followed || 'Follow');
    return h('div', { className: 'igmu-row' },
      h('a', { href: `/${name}/` }, h('img', { className: 'igmu-avatar', src: u.pic, alt: '' })),
      h('div', { className: 'igmu-text' },
        h('a', { className: 'igmu-name', href: `/${name}/` }, u.n || name),
        // The count, then the mutual whose face this is: IG's whole sentence adds nothing.
        h('span', { className: 'igmu-sub' },
          u.face && h('img', { className: 'igmu-face', src: u.face, alt: '' }),
          u.m > 0
            ? [h('b', { className: 'igmu-count' }, u.m.toLocaleString()), u.who && h('span', { className: 'igmu-context' }, `· ${u.who}`)]
            : h('span', { className: 'igmu-context' }, u.c || 'Suggested for you'))),
      btn);
  }

  // The same request IG's own Follow button sends.
  async function follow(u, btn) {
    btn.disabled = true;
    try {
      const res = await fetch(`/api/v1/friendships/create/${u.pk}/`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...HEADERS, 'x-csrftoken': cookie('csrftoken'), 'content-type': 'application/x-www-form-urlencoded' },
        body: `user_id=${u.pk}&container_module=discover_people`,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { friendship_status } = await res.json();
      // A private account only gets a request.
      u.followed = friendship_status?.following ? 'Following' : 'Requested';
      btn.textContent = u.followed;
      save();
    } catch (e) {
      console.warn('[igmu] follow failed:', e);
      btn.disabled = false;
      btn.textContent = 'Try again';
    }
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      sort();
      rail();
    });
  }

  document.addEventListener('igrb-suggested', (e) => {
    const batch = Object.entries(JSON.parse(e.detail));
    if (!batch.length) return; // the ask below is answered even before anything arrived
    users.clear();
    for (const [name, u] of batch) users.set(name, u);
    updated = Date.now();
    save();
    schedule();
  });
  // Catches the response if it landed before this listener existed.
  document.dispatchEvent(new CustomEvent('igrb-suggested-ask'));

  async function init() {
    const stored = (await chrome.storage.local.get(KEY))[KEY];
    // Unless a fresher batch already came in from the page.
    if (stored?.t > updated) {
      users.clear();
      for (const [name, u] of Object.entries(stored.users)) users.set(name, u);
      updated = stored.t;
    }
    // IG is an SPA that re-renders freely, so watch for it and redo; the path checks
    // in `sort` and `rail` are what keep this off every other page.
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    schedule();
  }

  init();
})();
