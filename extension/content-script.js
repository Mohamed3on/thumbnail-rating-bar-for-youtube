// Variables for throttling handling DOM mutations.
let HANDLE_DOM_MUTATIONS_THROTTLE_MS = 1000; // Wait longer for watched indicators to load
let domMutationsAreThrottled = false;
let hasUnseenDomMutations = false;

const WATCHED_THUMBNAIL_SELECTOR =
  '.ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment, ytd-thumbnail-overlay-resume-playback-renderer';

// Function to scroll to highest score video
const scrollToHighestScore = () => {
  let element = document.querySelector('#highest-score');
  
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    // Process thumbnails and try again after a brief delay
    processNewThumbnails();
    setTimeout(() => {
      element = document.querySelector('#highest-score');
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 1000);
  }
};

// Add keyboard shortcut listener
document.addEventListener('keydown', (e) => {
  // Check for Cmd+B (Mac) or Ctrl+B (Windows/Linux)
  if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
    e.preventDefault(); // Prevent default browser behavior
    scrollToHighestScore();
  }
});

// Variables for handling what to do when an API request fails.
const MAX_API_RETRIES_PER_THUMBNAIL = 10;
const API_RETRY_DELAY_MIN_MS = 3000;
const API_RETRY_UNIFORM_DISTRIBUTION_WIDTH_MS = 3000;
let isPendingApiRetry = false;
let thumbnailsToRetry = [];

// Used for marking thumbnails as processed.
const PROCESSED_DATA_ATTRIBUTE_NAME = "data-ytrb-processed";

// Whether we are currently viewing the mobile version of the YouTube website.
const IS_MOBILE_SITE = window.location.href.startsWith("https://m.youtube.com");
const IS_YOUTUBE_KIDS_SITE = window.location.href.startsWith(
  "https://www.youtubekids.com",
);

// Whether the site is currently using the dark theme.
const IS_USING_DARK_THEME =
  getComputedStyle(document.body).getPropertyValue(
    "--yt-spec-general-background-a",
  ) === " #181818";

let allThumbnails = [];
let numberOfThumbnailProcessed = 0;
let processedVideoIds = new Set(); // Cache to prevent reprocessing
let needsSort = false; // Track if sorting is needed

// Cache selectors for better performance
const THUMBNAIL_SELECTORS = [
  'a#thumbnail[href*="/watch?v="]:not([data-ytrb-processed])',
  'a.yt-lockup-view-model__content-image[href*="/watch?v="]:not([data-ytrb-processed])',
  'a.shortsLockupViewModelHostEndpoint[href*="/shorts/"]:not([data-ytrb-processed])',
  'a.ytp-videowall-still[href]:not([data-ytrb-processed])'
];

let addedFindBestThumbnailButton = false;

const isVideoWatched = (thumbnail) => {
  // Look for watched indicators in the thumbnail or its closest container
  const container = thumbnail.closest('ytd-rich-grid-media, ytd-video-renderer, .yt-lockup-view-model-wiz') || thumbnail;
  return !!container.querySelector(WATCHED_THUMBNAIL_SELECTOR);
};

// highest score on the page
let HIGHEST_SCORE = 0;

// score algorithm
const getScore = ({ likes, dislikes, rating }) => (likes - dislikes) * rating;

let pageURL = document.location.href;

// The default user settings. `userSettings` is replaced with the stored user's
// settings once they are loaded.
const DEFAULT_USER_SETTINGS = {
  barPosition: 'bottom',
  barColor: 'blue-gray',
  barLikesColor: '#3095e3',
  barDislikesColor: '#cfcfcf',
  barColorsSeparator: false,
  barHeight: 4,
  barOpacity: 100,
  barSeparator: false,
  useExponentialScaling: false,
  barTooltip: true,
  showPercentage: false,
};
let userSettings = DEFAULT_USER_SETTINGS;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ratingToPercentageString(rating) {
  // When the rating is 100%, we display "100%" instead of "100.0%".
  if (rating === 1) {
    return (100).toLocaleString() + "%";
  }
  // We use floor instead of round to ensure that anything lower than
  // 100% does not display "100.0%".
  return (
    (Math.floor(rating * 1000) / 10).toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }) + "%"
  );
}

