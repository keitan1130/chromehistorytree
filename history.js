// history.js - 新しいタブでの履歴表示

// Promise wrapper for chrome.history APIs
function historySearch(query) {
  return new Promise((resolve) => chrome.history.search(query, resolve));
}

function historyGetVisits(details) {
  return new Promise((resolve) => chrome.history.getVisits(details, resolve));
}

class HistoryManager {
  constructor() {
    this.allVisits = [];
    this.filteredData = [];
    this.currentSearchTerm = '';
    this.isDarkMode = this.getPreferredTheme();
    this.daysInputTimeout = null; // 入力遅延タイマー
    this.currentPage = 1;
    this.daysPerPage = 7; // デフォルト値、period inputから取得
    this.searchStartTime = null;
    this.searchEndTime = null;
    this.viewMode = 'chronological'; // 'chronological' or 'aggregated'
    this.stats = {
      totalSites: 0,
      totalVisits: 0,
      todayVisits: 0
    };

    this.initializeEventListeners();
    this.applyTheme();
  }  getPreferredTheme() {
    // 保存された設定を確認
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
      return savedTheme === 'dark';
    }

    // システム設定に合わせる
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  applyTheme() {
    document.documentElement.setAttribute('data-theme', this.isDarkMode ? 'dark' : 'light');

    // テーマ切り替えボタンのアイコンを更新
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
      themeToggle.textContent = this.isDarkMode ? '☀️' : '🌙';
      themeToggle.title = this.isDarkMode ? 'ライトモードに切り替え' : 'ダークモードに切り替え';
    }
  }

  toggleTheme() {
    this.isDarkMode = !this.isDarkMode;
    localStorage.setItem('theme', this.isDarkMode ? 'dark' : 'light');
    this.applyTheme();
  }

  initializeEventListeners() {
    document.getElementById('refresh').addEventListener('click', () => {
      this.loadHistoryForCurrentPage();
    });

    document.getElementById('days').addEventListener('input', () => {
      // 入力値の検証
      const daysInput = document.getElementById('days');
      const value = parseInt(daysInput.value);

      if (value && value > 0 && value <= 365) {
        this.daysPerPage = value;
        this.currentPage = 1; // 期間変更時はページを1に戻す

        // 有効な値の場合のみ更新（500ms後に自動更新）
        clearTimeout(this.daysInputTimeout);
        this.daysInputTimeout = setTimeout(() => {
          this.loadHistoryForCurrentPage();
        }, 500);
      }
    });

    document.getElementById('search').addEventListener('input', (e) => {
      this.currentSearchTerm = e.target.value.toLowerCase();
      this.currentPage = 1; // 検索時はページを1に戻す
      this.filterAndRenderData();
    });

    // ページネーションのイベントリスナー
    ['pageTopInput', 'pageBottomInput'].forEach(id => {
      document.getElementById(id).addEventListener('input', (e) => {
        const pageValue = parseInt(e.target.value);
        if (pageValue && pageValue > 0) {
          this.currentPage = pageValue;
          this.updatePageInputs();
          this.loadHistoryForCurrentPage();
        }
      });
    });

    // モード切り替えのイベントリスナー
    document.getElementById('viewMode').addEventListener('change', (e) => {
      this.viewMode = e.target.value;
      this.filterAndRenderData(); // 現在のデータを新しいモードで再描画
    });    // テーマ切り替えボタンのイベントリスナー
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
      themeToggle.addEventListener('click', () => {
        this.toggleTheme();
      });
    }

    // システムのテーマ変更を監視
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('theme')) {
        this.isDarkMode = e.matches;
        this.applyTheme();
      }
    });
  }

  getFaviconUrl(url) {
    try {
      const urlObj = new URL(url);
      // Google のファビコンサービスを使用（信頼性が高い）
      return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=16`;
    } catch (error) {
      // URLが無効な場合はデフォルトアイコン
      return 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="%23f1f3f4"/><path d="M4 4h8v8H4z" fill="%23666"/></svg>';
    }
  }

  async loadHistoryForCurrentPage() {
    const loadingElement = document.getElementById('loading');
    const errorElement = document.getElementById('error');
    const treeElement = document.getElementById('tree');
    const statsInlineElement = document.getElementById('statsInline');

    loadingElement.style.display = 'block';
    errorElement.style.display = 'none';
    treeElement.style.display = 'none';
    if (statsInlineElement) {
      statsInlineElement.style.display = 'none';
    }

    try {
      const daysPerPage = this.daysPerPage;
      const currentPage = this.currentPage;

      // 現在のページに対応する期間を計算
      const endDaysAgo = (currentPage - 1) * daysPerPage;
      const startDaysAgo = currentPage * daysPerPage;

      // 時刻を計算（ミリ秒）
      const now = Date.now();
      this.searchEndTime = now - (endDaysAgo * 24 * 60 * 60 * 1000);
      this.searchStartTime = now - (startDaysAgo * 24 * 60 * 60 * 1000);

      const roots = await this.buildHistoryTree({
        startTime: this.searchStartTime,
        endTime: this.searchEndTime
      });
      this.filteredData = roots;

      this.calculateStats();
      this.filterAndRenderData();

      loadingElement.style.display = 'none';
      treeElement.style.display = 'block';
      if (statsInlineElement) {
        statsInlineElement.style.display = 'flex';
      }

    } catch (error) {
      loadingElement.style.display = 'none';
      errorElement.style.display = 'block';
      errorElement.innerHTML = `<strong>エラー:</strong> 履歴の取得に失敗しました。<br>${error.message}`;
    }
  }  async buildHistoryTree({ startTime, endTime } = {}) {
    // デフォルト値の設定（後方互換性のため）
    if (!startTime || !endTime) {
      const days = 7;
      endTime = Date.now();
      startTime = endTime - days * 24 * 60 * 60 * 1000;
    }

    const items = await historySearch({ text: '', startTime, maxResults: 10000 });

    // すべての訪問情報を収集
    this.allVisits = [];
    const urlSet = new Set();

    for (const item of items) {
      const visits = await historyGetVisits({ url: item.url });
      urlSet.add(item.url);

      for (const visit of visits) {
        // startTime以降、endTime以前の訪問のみを含める
        if (visit.visitTime >= startTime && visit.visitTime <= endTime) {
          this.allVisits.push({
            visitId: visit.visitId,
            url: item.url,
            title: item.title || item.url,
            visitTime: visit.visitTime,
            referringVisitId: visit.referringVisitId || null,
            transition: visit.transition || '',
            favicon: this.getFaviconUrl(item.url)
          });

          // デバッグ用：transition情報をログ出力
          if (visit.transition && visit.transition !== 'link') {
            console.log(`特殊なtransition: ${visit.transition}, URL: ${item.url}, referringVisitId: ${visit.referringVisitId}`);
          }
        }
      }
    }

    // 訪問時刻の新しい順でソート
    this.allVisits.sort((a, b) => b.visitTime - a.visitTime);

    // visitIdでマップを構築
    const visitMap = new Map();
    for (const visit of this.allVisits) {
      visitMap.set(visit.visitId, { ...visit, children: [] });
    }

    // 親子関係を構築
    const roots = [];
    const processedVisits = new Set();

    // まず明確な親子関係（referringVisitIdがある）を構築
    for (const visit of visitMap.values()) {
      if (visit.referringVisitId && visitMap.has(visit.referringVisitId)) {
        const parent = visitMap.get(visit.referringVisitId);
        parent.children.push(visit);
        processedVisits.add(visit.visitId);
      }
    }

    // 次に、新規タブなどの推定親子関係を構築
    const orphanVisits = Array.from(visitMap.values()).filter(visit =>
      !visit.referringVisitId || !visitMap.has(visit.referringVisitId)
    );

    for (const orphan of orphanVisits) {
      if (processedVisits.has(orphan.visitId)) continue;

      // 時系列的に近い親候補を探す（5分以内）
      const potentialParents = Array.from(visitMap.values()).filter(parent =>
        parent.visitId !== orphan.visitId &&
        parent.visitTime > orphan.visitTime - 5 * 60 * 1000 && // 5分前まで
        parent.visitTime < orphan.visitTime && // 自分より前
        (orphan.transition === 'typed' || orphan.transition === 'auto_bookmark' || orphan.transition === 'generated')
      );

      if (potentialParents.length > 0) {
        // 最も近い時刻の親を選択
        potentialParents.sort((a, b) => b.visitTime - a.visitTime);
        const bestParent = potentialParents[0];
        bestParent.children.push(orphan);
        processedVisits.add(orphan.visitId);
        console.log(`推定親子関係: ${bestParent.title} -> ${orphan.title} (${orphan.transition})`);
      } else {
        roots.push(orphan);
      }
    }

    console.log(`構築されたツリー: ${roots.length}個のルート, 総訪問数: ${this.allVisits.length}`);

    // 親子関係の統計をログ出力
    let totalChildren = 0;
    const countChildren = (node) => {
      if (node.children.length > 0) {
        totalChildren += node.children.length;
        if (node.children.length > 1) {
          console.log(`複数子要素: ${node.title || node.url} (${node.children.length}個の子)`);
        }
        node.children.forEach(countChildren);
      }
    };
    roots.forEach(countChildren);
    console.log(`総子要素数: ${totalChildren}`);

    // ルートノードも時刻順（新しい順）でソート
    roots.sort((a, b) => b.visitTime - a.visitTime);

    // 子要素を時刻順（新しい順）でソート
    function sortChildren(node) {
      if (node.children.length > 0) {
        node.children.sort((a, b) => b.visitTime - a.visitTime);
        node.children.forEach(sortChildren);
      }
    }
    roots.forEach(sortChildren);

    // 重複する親子ノードを削除
    const cleanedRoots = this.removeDuplicateNodes(roots);

    return cleanedRoots;
  }

  // 集計モード: 同じURLを集約して最適なツリーを作成
  buildAggregatedTree() {
    // URLごとの訪問情報を集約
    const urlVisitMap = new Map();
    const urlTransitions = new Map(); // URL間の遷移関係を記録

    // 各訪問を処理してURL間の関係を構築
    for (const visit of this.allVisits) {
      const url = visit.url;

      // URLの訪問情報を集約
      if (!urlVisitMap.has(url)) {
        urlVisitMap.set(url, {
          url: visit.url,
          title: visit.title,
          favicon: visit.favicon,
          visits: [],
          firstVisitTime: visit.visitTime,
          lastVisitTime: visit.visitTime,
          visitCount: 0
        });
      }

      const urlInfo = urlVisitMap.get(url);
      urlInfo.visits.push(visit);
      urlInfo.visitCount++;
      urlInfo.firstVisitTime = Math.min(urlInfo.firstVisitTime, visit.visitTime);
      urlInfo.lastVisitTime = Math.max(urlInfo.lastVisitTime, visit.visitTime);
    }

    // URL間の遷移関係を構築
    for (const visit of this.allVisits) {
      if (visit.referringVisitId) {
        // 参照元の訪問を見つける
        const referringVisit = this.allVisits.find(v => v.visitId === visit.referringVisitId);
        if (referringVisit && referringVisit.url !== visit.url) {
          const fromUrl = referringVisit.url;
          const toUrl = visit.url;

          if (!urlTransitions.has(fromUrl)) {
            urlTransitions.set(fromUrl, new Map());
          }

          const fromTransitions = urlTransitions.get(fromUrl);
          if (!fromTransitions.has(toUrl)) {
            fromTransitions.set(toUrl, {
              count: 0,
              firstTime: visit.visitTime,
              lastTime: visit.visitTime
            });
          }

          const transition = fromTransitions.get(toUrl);
          transition.count++;
          transition.firstTime = Math.min(transition.firstTime, visit.visitTime);
          transition.lastTime = Math.max(transition.lastTime, visit.visitTime);
        }
      }
    }

    // 集約されたツリーを構築
    const aggregatedNodes = this.buildOptimalTree(urlVisitMap, urlTransitions);
    return aggregatedNodes;
  }

  // 最適なツリー構造を構築
  buildOptimalTree(urlVisitMap, urlTransitions) {
    const nodes = new Map();
    const childToParent = new Map(); // 子→親の関係を記録
    const parentToChildren = new Map(); // 親→子の関係を記録

    // 各URLのノードを作成
    for (const [url, urlInfo] of urlVisitMap) {
      nodes.set(url, {
        url: urlInfo.url,
        title: urlInfo.title,
        favicon: urlInfo.favicon,
        visitTime: urlInfo.lastVisitTime, // 表示用は最後の訪問時間
        visitCount: urlInfo.visitCount,
        children: []
      });
      parentToChildren.set(url, []);
    }

    // 全ての遷移関係を分析して最適な親子関係を決定
    const allTransitions = [];
    for (const [fromUrl, transitions] of urlTransitions) {
      for (const [toUrl, transitionInfo] of transitions) {
        allTransitions.push({
          from: fromUrl,
          to: toUrl,
          count: transitionInfo.count,
          firstTime: transitionInfo.firstTime,
          lastTime: transitionInfo.lastTime
        });
      }
    }

    // 遷移を優先度順にソート（回数多い順、同じなら早い順）
    allTransitions.sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count; // 回数の多い順
      }
      return a.firstTime - b.firstTime; // 時間の早い順
    });

    // 循環参照を避けながら最適な親子関係を構築
    for (const transition of allTransitions) {
      const { from, to, count } = transition;

      // 既に親子関係が逆向きに存在しないか確認
      if (!this.wouldCreateCycle(from, to, childToParent)) {
        // 子が既に他の親を持っていない場合、または現在の関係の方が強い場合
        const currentParent = childToParent.get(to);
        if (!currentParent || this.shouldReplaceParent(from, currentParent, to, urlTransitions)) {
          // 既存の親子関係を削除
          if (currentParent) {
            const currentParentChildren = parentToChildren.get(currentParent);
            const index = currentParentChildren.indexOf(to);
            if (index > -1) {
              currentParentChildren.splice(index, 1);
            }
          }

          // 新しい親子関係を設定
          childToParent.set(to, from);
          parentToChildren.get(from).push(to);
        }
      }
    }

    // ノードに子要素を設定
    for (const [parentUrl, childUrls] of parentToChildren) {
      const parentNode = nodes.get(parentUrl);
      if (parentNode) {
        // 子ノードを追加（訪問回数順、同じなら時間順）
        const childNodes = childUrls
          .map(childUrl => nodes.get(childUrl))
          .filter(child => child)
          .sort((a, b) => {
            const aTransition = urlTransitions.get(parentUrl)?.get(a.url);
            const bTransition = urlTransitions.get(parentUrl)?.get(b.url);

            if (aTransition && bTransition) {
              if (bTransition.count !== aTransition.count) {
                return bTransition.count - aTransition.count;
              }
              return aTransition.firstTime - bTransition.firstTime;
            }
            return b.visitTime - a.visitTime;
          });

        parentNode.children = childNodes;
      }
    }

    // ルートノード（親を持たない）を取得
    const rootUrls = Array.from(nodes.keys()).filter(url => !childToParent.has(url));
    const rootNodes = rootUrls
      .map(url => nodes.get(url))
      .sort((a, b) => b.visitTime - a.visitTime); // 時間順（新しい順）

    return rootNodes;
  }

  // 循環参照チェック
  wouldCreateCycle(from, to, childToParent) {
    let current = from;
    while (current) {
      if (current === to) {
        return true; // 循環が発生する
      }
      current = childToParent.get(current);
    }
    return false;
  }

  // より強い親子関係かどうか判定
  shouldReplaceParent(newParent, currentParent, child, urlTransitions) {
    const newTransition = urlTransitions.get(newParent)?.get(child);
    const currentTransition = urlTransitions.get(currentParent)?.get(child);

    if (!newTransition || !currentTransition) {
      return !!newTransition; // 新しい遷移が存在すれば置き換え
    }

    // 遷移回数で比較
    if (newTransition.count !== currentTransition.count) {
      return newTransition.count > currentTransition.count;
    }

    // 同じ回数なら時間で比較（早い方を優先）
    return newTransition.firstTime < currentTransition.firstTime;
  }

  // ページネーション関連のメソッド
  updatePageInputs() {
    ['pageTopInput', 'pageBottomInput'].forEach(id => {
      document.getElementById(id).value = this.currentPage;
    });

    // ページ上限は無いので、単純に現在ページを表示
    ['pageTopInfo', 'pageBottomInfo'].forEach(id => {
      document.getElementById(id).textContent = '';
    });
  }  updateSearchRange() {
    const startTime = this.searchStartTime;
    const endTime = this.searchEndTime;

    let rangeText = '-';
    if (startTime && endTime) {
      const startDate = new Date(startTime);
      const endDate = new Date(endTime);
      rangeText = `${this.formatTime(endDate)} ～ ${this.formatTime(startDate)}`;
    }

    ['searchRangeTop', 'searchRangeBottom'].forEach(id => {
      document.getElementById(id).textContent = rangeText;
    });
  }

  // 親と子が同じURL/タイトルの場合、重複する子を削除し孫を親に移す
  removeDuplicateNodes(nodes) {
    let removedCount = 0;

    const processNode = (node) => {
      // まず子ノードたちを再帰的に処理
      const processedChildren = node.children.map(processNode);

      // 現在のノードと同じURL/タイトルの子ノードを見つける
      const duplicateChildren = [];
      const uniqueChildren = [];

      for (const child of processedChildren) {
        if (this.isSameNode(node, child)) {
          // 重複する子ノードの場合、その子たち（孫）を取得
          duplicateChildren.push(...child.children);
          removedCount++;
          console.log(`重複ノードを削除: ${child.title || child.url} (${child.children.length}個の子を親に移動)`);
        } else {
          uniqueChildren.push(child);
        }
      }

      // 重複しない子ノードと、重複した子の孫ノードを合わせる
      const allChildren = [...uniqueChildren, ...duplicateChildren];

      // 時刻順でソート（新しい順）
      allChildren.sort((a, b) => b.visitTime - a.visitTime);

      return {
        ...node,
        children: allChildren
      };
    };

    const result = nodes.map(processNode);

    if (removedCount > 0) {
      console.log(`合計 ${removedCount} 個の重複ノードを削除しました`);
    }

    return result;
  }

  // 2つのノードが同じかどうかを判定
  isSameNode(node1, node2) {
    // URLが同じで、かつタイトルも同じ場合に重複と判定
    // ただし、タイトルが空やURLと同じ場合は、URLだけで判定
    const url1 = node1.url;
    const url2 = node2.url;
    const title1 = node1.title === node1.url ? '' : node1.title;
    const title2 = node2.title === node2.url ? '' : node2.title;

    if (url1 !== url2) {
      return false;
    }

    // URLが同じ場合
    if (!title1 || !title2) {
      // どちらかのタイトルが空ならURLだけで判定
      return true;
    }

    // 両方にタイトルがある場合はタイトルも比較
    return title1 === title2;
  }

  calculateStats() {
    const urlSet = new Set();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStartTime = today.getTime();

    let todayCount = 0;

    for (const visit of this.allVisits) {
      urlSet.add(visit.url);
      if (visit.visitTime >= todayStartTime) {
        todayCount++;
      }
    }

    this.stats = {
      totalSites: urlSet.size,
      totalVisits: this.allVisits.length,
      todayVisits: todayCount
    };

    // インライン統計を更新（履歴表示数を表示）
    const historyCount = document.getElementById('historyCount');
    if (historyCount) {
      historyCount.textContent = this.allVisits.length;
    }
  }

  filterAndRenderData() {
    let dataToRender;

    // モードに応じてデータ構造を決定
    if (this.viewMode === 'aggregated') {
      // 集計モード：同じURLを集約したツリーを構築
      const aggregatedData = this.buildAggregatedTree();

      if (!this.currentSearchTerm) {
        dataToRender = aggregatedData;
      } else {
        dataToRender = this.filterTree(aggregatedData, this.currentSearchTerm);
      }
    } else {
      // 時系列モード：従来の処理
      if (!this.currentSearchTerm) {
        dataToRender = this.filteredData;
      } else {
        dataToRender = this.filterTree(this.filteredData, this.currentSearchTerm);
      }
    }

    // データをそのまま表示（ページネーションは時間範囲で行う）
    this.renderTree(dataToRender);
    this.updatePageInputs();
    this.updateSearchRange();
  }  filterTree(nodes, searchTerm) {
    const filtered = [];

    for (const node of nodes) {
      const titleMatch = node.title.toLowerCase().includes(searchTerm);
      const urlMatch = node.url.toLowerCase().includes(searchTerm);
      const filteredChildren = this.filterTree(node.children, searchTerm);

      if (titleMatch || urlMatch || filteredChildren.length > 0) {
        filtered.push({
          ...node,
          children: filteredChildren
        });
      }
    }

    return filtered;
  }

  renderTree(nodes) {
    const container = document.getElementById('tree');
    container.innerHTML = '';

    if (nodes.length === 0) {
      container.innerHTML = '<div class="loading">該当する履歴が見つかりませんでした。</div>';
      return;
    }

    const ul = document.createElement('ul');
    container.appendChild(ul);

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const treeId = `${i + 1}`;  // 1, 2, 3...
      const isLast = i === nodes.length - 1;
      const isFirst = i === 0;
      ul.appendChild(this.createHistoryItem(node, treeId, isLast, isFirst));
    }
  }

  createHistoryItem(node, treeId, isLast = false, isFirst = false) {
    const li = document.createElement('li');
    li.className = 'history-item';

    // ツリーIDを data属性として追加
    li.setAttribute('data-tree-id', treeId);
    li.setAttribute('data-tree-depth', treeId.split('-').length - 1);

    // 最後の子要素かどうかのクラスを追加
    if (isLast) {
      li.classList.add('is-last-child');
    }

    // 最初の子要素かどうかのクラスを追加
    if (isFirst) {
      li.classList.add('is-first-child');
    }

    // 子要素がある場合のクラス追加
    if (node.children.length > 0) {
      li.classList.add('has-children');
    }

    // メインアイテムのヘッダー
    const header = document.createElement('div');
    header.className = 'item-header';

    // 展開/折りたたみトグル
    const toggle = document.createElement('div');
    toggle.className = 'toggle';

    if (node.children.length > 0) {
      toggle.textContent = '▾';
      toggle.style.cursor = 'pointer';

      toggle.addEventListener('click', (e) => {
        e.preventDefault();
        const childrenContainer = li.querySelector('.item-children');
        if (childrenContainer.classList.contains('collapsed')) {
          childrenContainer.classList.remove('collapsed');
          toggle.textContent = '▾';
        } else {
          childrenContainer.classList.add('collapsed');
          toggle.textContent = '▸';
        }
      });
    } else {
      toggle.textContent = '•';
      toggle.style.cursor = 'default';
    }

    header.appendChild(toggle);

    // 時刻
    const timeSpan = document.createElement('span');
    timeSpan.className = 'item-time';
    const date = new Date(node.visitTime);
    timeSpan.textContent = this.formatTime(date);
    header.appendChild(timeSpan);

    // ツリーID表示（デバッグ用、後で削除可能）
    const treeIdSpan = document.createElement('span');
    treeIdSpan.className = 'tree-id-debug';
    treeIdSpan.textContent = `[${treeId}]`;
    treeIdSpan.style.fontSize = '10px';
    treeIdSpan.style.color = '#999';
    treeIdSpan.style.marginRight = '8px';
    header.appendChild(treeIdSpan);

    // ファビコン
    const favicon = document.createElement('img');
    favicon.className = 'item-favicon';
    favicon.src = node.favicon;
    favicon.loading = 'lazy';
    favicon.onerror = () => {
      try {
        const urlObj = new URL(node.url);
        favicon.src = `${urlObj.origin}/favicon.ico`;
        favicon.onerror = () => {
          favicon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="%23f1f3f4"/><path d="M4 4h8v8H4z" fill="%23666"/></svg>';
        };
      } catch {
        favicon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="%23f1f3f4"/><path d="M4 4h8v8H4z" fill="%23666"/></svg>';
      }
    };
    header.appendChild(favicon);

    // タイトルリンク
    const titleLink = document.createElement('a');
    titleLink.className = 'item-title';
    titleLink.href = node.url;

    // 集計モードでは訪問回数も表示
    if (this.viewMode === 'aggregated' && node.visitCount > 1) {
      titleLink.textContent = `${node.title} (${node.visitCount}回)`;
    } else {
      titleLink.textContent = node.title;
    }

    titleLink.target = '_blank';
    header.appendChild(titleLink);

    li.appendChild(header);

    // URL表示
    if (node.url !== node.title) {
      const urlDiv = document.createElement('div');
      urlDiv.className = 'item-url';
      urlDiv.textContent = node.url;
      li.appendChild(urlDiv);
    }

    // 子要素
    if (node.children.length > 0) {
      const childrenContainer = document.createElement('div');
      childrenContainer.className = 'item-children';

      const childUl = document.createElement('ul');

      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        const childTreeId = `${treeId}-${i + 1}`;  // 1-1, 1-2, 2-1, 2-2-1...
        const isChildLast = i === node.children.length - 1;
        const isChildFirst = i === 0;
        const childLi = this.createHistoryItem(child, childTreeId, isChildLast, isChildFirst);
        childUl.appendChild(childLi);
      }
      childrenContainer.appendChild(childUl);
      li.appendChild(childrenContainer);
    }

    return li;
  }

  formatTime(date) {
    // YYYY/MM/DD HH:MM 形式で統一
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');

    return `${year}/${month}/${day} ${hours}:${minutes}`;
  }
}

// 初期化
document.addEventListener('DOMContentLoaded', () => {
  const historyManager = new HistoryManager();
  historyManager.loadHistoryForCurrentPage();
});
