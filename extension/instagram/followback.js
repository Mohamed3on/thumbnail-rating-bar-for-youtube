/**
 * Instagram Follow-back
 *
 * Adds a quiet "N not following back" stat beside your own profile's follower
 * counts. Clicking it opens your last results instantly and refreshes them in the
 * background when they're stale: it pages through both follow lists with IG's
 * private API, fetched from inside the page so it rides your logged-in session,
 * and diffs your followers against the previous check to log who unfollowed or
 * followed you. Only people you still follow count as unfollowers: an account
 * that vanished from your following list too deactivated, or you unfollowed it.
 *
 * One snapshot per account in chrome.storage.local under `igfb:<uid>`:
 *   { t, counts: [followers, following], followers: { pk: { u, n, pic } },
 *     following: { pk: { u, n, pic } }, log: [{ t, type: 'unfollowed' | 'followed', pk, u, n, pic }] }
 * `counts` are IG's own totals at check time, compared against the profile header
 * to refresh when they change. The first check only saves a baseline. Accounts are
 * matched by pk, never username, since usernames change.
 */
(() => {
  const cookie = (name) => document.cookie.match(`(?:^|; )${name}=([^;]*)`)?.[1];
  const uid = cookie('ds_user_id');
  if (!uid) return;

  const KEY = `igfb:${uid}`;
  const HEADERS = { 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest', 'x-asbd-id': '359341' };
  const LOG_CAP = 1000;
  // IG rate-limits follow lists after a few full passes, so opening the panel
  // refreshes at most hourly; the refresh button forces a check.
  const FRESH_MS = 60 * 60 * 1000;
  const TABS = [
    ['notBack', 'Not following back', (n) => `${n.toLocaleString()} not following back`],
    ['unfollowed', 'Unfollowers', (n) => `${n.toLocaleString()} unfollower${n === 1 ? '' : 's'}`],
    ['followed', 'New followers', (n) => `${n.toLocaleString()} new follower${n === 1 ? '' : 's'}`],
  ];
  const ICON = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const ICON_CLOSE = `<svg ${ICON}><path d="M18 6 6 18M6 6l12 12"/></svg>`;
  const ICON_REFRESH = `<svg ${ICON}><path d="M21 4v5h-5"/><path d="M20.5 15a9 9 0 1 1-2.1-9.4L21 9"/></svg>`;
  const ICON_SEARCH = `<svg ${ICON}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;
  // IG's own loading spinner: eight spokes stepping round.
  const SPINNER = `<svg viewBox="0 0 100 100" fill="currentColor" aria-hidden="true">${Array.from({ length: 8 }, (_, i) =>
    `<rect x="67" y="45" width="28" height="10" rx="5" opacity="${i / 8}" transform="rotate(${i * 45 - 90} 50 50)"/>`).join('')}</svg>`;

  let data = null; // this account's snapshot
  let seen = 0; // newest check you've had the panel open for; later log entries are "new"
  let attempted = 0; // when the last check started, so a failure isn't retried on every open
  let progress = null; // { text, pct } while a check runs
  let error = null; // why the last check failed
  let tab = 'notBack';
  let panel = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  // Children may be nested arrays or false/null/'' placeholders. IG data only
  // ever goes in as children, which the DOM turns into text nodes.
  const kids = (children) => children.flat().filter((c) => c || c === 0);

  function h(tag, props, ...children) {
    const el = Object.assign(document.createElement(tag), props);
    el.append(...kids(children));
    return el;
  }

  // 400/429 is IG rate-limiting and 5xx a hiccup: back off 15s, 30s, 45s… and
  // give up after 5 tries.
  async function api(path) {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(path, { credentials: 'include', headers: { ...HEADERS, 'x-csrftoken': cookie('csrftoken') } });
      if (res.ok) return res.json();
      if (res.status === 401 || res.status === 403) throw new Error('Instagram signed you out. Log back in to check.');
      if (attempt === 5 || !(res.status === 400 || res.status === 429 || res.status >= 500)) {
        throw new Error(`Instagram didn't respond (HTTP ${res.status}). Try again later.`);
      }
      progress.text = `Instagram is busy, retrying in ${15 * attempt}s…`;
      renderStatus();
      await sleep(15000 * attempt);
    }
  }

  // Pages through a follow list into { pk: { u, n, pic } }. `done` and `all`
  // span both lists, so the progress bar fills once over the whole check. A short
  // list would pass off everyone missing from it as an unfollower, or as unfollowed
  // by you, so it fails the check instead.
  async function fetchList(kind, params, total, done, all) {
    const verb = data ? 'Updating' : 'Loading';
    const users = {};
    let maxId = '';
    let got = 0;
    do {
      const page = await api(`/api/v1/friendships/${uid}/${kind}/?${params}${maxId && `&max_id=${encodeURIComponent(maxId)}`}`);
      for (const user of page.users) users[user.pk_id ?? user.pk] = { u: user.username, n: user.full_name, pic: user.profile_pic_url };
      got = Object.keys(users).length;
      progress = { text: `${verb} ${kind}… ${got.toLocaleString()} of ${total.toLocaleString()}`, pct: (done + got) / all };
      renderStatus();
      maxId = page.next_max_id;
      if (maxId) await sleep(500 + Math.random() * 500);
    } while (maxId);
    if (got < total - Math.max(5, total * 0.02)) {
      throw new Error(`Instagram only sent ${got.toLocaleString()} of ${total.toLocaleString()} ${kind}, so nothing changed. Try again in a few minutes.`);
    }
    return users;
  }

  async function check() {
    if (progress) return;
    attempted = Date.now();
    progress = { text: `${data ? 'Updating' : 'Loading'}…`, pct: 0 };
    error = null;
    render();
    try {
      const { user } = await api(`/api/v1/users/${uid}/info/`);
      const all = user.following_count + user.follower_count;
      const following = await fetchList('following', 'count=200', user.following_count, 0, all);
      const followers = await fetchList('followers', 'count=50&search_surface=follow_list_page', user.follower_count, user.following_count, all);
      const prev = (await chrome.storage.local.get(KEY))[KEY];
      const t = Date.now();
      const log = prev?.log ?? [];
      if (prev) {
        // Gone from your following list too means they deactivated, or you unfollowed them as well.
        for (const pk in prev.followers) if (!followers[pk] && following[pk]) log.push({ t, type: 'unfollowed', pk, ...prev.followers[pk] });
        for (const pk in followers) if (!prev.followers[pk]) log.push({ t, type: 'followed', pk, ...followers[pk] });
      }
      data = { t, counts: [user.follower_count, user.following_count], followers, following, log: log.slice(-LOG_CAP) };
      await chrome.storage.local.set({ [KEY]: data });
    } catch (e) {
      error = e.message;
    } finally {
      progress = null;
      render();
    }
  }

  function lists() {
    if (!data) return null;
    const events = (type) => data.log.filter((e) => e.type === type).reverse();
    return {
      notBack: data.following && Object.entries(data.following).filter(([pk]) => !data.followers[pk]).map(([pk, a]) => ({ pk, ...a })),
      // Anyone you've unfollowed since, or who deactivated, no longer matters.
      unfollowed: events('unfollowed').filter((e) => data.following?.[e.pk]),
      followed: events('followed'),
    };
  }

  function ago(t) {
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return rtf.format(-mins, 'minute');
    if (mins < 1440) return rtf.format(-Math.round(mins / 60), 'hour');
    return rtf.format(-Math.round(mins / 1440), 'day');
  }

  // IG's compact timestamps: 5m, 3h, 2d, 6w.
  function short(t) {
    const mins = Math.max(1, Math.floor((Date.now() - t) / 60000));
    if (mins < 60) return `${mins}m`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h`;
    if (mins < 10080) return `${Math.floor(mins / 1440)}d`;
    return `${Math.floor(mins / 10080)}w`;
  }

  // The icon and label are kept as nodes so the spinner doesn't restart on every tick.
  const chipIcon = h('span', { className: 'igfb-dot' });
  const chipLabel = h('span', {});
  const chip = h('button', { type: 'button', className: 'igfb-chip', onclick: openPanel }, chipIcon, chipLabel);

  function renderChip() {
    const l = lists();
    const unseen = l ? l.unfollowed.filter((e) => e.t > seen).length : 0;
    if (!!progress !== chipIcon.classList.contains('igfb-spinner')) {
      chipIcon.className = progress ? 'igfb-spinner' : 'igfb-dot';
      chipIcon.innerHTML = progress ? SPINNER : '';
    }
    chipLabel.replaceChildren(...kids([
      l?.notBack ? [h('b', {}, l.notBack.length.toLocaleString()), ' not following back']
        : progress ? `Checking… ${Math.round(progress.pct * 100)}%`
        : 'Check follow-back',
      unseen > 0 && h('span', { className: 'igfb-unseen' }, ` · ${unseen} unfollowed`),
    ]));
  }

  // Progress ticks only touch the chip and header, so the list keeps its scroll.
  function renderStatus() {
    renderChip();
    if (!panel) return;
    panel.bar.hidden = !progress;
    panel.bar.style.transform = `scaleX(${Math.min(1, progress?.pct ?? 0)})`;
    panel.status.textContent = progress?.text ?? (data ? `Updated ${ago(data.t)}` : '');
    panel.refresh.disabled = !!progress;
  }

  function render() {
    renderStatus();
    if (!panel) return;
    const l = lists();
    panel.searchBar.hidden = !data;
    panel.tabs.replaceChildren(...TABS.map(([id, title, label]) => h('button', {
      type: 'button',
      role: 'tab',
      className: 'igfb-tab',
      ariaSelected: id === tab,
      onclick: () => { tab = id; render(); },
    }, l?.[id] ? label(l[id].length) : title, l?.[id]?.some((e) => e.t > seen) && h('span', { className: 'igfb-tab-dot' }))));
    renderList();
  }

  function renderList() {
    const l = lists();
    const q = panel.search.value.trim().toLowerCase();
    const rows = (l?.[tab] ?? []).filter((a) => [a.u, a.n].join(' ').toLowerCase().includes(q));
    const empty = !data
      ? progress ? [h('span', { className: 'igfb-spinner', innerHTML: SPINNER }), 'Loading your followers for the first time…']
        : error && [error, h('button', { type: 'button', className: 'igfb-btn', onclick: check }, 'Try again')]
      : q ? 'No results found.'
      : {
        notBack: l.notBack ? 'Everyone you follow follows you back.' : 'Shows up after your next check.',
        unfollowed: 'No one you follow has unfollowed you since tracking started.',
        followed: 'No new followers since tracking started.',
      }[tab];
    panel.list.replaceChildren(...kids([
      data && error && h('p', { className: 'igfb-error' }, error),
      rows.map(row),
      !rows.length && h('div', { className: 'igfb-empty' }, empty),
    ]));
  }

  function row(a) {
    const pic = data.followers[a.pk]?.pic ?? data.following?.[a.pk]?.pic ?? a.pic;
    const avatar = h('span', { className: 'igfb-avatar' },
      pic && h('img', { alt: '', loading: 'lazy', decoding: 'async', onerror() { this.remove(); }, src: pic }));
    avatar.dataset.initial = (a.u.match(/[a-z0-9]/i)?.[0] ?? '').toUpperCase();
    return h('a', { className: 'igfb-row', href: `/${a.u}/`, target: '_blank', rel: 'noopener' },
      avatar,
      h('span', { className: 'igfb-names' },
        h('span', { className: 'igfb-user' }, a.u),
        (a.n || a.t) && h('span', { className: 'igfb-sub' },
          h('span', { className: 'igfb-name' }, a.n),
          a.t && h('span', { className: 'igfb-time' }, `${a.n ? ' · ' : ''}${short(a.t)}`))),
      a.type === 'unfollowed' && data.followers[a.pk] && h('span', { className: 'igfb-tag' }, 'Follows you'),
      a.t > seen && h('span', { className: 'igfb-unread', title: 'New' }),
    );
  }

  function openPanel() {
    if (panel) return;
    if (lists()?.unfollowed.some((e) => e.t > seen)) tab = 'unfollowed';
    const search = h('input', { type: 'search', placeholder: 'Search', spellcheck: false, oninput: renderList });
    panel = {
      search,
      searchBar: h('label', { className: 'igfb-search', innerHTML: ICON_SEARCH }, search),
      status: h('div', { className: 'igfb-status' }),
      refresh: h('button', { type: 'button', className: 'igfb-icon-btn igfb-refresh', ariaLabel: 'Refresh', title: 'Refresh', innerHTML: ICON_REFRESH, onclick: check }),
      tabs: h('div', { className: 'igfb-tabs', role: 'tablist' }),
      bar: h('div', { className: 'igfb-bar' }),
      list: h('div', { className: 'igfb-list' }),
    };
    const card = h('div', { className: 'igfb-card', role: 'dialog', ariaLabel: 'Follow-back', tabIndex: -1 },
      h('div', { className: 'igfb-head' },
        panel.refresh,
        h('div', { className: 'igfb-title' }, 'Follow-back', panel.status),
        h('button', { type: 'button', className: 'igfb-icon-btn', ariaLabel: 'Close', title: 'Close', innerHTML: ICON_CLOSE, onclick: closePanel })),
      h('div', { className: 'igfb-nav' }, panel.bar, panel.tabs),
      panel.searchBar,
      panel.list,
    );
    panel.root = h('div', {
      className: 'igfb-backdrop',
      // Only the backdrop itself closes. Written as a statement: a false return from
      // an on* handler cancels the click, which would keep the rows' links from opening.
      onclick: (e) => { if (e.target === e.currentTarget) closePanel(); },
      // Escape clears a search first, then closes.
      onkeydown: (e) => {
        if (e.key !== 'Escape') return;
        if (!search.value) return closePanel();
        search.value = '';
        renderList();
      },
    }, card);
    document.body.append(panel.root);
    card.focus();
    render();
    if (Date.now() - Math.max(data?.following ? data.t : 0, attempted) > FRESH_MS) check();
  }

  // Whatever was on screen counts as seen; a check still running reports as new.
  function closePanel() {
    panel.root.remove();
    panel = null;
    seen = Math.max(seen, data?.t ?? 0);
    renderChip();
  }

  // IG re-renders the header freely, so re-find our spot after each batch of DOM
  // changes (a couple of µs when there's nothing to do). Only your own profile's
  // header has the Edit Profile link, and its last two href="#" links that start
  // with a number are followers and following.
  function mount() {
    const header = document.querySelector('a[href="/accounts/edit/"]')?.closest('header');
    if (!header) return chip.remove();
    const [followers, following] = [...header.querySelectorAll('a[href="#"]')].filter((a) => /^\d/.test(a.textContent)).slice(-2);
    if (!following) return;
    if (!header.contains(chip)) {
      let row = following.parentElement;
      while (!row.contains(followers)) row = row.parentElement;
      row.append(chip);
    }
    watchCounts(`${count(followers)},${count(following)}`);
  }

  // "694 followers", or the exact figure IG keeps in a title once it abbreviates (12.5K).
  const count = (link) => Number((link.querySelector('[title]')?.title ?? link.textContent).replace(/\D/g, ''));

  // The header counts are free to read, so when they stop matching the last check
  // (someone followed you, you unfollowed someone) refresh without being asked.
  // Each header value triggers once, and changes made mid-check are picked up after it.
  let reacted = '';
  function watchCounts(counts) {
    if (!data || progress || counts === reacted) return;
    reacted = counts;
    if (counts !== String(data.counts)) check();
  }

  async function init() {
    data = (await chrome.storage.local.get(KEY))[KEY] ?? null;
    // Carry over the bookmarklet's history, which it kept in IG's localStorage.
    const legacy = !data && JSON.parse(localStorage.getItem(KEY));
    if (legacy?.followers) {
      data = { log: [], ...legacy };
      await chrome.storage.local.set({ [KEY]: data });
    }
    seen = data?.t ?? 0;
    renderChip();
    // characterData too: IG updates a count in place when you unfollow from its dialog.
    new MutationObserver(mount).observe(document.body, { childList: true, subtree: true, characterData: true });
    mount();
  }

  // Keeps other IG tabs in step when a check finishes in one of them.
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes[KEY]) return;
    data = changes[KEY].newValue ?? null;
    render();
  });

  init();
})();