function getToolTipHtml(videoData) {
  return (
    videoData.likes.toLocaleString() +
    "&nbsp;/&nbsp;" +
    videoData.dislikes.toLocaleString() +
    " &nbsp;&nbsp; " +
    ratingToPercentageString(videoData.rating) +
    " &nbsp;&nbsp; " +
    videoData.total.toLocaleString() +
    "&nbsp;total"
  );
}

function exponentialRatingWidthPercentage(rating) {
  return 100 * Math.pow(2, 10 * (rating - 1));
}

function getRatingScoreElement({ score, watched, isShort }) {
  let isHighestScore = false;

  // Don't count shorts as highest score candidates
  if (score > HIGHEST_SCORE && !watched && !isShort) {
    console.log('New highest score (regular video):', score);
    HIGHEST_SCORE = score;
    const previousHighestScore = document.getElementById('highest-score');
    if (previousHighestScore) {
      previousHighestScore.removeAttribute('id');
    }
    isHighestScore = true;
  } else if (isShort && score > HIGHEST_SCORE) {
    console.log('Short with high score detected but excluded:', score);
  }
  
  const scoreElement = document.createElement("ytrb-score-bar");
  if (isHighestScore) {
    scoreElement.id = 'highest-score';
  } else if (watched) {
    scoreElement.id = 'watched';
  }
  scoreElement.textContent = score.toLocaleString();
  return scoreElement;
}

function getRatingBarElement(videoData) {
  const barElement = document.createElement("ytrb-bar");

  if (userSettings.barOpacity !== 100) {
    barElement.style.opacity = (userSettings.barOpacity / 100).toString();
  }

  let ratingElement;
  if (videoData.rating == null) {
    ratingElement = document.createElement("ytrb-no-rating");
  } else {
    const likesWidthPercentage = userSettings.useExponentialScaling
      ? exponentialRatingWidthPercentage(videoData.rating)
      : 100 * videoData.rating;

    ratingElement = document.createElement("ytrb-rating");

    const likesElement = document.createElement("ytrb-likes");
    likesElement.style.width = `${likesWidthPercentage}%`;

    const dislikesElement = document.createElement("ytrb-dislikes");

    ratingElement.appendChild(likesElement);
    ratingElement.appendChild(dislikesElement);
  }

  barElement.appendChild(ratingElement);

  if (userSettings.barTooltip) {
    const tooltipElement = document.createElement("ytrb-tooltip");
    const divElement = document.createElement("div");
    divElement.innerHTML = getToolTipHtml(videoData);
    tooltipElement.appendChild(divElement);
    barElement.appendChild(tooltipElement);
  }

  return barElement;
}

function getRatingPercentageElement(videoData) {
  const span = document.createElement("span");
  span.role = "text";

  const ratingTextNode = document.createTextNode(
    ratingToPercentageString(videoData.rating),
  );

  if (videoData.likes === 0) {
    // Don't colorize the text percentage for videos with 0 likes, since that
    // could mean that the creator of the video has disabled showing the like
    // count for that video.
    // See: https://github.com/elliotwaite/thumbnail-rating-bar-for-youtube/issues/83
    span.appendChild(ratingTextNode);
  } else {
    // Create inner span for colorized text.
    const innerSpan = document.createElement("span");

    // Calculate the color based on the rating.
    const r = Math.round((1 - videoData.rating) * 1275);
    let g = videoData.rating * 637.5 - 255;
    if (!IS_USING_DARK_THEME) {
      g = Math.min(g, 255) * 0.85;
    }

    // Apply the color to the inner span and add the text.
    const color = `rgb(${r},${Math.round(g)},0)`;
    innerSpan.style.setProperty("color", color, "important");
    innerSpan.appendChild(ratingTextNode);
    span.appendChild(innerSpan);
  }

  return span;
}


