// background.js (service worker)
chrome.runtime.onInstalled.addListener(() => {
  // ここで初期設定やキャッシュ作成をしても良い
  console.log('History Tree installed');
});
