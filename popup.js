// popup.js - ポップアップを開いた瞬間に履歴ツリーを新しいタブで開く

// ポップアップが開かれたらすぐに新しいタブでhistory.htmlを開く
chrome.tabs.create({
  url: chrome.runtime.getURL('history.html')
});

// ポップアップを閉じる
window.close();