// Function to detect if a thumbnail is for a YouTube Short
function isShortVideo(thumbnailElement) {
  // Check if the link href contains "/shorts/"
  const linkElement = thumbnailElement.closest('a[href*="/shorts/"]');
  if (linkElement) {
    return true;
  }
  
  // Check for shorts-specific classes or containers
  const shortsContainer = thumbnailElement.closest(
    'ytd-reel-item-renderer, ytd-shorts-lockup-view-model, ytm-shorts-lockup-view-model, .shortsLockupViewModelHostEndpoint'
  );
  if (shortsContainer) {
    return true;
  }
  
  // Additional check for elements with shortsLockupViewModelHost in their classes
  const elementWithShortsClass = thumbnailElement.closest('[class*="shortsLockupViewModelHost"]');
  return !!elementWithShortsClass;
}

// Adds the rating bar after the thumbnail img tag.
function addRatingBar(thumbnailElement, videoData) {
  // Find the appropriate container for the rating bar
  // For modern YouTube, we want to add it to the yt-thumbnail-view-model or a#thumbnail
  let targetContainer = thumbnailElement.closest('yt-thumbnail-view-model');
  if (!targetContainer) {
    // Fallback to the link container or parent
    targetContainer = thumbnailElement.closest('a#thumbnail, a.yt-lockup-view-model__content-image');
    if (!targetContainer) {
      targetContainer = thumbnailElement.parentElement;
    }
  }

  // Sometimes by the time we are ready to add a rating bar after the thumbnail
  // element, it won't have a parent. I'm not sure why this happens, but it
  // might be related to how YouTube's UI framework works. Regardless, it means
  // the thumbnail is currently not on the page in a normal position, so we can
  // skip trying to add a rating bar after it. Also the code we use below to
  // add the rating bar after the thumbnail requires the parent to exist.
  if (targetContainer) {
    const watched = isVideoWatched(targetContainer);
    const isPlaylist = !!targetContainer.querySelector(
      'ytd-thumbnail-overlay-side-panel-renderer, ytd-thumbnail-overlay-bottom-panel-renderer'
    );
    const isShort = isShortVideo(targetContainer);

    // don't add rating bar to playlists as they're not actual videos
    if (!isPlaylist) {
      // Debug logging
      if (isShort) {
        console.log('Detected short video, score:', videoData.score);
      }
      
      targetContainer.appendChild(getRatingScoreElement({ score: videoData.score, watched, isShort }));
      targetContainer.appendChild(getRatingBarElement(videoData));

      allThumbnails.push({
        thumbnail: targetContainer,
        score: videoData.score,
        watched,
        isShort,
      });
    }
  }
}

function getVideoDataObject(likes, dislikes) {
  const total = likes + dislikes;
  const rating = total ? likes / total : null;
  return {
    likes: likes,
    dislikes: dislikes,
    total: total,
    rating: rating,
    score: Math.round(getScore({ likes, dislikes, rating }), 2),
  };
}

async function getVideoDataFromApi(videoId) {
  for (let i = 0; i <= MAX_API_RETRIES_PER_THUMBNAIL; i++) {
    let likesData = await chrome.runtime.sendMessage({
      query: "getLikesData",
      videoId: videoId,
    });

    if (likesData !== null) {
      return getVideoDataObject(likesData.likes, likesData.dislikes);
    }

    await sleep(
      API_RETRY_DELAY_MIN_MS +
        Math.random() * API_RETRY_UNIFORM_DISTRIBUTION_WIDTH_MS,
    );
  }
  return null;
}

function removeOldPercentages(element) {
  element.querySelectorAll(".ytrb-percentage").forEach((oldPercentage) => {
    oldPercentage.remove();
  });
}

