// Runs in MAIN world — watches for data-ytrb-dismiss attribute set by content script

// YT moved role="menuitem" from yt-list-item-view-model onto an inner <button>.
const MENU_ITEM_SELECTOR = '[role="menuitem"], ytd-menu-service-item-renderer';
const MENU_BUTTON_SELECTOR = 'button[aria-label="More actions"], button[aria-label="Action menu"]';

// Poll per frame until `find` returns something truthy (or the timeout passes).
function waitFor(find, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const deadline = performance.now() + timeoutMs;
    const tick = () => {
      const found = find();
      if (found) return resolve(found);
      if (performance.now() > deadline) return resolve(null);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

// The item is in the DOM ~1 frame before it is laid out, and clicking it before
// then is a no-op — so only accept one that is actually rendered.
const findNotInterestedItem = () =>
  [...document.querySelectorAll(MENU_ITEM_SELECTOR)].find(
    (el) =>
      el.textContent?.toLowerCase().includes('not interested') &&
      el.offsetParent &&
      el.getBoundingClientRect().height > 0
  );

async function dismissContainer(container) {
  const menuButton = container.querySelector(MENU_BUTTON_SELECTOR);
  if (menuButton) {
    // The menu restores focus to the active element when it closes, which
    // scrolls the page back to it (usually the player).
    document.activeElement.blur();
    menuButton.click();
    const item = await waitFor(findNotInterestedItem);
    if (item) {
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        item.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      // While open, the menu (a tp-yt-iron-dropdown with scroll-action="lock")
      // snaps the page back to its opening scroll position on every scroll
      // event, which kills any scroll started before it has closed.
      const dropdown = item.closest('tp-yt-iron-dropdown');
      await waitFor(() => !dropdown || dropdown.style.display === 'none', 1000);
    }
  }
  // The content script scrolls to the next best video on this.
  document.dispatchEvent(new Event('ytrb-dismissed'));
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
