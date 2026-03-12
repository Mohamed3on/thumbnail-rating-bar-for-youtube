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
    return await fetchLikesData(videoId);
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

  if (message.query === 'clearCache') {
    chrome.storage.local.clear()
      .then(() => console.log('Cache cleared'))
      .catch(error => console.error('Failed to clear cache:', error));
  }
});