// This provides a list of ways we try to find the metadata line for appending
// the text percentage to it. Each item in the list contains:
// - The CSS selector for the closest common element of the thumbnail element
//   and the metadata line element.
// - The CSS selector for the metadata line element.
// - The classes that should be added to the inserted percentage text span.
const METADATA_LINE_DATA_DESKTOP = [
  // - Homepage videos
  [
    "ytd-rich-grid-media",
    "#metadata-line",
    "style-scope ytd-video-meta-block ytd-grid-video-renderer",
  ],
  // - Search result videos
  // - Search result Shorts listed individually
  [
    // The `div.` is required for the playlist page small thumbnails because
    // they have a closer `ytd-thumbnail` element that also has the
    // "ytd-playlist-video-renderer" class.
    "ytd-video-renderer",
    "#metadata-line",
    "inline-metadata-item style-scope ytd-video-meta-block",
  ],
  // - Search result Shorts in horizontal carousel
  [
    "ytm-shorts-lockup-view-model",
    ".shortsLockupViewModelHostMetadataSubhead",
    "yt-core-attributed-string yt-core-attributed-string--white-space-pre-wrap",
  ],
  // - Subscriptions page videos
  [
    ".yt-lockup-view-model-wiz",
    ".yt-content-metadata-view-model-wiz__metadata-row:last-child",
    "yt-core-attributed-string yt-content-metadata-view-model-wiz__metadata-text yt-core-attributed-string--white-space-pre-wrap yt-core-attributed-string--link-inherit-color",
  ],
  // - Playlist page small thumbnails
  [
    // The `div.` part is required because there is a closer `ytd-thumbnail`
    // element that also has the "ytd-playlist-video-renderer" class.
    "div.ytd-playlist-video-renderer",
    "#metadata-line",
    "style-scope ytd-video-meta-block",
  ],
  // - Movies page movies
  ["ytd-grid-movie-renderer", ".grid-movie-renderer-metadata", ""],
  // - Your Courses page playlist
  [
    "ytd-grid-movie-renderer",
    "#byline-container",
    "style-scope ytd-video-meta-block",
  ],
  // - Your Clips page clips
  [
    // The `div.` part is required because there is a closer `ytd-thumbnail`
    // element that also has the "ytd-playlist-video-renderer" class.
    "div.ytd-grid-video-renderer",
    "#metadata-line",
    "style-scope ytd-grid-video-renderer",
  ],
  // - Home page sponsored video version 1
  [
    "ytd-promoted-video-renderer",
    "#metadata-line",
    "style-scope ytd-video-meta-block",
  ],
  // - Home page sponsored video version 2
  [
    ".ytd-video-display-full-buttoned-and-button-group-renderer",
    "#byline-container",
    "style-scope ytd-ad-inline-playback-meta-block yt-simple-endpoint",
  ],
  // - YouTube Music (music.youtube.com) home page videos
  [
    "ytmusic-two-row-item-renderer",
    "yt-formatted-string.subtitle",
    "style-scope yt-formatted-string",
  ],
];
const METADATA_LINE_DATA_MOBILE = [
  // Homepage videos
  [
    "ytm-media-item",
    "ytm-badge-and-byline-renderer",
    "ytm-badge-and-byline-item-byline small-text",
  ],
  // Subscriptions page Shorts in horizontal carousel
  [
    ".shortsLockupViewModelHostEndpoint",
    ".shortsLockupViewModelHostMetadataSubhead",
    "yt-core-attributed-string yt-core-attributed-string--white-space-pre-wrap",
  ],
  // Profile page History videos in horizontal carousel
  [
    "ytm-video-card-renderer",
    ".subhead .small-text:last-child",
    "yt-core-attributed-string",
  ],
  // Profile my videos
  [".compact-media-item", ".subhead", "compact-media-item-stats small-text"],
];

const getFullThumbnail = (thumbnail) =>
  thumbnail.closest(
    '.ytd-rich-item-renderer, ' + // Home page.
      '.ytd-grid-renderer, ' + // Trending and subscriptions page.
      '.ytd-expanded-shelf-contents-renderer, ' + // Also subscriptions page.
      '.yt-horizontal-list-renderer, ' + // Channel page.
      '.ytd-item-section-renderer, ' + // History / Player page.
      '.ytd-horizontal-card-list-renderer, ' + // Gaming page.
      '.ytd-playlist-video-list-renderer' // Playlist page.
  );

