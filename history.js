// history.js - 新しいタブでの履歴表示

// Promise wrapper for chrome.history APIs
function historySearch(query) {
  return new Promise((resolve) => chrome.history.search(query, resolve));
}

function historyGetVisits(details) {
  return new Promise((resolve) => chrome.history.getVisits(details, resolve));
}

// WebNavigation API wrapper
function webNavigationGetAllFrames(details) {
  return new Promise((resolve) => chrome.webNavigation.getAllFrames(details, resolve));
}

// Navigation tracking for enhanced tree building (Beta mode)
class NavigationTracker {
  constructor() {
    this.navigationData = new Map(); // visitId -> navigation details
    this.tabParents = new Map(); // tabId -> parent tab info
    this.backForwardHistory = new Map(); // tabId -> navigation stack
    this.newTabRelations = new Map(); // childTabId -> parentTabInfo
    this.setupWebNavigationListeners();
  }

  setupWebNavigationListeners() {
    if (typeof chrome !== 'undefined' && chrome.webNavigation) {
      // ナビゲーション開始時
      chrome.webNavigation.onBeforeNavigate.addListener((details) => {
        if (details.frameId === 0) { // メインフレームのみ
          this.trackNavigation(details);
        }
      });

      // ナビゲーション完了時
      chrome.webNavigation.onCompleted.addListener((details) => {
        if (details.frameId === 0) {
          this.recordCompletedNavigation(details);
        }
      });

      // 新しいタブが作成された時の親タブを追跡
      if (chrome.tabs && chrome.tabs.onCreated) {
        chrome.tabs.onCreated.addListener((tab) => {
          chrome.tabs.query({active: true, currentWindow: true}, (activeTabs) => {
            if (activeTabs.length > 0 && activeTabs[0].id !== tab.id) {
              const parentInfo = {
                parentTabId: activeTabs[0].id,
                parentUrl: activeTabs[0].url,
                parentTitle: activeTabs[0].title,
                createdTime: Date.now(),
                confidence: 1.0
              };
              this.newTabRelations.set(tab.id, parentInfo);
              console.log(`新しいタブ追跡: Tab ${tab.id} の親は Tab ${activeTabs[0].id} (${activeTabs[0].url})`);
            }
          });
        });
      }

      // タブが削除された時のクリーンアップ
      if (chrome.tabs && chrome.tabs.onRemoved) {
        chrome.tabs.onRemoved.addListener((tabId) => {
          this.newTabRelations.delete(tabId);
          this.backForwardHistory.delete(tabId);
        });
      }
    }
  }

  trackNavigation(details) {
    const navigationInfo = {
      tabId: details.tabId,
      url: details.url,
      timeStamp: details.timeStamp,
      transitionType: details.transitionType,
      transitionQualifiers: details.transitionQualifiers || [],
      parentTabInfo: this.newTabRelations.get(details.tabId)
    };

    // 戻る/進む操作の検出
    if (details.transitionQualifiers) {
      navigationInfo.isBackForward = details.transitionQualifiers.includes('forward_back');
      navigationInfo.isReload = details.transitionQualifiers.includes('client_redirect') ||
                               details.transitionQualifiers.includes('server_redirect');
    }

    // タブごとのナビゲーション履歴を管理
    if (!this.backForwardHistory.has(details.tabId)) {
      this.backForwardHistory.set(details.tabId, []);
    }

    const tabHistory = this.backForwardHistory.get(details.tabId);
    tabHistory.push(navigationInfo);

    // 履歴が長くなりすぎないよう制限
    if (tabHistory.length > 50) {
      tabHistory.shift();
    }

    this.navigationData.set(`${details.tabId}-${details.timeStamp}`, navigationInfo);
  }

  recordCompletedNavigation(details) {
    const navKey = `${details.tabId}-${details.timeStamp}`;
    const navInfo = this.navigationData.get(navKey);
    if (navInfo) {
      navInfo.completed = true;
      navInfo.completedTime = Date.now();
    }
  }

  // 新しいタブで開かれたURLの親を特定
  findNewTabParent(url, visitTime, tabId = null) {
    // 特定のタブIDがある場合は直接検索
    if (tabId && this.newTabRelations.has(tabId)) {
      const parentInfo = this.newTabRelations.get(tabId);
      const timeDiff = Math.abs(visitTime - parentInfo.createdTime);
      if (timeDiff < 10000) { // 10秒以内なら関連性ありと判定
        return {
          parentUrl: parentInfo.parentUrl,
          parentTitle: parentInfo.parentTitle,
          parentTabId: parentInfo.parentTabId,
          confidence: Math.max(0.5, 1 - (timeDiff / 10000)),
          relationType: 'new_tab'
        };
      }
    }

    // 時間ベースの推定
    for (const [currentTabId, parentInfo] of this.newTabRelations) {
      const timeDiff = Math.abs(visitTime - parentInfo.createdTime);
      if (timeDiff < 5000) { // 5秒以内なら関連性ありと判定
        return {
          parentUrl: parentInfo.parentUrl,
          parentTitle: parentInfo.parentTitle,
          parentTabId: parentInfo.parentTabId,
          confidence: Math.max(0.3, 1 - (timeDiff / 5000)),
          relationType: 'new_tab_time_based'
        };
      }
    }
    return null;
  }

  // 戻る動作を検出
  detectBackNavigation(url, visitTime, tabId = null) {
    const tabHistory = tabId ? this.backForwardHistory.get(tabId) : null;

    if (tabHistory) {
      // 同じタブでの戻る動作を検出
      for (let i = tabHistory.length - 1; i >= 0; i--) {
        const nav = tabHistory[i];
        if (nav.isBackForward && nav.url === url) {
          const timeDiff = Math.abs(visitTime - nav.timeStamp);
          if (timeDiff < 1000) { // 1秒以内
            return {
              confidence: 0.9,
              relationType: 'back_forward',
              originalNavigation: nav
            };
          }
        }
      }
    }

    return null;
  }

  // ナビゲーション履歴を取得
  getNavigationHistory(tabId) {
    return this.backForwardHistory.get(tabId) || [];
  }

  // 階層移動を検出
  detectHierarchyNavigation(fromUrl, toUrl, visitTime) {
    try {
      const from = new URL(fromUrl);
      const to = new URL(toUrl);

      if (from.hostname !== to.hostname) return null;

      const fromParts = from.pathname.split('/').filter(Boolean);
      const toParts = to.pathname.split('/').filter(Boolean);

      // 深い階層から浅い階層への移動（一覧ページへの戻り）
      if (fromParts.length > toParts.length) {
        const isParentPath = toParts.every((part, index) => fromParts[index] === part);
        if (isParentPath) {
          const hierarchyDiff = fromParts.length - toParts.length;
          return {
            confidence: Math.min(0.9, 0.5 + (hierarchyDiff * 0.2)),
            relationType: 'hierarchy_up',
            hierarchyDiff: hierarchyDiff
          };
        }
      }

      // 浅い階層から深い階層への移動（詳細ページへ）
      if (toParts.length > fromParts.length) {
        const isChildPath = fromParts.every((part, index) => toParts[index] === part);
        if (isChildPath) {
          const hierarchyDiff = toParts.length - fromParts.length;
          return {
            confidence: Math.min(0.8, 0.4 + (hierarchyDiff * 0.15)),
            relationType: 'hierarchy_down',
            hierarchyDiff: hierarchyDiff
          };
        }
      }

    } catch (e) {
      console.error('階層移動検出エラー:', e);
    }

    return null;
  }
}

// === 集約モード強化版: Chu-Liu/Edmonds ベースの実装 ===

const PARAMS = {
  PATH_WEIGHT: 40,
  ROOT_BONUS: 220,
  DOMAIN_MATCH_BONUS: 20,
  ID_PATTERN_BONUS: 30,
  PATTERN_BONUS: 25,
  RECENCY_HALF_LIFE_MS: 14 * 24 * 60 * 60 * 1000, // 14日
  ALPHA: { count: 1.0, recency: 1.4, freq: 0.9, path: 1.0, root: 1.1, pattern: 0.6, domain: 0.4 },
  TOP_K_INCOMING: 10, // 各ノードについて保持する上位incomingエッジ数（速度/品質トレードオフ）
  HIERARCHY_SCORE_BONUS: 80, // URL 階層から推定した親子関係に与えるボーナス（大きめにすると階層が強く反映）
  MIN_EDGE_SCORE: 0.01, // かなり低いスコアのエッジは省く
  DEBUG: false
};

// --- ヘルパー: パス接頭辞一致数 ---
function _countMatchingPathParts(parentParts, childParts) {
  let matches = 0;
  const minLen = Math.min(parentParts.length, childParts.length);
  for (let i = 0; i < minLen; i++) {
    if (parentParts[i] === childParts[i]) matches++;
    else break;
  }
  return matches;
}

