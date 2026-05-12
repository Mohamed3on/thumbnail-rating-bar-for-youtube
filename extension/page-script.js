// Runs in MAIN world — watches for data-ytrb-dismiss attribute set by content script

const MENU_ITEM_SELECTOR = 'yt-list-item-view-model[role="menuitem"], ytd-menu-service-item-renderer';
const MENU_BUTTON_SELECTOR = 'button[aria-label="More actions"], button[aria-label="Action menu"]';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForElement(predicate, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const existing = [...document.querySelectorAll(MENU_ITEM_SELECTOR)].find(predicate);
    if (existing) return resolve(existing);

    const obs = new MutationObserver(() => {
      const found = [...document.querySelectorAll(MENU_ITEM_SELECTOR)].find(predicate);
      if (found) { obs.disconnect(); clearTimeout(timer); resolve(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs);
  });
}

// YT scrolls the page when opening the menu; pin scroll so the user's view stays put.
function lockScroll() {
  const y = window.scrollY;
  const handler = () => window.scrollTo({ top: y, behavior: 'instant' });
  window.addEventListener('scroll', handler);
  return () => window.removeEventListener('scroll', handler);
}

async function dismissContainer(container) {
  const menuButton = container.querySelector(MENU_BUTTON_SELECTOR);
  if (!menuButton) return;

  await sleep(500);
  const unlock = lockScroll();
  try {
    menuButton.click();
    const item = await waitForElement((el) => el.textContent?.toLowerCase().includes('not interested'));
    if (!item) return;
    await sleep(100);
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      item.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    await sleep(500);
  } finally {
    unlock();
  }
}

new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.attributeName !== 'data-ytrb-dismiss') continue;
    const container = m.target;
    if (!container.hasAttribute('data-ytrb-dismiss')) continue;
    container.removeAttribute('data-ytrb-dismiss');
    dismissContainer(container);
  }
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-ytrb-dismiss'] });