const sortThumbnails = () => {
  if (numberOfThumbnailProcessed === allThumbnails.length) {
    return;
  }

  const t = allThumbnails[0].thumbnail;
  let content = t.closest('#contents.ytd-item-section-renderer');

  if (!content) return;

  const newContent = document.createElement('div');
  newContent.id = 'contents';
  newContent.className = 'ytd-item-section-renderer';

  // Sort thumbnails by score, but keep shorts separate/at the end
  allThumbnails.sort((a, b) => {
    // If both are shorts or both are not shorts, sort by score
    if ((a.isShort && b.isShort) || (!a.isShort && !b.isShort)) {
      return b.score - a.score;
    }
    // If one is a short and one isn't, prioritize non-shorts
    return a.isShort ? 1 : -1;
  });

  allThumbnails.forEach(({ thumbnail }) => {
    const fullThumbnail = getFullThumbnail(thumbnail);
    if (fullThumbnail) {
      newContent.appendChild(fullThumbnail);
    }
  });

  content.replaceWith(newContent);

  numberOfThumbnailProcessed = allThumbnails.length;
};



// Adds the rating text percentage below or next to the thumbnail in the video
// metadata line.
function addRatingPercentage(thumbnailElement, videoData) {
  let metadataLineFinderAndElementClasses = IS_MOBILE_SITE
    ? METADATA_LINE_DATA_MOBILE
    : METADATA_LINE_DATA_DESKTOP;

  for (let i = 0; i < metadataLineFinderAndElementClasses.length; i++) {
    const [containerSelector, metadataLineSelector, metadataLineItemClasses] =
      metadataLineFinderAndElementClasses[i];
    const container = thumbnailElement.closest(containerSelector);
    if (container) {
      // We found the container.
      const metadataLine = container.querySelector(metadataLineSelector);
      if (metadataLine) {
        // We found the metadata line. Remove any old percentages.
        removeOldPercentages(metadataLine);

        // We create the rating percentage element and give it the same classes
        // as the other metadata line items in the metadata line, plus
        // "ytrb-percentage".
        const ratingPercentageElement = getRatingPercentageElement(videoData);
        ratingPercentageElement.className =
          metadataLineItemClasses + " ytrb-percentage";

        // Append the rating percentage element to the end of the metadata line.
        metadataLine.appendChild(ratingPercentageElement);

        return;
      }
    }
  }
}

function processNewThumbnails() {
  // Use cached selectors and combine results more efficiently
  const thumbnailLinks = [];
  for (const selector of THUMBNAIL_SELECTORS) {
    thumbnailLinks.push(...document.querySelectorAll(selector));
  }

  for (const link of thumbnailLinks) {
    // Skip mix recommendations and playlists
    if (link.closest('yt-collections-stack, ytd-thumbnail-overlay-side-panel-renderer, ytd-thumbnail-overlay-bottom-panel-renderer')) {
      continue;
    }

    const href = link.getAttribute('href');
    if (!href) continue;

    // Extract video ID
    const match = href.match(/.*[?&]v=([^&]+).*/) || href.match(/^\/shorts\/(.+)$/);
    if (!match) continue;

    const videoId = match[1];
    
    link.setAttribute(PROCESSED_DATA_ATTRIBUTE_NAME, '');
    
    // Skip if already processed this video ID
    if (processedVideoIds.has(videoId)) {
      continue;
    }
    
    processedVideoIds.add(videoId);

    // Get video data and add rating elements
    getVideoDataFromApi(videoId).then(videoData => {
      if (videoData) {
        if (userSettings.barHeight !== 0) {
          addRatingBar(link, videoData);
        }
        if (userSettings.showPercentage && videoData.rating != null && !(videoData.likes === 0 && videoData.dislikes >= 10)) {
          addRatingPercentage(link, videoData);
        }
      }
    }).catch(() => {
      link.removeAttribute(PROCESSED_DATA_ATTRIBUTE_NAME);
      processedVideoIds.delete(videoId);
    });
  }

  // Mark that sorting is needed for search pages
  if (window.location.href.includes('search')) {
    needsSort = true;
  }
}

function parseInternationalInt(string) {
  // Parse an integer that may contain commas or other locale-specific
  // formatting.
  return parseInt(string.replace(/[^\d]/g, ""), 10);
}

