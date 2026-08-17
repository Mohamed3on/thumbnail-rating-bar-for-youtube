// Runs in MAIN world — watches for data-ytrb-dismiss attribute set by content script

// YT moved role="menuitem" from yt-list-item-view-model onto an inner <button>.
const MENU_ITEM_SELECTOR = '[role="menuitem"], ytd-menu-service-item-renderer';
const MENU_BUTTON_SELECTOR = 'button[aria-label="More actions"], button[aria-label="Action menu"]';

// The item is in the DOM ~1 frame before it is laid out, and clicking it before
// then is a no-op — so poll per frame for one that is actually rendered.
function waitForMenuItem(predicate, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const deadline = performance.now() + timeoutMs;
    const tick = () => {
      const found = [...document.querySelectorAll(MENU_ITEM_SELECTOR)].find(
        (el) => predicate(el) && el.offsetParent && el.getBoundingClientRect().height > 0
      );
      if (found) return resolve(found);
      if (performance.now() > deadline) return resolve(null);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

async function dismissContainer(container) {
  const menuButton = container.querySelector(MENU_BUTTON_SELECTOR);
  if (!menuButton) return;

  menuButton.click();
  const item = await waitForMenuItem((el) => el.textContent?.toLowerCase().includes('not interested'));
  if (!item) return;

  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    item.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, view: window }));
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