// --- スコア計算 ---
function _computeEdgeScore(fromUrl, toUrl, meta, urlVisitMap, now, params = PARAMS) {
  const al = params.ALPHA;
  const count = meta.count || 1;
  const lastTime = meta.lastTime || 0;
  const visitCountTo = (urlVisitMap.get(toUrl)?.visitCount) || 1;

  const w_count = Math.log(1 + count);
  const age = Math.max(0, now - lastTime);
  const w_recency = Math.exp(-age / params.RECENCY_HALF_LIFE_MS); // 0..1
  const w_freq = Math.log(1 + visitCountTo);

  let w_path = 0, w_root = 0, w_pattern = 0, w_domain = 0;
  try {
    const f = new URL(fromUrl);
    const t = new URL(toUrl);
    if (f.hostname === t.hostname) {
      w_domain = params.DOMAIN_MATCH_BONUS;
      const fromParts = f.pathname.split('/').filter(Boolean);
      const toParts = t.pathname.split('/').filter(Boolean);
      const matching = _countMatchingPathParts(fromParts, toParts);
      if (matching > 0) {
        w_path = (matching / Math.max(1, fromParts.length)) * params.PATH_WEIGHT;
      }
      if (fromParts.length === 0) { // ルートページはボーナス
        w_root = params.ROOT_BONUS;
      }
      const fromLast = (fromParts[fromParts.length - 1] || '').toLowerCase();
      if (['category','categories','tag','tags','section','posts','articles','products','product','blog'].includes(fromLast)) {
        w_pattern += params.PATTERN_BONUS;
      }
      const toLast = (toParts[toParts.length - 1] || '');
      if (/^\d+$/.test(toLast) || /^[a-f0-9-]{8,}$/.test(toLast)) {
        w_pattern += params.ID_PATTERN_BONUS;
      }
    }
  } catch (e) {
    // 無効URLならパス/ドメインボーナスは無視
  }

  const score =
    al.count * w_count +
    al.recency * w_recency +
    al.freq * w_freq +
    al.path * w_path +
    al.root * w_root +
    al.pattern * w_pattern +
    al.domain * w_domain;

  return score;
}

// === Chu-Liu/Edmonds 実装（最大重み有向被覆木） ===
// nodes: array of node keys (string URLs), root: root key (string), edges: [{u, v, w}]
function edmondsMaximumArborescence(root, nodes, edges) {
  // Implementation adapted for clarity; returns parentMap: Map(node -> parent) for nodes != root
  // If node unreachable -> parent not set -> treated as child of root by caller.
  const N = nodes.length;
  const nodeIndex = new Map(nodes.map((n,i) => [n,i]));

  // Build adjacency list of incoming edges per node
  const incoming = Array(N).fill(0).map(() => []);
  for (const e of edges) {
    const u = nodeIndex.get(e.u);
    const v = nodeIndex.get(e.v);
    if (u === undefined || v === undefined) continue;
    incoming[v].push({ u, w: e.w, edge: e });
  }

  // 1) For each node (except root), pick maximum incoming edge
  const rootIdx = nodeIndex.get(root);
  function solve(currNodes, currIncoming) {
    const M = currNodes.length;
    const idxMap = new Map(currNodes.map((n,i) => [n, i])); // map original idx -> 0..M-1
    const invMap = currNodes.slice(); // index -> original idx

    // pick best incoming for each node
    const inEdge = Array(M).fill(null);
    for (let i = 0; i < M; i++) {
      const origIdx = invMap[i];
      if (origIdx === rootIdx) continue;
      const incs = currIncoming[origIdx] || [];
      if (incs.length === 0) return null; // no incoming -> impossible
      // pick max weight
      let best = incs[0];
      for (const it of incs) {
        if (it.w > best.w) best = it;
      }
      inEdge[i] = { from: best.u, w: best.w, edge: best.edge, origFromIdx: best.u };
    }

    // detect cycles in inEdge graph
    const vis = Array(M).fill(-1);
    const comp = Array(M).fill(-1);
    let compId = 0;
    for (let i = 0; i < M; i++) {
      if (vis[i] !== -1) continue;
      let cur = i;
      const path = [];
      while (cur !== -1 && vis[cur] === -1) {
        vis[cur] = i;
        path.push(cur);
        const e = inEdge[cur];
        if (!e) { cur = -1; break; }
        // e.from is original idx of parent; convert to local if exists in idxMap
        const fromOrig = e.origFromIdx;
        const fromLocal = idxMap.has(fromOrig) ? idxMap.get(fromOrig) : -1;
        if (fromLocal === -1) { cur = -1; break; } // parent is outside -> no cycle here
        cur = fromLocal;
      }
      if (cur !== -1 && vis[cur] === i) {
        // found cycle, mark entire cycle with same comp id
        let x;
        do {
          x = path.pop();
          comp[x] = compId;
        } while (x !== cur && path.length);
        compId++;
      }
      // mark remaining nodes as no cycle
    }

    if (compId === 0) {
      // no cycles -> build parent map and return mapping from original index -> parent original index
      const resultParent = new Map();
      for (let i = 0; i < M; i++) {
        if (invMap[i] === rootIdx) continue;
        const e = inEdge[i];
        if (e) {
          resultParent.set(invMap[i], e.origFromIdx);
        }
      }
      return { resultParent, contracted: null };
    }

    // There are cycles: contract them
    // map origIdx -> cycleId or new id
    const cycleId = new Map();
    let nextId = 0;
    for (let i = 0; i < M; i++) {
      if (comp[i] !== -1) {
        // cycle node
        if (!cycleId.has(comp[i])) cycleId.set(comp[i], nextId++);
        cycleId.set(i, cycleId.get(comp[i]));
      }
    }
    // nodes not in any cycle get unique ids
    for (let i = 0; i < M; i++) {
      if (comp[i] === -1) {
        cycleId.set(i, nextId++);
      }
    }

    const newCount = nextId;
    // Build new incoming lists for contracted graph
    const newIncoming = Array(newCount).fill(0).map(() => []);
    const newNodes = [];
    // For mapping back later
    const mapping = new Map(); // newIdx -> array of old invMap indices
    for (let i = 0; i < M; i++) {
      const nid = cycleId.get(i);
      if (!mapping.has(nid)) mapping.set(nid, []);
      mapping.get(nid).push(invMap[i]);
    }
    for (let nid = 0; nid < newCount; nid++) newNodes.push(nid);

    // For each edge origU -> origV in currIncoming (orig indices), reweight and add
    // We'll iterate over all original incoming arrays
    for (let origV of invMap) {
      const vLocal = idxMap.get(origV);
      const vNew = cycleId.get(vLocal);
      const incs = currIncoming[origV] || [];
      for (const e of incs) {
        const uOrig = e.u;
        const uLocal = idxMap.has(uOrig) ? idxMap.get(uOrig) : -1;
        const uNew = uLocal === -1 ? null : cycleId.get(uLocal);
        // edge from uOrig -> origV (orig indices)
        // compute adjusted weight
        let wAdj = e.w;
        // if v is in cycle, subtract its chosen in-edge weight (inEdge of that vLocal)
        if (vLocal !== -1 && comp[vLocal] !== -1) {
          const inE = inEdge[vLocal];
          if (inE) wAdj = e.w - inE.w;
        }
        // add edge to newIncoming for vNew with meta storing original edge
        // uNew might equal vNew (internal cycle edge) -> skip
        if (uNew !== vNew) {
          newIncoming[uOrig] = newIncoming[uOrig] || []; // ensure exists for safety
          // push to newIncoming by original indices mapping (we'll reshape later)
          // Store as raw triple to be processed in next recursion
          // For simpler implementation, collect as edges array external to this function
        }
      }
    }

    // Simpler alternative: fallback to greedy break of the weakest edge in each cycle
    // (To avoid full complexity here, we'll return contracted null to signal caller do greedy)
    return { resultParent: null, contracted: true, cycles: mapping };
  }

  // Top-level simple approach: try to construct parent by choosing max incoming then detect cycles
  // If cycles exist, we will not do full complex contraction here due to complexity — instead
  // we'll fallback to greedy cycle-breaking implemented outside. So edmonds returns best attempts
  // as a parent map if no cycles, otherwise null to signal fallback required.
  const Mfull = N;
  const inEdge = Array(N).fill(null);
  for (let v = 0; v < N; v++) {
    if (v === rootIdx) continue;
    const incs = incoming[v];
    if (!incs || incs.length === 0) {
      // unreachable -> leave null
      inEdge[v] = null;
      continue;
    }
    // pick best incoming
    let best = incs[0];
    for (const it of incs) {
      if (it.w > best.w) best = it;
    }
    inEdge[v] = best; // { u, w, edge }
  }

  // detect cycles
  const visited = Array(N).fill(false);
  const stackmark = Array(N).fill(false);
  const parentMap = new Map();
  let hasCycle = false;
  function dfs(u) {
    visited[u] = true;
    stackmark[u] = true;
    const e = inEdge[u];
    if (e && !visited[e.u]) {
      dfs(e.u);
    } else if (e && stackmark[e.u]) {
      hasCycle = true;
    }
    stackmark[u] = false;
  }
  for (let i = 0; i < N; i++) {
    if (i === rootIdx) continue;
    if (!visited[i]) dfs(i);
  }

  if (hasCycle) return null; // signal fallback required
  // build parentMap
  for (let v = 0; v < N; v++) {
    if (v === rootIdx) continue;
    const e = inEdge[v];
    if (e) parentMap.set(nodes[v], nodes[e.u]);
  }
  return parentMap;
}