// This function parses the Return YouTube Dislike tooltip text (see:
// https://github.com/Anarios/return-youtube-dislike/blob/main/Extensions/combined/src/bar.js#L33).
// Currently, this function does not support the case where the user has set
// their Return YouTube Dislike tooltip setting to "only_like" (only show the
// likes count) or "only_dislike" (only show the dislikes count). In those
// cases, this function will return null and the tooltip and rating bar will not
// be updated. Support for those options could potentially be added in the
// future by having this function fall back to retrieving the rating from the
// API when it can't compute the rating using only the tooltip text.
function getVideoDataFromTooltipText(text) {
  let match = text.match(/^([^\/]+)\/([^-]+)(-|$)/);
  if (match && match.length >= 4) {
    const likes = parseInternationalInt(match[1]);
    const dislikes = parseInternationalInt(match[2]);
    return getVideoDataObject(likes, dislikes);
  }
  return null;
}

function updateVideoRatingBar() {
  for (const rydTooltip of document.querySelectorAll(".ryd-tooltip")) {
    const tooltip = rydTooltip.querySelector("#tooltip");
    if (!tooltip) continue;

    const curText = tooltip.textContent;

    // We add a zero-width space to the end of any processed tooltip text to
    // prevent it from being reprocessed.
    if (!curText.endsWith("\u200b")) {
      const videoData = getVideoDataFromTooltipText(curText);
      if (!videoData) continue;

      if (userSettings.barTooltip) {
        tooltip.textContent =
          `${curText} \u00A0\u00A0 ` +
          `${ratingToPercentageString(videoData.rating ?? 0)} \u00A0\u00A0 ` +
          `${videoData.total.toLocaleString()} total\u200b`;
      } else {
        tooltip.textContent = `${curText}\u200b`;
      }

      if (userSettings.useExponentialScaling && videoData.rating) {
        const rydBar = rydTooltip.querySelector("#ryd-bar");
        if (rydBar) {
          rydBar.style.width = `${exponentialRatingWidthPercentage(
            videoData.rating,
          )}%`;
        }
      }
    }
  }
}



// Simple DOM mutation handler
function handleDomMutations() {
  if (domMutationsAreThrottled) {
    hasUnseenDomMutations = true;
    return;
  }

  domMutationsAreThrottled = true;

  // Add "scroll to best" button on video pages
  if (!addedFindBestThumbnailButton && document.querySelector('ytd-watch-next-secondary-results-renderer')) {
    const button = document.createElement('button');
    button.innerText = 'Scroll to best next video';
    button.className = 'ytrb-find-best-thumbnail';
    button.addEventListener('click', scrollToHighestScore);
    
    const related = document.querySelector('#related');
    if (related) {
      related.insertBefore(button, related.firstChild);
    }
    addedFindBestThumbnailButton = true;
  }

  // Process thumbnails
  processNewThumbnails();
  updateVideoRatingBar();
  
  // Perform sort if needed (after processing is complete)
  if (needsSort && window.location.href.includes('search')) {
    setTimeout(() => {
      sortThumbnails();
      needsSort = false;
    }, 500); // Small delay to ensure processing is complete
  }

  // Reset on page change
  if (pageURL !== document.location.href) {
    pageURL = document.location.href;
    HIGHEST_SCORE = 0;
    // Clean up data structures to prevent memory leaks
    allThumbnails = [];
    numberOfThumbnailProcessed = 0;
    processedVideoIds.clear();
    needsSort = false;
    addedFindBestThumbnailButton = false;
  }

  setTimeout(() => {
    domMutationsAreThrottled = false;
    if (hasUnseenDomMutations) {
      hasUnseenDomMutations = false;
      handleDomMutations();
    }
  }, HANDLE_DOM_MUTATIONS_THROTTLE_MS);
}


// Periodic check to catch any thumbnails that might have been missed
function periodicThumbnailCheck() {
  // Only do light processing - the mutation observer handles most cases
  updateVideoRatingBar();
  setTimeout(periodicThumbnailCheck, 5000);
}

const delayedStart = () => {
  const promise1 = new Promise((resolve) => {
    const interval = setInterval(() => {
      if (document.location.href.includes('search')) {
        if (document.querySelector(WATCHED_THUMBNAIL_SELECTOR)) {
          clearInterval(interval);
          resolve();
        }
      } else {
        clearInterval(interval);
        resolve();
      }
    }, 300);
  });
  const promise2 = new Promise((resolve) => setTimeout(resolve, 3000, 'slow'));

  Promise.any([promise1, promise2]).then(() => {
    handleDomMutations();
    // Start periodic checking as backup
    setTimeout(periodicThumbnailCheck, 2000);
  });
};

