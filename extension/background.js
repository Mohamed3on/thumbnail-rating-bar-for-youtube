// All AJAX requests are made from this background script to avoid CORB errors.

let cache = {};
let cacheTimes = [];
let cacheDuration = 600000; // Default is 10 mins.

const YOUTUBE_API_KEY = 'AIzaSyDF46IyZYwPlb6ZBxAD6-IuLxVNYsbTIwQ'; // You'll need to get an API key from Google Cloud Console

chrome.storage.sync.get({ cacheDuration: 600000 }, function (settings) {
  if (settings && settings.cacheDuration !== undefined) {
    cacheDuration = settings.cacheDuration;
  }
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.query === 'videoApiRequest') {
    // Remove expired cache data.
    const now = new Date().getTime();
    let numRemoved = 0;
    for (const [fetchTime, videoId] of cacheTimes) {
      if (now - fetchTime > cacheDuration) {
        delete cache[videoId];
        numRemoved++;
      } else {
        break;
      }
    }
    if (numRemoved > 0) {
      cacheTimes = cacheTimes.slice(numRemoved);
    }

    if (message.videoId in cache) {
      sendResponse(cache[message.videoId]);
    } else {
      // Try Return YouTube Dislike API first
      fetch('https://returnyoutubedislikeapi.com/Votes?videoId=' + message.videoId)
        .then((response) => {
          if (!response.ok) {
            // If RYD API fails, try YouTube API as backup
            return fetchFromYouTubeAPI(message.videoId);
          }
          return response.json();
        })
        .then((data) => {
          const likesData = {
            likes: data.likes,
            dislikes: data.dislikes || 0, // YouTube API won't provide dislikes
            isFromYouTubeAPI: data.isFromYouTubeAPI || false,
          };
          if (!(message.videoId in cache)) {
            cache[message.videoId] = likesData;
            cacheTimes.push([new Date().getTime(), message.videoId]);
          }
          sendResponse(likesData);
        })
        .catch((error) => {
          console.error('Error fetching data:', error);
          sendResponse(null);
        });

      return true;
    }
  } else if (message.query === 'insertCss') {
    chrome.tabs.insertCSS(sender.tab.id, { file: message.url });
  } else if (message.query === 'updateSettings') {
    cacheDuration = message.cacheDuration;
  }
});

function fetchFromYouTubeAPI(videoId) {
  return fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoId}&key=${YOUTUBE_API_KEY}`
  )
    .then((response) => response.json())
    .then((data) => {
      if (data.items && data.items.length > 0) {
        return {
          likes: parseInt(data.items[0].statistics.likeCount),
          dislikes: 0, // YouTube API no longer provides dislike counts
          isFromYouTubeAPI: true,
        };
      }
      throw new Error('Video not found');
    });
}