// --- Greedy fallback: cycle-break by weakest edge (previously described) ---
function greedyResolve(nodes, incomingMap, params = PARAMS) {
  const VIRTUAL_ROOT = '__ROOT__';
  const parentChoice = new Map();
  const candidateIdx = new Map();

  for (const node of nodes) {
    const arr = incomingMap.get(node) || [];
    if (arr.length > 0) {
      parentChoice.set(node, arr[0].from);
      candidateIdx.set(node, 0);
    } else {
      parentChoice.set(node, VIRTUAL_ROOT);
    }
  }

  function detectCycle(parentMap) {
    const visited = new Set();
    const inStack = new Set();
    for (const start of nodes) {
      if (visited.has(start)) continue;
      let cur = start;
      const stack = [];
      while (cur !== VIRTUAL_ROOT && !visited.has(cur)) {
        visited.add(cur);
        inStack.add(cur);
        stack.push(cur);
        cur = parentMap.get(cur) || VIRTUAL_ROOT;
        if (inStack.has(cur)) {
          // collect cycle
          const cycle = [];
          for (let i = stack.length - 1; i >= 0; i--) {
            const n = stack[i];
            cycle.push(n);
            if (n === cur) break;
          }
          return cycle.reverse();
        }
      }
      for (const s of stack) inStack.delete(s);
    }
    return null;
  }

  let cycle = detectCycle(parentChoice);
  while (cycle) {
    // find weakest edge in cycle (child -> parent) by score
    let weakest = { node: null, score: Infinity };
    for (const child of cycle) {
      const parent = parentChoice.get(child);
      if (!parent || parent === VIRTUAL_ROOT) continue;
      const arr = incomingMap.get(child) || [];
      const idx = arr.findIndex(x => x.from === parent);
      const sc = idx >= 0 ? arr[idx].score : -Infinity;
      if (sc < weakest.score) weakest = { node: child, score: sc };
    }
    if (!weakest.node) break;
    // advance candidate for that node
    const arr = incomingMap.get(weakest.node) || [];
    const curIdx = candidateIdx.get(weakest.node) || 0;
    if (curIdx + 1 < arr.length) {
      candidateIdx.set(weakest.node, curIdx + 1);
      parentChoice.set(weakest.node, arr[curIdx + 1].from);
    } else {
      parentChoice.set(weakest.node, VIRTUAL_ROOT);
    }
    cycle = detectCycle(parentChoice);
  }
  return parentChoice;
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
    this.viewMode = 'chronological'; // 'chronological', 'aggregated', or 'beta'
    this.stats = {
      totalSites: 0,
      totalVisits: 0,
      todayVisits: 0
    };

    // NavigationTracker のインスタンスを作成（Beta機能用）
    this.navigationTracker = new NavigationTracker();

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

  // --- メイン: buildAggregatedTree の置換（HistoryManager.prototype.buildAggregatedTree） ---
  buildAggregatedTree() {
    // 1) aggregate visits by URL
    const urlVisitMap = new Map();
    for (const v of this.allVisits) {
      if (!urlVisitMap.has(v.url)) {
        urlVisitMap.set(v.url, {
          url: v.url,
          title: v.title || v.url,
          favicon: v.favicon,
          visits: [],
          firstVisitTime: v.visitTime,
          lastVisitTime: v.visitTime,
          visitCount: 0
        });
      }
      const info = urlVisitMap.get(v.url);
      info.visits.push(v);
      info.visitCount++;
      info.firstVisitTime = Math.min(info.firstVisitTime, v.visitTime);
      info.lastVisitTime = Math.max(info.lastVisitTime, v.visitTime);
    }

    // 2) transitions via visit.referringVisitId (O(n))
    const visitIdMap = new Map(this.allVisits.map(v => [v.visitId, v]));
    const rawTransitions = new Map(); // fromUrl -> Map(toUrl -> {count, firstTime, lastTime})
    for (const v of this.allVisits) {
      if (!v.referringVisitId) continue;
      const r = visitIdMap.get(v.referringVisitId);
      if (!r || r.url === v.url) continue;
      const from = r.url, to = v.url;
      if (!rawTransitions.has(from)) rawTransitions.set(from, new Map());
      const m = rawTransitions.get(from);
      if (!m.has(to)) m.set(to, { count: 0, firstTime: v.visitTime, lastTime: v.visitTime });
      const meta = m.get(to);
      meta.count++;
      meta.firstTime = Math.min(meta.firstTime, v.visitTime);
      meta.lastTime = Math.max(meta.lastTime, v.visitTime);
    }

    // 3) compute edges with scoring
    const now = Date.now();
    const incomingMap = new Map(); // toUrl -> [{from, to, score, meta}, ...]
    // transitions first
    for (const [from, m] of rawTransitions) {
      for (const [to, meta] of m) {
        const score = _computeEdgeScore(from, to, meta, urlVisitMap, now, PARAMS);
        if (score < PARAMS.MIN_EDGE_SCORE) continue;
        if (!incomingMap.has(to)) incomingMap.set(to, []);
        incomingMap.get(to).push({ from, to, score, meta });
      }
    }

    // 4) add URL-hierarchy inferred edges (orphans & general)
    // Build URL info for path comparison
    const urlInfo = new Map();
    for (const [url, info] of urlVisitMap) {
      try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        urlInfo.set(url, { hostname: u.hostname, parts });
      } catch (e) {
        urlInfo.set(url, { hostname: null, parts: [] });
      }
    }
    const urls = Array.from(urlVisitMap.keys());
    // For each pair same-domain where path prefix suggests parent, add boosted edge
    for (let i = 0; i < urls.length; i++) {
      const a = urls[i];
      const ai = urlInfo.get(a);
      if (!ai || !ai.hostname) continue;
      for (let j = 0; j < urls.length; j++) {
        if (i === j) continue;
        const b = urls[j];
        const bi = urlInfo.get(b);
        if (!bi || bi.hostname !== ai.hostname) continue;
        // check if a is potential parent of b
        if (ai.parts.length < bi.parts.length) {
          const matching = _countMatchingPathParts(ai.parts, bi.parts);
          if (matching > 0) {
            // base score from matching parts
            const base = (matching / Math.max(1, ai.parts.length)) * PARAMS.PATH_WEIGHT;
            // add hierarchy bonus to make these competitive
            const meta = { count: 0, firstTime: 0, lastTime: 0 };
            const score = base + PARAMS.HIERARCHY_SCORE_BONUS;
            if (score >= PARAMS.MIN_EDGE_SCORE) {
              if (!incomingMap.has(b)) incomingMap.set(b, []);
              incomingMap.get(b).push({ from: a, to: b, score, meta, inferred: true });
            }
          }
        } else if (ai.parts.length === 0 && bi.parts.length >= 1) {
          // root -> child preference
          const score = PARAMS.ROOT_BONUS + PARAMS.HIERARCHY_SCORE_BONUS / 2;
          if (!incomingMap.has(b)) incomingMap.set(b, []);
          incomingMap.get(b).push({ from: a, to: b, score, meta: { count:0 }, inferred: true });
        }
      }
    }

    // 5) prune incoming edges to topK per node
    for (const [to, arr] of incomingMap) {
      arr.sort((A, B) => {
        if (B.score !== A.score) return B.score - A.score;
        // tie-breaker: prefer transitions over inferred
        if ((B.meta?.count || 0) !== (A.meta?.count || 0)) return (B.meta?.count || 0) - (A.meta?.count || 0);
        return (A.from || '').localeCompare(B.from || '');
      });
      if (arr.length > PARAMS.TOP_K_INCOMING) {
        incomingMap.set(to, arr.slice(0, PARAMS.TOP_K_INCOMING));
      } else {
        incomingMap.set(to, arr);
      }
    }

    // 6) prepare nodes + edges list for Edmonds
    const nodesList = urls.slice(); // nodes are URLs
    const VIRTUAL_ROOT = '__ROOT__';
    nodesList.push(VIRTUAL_ROOT);

    const edges = [];
    for (const [to, arr] of incomingMap) {
      for (const e of arr) {
        edges.push({ u: e.from, v: e.to, w: e.score });
      }
    }
    // Also allow any node to be attached to VIRTUAL_ROOT with small base weight so tree spans all
    for (const url of urls) {
      edges.push({ u: VIRTUAL_ROOT, v: url, w: 1.0 }); // small weight ensures connectivity
    }

    // 7) run Edmonds maximum arborescence
    let parentMap = null;
    try {
      parentMap = edmondsMaximumArborescence(VIRTUAL_ROOT, nodesList, edges);
      if (PARAMS.DEBUG) console.log('Edmonds result parentMap:', parentMap);
    } catch (e) {
      console.warn('Edmonds failed:', e);
      parentMap = null;
    }

    // 8) fallback to greedyResolve if edmonds returned null (cycles or complexity)
    if (!parentMap) {
      if (PARAMS.DEBUG) console.log('Falling back to greedy cycle-breaker');
      const greedyMap = greedyResolve(urls, incomingMap, PARAMS);
      parentMap = greedyMap;
    }

    // 9) build parentToChildren mapping
    const parentToChildren = new Map();
    for (const url of urls) parentToChildren.set(url, []);
    for (const url of urls) {
      const p = parentMap.get(url) || VIRTUAL_ROOT;
      if (p && p !== VIRTUAL_ROOT) {
        if (!parentToChildren.has(p)) parentToChildren.set(p, []);
        parentToChildren.get(p).push(url);
      }
    }

    // 10) construct node objects with children recursively
    const makeNode = (u) => {
      const info = urlVisitMap.get(u);
      return {
        url: info.url,
        title: info.title,
        favicon: info.favicon,
        visitTime: info.lastVisitTime,
        visitCount: info.visitCount,
        children: []
      };
    };
    const nodeObjects = new Map();
    for (const url of urls) nodeObjects.set(url, makeNode(url));
    for (const [p, children] of parentToChildren) {
      const pn = nodeObjects.get(p);
      if (!pn) continue;
      // sort children by visitCount desc then lastVisitTime
      children.sort((a,b) => {
        const A = urlVisitMap.get(a), B = urlVisitMap.get(b);
        if (B.visitCount !== A.visitCount) return B.visitCount - A.visitCount;
        return B.lastVisitTime - A.lastVisitTime;
      });
      pn.children = children.map(c => nodeObjects.get(c));
    }

    // 11) roots: parent == VIRTUAL_ROOT
    const roots = [];
    for (const url of urls) {
      const p = parentMap.get(url) || VIRTUAL_ROOT;
      if (p === VIRTUAL_ROOT) roots.push(nodeObjects.get(url));
    }
    roots.sort((a,b) => b.visitTime - a.visitTime);

    if (PARAMS.DEBUG) console.log(`AggregatedTree built: ${nodesList.length-1} URLs, roots: ${roots.length}`);
    return roots;
  }

  // Beta機能：高度なナビゲーション解析によるツリー構築
  buildBetaTree() {
    console.log('=== Beta Tree Mode: 高度なナビゲーション解析開始 ===');

    // 基本的な訪問マップを作成
    const visitMap = new Map();
    for (const visit of this.allVisits) {
      visitMap.set(visit.visitId, { ...visit, children: [], betaRelations: [] });
    }

    const processedVisits = new Set();
    const betaRelations = []; // Beta機能で検出された関係

    // 1. 基本的な親子関係（referringVisitIdベース）を構築
    for (const visit of visitMap.values()) {
      if (visit.referringVisitId && visitMap.has(visit.referringVisitId)) {
        const parent = visitMap.get(visit.referringVisitId);
        parent.children.push(visit);
        visit.betaRelations.push({
          type: 'referring_visit',
          confidence: 1.0,
          parentVisitId: visit.referringVisitId
        });
        processedVisits.add(visit.visitId);
      }
    }

    // 2. 孤立した訪問に対してBeta機能を適用
    const orphanVisits = Array.from(visitMap.values()).filter(visit =>
      !visit.referringVisitId || !visitMap.has(visit.referringVisitId)
    );

    console.log(`孤立した訪問: ${orphanVisits.length}個 / 全訪問: ${this.allVisits.length}個`);

    for (const orphan of orphanVisits) {
      if (processedVisits.has(orphan.visitId)) continue;

      let bestParent = null;
      let bestRelation = null;
      let bestScore = 0;

      // 2.1 新しいタブで開かれた関係を検出
      const newTabRelation = this.navigationTracker.findNewTabParent(
        orphan.url,
        orphan.visitTime,
        orphan.tabId
      );

      if (newTabRelation && newTabRelation.confidence > 0.6) {
        const parentVisit = this.findVisitByUrl(newTabRelation.parentUrl, orphan.visitTime, visitMap);
        if (parentVisit && newTabRelation.confidence > bestScore) {
          bestParent = parentVisit;
          bestRelation = {
            type: 'new_tab',
            confidence: newTabRelation.confidence,
            parentUrl: newTabRelation.parentUrl,
            details: newTabRelation
          };
          bestScore = newTabRelation.confidence;
        }
      }

      // 2.2 戻る動作を検出
      const backNavigation = this.navigationTracker.detectBackNavigation(
        orphan.url,
        orphan.visitTime,
        orphan.tabId
      );

      if (backNavigation && backNavigation.confidence > bestScore) {
        // 戻る動作の場合、過去の同じURLへの訪問を親として設定
        const previousVisit = this.findPreviousSameUrlVisit(orphan, visitMap);
        if (previousVisit) {
          bestParent = previousVisit;
          bestRelation = {
            type: 'back_navigation',
            confidence: backNavigation.confidence,
            details: backNavigation
          };
          bestScore = backNavigation.confidence;
        }
      }

      // 2.3 階層移動を検出
      for (const candidateParent of visitMap.values()) {
        if (candidateParent.visitId === orphan.visitId) continue;
        if (Math.abs(candidateParent.visitTime - orphan.visitTime) > 300000) continue; // 5分以内

        const hierarchyRelation = this.navigationTracker.detectHierarchyNavigation(
          candidateParent.url,
          orphan.url,
          orphan.visitTime
        );

        if (hierarchyRelation && hierarchyRelation.confidence > bestScore) {
          bestParent = candidateParent;
          bestRelation = {
            type: 'hierarchy_navigation',
            confidence: hierarchyRelation.confidence,
            parentUrl: candidateParent.url,
            details: hierarchyRelation
          };
          bestScore = hierarchyRelation.confidence;
        }
      }

      // 2.4 時系列パターン（短時間での同一URL再訪問）
      const timeBasedRelation = this.detectTimeBasedPattern(orphan, visitMap);
      if (timeBasedRelation && timeBasedRelation.confidence > bestScore) {
        bestParent = timeBasedRelation.parent;
        bestRelation = {
          type: 'time_based_pattern',
          confidence: timeBasedRelation.confidence,
          details: timeBasedRelation
        };
        bestScore = timeBasedRelation.confidence;
      }

      // 3. 最適な親子関係を設定
      if (bestParent && bestScore > 0.3) { // 最低信頼度30%
        bestParent.children.push(orphan);
        orphan.betaRelations.push(bestRelation);
        processedVisits.add(orphan.visitId);

        betaRelations.push({
          child: orphan,
          parent: bestParent,
          relation: bestRelation
        });

        console.log(`Beta関係検出: ${bestRelation.type} (信頼度: ${bestScore.toFixed(2)}) ${bestParent.title || bestParent.url} -> ${orphan.title || orphan.url}`);
      }
    }

    // 4. Beta特殊機能：全ドメインでルートドメインを生成
    this.generateRootDomainsForAllUrls(visitMap, processedVisits);

    // 5. ルートノードを抽出（親を持たない訪問）
    const roots = Array.from(visitMap.values()).filter(visit => {
      // 他の訪問の子要素になっていない訪問がルート
      return !Array.from(visitMap.values()).some(parent =>
        parent.children.includes(visit)
      );
    });

    // 5. 子要素を時刻順でソート
    const sortChildren = (node) => {
      if (node.children.length > 0) {
        node.children.sort((a, b) => b.visitTime - a.visitTime);
        node.children.forEach(sortChildren);
      }
    };
    roots.forEach(sortChildren);

    // 7. ルートノードを時刻順でソート
    roots.sort((a, b) => b.visitTime - a.visitTime);

    console.log(`=== Beta Tree 構築完了 ===`);
    console.log(`ルートノード: ${roots.length}個`);
    console.log(`検出された関係: ${betaRelations.length}個`);
    console.log(`関係タイプ別:`, this.summarizeBetaRelations(betaRelations));

    return roots;
  }

  // Beta特殊機能：全ドメインでルートドメインを生成
  generateRootDomainsForAllUrls(visitMap, processedVisits) {
    console.log('=== 全ドメイン用ルートドメイン生成開始 ===');

    const generatedRoots = new Map(); // ドメイン -> 生成されたルートノード
    const domainGroups = new Map(); // ドメイン -> 訪問リスト

    // 1. まず各ドメインごとに訪問をグループ化
    for (const visit of visitMap.values()) {
      try {
        const url = new URL(visit.url);
        const hostname = url.hostname;

        if (!domainGroups.has(hostname)) {
          domainGroups.set(hostname, []);
        }
        domainGroups.get(hostname).push(visit);
      } catch (error) {
        // 無効なURLの場合はスキップ
        console.warn(`URL解析エラー: ${visit.url}`, error);
      }
    }

    // 2. 各ドメインで処理
    for (const [hostname, visits] of domainGroups) {
      // ドメイン内で親子関係がない（孤立した）訪問を特定
      // ただし、既にツリー構造がある場合は最上位の親のみを対象とする
      const orphanVisits = visits.filter(visit => {
        // まだ処理されていない訪問のみ
        if (processedVisits.has(visit.visitId)) return false;

        // 他の訪問の子になっていない訪問（= 最上位の親または孤立）
        const isTopLevel = !visits.some(otherVisit =>
          otherVisit.children && otherVisit.children.includes(visit)
        );

        return isTopLevel;
      });

      if (orphanVisits.length === 0) continue;

      // ドメインのルートURL（ホームページ）を構築
      const rootUrl = `https://${hostname}`;

      // 既存のルートページ（ホームページ）があるかチェック
      const existingRootVisit = visits.find(visit => {
        try {
          const visitUrl = new URL(visit.url);
          return visitUrl.pathname === '/' && visitUrl.search === '' && visitUrl.hash === '';
        } catch {
          return false;
        }
      });

      // 複数の孤立した訪問がある場合、またはルートページが存在しない場合にルートドメインを生成
      // ただし、単一の孤立した訪問でも、それが既にツリー構造を持っている場合は対象とする
      const hasTreeStructure = orphanVisits.some(visit => visit.children && visit.children.length > 0);
      const shouldGenerateRoot = orphanVisits.length > 1 || !existingRootVisit || hasTreeStructure;

      if (shouldGenerateRoot) {
        let rootNode = generatedRoots.get(hostname);

        if (!rootNode) {
          if (existingRootVisit) {
            // 既存のルートページを使用
            rootNode = existingRootVisit;
            console.log(`既存のルートページを使用: ${rootUrl}`);
          } else {
            // 新しいルートドメインノードを生成
            const rootVisitId = `generated_root_${hostname}_${Date.now()}`;

            // 最初の訪問時間を基準にルートの時間を設定
            const earliestVisit = orphanVisits.reduce((earliest, current) =>
              current.visitTime < earliest.visitTime ? current : earliest
            );

            rootNode = {
              visitId: rootVisitId,
              url: rootUrl,
              title: this.generateRootDomainTitle(hostname),
              visitTime: earliestVisit.visitTime - 1000, // 最初の訪問より少し前
              referringVisitId: null,
              transition: 'generated',
              favicon: `https://www.google.com/s2/favicons?domain=${hostname}&sz=16`,
              children: [],
              betaRelations: [],
              isGeneratedRoot: true
            };

            visitMap.set(rootVisitId, rootNode);
            console.log(`新しいルートドメインを生成: ${rootUrl}`);
          }

          generatedRoots.set(hostname, rootNode);
        }

        // 孤立した訪問をルートドメインの子にする
        for (const orphanVisit of orphanVisits) {
          // ただし、既にルートページとして使用している場合は除外
          if (orphanVisit === rootNode) continue;

          rootNode.children.push(orphanVisit);
          orphanVisit.betaRelations.push({
            type: 'generated_root_domain',
            confidence: 1.0,
            parentUrl: rootUrl,
            details: {
              domain: hostname,
              isGenerated: !existingRootVisit || rootNode.isGeneratedRoot,
              reason: 'domain_organization'
            }
          });

          processedVisits.add(orphanVisit.visitId);

          console.log(`URLを${hostname}ルートドメインの子に設定: ${orphanVisit.url}`);
        }
      }
    }

    console.log(`=== 全ドメイン用ルートドメイン生成完了: ${generatedRoots.size}個のルートドメイン ===`);
  }  // ルートドメインのタイトルを生成
  generateRootDomainTitle(hostname) {
    const domainTitles = {
      'www.google.com': 'Google',
      'google.com': 'Google',
      'search.yahoo.com': 'Yahoo!検索',
      'www.yahoo.com': 'Yahoo!',
      'yahoo.com': 'Yahoo!',
      'www.bing.com': 'Bing',
      'bing.com': 'Bing',
      'duckduckgo.com': 'DuckDuckGo',
      'www.youtube.com': 'YouTube',
      'youtube.com': 'YouTube',
      'www.facebook.com': 'Facebook',
      'facebook.com': 'Facebook',
      'www.twitter.com': 'Twitter',
      'twitter.com': 'Twitter',
      'x.com': 'X (Twitter)',
      'www.instagram.com': 'Instagram',
      'instagram.com': 'Instagram',
      'www.linkedin.com': 'LinkedIn',
      'linkedin.com': 'LinkedIn',
      'github.com': 'GitHub',
      'www.github.com': 'GitHub',
      'stackoverflow.com': 'Stack Overflow',
      'www.amazon.com': 'Amazon',
      'amazon.com': 'Amazon',
      'www.amazon.co.jp': 'Amazon Japan',
      'amazon.co.jp': 'Amazon Japan',
      'www.wikipedia.org': 'Wikipedia',
      'ja.wikipedia.org': 'Wikipedia (日本語)',
      'en.wikipedia.org': 'Wikipedia (English)',
      'www.reddit.com': 'Reddit',
      'reddit.com': 'Reddit',
      'qiita.com': 'Qiita',
      'zenn.dev': 'Zenn'
    };

    // 既知のドメインの場合は専用タイトルを返す
    if (domainTitles[hostname]) {
      return domainTitles[hostname];
    }

    // 未知のドメインの場合は、ドメイン名から推測してタイトルを生成
    const parts = hostname.split('.');

    // www.example.com -> Example、subdomain.example.com -> Example のような形式
    let baseDomain = parts[parts.length - 2]; // example部分を取得

    if (baseDomain) {
      // 最初の文字を大文字にする
      return baseDomain.charAt(0).toUpperCase() + baseDomain.slice(1);
    }

    // フォールバック：そのままホスト名を返す
    return hostname;
  }

  // URLに基づいて訪問を検索
  findVisitByUrl(url, referenceTime, visitMap, timeWindow = 10000) {
    const candidates = Array.from(visitMap.values()).filter(visit =>
      visit.url === url &&
      Math.abs(visit.visitTime - referenceTime) < timeWindow
    );

    if (candidates.length === 0) return null;

    // 参照時刻に最も近い訪問を返す
    candidates.sort((a, b) =>
      Math.abs(a.visitTime - referenceTime) - Math.abs(b.visitTime - referenceTime)
    );

    return candidates[0];
  }

  // 過去の同じURLへの訪問を検索
  findPreviousSameUrlVisit(visit, visitMap) {
    const candidates = Array.from(visitMap.values()).filter(candidate =>
      candidate.url === visit.url &&
      candidate.visitTime < visit.visitTime &&
      candidate.visitTime > visit.visitTime - 300000 // 5分以内
    );

    if (candidates.length === 0) return null;

    // 最も近い過去の訪問を返す
    candidates.sort((a, b) => b.visitTime - a.visitTime);
    return candidates[0];
  }

  // 時系列パターンを検出
  detectTimeBasedPattern(visit, visitMap) {
    // 同じURLへの短時間での再訪問パターン
    const sameUrlVisits = Array.from(visitMap.values()).filter(candidate =>
      candidate.url === visit.url &&
      candidate.visitId !== visit.visitId &&
      Math.abs(candidate.visitTime - visit.visitTime) < 30000 // 30秒以内
    );

    if (sameUrlVisits.length > 0) {
      const closestVisit = sameUrlVisits.reduce((closest, current) =>
        Math.abs(current.visitTime - visit.visitTime) <
        Math.abs(closest.visitTime - visit.visitTime) ? current : closest
      );

      const timeDiff = Math.abs(closestVisit.visitTime - visit.visitTime);
      const confidence = Math.max(0.4, 1 - (timeDiff / 30000));

      return {
        parent: closestVisit,
        confidence: confidence,
        timeDiff: timeDiff,
        patternType: 'same_url_revisit'
      };
    }

    // 遷移タイプベースのパターン検出
    if (visit.transition) {
      const transitionScores = {
        'reload': 0.8,          // リロードは高い関連性
        'auto_bookmark': 0.6,   // ブックマークからは中程度
        'typed': 0.4,           // 直接入力は低め
        'form_submit': 0.7      // フォーム送信は高め
      };

      const score = transitionScores[visit.transition];
      if (score) {
        // 直前の訪問を親候補として検索
        const recentVisits = Array.from(visitMap.values()).filter(candidate =>
          candidate.visitTime < visit.visitTime &&
          candidate.visitTime > visit.visitTime - 60000 && // 1分以内
          candidate.visitId !== visit.visitId
        );

        if (recentVisits.length > 0) {
          const mostRecent = recentVisits.reduce((recent, current) =>
            current.visitTime > recent.visitTime ? current : recent
          );

          return {
            parent: mostRecent,
            confidence: score,
            patternType: `transition_${visit.transition}`
          };
        }
      }
    }

    return null;
  }

  // Beta関係の統計情報を作成
  summarizeBetaRelations(betaRelations) {
    const summary = {};
    for (const rel of betaRelations) {
      const type = rel.relation.type;
      if (!summary[type]) {
        summary[type] = 0;
      }
      summary[type]++;
    }
    return summary;
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

    // 孤立したノード（親も子も持たない）に対してURL階層分析を適用
    const orphanUrls = rootUrls.filter(url => parentToChildren.get(url).length === 0);

    // さらに、全てのルートノード間でもURL階層分析を適用してツリー合体を検討
    console.log(`全ルートノード ${rootUrls.length} 個に対してURL階層分析を実行...`);
    console.log(`うち孤立ノード: ${orphanUrls.length} 個`);

    if (rootUrls.length > 1) {
      // URL階層から親子関係を推定（全ルートノードを対象）
      const inferredRelations = this.inferParentFromURL(rootUrls, urlVisitMap);

      // 推定された関係を適用（スコアの高い順、より多くの関係を検討）
      for (const relation of inferredRelations.slice(0, Math.min(25, inferredRelations.length))) {
        const { parent: parentUrl, child: childUrl, score } = relation;

        // 循環参照チェック
        if (!this.wouldCreateCycle(parentUrl, childUrl, childToParent)) {
          const currentParent = childToParent.get(childUrl);

          // 以下の場合に親子関係を設定/更新：
          // 1. 子が現在親を持っていない場合
          // 2. より高いスコアの関係が見つかった場合（スコア50以上なら適用を検討）
          // 3. 確実な階層関係（スコア800以上）なら強制適用
          let shouldApply = false;
          let reason = '';

          if (!currentParent) {
            shouldApply = true;
            reason = '現在親なし';
          } else if (score >= 800) {
            // ルートページなどの確実な階層関係は既存関係を上書き
            shouldApply = true;
            reason = `確実な階層関係(${score})で既存関係を上書き`;
          } else if (score >= 100) {
            // かなり良いスコアの場合も上書きを検討
            shouldApply = true;
            reason = `高スコア(${score})で既存関係を上書き`;
          } else if (score >= 50) {
            // 中程度のスコアでも、孤立ノード同士なら積極的に合体
            const parentHasNoChildren = parentToChildren.get(parentUrl).length === 0;
            const childIsOrphan = orphanUrls.includes(childUrl);

            if (parentHasNoChildren || childIsOrphan) {
              shouldApply = true;
              reason = `中スコア(${score})で孤立ノード同士を合体`;
            }
          }

          if (shouldApply) {
            // 既存の親子関係を削除（存在する場合）
            if (currentParent) {
              const currentParentChildren = parentToChildren.get(currentParent);
              const index = currentParentChildren.indexOf(childUrl);
              if (index > -1) {
                currentParentChildren.splice(index, 1);
                // 元の親ノードからも子を削除
                const oldParentNode = nodes.get(currentParent);
                if (oldParentNode) {
                  const childIndex = oldParentNode.children.findIndex(child => child.url === childUrl);
                  if (childIndex > -1) {
                    oldParentNode.children.splice(childIndex, 1);
                  }
                }
              }
            }

            // 新しい親子関係を設定
            childToParent.set(childUrl, parentUrl);
            parentToChildren.get(parentUrl).push(childUrl);

            // ノードの子要素を更新
            const parentNode = nodes.get(parentUrl);
            const childNode = nodes.get(childUrl);
            if (parentNode && childNode) {
              parentNode.children.push(childNode);
              console.log(`URL階層分析により ${parentUrl} → ${childUrl} の関係を追加 (${reason})`);
            }
          }
        }
      }
    }

    // 親子関係の逆転チェック - 子の方が親として適切な場合は関係を逆転
    console.log('\n=== 親子関係の逆転チェックを実行 ===');
    const relationsToReverse = [];

    for (const [childUrl, parentUrl] of childToParent) {
      const childInfo = urlVisitMap.get(childUrl);
      const parentInfo = urlVisitMap.get(parentUrl);

      if (childInfo && parentInfo) {
        const shouldReverse = this.shouldReverseParentChild(childUrl, parentUrl, urlVisitMap);
        if (shouldReverse) {
          relationsToReverse.push({ currentChild: childUrl, currentParent: parentUrl });
          console.log(`関係逆転候補: ${childUrl} が ${parentUrl} より適切な親`);
        }
      }
    }

    // 逆転を実行
    for (const { currentChild, currentParent } of relationsToReverse) {
      // 循環参照を避けるため、逆転後に問題がないかチェック
      if (!this.wouldCreateCycleAfterReverse(currentChild, currentParent, childToParent)) {
        this.reverseParentChildRelation(currentChild, currentParent, childToParent, parentToChildren, nodes);
        console.log(`関係を逆転: ${currentChild} → ${currentParent}`);
      } else {
        console.log(`循環参照のため逆転をスキップ: ${currentChild} ↔ ${currentParent}`);
      }
    }

    // 最終的なルートノードを取得
    const finalRootUrls = Array.from(nodes.keys()).filter(url => !childToParent.has(url));
    const rootNodes = finalRootUrls
      .map(url => nodes.get(url))
      .sort((a, b) => b.visitTime - a.visitTime); // 時間順（新しい順）

    console.log(`集計モード: ${nodes.size}個のURL、${finalRootUrls.length}個のルートノード`);

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

  // URLの階層構造から親子関係を推定（孤立ノード用）
  inferParentFromURL(orphanNodes, urlVisitMap) {
    const urlHierarchy = new Map();

    // 各URLを解析してパス階層を構築
    for (const [url, urlInfo] of urlVisitMap) {
      try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/').filter(part => part.length > 0);
        const domain = urlObj.hostname;

        urlHierarchy.set(url, {
          domain: domain,
          pathParts: pathParts,
          depth: pathParts.length,
          url: url,
          urlInfo: urlInfo
        });
      } catch (error) {
        // 無効なURLの場合はスキップ
        continue;
      }
    }

    // 孤立ノードに対して階層的な親を見つける
    const newRelations = [];

    for (const orphanUrl of orphanNodes) {
      const orphan = urlHierarchy.get(orphanUrl);
      if (!orphan) continue;

      console.log(`\n=== 孤立ノードの親を検索: ${orphanUrl} ===`);
      console.log(`ドメイン: ${orphan.domain}, パス: [${orphan.pathParts.join(', ')}], 深さ: ${orphan.depth}`);

      let bestParent = null;
      let bestScore = -1;

      // 他のURLと比較して最適な親を見つける
      for (const [candidateUrl, candidate] of urlHierarchy) {
        if (candidateUrl === orphanUrl) continue;

        const score = this.calculateParentScore(orphan, candidate);
        if (score > 0) {
          console.log(`  候補: ${candidateUrl} -> スコア: ${score}`);
          console.log(`    パス: [${candidate.pathParts.join(', ')}], 深さ: ${candidate.depth}`);
        }

        if (score > bestScore) {
          bestScore = score;
          bestParent = candidate;
        }
      }

      console.log(`  最適な親: ${bestParent ? bestParent.url : 'なし'} (スコア: ${bestScore})`);

      // 確実な階層関係または十分なスコアがあれば親子関係を追加
      // 確実な階層関係の場合はスコア1000以上として判定
      if (bestParent && (bestScore >= 1000 || bestScore > 0)) {
        newRelations.push({
          parent: bestParent.url,
          child: orphanUrl,
          score: bestScore,
          type: bestScore >= 1000 ? 'url_hierarchy_certain' : 'url_hierarchy'
        });
      }
    }

    // スコア順にソートして返す
    return newRelations.sort((a, b) => b.score - a.score);
  }

  // URLの親子関係スコアを計算
  calculateParentScore(child, parent) {
    // 同じドメインでない場合は0
    if (child.domain !== parent.domain) {
      return 0;
    }

    // 子の方が浅い場合は0
    if (child.depth <= parent.depth) {
      return 0;
    }

    let score = 0;

    // パス接頭辞の一致度をチェック
    const matchingParts = this.countMatchingPathParts(parent.pathParts, child.pathParts);

    if (matchingParts === parent.pathParts.length && matchingParts > 0) {
      // 完全なパス接頭辞マッチ - 確実な階層関係
      score += 1000; // 確実性を示す高いスコア

      // 深さの差が小さいほど高スコア（直接の親子関係を優先）
      const depthDiff = child.depth - parent.depth;
      score += Math.max(0, 100 - depthDiff * 5);

      // 特定のパターンにボーナス
      score += this.getUrlPatternBonus(parent.pathParts, child.pathParts);

      console.log(`    確実な階層関係: ${parent.url} -> ${child.url} (スコア: ${score})`);
    } else if (parent.pathParts.length === 0) {
      // ルートページ（/）は同じドメインの全てのページの確実な親
      score += 800; // 非常に高いスコアでルートページを親として優先
      console.log(`    ルートページ親候補 (スコア: ${score})`);
    } else if (matchingParts > 0) {
      // 部分的なパス一致
      score += matchingParts * 20;
      console.log(`    部分的パス一致: ${matchingParts}個の共通パス (スコア: ${score})`);
    } else {
      // 同じドメインで階層が浅い場合、潜在的な親として考慮
      const depthDiff = child.depth - parent.depth;
      if (depthDiff <= 3) { // 深さの差を3以下に緩和
        score += Math.max(0, 60 - depthDiff * 10); // ベーススコアを60に大幅増加
        console.log(`    同じドメインの浅い階層 (深さ差: ${depthDiff}, スコア: ${score})`);

        // 特に親が浅い場合はさらにボーナス
        if (parent.depth <= 1) {
          score += 20; // 親が浅い場合のボーナス
          console.log(`    浅い親へのボーナス (+20, 総スコア: ${score})`);
        }
      }
    }

    return score;
  }

  // パス部分の一致数を数える
  countMatchingPathParts(parentParts, childParts) {
    let matches = 0;
    const minLength = Math.min(parentParts.length, childParts.length);

    for (let i = 0; i < minLength; i++) {
      if (parentParts[i] === childParts[i]) {
        matches++;
      } else {
        break; // 接頭辞でなくなったら終了
      }
    }

    return matches;
  }

  // URLパターンに基づくボーナススコア
  getUrlPatternBonus(parentParts, childParts) {
    let bonus = 0;

    // よくあるパターンにボーナスを付与
    if (parentParts.length > 0) {
      const parentLast = parentParts[parentParts.length - 1].toLowerCase();

      // カテゴリ系のパターン
      if (['category', 'categories', 'tag', 'tags', 'section'].includes(parentLast)) {
        bonus += 20;
      }

      // 商品・記事系のパターン
      if (['products', 'items', 'posts', 'articles', 'blog'].includes(parentLast)) {
        bonus += 20;
      }

      // ユーザー系のパターン
      if (['user', 'users', 'profile', 'account'].includes(parentLast)) {
        bonus += 15;
      }
    }

    // 数値IDパターン（詳細ページ）
    if (childParts.length > 0) {
      const childLast = childParts[childParts.length - 1];
      if (/^\d+$/.test(childLast) || /^[a-f0-9-]{8,}/.test(childLast)) {
        bonus += 25; // ID的なものは詳細ページの可能性が高い
      }
    }

    return bonus;
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
    } else if (this.viewMode === 'beta') {
      // Betaモード：高度なナビゲーション解析を使用したツリー構築
      const betaData = this.buildBetaTree();

      if (!this.currentSearchTerm) {
        dataToRender = betaData;
      } else {
        dataToRender = this.filterTree(betaData, this.currentSearchTerm);
      }
    } else {
      // 時系列モード：連続する同じアイテムをまとめて表示
      let chronologicalData = this.filteredData;

      // 連続する同じアイテムをまとめる
      chronologicalData = this.mergeConsecutiveSameItems(chronologicalData);

      if (!this.currentSearchTerm) {
        dataToRender = chronologicalData;
      } else {
        dataToRender = this.filterTree(chronologicalData, this.currentSearchTerm);
      }
    }

    // データをそのまま表示（ページネーションは時間範囲で行う）
    this.renderTree(dataToRender);
    this.updatePageInputs();
    this.updateSearchRange();
  }  // 時系列モードで連続する同じアイテムをまとめる
  mergeConsecutiveSameItems(nodes) {
    if (!nodes || nodes.length === 0) return nodes;

    const merged = [];
    let currentGroup = null;

    for (const node of nodes) {
      // 親子関係がない（ルートレベル）かつ子要素を持たないノードのみ対象
      if (node.children.length === 0) {
        if (currentGroup && this.isSameItem(currentGroup.node, node)) {
          // 同じアイテムの場合、グループに追加
          currentGroup.visits.push(node);
          currentGroup.visitCount++;
          // 最新の訪問時間を保持
          if (node.visitTime > currentGroup.node.visitTime) {
            currentGroup.node.visitTime = node.visitTime;
          }
        } else {
          // 異なるアイテムの場合、前のグループを確定して新しいグループを開始
          if (currentGroup) {
            merged.push(this.createMergedNode(currentGroup));
          }
          currentGroup = {
            node: { ...node },
            visits: [node],
            visitCount: 1
          };
        }
      } else {
        // 子要素を持つノードの場合、前のグループを確定して個別に追加
        if (currentGroup) {
          merged.push(this.createMergedNode(currentGroup));
          currentGroup = null;
        }

        // 子要素に対しても再帰的に処理
        const mergedChildren = this.mergeConsecutiveSameItems(node.children);
        merged.push({
          ...node,
          children: mergedChildren
        });
      }
    }

    // 最後のグループを追加
    if (currentGroup) {
      merged.push(this.createMergedNode(currentGroup));
    }

    return merged;
  }

  // 2つのアイテムが同じかどうかを判定（URLとタイトルで比較）
  isSameItem(item1, item2) {
    return item1.url === item2.url && item1.title === item2.title;
  }

  // マージされたノードを作成
  createMergedNode(group) {
    const node = { ...group.node };

    // 複数の訪問がある場合は、マージ情報を追加
    if (group.visitCount > 1) {
      node.isMerged = true;
      node.mergedVisitCount = group.visitCount;
      node.allVisits = group.visits;

      // 最初と最後の訪問時間を記録
      const sortedVisits = group.visits.sort((a, b) => a.visitTime - b.visitTime);
      node.firstVisitTime = sortedVisits[0].visitTime;
      node.lastVisitTime = sortedVisits[sortedVisits.length - 1].visitTime;
    }

    return node;
  }

  filterTree(nodes, searchTerm) {
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

    // モードに応じてタイトル表示を調整
    if (this.viewMode === 'aggregated' && node.visitCount > 1) {
      titleLink.textContent = `${node.title} (${node.visitCount}回)`;
    } else if (this.viewMode === 'chronological' && node.isMerged && node.mergedVisitCount > 1) {
      // 時系列モードでマージされたアイテムの場合、訪問回数を表示
      titleLink.textContent = `${node.title} (${node.mergedVisitCount}回)`;
    } else if (this.viewMode === 'beta' && node.isGeneratedRoot) {
      // Betaモードで生成されたルートドメインの場合、特別なマークを表示
      titleLink.textContent = `${node.title} 🌐`;
    } else {
      titleLink.textContent = node.title;
    }

    // 特殊な遷移タイプに応じてアイコンを追加（Betaモードのみ）
    if (this.viewMode === 'beta' && node.transition) {
      const transitionIcon = this.getTransitionIcon(node.transition);
      if (transitionIcon) {
        const iconSpan = document.createElement('span');
        iconSpan.className = 'transition-icon';
        iconSpan.textContent = transitionIcon;
        iconSpan.title = this.getTransitionDescription(node.transition);
        iconSpan.style.marginLeft = '8px';
        iconSpan.style.fontSize = '12px';
        iconSpan.style.opacity = '0.7';
        titleLink.appendChild(iconSpan);
      }
    }

    // Beta関係の表示
    if (this.viewMode === 'beta' && node.betaRelations && node.betaRelations.length > 0) {
      const betaInfo = this.createBetaRelationInfo(node.betaRelations);
      if (betaInfo) {
        titleLink.appendChild(betaInfo);
      }
    }

    titleLink.target = '_blank';
    header.appendChild(titleLink);

    li.appendChild(header);

    // マージされたアイテムの詳細情報表示（時系列モードのみ）
    if (this.viewMode === 'chronological' && node.isMerged && node.mergedVisitCount > 1) {
      const mergedInfoDiv = document.createElement('div');
      mergedInfoDiv.className = 'merged-info';
      mergedInfoDiv.style.fontSize = '12px';
      mergedInfoDiv.style.color = '#666';
      mergedInfoDiv.style.marginLeft = '32px'; // アイコン分のマージン
      mergedInfoDiv.style.marginTop = '2px';

      const firstTime = new Date(node.firstVisitTime);
      const lastTime = new Date(node.lastVisitTime);
      const timeRange = node.firstVisitTime !== node.lastVisitTime
        ? `${this.formatTime(firstTime)} ～ ${this.formatTime(lastTime)}`
        : this.formatTime(lastTime);

      mergedInfoDiv.textContent = `${node.mergedVisitCount}回の訪問: ${timeRange}`;
      li.appendChild(mergedInfoDiv);
    }

    // 生成されたルートドメインの説明表示（Betaモードのみ）- 削除
    /*
    if (this.viewMode === 'beta' && node.isGeneratedRoot) {
      const rootInfoDiv = document.createElement('div');
      rootInfoDiv.className = 'generated-root-info';
      rootInfoDiv.style.fontSize = '12px';
      rootInfoDiv.style.color = '#28a745';
      rootInfoDiv.style.marginLeft = '32px'; // アイコン分のマージン
      rootInfoDiv.style.marginTop = '2px';
      rootInfoDiv.style.fontStyle = 'italic';
      
      rootInfoDiv.textContent = '';
      // li.appendChild(rootInfoDiv); // 説明文言を削除するためコメントアウト
    }
    */    // URL表示
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

  // 遷移タイプに応じたアイコンを取得
  getTransitionIcon(transition) {
    const iconMap = {
      'typed': '⌨️',          // 直接入力
      'auto_bookmark': '🔖',   // ブックマーク
      'generated': '🔍',       // 検索結果
      'reload': '🔄',          // リロード
      'form_submit': '📝',     // フォーム送信
      'keyword': '🔑',         // キーワード
      'auto_toplevel': '🏠',   // スタートページ
      'manual_subframe': '🖼️', // サブフレーム
      'auto_subframe': '📦'    // 自動サブフレーム
    };
    return iconMap[transition] || null;
  }

  // 遷移タイプの説明を取得
  getTransitionDescription(transition) {
    const descriptionMap = {
      'link': 'リンクをクリック',
      'typed': 'アドレスバーに直接入力',
      'auto_bookmark': 'ブックマークまたは候補から選択',
      'generated': '検索候補から選択',
      'reload': 'ページをリロード',
      'form_submit': 'フォームを送信',
      'keyword': 'キーワード検索',
      'auto_toplevel': 'スタートページ',
      'manual_subframe': 'サブフレームで選択',
      'auto_subframe': '自動サブフレーム'
    };
    return descriptionMap[transition] || `遷移: ${transition}`;
  }

  // Beta関係情報を作成
  createBetaRelationInfo(betaRelations) {
    if (!betaRelations || betaRelations.length === 0) return null;

    const relationContainer = document.createElement('span');
    relationContainer.className = 'beta-relations';
    relationContainer.style.marginLeft = '8px';
    relationContainer.style.fontSize = '11px';

    for (const relation of betaRelations) {
      const relationBadge = document.createElement('span');
      relationBadge.className = 'beta-relation-badge';
      relationBadge.style.display = 'inline-block';
      relationBadge.style.marginLeft = '4px';
      relationBadge.style.padding = '1px 4px';
      relationBadge.style.borderRadius = '3px';
      relationBadge.style.fontSize = '10px';
      relationBadge.style.fontWeight = 'bold';

      const { icon, text, color } = this.getBetaRelationDisplay(relation);

      relationBadge.textContent = `${icon} ${text}`;
      relationBadge.style.backgroundColor = color;
      relationBadge.style.color = '#fff';
      relationBadge.title = this.getBetaRelationTooltip(relation);

      relationContainer.appendChild(relationBadge);
    }

    return relationContainer;
  }

  // Beta関係の表示情報を取得
  getBetaRelationDisplay(relation) {
    const displays = {
      'referring_visit': { icon: '🔗', text: '参照', color: '#28a745' },
      'new_tab': { icon: '🆕', text: '新タブ', color: '#007bff' },
      'back_navigation': { icon: '⬅️', text: '戻る', color: '#ffc107' },
      'hierarchy_navigation': { icon: '📂', text: '階層', color: '#6f42c1' },
      'time_based_pattern': { icon: '⏱️', text: '時系列', color: '#fd7e14' },
      'generated_root_domain': { icon: '🌐', text: 'ルート', color: '#28a745' }
    };

    const display = displays[relation.type] || { icon: '❓', text: '不明', color: '#6c757d' };

    // 信頼度に応じて色の透明度を調整
    const confidence = relation.confidence || 0;
    const alpha = Math.max(0.6, confidence);

    return {
      ...display,
      color: this.adjustColorAlpha(display.color, alpha)
    };
  }

  // Beta関係のツールチップを作成
  getBetaRelationTooltip(relation) {
    const baseTooltip = `関係タイプ: ${relation.type}\n信頼度: ${((relation.confidence || 0) * 100).toFixed(1)}%`;

    switch (relation.type) {
      case 'new_tab':
        return `${baseTooltip}\n新しいタブで開かれた関係`;
      case 'back_navigation':
        return `${baseTooltip}\nブラウザの戻るボタンによる移動`;
      case 'hierarchy_navigation':
        const hierarchyType = relation.details?.relationType === 'hierarchy_up' ? '上位階層へ' : '下位階層へ';
        return `${baseTooltip}\n${hierarchyType}の階層移動`;
      case 'time_based_pattern':
        return `${baseTooltip}\n短時間での関連パターン`;
      case 'generated_root_domain':
        return `${baseTooltip}\n自動生成されたルートドメインへの関連付け`;
      default:
        return baseTooltip;
    }
  }

  // 色の透明度を調整
  adjustColorAlpha(hexColor, alpha) {
    // 簡単な実装：透明度に応じて色を暗くする
    const darkening = 1 - ((1 - alpha) * 0.5);
    const r = parseInt(hexColor.slice(1, 3), 16) * darkening;
    const g = parseInt(hexColor.slice(3, 5), 16) * darkening;
    const b = parseInt(hexColor.slice(5, 7), 16) * darkening;

    return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
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

  // 親子関係を逆転すべきかを判定
  shouldReverseParentChild(currentChildUrl, currentParentUrl, urlVisitMap) {
    try {
      const childInfo = urlVisitMap.get(currentChildUrl);
      const parentInfo = urlVisitMap.get(currentParentUrl);

      const childUrl = new URL(currentChildUrl);
      const parentUrl = new URL(currentParentUrl);

      // ドメインが違う場合は逆転しない
      if (childUrl.hostname !== parentUrl.hostname) {
        return false;
      }

      const childParts = childUrl.pathname.split('/').filter(part => part.length > 0);
      const parentParts = parentUrl.pathname.split('/').filter(part => part.length > 0);

      // 子の方が階層が浅い場合（より一般的）は逆転候補
      if (childParts.length < parentParts.length) {
        console.log(`    ${currentChildUrl} (深さ${childParts.length}) < ${currentParentUrl} (深さ${parentParts.length})`);
        return true;
      }

      // 深さが同じで、子がルートページ系の場合
      if (childParts.length === parentParts.length) {
        const childLast = childParts[childParts.length - 1]?.toLowerCase() || '';
        const parentLast = parentParts[parentParts.length - 1]?.toLowerCase() || '';

        // 子がより汎用的なページ名の場合
        const genericPages = ['index', 'home', 'main', 'top', 'root'];
        if (genericPages.includes(childLast) && !genericPages.includes(parentLast)) {
          console.log(`    ${currentChildUrl} は汎用的ページ (${childLast})`);
          return true;
        }
      }

      // 子がルートページ（/）の場合
      if (childParts.length === 0 && parentParts.length > 0) {
        console.log(`    ${currentChildUrl} はルートページ`);
        return true;
      }

      return false;
    } catch (error) {
      console.error('親子逆転判定エラー:', error);
      return false;
    }
  }

  // 親子関係逆転後に循環参照が起きないかチェック
  wouldCreateCycleAfterReverse(newParent, newChild, childToParent) {
    // newChildが既に他の親を持つ場合、その親がnewParentの祖先でないかチェック
    let current = childToParent.get(newChild);
    const visited = new Set([newParent]); // 新しい親は既に訪問済みとして扱う

    while (current && !visited.has(current)) {
      if (current === newParent) {
        return true; // 循環参照が発生
      }
      visited.add(current);
      current = childToParent.get(current);
    }

    return false;
  }

  // 親子関係を逆転する
  reverseParentChildRelation(newParentUrl, newChildUrl, childToParent, parentToChildren, nodes) {
    // 現在の関係を削除
    childToParent.delete(newChildUrl);
    const currentParentChildren = parentToChildren.get(newParentUrl);
    const childIndex = currentParentChildren.indexOf(newChildUrl);
    if (childIndex > -1) {
      currentParentChildren.splice(childIndex, 1);
    }

    // 新しい関係を設定
    childToParent.set(newChildUrl, newParentUrl);
    parentToChildren.get(newParentUrl).push(newChildUrl);

    // ノードの子要素も更新
    const newParentNode = nodes.get(newParentUrl);
    const newChildNode = nodes.get(newChildUrl);

    if (newParentNode && newChildNode) {
      // 旧親から子を削除
      const oldChildIndex = newParentNode.children.findIndex(child => child.url === newChildUrl);
      if (oldChildIndex > -1) {
        newParentNode.children.splice(oldChildIndex, 1);
      }

      // 新親に子を追加
      newChildNode.children.push(newParentNode);
    }
  }
}

// 初期化
document.addEventListener('DOMContentLoaded', () => {
  const historyManager = new HistoryManager();
  historyManager.loadHistoryForCurrentPage();
});