// Simple mutation observer
const mutationObserver = new MutationObserver(delayedStart);

function insertCss(url) {
  chrome.runtime.sendMessage({
    query: 'insertCss',
    url: url,
  });
}

chrome.storage.sync.get(DEFAULT_USER_SETTINGS, function (storedSettings) {
  // In Firefox, `storedSettings` will be undeclared if not previously set.
  if (storedSettings) {
    userSettings = storedSettings;
  }

  // On the YouTube Kids site, we never show text percentages, so we just
  // pretend the user has disabled them when on the YouTube Kids site.
  if (IS_YOUTUBE_KIDS_SITE) {
    userSettings.showPercentage = false;
  }

  const cssFiles = [];
  if (userSettings.barHeight !== 0) {
    cssFiles.push('css/bar.css');

    if (userSettings.barPosition === 'top') {
      cssFiles.push('css/bar-top.css');
    } else {
      cssFiles.push('css/bar-bottom.css');
    }

    if (userSettings.barSeparator) {
      if (userSettings.barPosition === 'top') {
        cssFiles.push('css/bar-top-separator.css');
      } else {
        cssFiles.push('css/bar-bottom-separator.css');
      }
    }

    if (userSettings.barTooltip) {
      cssFiles.push('css/bar-tooltip.css');
      if (userSettings.barPosition === 'top') {
        cssFiles.push('css/bar-top-tooltip.css');
      } else {
        cssFiles.push('css/bar-bottom-tooltip.css');
      }
    }

    cssFiles.push('css/bar-video-page.css');
  }

  if (userSettings.showPercentage) {
    cssFiles.push('css/text-percentage.css');
  }

  if (cssFiles.length > 0) {
    cssFiles.forEach((cssFile) => {
      insertCss(cssFile);
    });
  }

  document.documentElement.style.setProperty('--ytrb-bar-height', userSettings.barHeight + 'px');
  document.documentElement.style.setProperty('--ytrb-bar-opacity', userSettings.barOpacity / 100);

  if (userSettings.barColor === 'blue-gray') {
    document.documentElement.style.setProperty('--ytrb-bar-likes-color', '#3095e3');
    document.documentElement.style.setProperty('--ytrb-bar-dislikes-color', '#cfcfcf');
    document.documentElement.style.setProperty('--ytrb-bar-likes-shadow', 'none');
    document.documentElement.style.setProperty('--ytrb-bar-dislikes-shadow', 'none');
  } else if (userSettings.barColor === 'green-red') {
    document.documentElement.style.setProperty('--ytrb-bar-likes-color', '#060');
    document.documentElement.style.setProperty('--ytrb-bar-dislikes-color', '#c00');
    document.documentElement.style.setProperty('--ytrb-bar-likes-shadow', '1px 0 #fff');
    document.documentElement.style.setProperty('--ytrb-bar-dislikes-shadow', 'inset 1px 0 #fff');
  } else if (userSettings.barColor === 'custom-colors') {
    document.documentElement.style.setProperty(
      '--ytrb-bar-likes-color',
      userSettings.barLikesColor
    );
    document.documentElement.style.setProperty(
      '--ytrb-bar-dislikes-color',
      userSettings.barDislikesColor
    );
    document.documentElement.style.setProperty(
      '--ytrb-bar-likes-shadow',
      userSettings.barColorsSeparator ? '1px 0 #fff' : 'none'
    );
    document.documentElement.style.setProperty(
      '--ytrb-bar-dislikes-shadow',
      userSettings.barColorsSeparator ? 'inset 1px 0 #fff' : 'none'
    );
  }

  // Standard mutation observation for thumbnail detection
  mutationObserver.observe(document.body, { 
    childList: true, 
    subtree: true
  });
  
  
  // Initial thumbnail processing
  processNewThumbnails();
  updateVideoRatingBar();
  setTimeout(() => processNewThumbnails(), 1000);
  
});
