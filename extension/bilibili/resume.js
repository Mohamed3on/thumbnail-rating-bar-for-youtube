/**
 * Bilibili Resume
 *
 * Bilibili only resumes a video from your account's watch history, so logged
 * out every video starts over. Save each part's position while it plays and
 * seek back to it the next time that part starts. A finished part is forgotten.
 */

let current = null;

// "bili-resume:BV14s4y1D7XM:3": video id + part, ignoring tracking params.
function key() {
  return `bili-resume:${location.pathname.split('/')[2]}:${new URLSearchParams(location.search).get('p') ?? 1}`;
}

// Media events don't bubble, but capturing them on the document catches the
// player's <video>, which Bilibili reuses for every part it switches to.
document.addEventListener('timeupdate', async ({ target: video }) => {
  // A part switch loads the new part before the player pushes its ?p= to the
  // URL, but the video stays paused until then, so a playing video matches the URL.
  if (video.paused) return;
  const k = key();
  if (k === current) {
    // chrome.storage skips unchanged values, so whole seconds mean one write a second.
    chrome.storage.local.set({ [k]: Math.floor(video.currentTime) });
  } else {
    current = k;
    const { [k]: t } = await chrome.storage.local.get(k);
    if (t) video.currentTime = t;
  }
}, true);

// Bilibili fires `ended` before it moves the URL on to the next part.
document.addEventListener('ended', () => chrome.storage.local.remove(key()), true);
