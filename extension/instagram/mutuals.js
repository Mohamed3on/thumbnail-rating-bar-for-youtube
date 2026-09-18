/**
 * Instagram Discover People, ranked by mutuals
 *
 * /explore/people/ comes back in IG's own order, so an account a dozen people you
 * follow already follow can sit below one nobody you know does. This reorders the
 * list by that count, which page-script.js reads off the suggestions response IG
 * already made — one request carries the whole page, so this costs nothing.
 *
 * Rows are matched to their count by the username in their links rather than by
 * the "Followed by…" line they render, so a row IG gave no such line ("Suggested
 * for you") still takes part, as 0, instead of being stranded mid-list.
 */
(() => {
  const PATH = '/explore/people';
  const counts = new Map(); // username → mutual followers
  let queued = false;

  const username = (link) => link.pathname.match(/^\/([A-Za-z0-9._]+)\/$/)?.[1];

  // The rows carry no stable class, so anchor on the links IG gives each suggestion
  // and work outwards: the nearest parent that two rows' links share is the list,
  // and a row is the child of that list holding one of them. Avatar and name both
  // link out, so each row turns up twice — hence keying the result by row.
  function collect() {
    const links = [];
    for (const link of document.querySelectorAll('a[href^="/"]')) {
      const name = username(link);
      if (counts.has(name)) links.push([link, name]);
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
      rows.set(row, counts.get(name));
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

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      sort();
    });
  }

  document.addEventListener('igrb-suggested', (e) => {
    for (const [name, mutuals] of Object.entries(JSON.parse(e.detail))) counts.set(name, mutuals);
    schedule();
  });
  // Catches the response if it landed before this listener existed.
  document.dispatchEvent(new CustomEvent('igrb-suggested-ask'));

  // IG is an SPA that re-renders the list freely, so watch for it and re-sort; the
  // check in `sort` is what keeps this off every other page.
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
})();
