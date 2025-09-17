// Default cache duration: 1 hour
const DEFAULT_CACHE_DURATION = 60 * 60 * 1000;

// --- Helper Functions ---

async function getYouTubeAPIKey() {
  const result = await chrome.storage.sync.get('youtubeApiKey');
  return result.youtubeApiKey;
}

async function getCacheDuration() {
  const settings = await chrome.storage.sync.get({ cacheDuration: DEFAULT_CACHE_DURATION });
  return settings.cacheDuration;
}

async function cleanupExpiredCache() {
  // Get current time and configured cache duration
  const now = Date.now();
  const duration = await getCacheDuration();

  // Get all items from local storage to check timestamps
  // Note: This still loads all keys, but only for cleanup, not every request.
  // Consider using chrome.alarms for less frequent cleanup.
  const currentCache = await chrome.storage.local.get(null);
  const itemsToRemove = [];

  for (const videoId in currentCache) {
    // Ensure the cache item has the expected structure
    if (currentCache[videoId] && currentCache[videoId].timestamp) {
      if (now - currentCache[videoId].timestamp > duration) {
        itemsToRemove.push(videoId);
      }
    } else {
      // Optionally remove items with unexpected structure
      // itemsToRemove.push(videoId);
      // console.warn(`Removing malformed cache entry for ${videoId}`);
    }
  }

  if (itemsToRemove.length > 0) {
    await chrome.storage.local.remove(itemsToRemove);
    console.log(`Removed ${itemsToRemove.length} expired cache entries.`);
  }
}

async function fetchFromYouTubeAPI(videoId) {
  try {
    const apiKey = await getYouTubeAPIKey();
    if (!apiKey) {
      throw new Error('YouTube API key not configured. Please set it in the extension options.');
    }

    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoId}&key=${apiKey}`
    );
    if (!response.ok) {
      throw new Error(`YouTube API request failed with status ${response.status}`);
    }
    const data = await response.json();
    if (data.items && data.items.length > 0) {
      return {
        likes: parseInt(data.items[0].statistics.likeCount, 10),
        dislikes: 0, // YouTube API no longer provides dislike counts
        isFromYouTubeAPI: true,
      };
    } else {
      throw new Error('Video not found in YouTube API response');
    }
  } catch (error) {
    console.error('Error fetching from YouTube API:', error);
    throw error; // Re-throw the error to be caught by the caller
  }
}

// --- Event Listener ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.query === 'getLikesData') {
    (async () => {
      const videoId = message.videoId;
      if (!videoId) {
        console.error('No videoId provided in getLikesData');
        sendResponse(null);
        return;
      }

      try {
        // Attempt to get the specific video data from local storage
        const cacheResult = await chrome.storage.local.get(videoId);
        const cacheDuration = await getCacheDuration();
        const now = Date.now();

        // Check if the video ID exists in storage and is not expired
        if (
          cacheResult[videoId] &&
          cacheResult[videoId].timestamp &&
          now - cacheResult[videoId].timestamp <= cacheDuration
        ) {
          console.log(`Cache hit for ${videoId}`);
          sendResponse(cacheResult[videoId].data); // Send the cached data
          // Run cleanup asynchronously, don't wait for it
          cleanupExpiredCache().catch(console.error);
        } else {
          // Cache miss or expired entry
          if (cacheResult[videoId]) {
            console.log(`Cache expired for ${videoId}, fetching...`);
          } else {
            console.log(`Cache miss for ${videoId}, fetching...`);
          }

          // Fetching logic with timeout for RYD API
          let likesData;
          try {
            // Create a timeout promise that rejects after 1 second
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error('RYD API timeout')), 1000);
            });

            // Race between the fetch and timeout
            const rydResponse = await Promise.race([
              fetch(`https://returnyoutubedislikeapi.com/Votes?videoId=${videoId}`),
              timeoutPromise,
            ]);

            if (rydResponse.ok) {
              const data = await rydResponse.json();
              likesData = {
                likes: data.likes,
                dislikes: data.dislikes || 0,
                isFromYouTubeAPI: false,
              };
            } else {
              console.warn(
                `RYD API failed for ${videoId} (${rydResponse.status}), falling back to YouTube API.`
              );
              likesData = await fetchFromYouTubeAPI(videoId); // Use YouTube API as backup
            }
          } catch (fetchError) {
            console.error(
              `Initial fetch failed for ${videoId}, trying YouTube API fallback:`,
              fetchError
            );
            try {
              likesData = await fetchFromYouTubeAPI(videoId);
              console.log(`YouTube API fallback successful for ${videoId}`);
            } catch (error) {
              console.error(`YouTube API fallback failed for ${videoId}:`, error);
              sendResponse(null);
              return;
            }
          }

          // Store the new data with a fresh timestamp
          const cacheEntry = { data: likesData, timestamp: now }; // Use 'now' from earlier
          await chrome.storage.local.set({ [videoId]: cacheEntry });
          console.log(`Stored data for ${videoId}`);
          sendResponse(likesData);

          // Run cleanup asynchronously after a cache miss too
          cleanupExpiredCache().catch(console.error);
        }
      } catch (error) {
        console.error(`Error processing getLikesData for ${videoId}:`, error);
        sendResponse(null); // Send null on error
      }
    })();
    return true; // Keep the message channel open for the async response
  } else if (message.query === 'insertCss') {
    if (sender.tab && sender.tab.id && message.url) {
      chrome.scripting
        .insertCSS({
          target: { tabId: sender.tab.id },
          files: [message.url],
        })
        .catch((error) => console.error(`Failed to insert CSS: ${message.url}`, error));
    } else {
      console.error('Missing tab ID or URL for insertCss request.');
    }
  } else if (message.query === 'updateSettings') {
    const updates = {};
    if (message.cacheDuration !== undefined) {
      updates.cacheDuration = message.cacheDuration;
    }
    if (message.youtubeApiKey !== undefined) {
      updates.youtubeApiKey = message.youtubeApiKey;
    }

    if (Object.keys(updates).length > 0) {
      chrome.storage.sync
        .set(updates)
        .then(() => console.log('Updated settings:', updates))
        .catch((error) => console.error('Failed to update settings in storage:', error));
    }
  }
});
