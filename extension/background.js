// Default cache duration: 1 hour
const DEFAULT_CACHE_DURATION = 60 * 60 * 1000;

// --- Helper Functions ---

async function getStorageData(keys) {
  return chrome.storage.sync.get(keys);
}

async function fetchFromRYDAPI(videoId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  
  try {
    const response = await fetch(
      `https://returnyoutubedislikeapi.com/Votes?videoId=${videoId}`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    
    if (!response.ok) throw new Error(`RYD API failed: ${response.status}`);
    const data = await response.json();
    return { likes: data.likes, dislikes: data.dislikes || 0 };
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

async function fetchFromYouTubeAPI(videoId) {
  const { youtubeApiKey } = await getStorageData('youtubeApiKey');
  if (!youtubeApiKey) throw new Error('YouTube API key not configured');

  const response = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoId}&key=${youtubeApiKey}`
  );
  if (!response.ok) throw new Error(`YouTube API failed: ${response.status}`);
  
  const data = await response.json();
  if (!data.items?.length) throw new Error('Video not found');
  
  return {
    likes: parseInt(data.items[0].statistics.likeCount, 10),
    dislikes: 0 // YouTube API no longer provides dislike counts
  };
}

async function fetchLikesData(videoId) {
  try {
    return await fetchFromRYDAPI(videoId);
  } catch (error) {
    console.log(`RYD failed for ${videoId}, trying YouTube API:`, error.message);
    return await fetchFromYouTubeAPI(videoId);
  }
}

// --- Message Handlers ---

async function handleGetLikesData(videoId) {
  if (!videoId) return null;

  try {
    // Check cache
    const cached = await chrome.storage.local.get(videoId);
    const { cacheDuration = DEFAULT_CACHE_DURATION } = await getStorageData('cacheDuration');
    const now = Date.now();

    if (cached[videoId]?.timestamp && now - cached[videoId].timestamp <= cacheDuration) {
      console.log(`Cache hit for ${videoId}`);
      return cached[videoId].data;
    }

    // Fetch new data
    console.log(`Cache miss for ${videoId}, fetching...`);
    const likesData = await fetchLikesData(videoId);
    
    // Store in cache
    await chrome.storage.local.set({ 
      [videoId]: { data: likesData, timestamp: now } 
    });
    
    return likesData;
  } catch (error) {
    console.error(`Error getting likes for ${videoId}:`, error);
    return null;
  }
}

// --- Event Listeners ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.query === 'getLikesData') {
    handleGetLikesData(message.videoId).then(sendResponse);
    return true; // Keep channel open for async response
  }
  
  if (message.query === 'insertCss' && sender.tab?.id && message.url) {
    chrome.scripting.insertCSS({
      target: { tabId: sender.tab.id },
      files: [message.url],
    }).catch(error => console.error(`Failed to insert CSS: ${message.url}`, error));
  }
  
  if (message.query === 'updateSettings') {
    const updates = {};
    ['cacheDuration', 'youtubeApiKey'].forEach(key => {
      if (message[key] !== undefined) updates[key] = message[key];
    });
    
    if (Object.keys(updates).length) {
      chrome.storage.sync.set(updates)
        .then(() => console.log('Updated settings:', updates))
        .catch(error => console.error('Failed to update settings:', error));
    }
  }
});

// --- Cache Cleanup ---

chrome.alarms.create('cleanupCache', { periodInMinutes: 60 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'cleanupCache') return;
  
  const { cacheDuration = DEFAULT_CACHE_DURATION } = await getStorageData('cacheDuration');
  const now = Date.now();
  const cache = await chrome.storage.local.get(null);
  
  const expired = Object.keys(cache).filter(
    key => cache[key]?.timestamp && now - cache[key].timestamp > cacheDuration
  );
  
  if (expired.length) {
    await chrome.storage.local.remove(expired);
    console.log(`Removed ${expired.length} expired cache entries`);
  }
});