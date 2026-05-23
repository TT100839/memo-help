const isWindowMode =
  new URLSearchParams(window.location.search).has("mode") ||
  window.location.pathname.endsWith("mobile.html");
const isMobileMode = window.location.pathname.endsWith("mobile.html");
const CHUNK_SIZE = 16 * 1024; // 64KB（安定して最速を出せるサイズ）
const MAX_BUFFER = 256 * 1024; // 1MB（これ以上溜まったら送信を一時停止）
let incomingFile = [];
let incomingFileInfo = null;

// ファイルを限界速度で送信するコア関数
// 【修正】sendFileAtMaxSpeed を以下に差し替えてください
// 【修正】sendFileAtMaxSpeed を以下に差し替えてください
async function sendFileAtMaxSpeed(file, tag, fileName) {
  if (!syncDataChannel || syncDataChannel.readyState !== "open") return;
  
  // スマホの受信限界を超えないようバッファしきい値を小さく設定
  syncDataChannel.bufferedAmountLowThreshold = 32 * 1024;
  
  syncDataChannel.send(
    JSON.stringify({
      type: "file_start",
      name: fileName || file.name,
      tag: tag,
      size: file.size,
      mimeType: file.type,
    }),
  );

  const arrayBuffer = await file.arrayBuffer();
  let offset = 0;

  // チャンク送信を意図的にペースダウンしてパケットロスと受信側のフリーズを防ぐ
  const sendChunk = async () => {
    while (offset < arrayBuffer.byteLength) {
      if (syncDataChannel.bufferedAmount > 64 * 1024) {
        await new Promise((resolve) => {
          syncDataChannel.onbufferedamountlow = () => {
            syncDataChannel.onbufferedamountlow = null;
            resolve();
          };
        });
      }
      const chunk = arrayBuffer.slice(offset, offset + 16 * 1024);
      syncDataChannel.send(chunk);
      offset += 16 * 1024;
      
      // スマホのブラウザが処理を追いつけるように5ミリ秒だけ休む（パケットロス対策）
      await new Promise(r => setTimeout(r, 5));
    }
  };

  await sendChunk();
  syncDataChannel.send(JSON.stringify({ type: "file_end" }));
}
if (typeof chrome === "undefined" || !chrome.storage) {
  window.chrome = {
    storage: {
      local: { get: (k, cb) => cb({}), set: () => {} },
      onChanged: { addListener: () => {} },
    },
    windows: { getLastFocused: () => {}, create: () => {} },
    tabs: { query: () => {}, create: (o) => window.open(o.url, "_blank") },
    runtime: { getURL: (p) => p },
  };
}

// handleSyncMessage関数を拡張してバイナリとメタデータを処理
function handleSyncMessage(event) {
  // バイナリデータ（ファイルのチャンク）が届いた場合
  if (event.data instanceof ArrayBuffer) {
    incomingFile.push(event.data);
    
    // 【追記】受信進捗を背景テキストとして表示（止まっていないか可視化する）
    if (incomingFileInfo && incomingFileInfo.size > 0) {
      const received = incomingFile.length * (16 * 1024);
      const percent = Math.min(100, Math.floor((received / incomingFileInfo.size) * 100));
      els.memoArea.placeholder = `[${incomingFileInfo.name}] を受信中... ${percent}%`;
    }
    return;
  }

  try {
    const data = JSON.parse(event.data);

    // ファイル送信開始の合図
    if (data.type === "file_start") {
      incomingFileInfo = data;
      incomingFile = [];
      els.memoArea.placeholder = `[${data.name}] の受信を開始... 0%`;
      return;
    }

    // ファイル送信完了の合図（受け取ったデータをDBに保存する）
    if (data.type === "file_end" && incomingFileInfo) {
      els.memoArea.placeholder = `ファイルを構築・保存中...`;
      const blob = new Blob(incomingFile, { type: incomingFileInfo.mimeType });
      
      if (db) {
        const tx = db.transaction("files", "readwrite");
        tx.objectStore("files").put(blob, incomingFileInfo.tag);
        
        tx.oncomplete = () => {
          els.memoArea.placeholder = ""; // 完了したら文字を消す
          updateFiles(); // UIを更新して欄に表示させる
        };
        tx.onerror = (e) => {
          els.memoArea.placeholder = "保存エラー: スマホの容量制限等により失敗しました";
          console.error("DB Save Error:", e);
        };
      }
      
      incomingFile = [];
      incomingFileInfo = null;
      return;
    }
    // 【修正】data.tabs が存在し、かつ1個以上タブがある場合のみ同期を許可する
    if (data.type === "sync_state" && data.tabs && data.tabs.length > 0) {
      state.tabs = data.tabs;
      state.activeTabId = data.activeTabId;

      const t = state.tabs.find((t) => t.id === state.activeTabId);
      if (els.memoArea.value !== (t ? t.text : "")) {
        els.memoArea.value = t ? t.text : "";
      }

      if (data.searchVisible !== undefined) {
        els.searchContainer.style.display = data.searchVisible
          ? "flex"
          : "none";
      }
      if (
        data.searchValue !== undefined &&
        els.searchInput.value !== data.searchValue
      ) {
        els.searchInput.value = data.searchValue;
      }

      renderTabs();
      updateVisuals();
      if (!window.location.pathname.endsWith("mobile.html")) {
        chrome.storage.local.set({
          tabs: state.tabs,
          activeTabId: state.activeTabId,
        });
      }
    }
  } catch (e) {}
}
const els = {
  memoArea: document.getElementById("memo-area"),
  tabContainer: document.getElementById("tab-container"),
  linksArea: document.getElementById("links-area"),
  filesArea: document.getElementById("files-area"),
  addTabBtn: document.getElementById("add-tab-btn"),
  removeTabBtn: document.getElementById("remove-tab-btn"),
  timeBtn: document.getElementById("time-btn"),
  urlBtn: document.getElementById("url-btn"),
  fileBtn: document.getElementById("file-btn"),
  modeSwitchBtn: document.getElementById("mode-switch-btn"),
  undoBtn: document.getElementById("undo-btn"),
  redoBtn: document.getElementById("redo-btn"),
  exportBtn: document.getElementById("export-btn"),
  header: document.getElementById("header"),
  charCount: document.getElementById("char-count"),
  searchBtn: document.getElementById("search-btn"),
  searchContainer: document.getElementById("search-container"),
  searchInput: document.getElementById("search-input"),
  searchNextBtn: document.getElementById("search-next-btn"),
  searchPrevBtn: document.getElementById("search-prev-btn"),
  searchCloseBtn: document.getElementById("search-close-btn"),
  backdrop: document.getElementById("backdrop"),
  contextMenu: document.getElementById("tab-context-menu"),
  menuDuplicate: document.getElementById("menu-duplicate-tab"),
  menuAddRight: document.getElementById("menu-add-tab-right"),
  menuRemove: document.getElementById("menu-remove-tab"),
  helpBtn: document.getElementById("help-btn"),
};

const state = {
  tabs: [],
  activeTabId: null,
  history: [],
  redo: [],
  deleted: [],
  searchIdx: -1,
  timer: null,
  dragging: false,
  startX: 0,
  startY: 0,
  mWidth: "500px",
  mHeight: "300px",
  wWidth: 420,
  wHeight: 550,
  contextTargetId: null,
  targetTabId: null,
};
let db;
let syncDataChannel = null;
let syncPeerConnection = null;

const incomingFiles = {};
const initDB = () => {
  const req = indexedDB.open("MemoFilesDB", 1);
  req.onupgradeneeded = (e) => {
    db = e.target.result;
    if (!db.objectStoreNames.contains("files")) {
      db.createObjectStore("files");
    }
  };
  req.onsuccess = (e) => {
    db = e.target.result;
    updateFiles();
  };
};
function getUniqueFileTag(fileName) {
  let nameWithoutExt = fileName;
  let ext = "";
  const lastDotIdx = fileName.lastIndexOf(".");
  if (lastDotIdx > 0) {
    nameWithoutExt = fileName.substring(0, lastDotIdx);
    ext = fileName.substring(lastDotIdx);
  }
  let tag = `[${fileName}](file)`;
  let counter = 1;
  const allText = state.tabs.map((t) => t.text).join("");

  while (allText.includes(tag)) {
    tag = `[${nameWithoutExt} (${counter})${ext}](file)`;
    counter++;
  }
  return tag;
}
function init() {
  initDB();
  els.memoArea.placeholder = "";
  chrome.storage.local.get(
    [
      "tabs",
      "activeTabId",
      "memoWidth",
      "memoHeight",
      "windowWidth",
      "windowHeight",
    ],
    (res) => {
      state.tabs = res.tabs?.length ? res.tabs : [{ id: Date.now(), text: "" }];
      Object.assign(state, {
        activeTabId: res.activeTabId || state.activeTabId,
        wWidth: res.windowWidth || state.wWidth,
        wHeight: res.windowHeight || state.wHeight,
        mWidth: res.memoWidth || state.mWidth,
        mHeight: res.memoHeight || state.mHeight,
      });

      applyModeLayout();

      if (!state.tabs.some((t) => t.id === state.activeTabId)) {
        state.activeTabId = state.tabs[0].id;
      }
      switchTab(state.activeTabId);
      updateUndoRedo();
    },
  );
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.tabs) {
      state.tabs = changes.tabs.newValue || [];
      const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
      if (currentTab && els.memoArea.value !== currentTab.text) {
        els.memoArea.value = currentTab.text;
        updateVisuals();
      }
      renderTabs();
    }
  });
}

function applyModeLayout() {
  if (isWindowMode) {
    els.modeSwitchBtn.style.display = "none";
    els.memoArea.style.resize = "none";
    document.body.style.width = "100%";
    document.body.style.height = "100vh";
    els.memoArea.style.maxWidth = "none";

    const container = document.getElementById("memo-container");
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.flexGrow = "1";

    els.memoArea.style.flexGrow = "1";
    els.memoArea.style.height = "auto";
    els.memoArea.style.maxHeight = "none";
    els.tabContainer.parentElement.style.width = "100%";
  } else {
    els.modeSwitchBtn.style.display = "flex";

    els.memoArea.style.width = state.mWidth;
    els.memoArea.style.height = state.mHeight;
    els.memoArea.style.maxHeight = "480px";
    els.tabContainer.parentElement.style.width = els.memoArea.style.width;
  }
}

function saveToStorage() {
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      memoWidth: state.mWidth,
      memoHeight: state.mHeight,
      windowWidth: state.wWidth,
      windowHeight: state.wHeight,
    });
  }
  if (syncDataChannel?.readyState === "open") {
    syncDataChannel.send(
      JSON.stringify({
        type: "sync_state",
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        searchVisible: els.searchContainer.style.display === "flex",
        searchValue: els.searchInput.value,
      }),
    );
  }
}

function updateVisuals() {
  updateLinks();
  updateCharCount();
  updateFiles();
}

function updateUI() {
  updateVisuals();
  saveToStorage();
}

function updateLinks() {
  els.linksArea.innerHTML = "";
  const urls = els.memoArea.value.match(/https?:\/\/[^\s)]+/g) || [];

  if (!urls.length) {
    els.linksArea.style.display = "none";
    return;
  }

  els.linksArea.style.display = "flex";
  const label = document.createElement("div");
  label.className = "links-label";
  label.textContent = "links";
  els.linksArea.appendChild(label);

  urls.forEach((url) => {
    const a = document.createElement("a");
    Object.assign(a, { href: url, target: "_blank", title: url });

    let displayStr = url;
    try {
      displayStr = new URL(url).hostname;
    } catch (e) {}

    a.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" class="link-icon">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
      </svg>
      <span class="link-text"></span>
    `;
    a.querySelector(".link-text").textContent = displayStr;
    els.linksArea.appendChild(a);
  });
}
// 【修正】updateFiles 関数を以下に丸ごと差し替えてください
function updateFiles() {
  if (!els.filesArea || !db) return;

  const tx = db.transaction("files", "readonly");
  const req = tx.objectStore("files").getAllKeys();

  req.onsuccess = () => {
    // メモリリーク防止：前回のBlob URLを破棄してスマホの動作を軽くする
    if (els.filesArea._blobUrls) {
      els.filesArea._blobUrls.forEach((url) => URL.revokeObjectURL(url));
    }
    els.filesArea._blobUrls = [];

    els.filesArea.innerHTML = "";
    const keys = req.result;
    const currentText = els.memoArea.value;

    // 現在のテキスト内に存在するファイルタグのみを抽出
    const activeFiles = keys.filter((key) => currentText.includes(key));

    if (!activeFiles.length) {
      els.filesArea.style.display = "none";
      return;
    }

    els.filesArea.style.display = "flex";
    const label = document.createElement("div");
    label.className = "files-label";
    label.textContent = "files";
    els.filesArea.appendChild(label);

    activeFiles.forEach((fileTag) => {
      const match = fileTag.match(/\[(.*?)\]/);
      const displayStr = match ? match[1] : fileTag;

      // スマホのセキュリティブロックを回避するため、ButtonではなくAタグ（リンク）として生成する
      const a = document.createElement("a");
      a.className = "file-link";
      a.style.textDecoration = "none";
      a.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" class="link-icon">
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
          <polyline points="13 2 13 9 20 9"></polyline>
        </svg>
        <span class="link-text">${displayStr}</span>
      `;

      // 裏側でデータベースからファイルを読み込む
      const getReq = db
        .transaction("files", "readonly")
        .objectStore("files")
        .get(fileTag);

      getReq.onsuccess = () => {
        if (getReq.result) {
          // AタグにあらかじめURLとダウンロード属性をセットしておく（これでネイティブ機能が動く）
          const url = URL.createObjectURL(getReq.result);
          els.filesArea._blobUrls.push(url); // 解放用に保存
          a.href = url;
          a.download = displayStr;
        } else {
          a.onclick = (e) => {
            e.preventDefault();
            alert("ファイルデータが見つかりません");
          };
        }
      };

      els.filesArea.appendChild(a);
    });
  };
}
function updateCharCount() {
  els.charCount.textContent = `${els.memoArea.value.length}文字`;
}

function renderTabs() {
  els.tabContainer.innerHTML = "";

  state.tabs.forEach((tab, i) => {
    const btn = document.createElement("button");
    Object.assign(btn, {
      textContent: i + 1,
      title: `Tab ${i + 1}`,
    });
    if (tab.id === state.activeTabId) btn.classList.add("active");

    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      state.contextTargetId = tab.id;
      els.contextMenu.style.left = `${e.clientX}px`;
      els.contextMenu.style.top = `${e.clientY}px`;
      els.contextMenu.style.display = "block";
    });

    // ブラウザタブ風の滑らかなドラッグ＆ドロップ処理
    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;

      let dragged = false;
      const startX = e.clientX;
      const startY = e.clientY;
      let placeholder = null;

      const onPointerMove = (moveEvent) => {
        // 一定距離動かしたらドラッグ開始と判定する
        if (!dragged) {
          if (
            Math.abs(moveEvent.clientX - startX) > 3 ||
            Math.abs(moveEvent.clientY - startY) > 3
          ) {
            dragged = true;
            const rect = btn.getBoundingClientRect();

            placeholder = document.createElement("button");
            placeholder.style.width = `${rect.width}px`;
            placeholder.style.height = `${rect.height}px`;
            placeholder.style.opacity = "0";
            placeholder.style.margin = "0";
            els.tabContainer.insertBefore(placeholder, btn);

            btn.classList.add("tab-dragging");
            btn.style.width = `${rect.width}px`;
            btn.style.height = `${rect.height}px`;
            document.body.appendChild(btn);
          }
        }

        if (dragged) {
          // カーソル位置に合わせてタブを移動
          btn.style.left = `${moveEvent.clientX - btn.offsetWidth / 2}px`;
          btn.style.top = `${moveEvent.clientY - btn.offsetHeight / 2}px`;

          // 背面にある要素を特定してプレースホルダーを挿入（視覚的な入れ替え）
          const elements = document.elementsFromPoint(
            moveEvent.clientX,
            moveEvent.clientY,
          );
          const targetTab = elements.find(
            (el) => el.parentElement === els.tabContainer && el !== placeholder,
          );

          if (targetTab) {
            const targetRect = targetTab.getBoundingClientRect();
            if (moveEvent.clientX > targetRect.left + targetRect.width / 2) {
              els.tabContainer.insertBefore(placeholder, targetTab.nextSibling);
            } else {
              els.tabContainer.insertBefore(placeholder, targetTab);
            }
          }
        }
      };

      const onPointerUp = () => {
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", onPointerUp);

        if (dragged) {
          if (placeholder) {
            pushSnapshot();
            // ドロップ位置に応じてデータの配列を更新
            const children = Array.from(els.tabContainer.children);
            const newIndex = children.indexOf(placeholder);
            const [movedTab] = state.tabs.splice(i, 1);
            state.tabs.splice(newIndex, 0, movedTab);
            placeholder.remove(); // 不要になったプレースホルダーを削除
          }
          btn.remove(); // bodyに取り残されたドラッグ用のボタンを削除

          saveToStorage();
          renderTabs();
        } else {
          // ドラッグされなかった場合は通常のタブ切り替えとして処理
          switchTab(tab.id);
        }
      };

      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
    });

    els.tabContainer.appendChild(btn);
  });

  els.removeTabBtn.style.display =
    state.tabs.length > 1 ? "inline-block" : "none";
}

function switchTab(id, isAuto = false) {
  if (!isAuto && state.activeTabId !== id && state.activeTabId !== null) {
    state.targetTabId = state.activeTabId;
  }

  state.activeTabId = id;
  const t = state.tabs.find((t) => t.id === id);
  els.memoArea.value = t ? t.text : "";

  renderTabs();
  updateUI();
  if (els.backdrop) els.backdrop.innerHTML = "";
}

function addTab() {
  insertTabAt(state.tabs.length);
}

function removeCurrentTab() {
  removeTabById(state.activeTabId);
}

function insertTabAt(index, text = "") {
  pushSnapshot();
  const id = Date.now();
  state.tabs.splice(index, 0, { id, text });
  switchTab(id);
}
function duplicateCurrentTab() {
  const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
  if (idx === -1) return;
  insertTabAt(idx + 1, state.tabs[idx].text);
}

function removeTabById(id) {
  if (state.tabs.length <= 1) return;
  pushSnapshot();

  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  let nextId = state.activeTabId;

  if (state.activeTabId === id) {
    let closeDir = "right";
    if (state.targetTabId) {
      const targetIdx = state.tabs.findIndex((t) => t.id === state.targetTabId);
      if (targetIdx !== -1) {
        closeDir = targetIdx < idx ? "left" : "right";
      } else {
        state.targetTabId = null;
      }
    } else if (idx === state.tabs.length - 1) {
      closeDir = "left";
    }

    if (closeDir === "left") {
      nextId = state.tabs[idx > 0 ? idx - 1 : idx + 1].id;
    } else {
      nextId = state.tabs[idx < state.tabs.length - 1 ? idx + 1 : idx - 1].id;
    }
    if (nextId === state.targetTabId) {
      state.targetTabId = null;
    }
  }

  const btn = els.tabContainer.children[idx];
  if (btn) {
    btn.style.width = `${btn.offsetWidth}px`;
    btn.offsetHeight;
    btn.classList.add("removing");

    setTimeout(() => {
      executeRemove(id, nextId);
    }, 20);
  } else {
    executeRemove(id, nextId);
  }
}

function executeRemove(id, nextId) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx !== -1) {
    state.deleted.push({ origIdx: idx, data: state.tabs[idx] });
    state.tabs.splice(idx, 1);
  }

  if (state.targetTabId === id) {
    state.targetTabId = null;
  }

  if (state.activeTabId === id) {
    switchTab(nextId, true);
  } else {
    renderTabs();
    updateUI();
  }
}

function getSnapshot() {
  return {
    tabs: structuredClone(state.tabs),
    activeTabId: state.activeTabId,
  };
}

function pushSnapshot() {
  state.history.push(getSnapshot());
  if (state.history.length > 100) state.history.shift();
  state.redo = [];
  updateUndoRedo();
}

function handleHistory(isUndo) {
  const source = isUndo ? state.history : state.redo;
  const target = isUndo ? state.redo : state.history;
  if (!source.length) return;
  target.push(getSnapshot());
  restoreState(source.pop());
}

function undoAction() {
  if (!state.history.length) return;
  state.redo.push(getSnapshot());
  restoreState(state.history.pop());
}

function redoAction() {
  if (!state.redo.length) return;
  state.history.push(getSnapshot());
  restoreState(state.redo.pop());
}

function restoreState(s) {
  state.tabs = s.tabs;
  state.activeTabId = s.activeTabId;
  els.memoArea.value =
    state.tabs.find((t) => t.id === state.activeTabId)?.text || "";

  renderTabs();
  updateUI();
  updateUndoRedo();
}

function undoRemove() {
  if (!state.deleted.length) return;
  pushSnapshot();
  const last = state.deleted.pop();
  state.tabs.splice(Math.min(last.origIdx, state.tabs.length), 0, last.data);
  switchTab(last.data.id);
}

function updateUndoRedo() {
  els.undoBtn.disabled = !state.history.length;
  els.redoBtn.disabled = !state.redo.length;
}

function insertText(text) {
  pushSnapshot();
  const t = state.tabs.find((t) => t.id === state.activeTabId);
  if (!t) return;

  const { selectionStart: start, selectionEnd: end, value: val } = els.memoArea;
  els.memoArea.value = val.slice(0, start) + text + val.slice(end);
  els.memoArea.setSelectionRange(start + text.length, start + text.length);
  els.memoArea.focus();

  t.text = els.memoArea.value;
  updateUI();
}

function insertTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  insertText(
    `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  );
}

function insertUrl() {
  chrome.windows.getLastFocused({ windowTypes: ["normal"] }, (win) => {
    if (win)
      chrome.tabs.query({ active: true, windowId: win.id }, (tabs) => {
        if (tabs?.length) insertText(`[${tabs[0].title}](${tabs[0].url})\n`);
      });
  });
}

function exportMemo() {
  const text = els.memoArea.value;
  if (!text) return;

  const name =
    text
      .split("\n")[0]
      .trim()
      .replace(/[\\/:*?"<>|]/g, "")
      .slice(0, 30) || "memo";
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");

  Object.assign(a, { href: url, download: `${name}.txt` }).click();
  URL.revokeObjectURL(url);
}

function openInWindow() {
  chrome.windows.create({
    url: chrome.runtime.getURL("popup.html") + "?mode=window",
    type: "popup",
    width: state.wWidth,
    height: state.wHeight,
  });
  window.close();
}

function toggleSearchUI() {
  const isHidden =
    els.searchContainer.style.display === "none" ||
    !els.searchContainer.style.display;
  els.searchContainer.style.display = isHidden ? "flex" : "none";

  if (isHidden) {
    els.searchInput.focus();
  } else {
    if (els.backdrop) els.backdrop.innerHTML = "";
    els.memoArea.focus();
  }
  saveToStorage();
}

function performGlobalSearch(dir = "next") {
  const query = els.searchInput.value.toLowerCase();
  if (!query) return els.backdrop && (els.backdrop.innerHTML = "");

  const curIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);

  for (let i = 0; i <= state.tabs.length; i++) {
    const tIdx =
      dir === "next"
        ? (curIdx + i) % state.tabs.length
        : (curIdx - i + state.tabs.length) % state.tabs.length;

    // 【修正】改行コードを \n に完全正規化して文字数のズレを防止
    const rawText = state.tabs[tIdx].text.replace(/\r\n/g, "\n");
    const text = rawText.toLowerCase();

    let start =
      i === 0
        ? dir === "next"
          ? state.searchIdx + 1
          : state.searchIdx - 1
        : dir === "next"
          ? 0
          : text.length;
    if (i === 0 && dir !== "next" && state.searchIdx === -1)
      start = text.length;

    const found =
      dir === "next"
        ? text.indexOf(query, start)
        : text.lastIndexOf(query, start);

    if (found !== -1) {
      if (i !== 0) switchTab(state.tabs[tIdx].id);

      setTimeout(() => {
        // 正規化済みの rawText を渡す
        applyHighlight(rawText, found, query.length);
        els.memoArea.setSelectionRange(found, found + query.length);
        state.searchIdx = found;
        els.searchInput.focus();

        const mark = els.backdrop?.querySelector("mark");
        if (mark) {
          const scrollTo = Math.max(0, mark.offsetTop - 40);
          els.memoArea.scrollTop = scrollTo;
          els.backdrop.scrollTop = scrollTo;
        }
      }, 10);
      return;
    }
  }
}

function applyHighlight(text, idx, len) {
  if (!els.backdrop) return;
  const esc = (s) =>
    s.replace(/[&<>"']/g, (m) => {
      const map = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      };
      return map[m];
    });

  els.backdrop.innerHTML = `${esc(text.slice(0, idx))}<mark>${esc(text.slice(idx, idx + len))}</mark>${esc(text.slice(idx + len))}<br>`;

  syncBackdrop();
  els.backdrop.scrollTop = els.memoArea.scrollTop;
}

function syncBackdrop() {
  if (!els.backdrop) return;
  const s = window.getComputedStyle(els.memoArea);
  Object.assign(els.backdrop.style, {
    top: `${els.memoArea.offsetTop + (parseFloat(s.borderTopWidth) || 0)}px`,
    left: `${els.memoArea.offsetLeft + (parseFloat(s.borderLeftWidth) || 0)}px`,
    width: `${els.memoArea.clientWidth}px`,
    height: `${els.memoArea.clientHeight}px`,
    padding: s.padding,
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    letterSpacing: s.letterSpacing,
    wordSpacing: s.wordSpacing,
    textIndent: s.textIndent,
  });
}
els.addTabBtn.onclick = addTab;
els.removeTabBtn.onclick = removeCurrentTab;
els.timeBtn.onclick = insertTime;
els.urlBtn.onclick = insertUrl;
if (els.helpBtn) {
  els.helpBtn.onclick = () => {
    chrome.tabs.create({ url: "https://tt100839.github.io/memo-help/" });
  };
}
[els.searchBtn, els.searchCloseBtn].forEach(
  (btn) => (btn.onclick = toggleSearchUI),
);
els.undoBtn.onclick = () => handleHistory(true);
els.redoBtn.onclick = () => handleHistory(false);
els.exportBtn.onclick = exportMemo;
els.searchBtn.onclick = toggleSearchUI;
els.searchCloseBtn.onclick = toggleSearchUI;
els.searchPrevBtn.onclick = () => performGlobalSearch("prev");
els.searchNextBtn.onclick = () => performGlobalSearch("next");

els.menuDuplicate.onclick = () => {
  const idx = state.tabs.findIndex((t) => t.id === state.contextTargetId);
  if (idx === -1) return;
  insertTabAt(idx + 1, state.tabs[idx].text);
};

els.menuAddRight.onclick = () => {
  const idx = state.tabs.findIndex((t) => t.id === state.contextTargetId);
  if (idx === -1) return;
  insertTabAt(idx + 1, "");
};
els.menuRemove.onclick = () => {
  removeTabById(state.contextTargetId);
};
window.addEventListener("dragover", async (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  if (!db || !e.dataTransfer.files.length) return;
  for (const file of e.dataTransfer.files) {
    const fileTag = getUniqueFileTag(file.name);
    const tx = db.transaction("files", "readwrite");
    tx.objectStore("files").put(file, fileTag);
    tx.oncomplete = () => updateFiles(); // ★保存完了後に欄を更新する
    insertText(fileTag + "\n");
    await sendFileAtMaxSpeed(file, fileTag, file.name);
  }
});
els.memoArea.addEventListener("input", () => {
  updateCharCount();
  if (els.backdrop) els.backdrop.innerHTML = "";

  if (!state.timer) pushSnapshot();
  clearTimeout(state.timer);

  const t = state.tabs.find((t) => t.id === state.activeTabId);
  if (t) {
    t.text = els.memoArea.value;
    updateUI();
  }
  state.timer = setTimeout(() => (state.timer = null), 500);
});

els.memoArea.addEventListener(
  "scroll",
  () => els.backdrop && (els.backdrop.scrollTop = els.memoArea.scrollTop),
);

els.searchInput.addEventListener("input", () => {
  state.searchIdx = -1;
  saveToStorage();
});
els.searchInput.addEventListener("keydown", (e) => {
  if ((e.code === "Enter" && !e.shiftKey) || e.code === "ArrowDown") {
    e.preventDefault();
    performGlobalSearch("next");
  } else if ((e.code === "Enter" && e.shiftKey) || e.code === "ArrowUp") {
    e.preventDefault();
    performGlobalSearch("prev");
  }
});

document.addEventListener("click", () => {
  if (els.contextMenu) els.contextMenu.style.display = "none";
});

document.addEventListener("keydown", (e) => {
  if (e.code === "Escape") {
    if (els.searchContainer.style.display === "flex") {
      e.preventDefault();
      toggleSearchUI();
    }
    return;
  }
  const isCmdOrCtrl = e.ctrlKey || e.metaKey;
  if (!isCmdOrCtrl || e.altKey) return;

  const c = e.code;

  if (c === "KeyZ") {
    e.preventDefault();
    handleHistory(!e.shiftKey);
  } else if (c === "KeyY" && !e.shiftKey) {
    e.preventDefault();
    handleHistory(false);
  } else if (c === "KeyT" || c === "KeyN") {
    e.preventDefault();
    e.shiftKey ? undoRemove() : addTab();
  } else if (c === "KeyW" && !e.shiftKey) {
    e.preventDefault();
    removeCurrentTab();
  } else if (c === "KeyP" && !e.shiftKey) {
    e.preventDefault();
    isWindowMode ? window.close() : openInWindow();
  } else if ((c === "KeyH" || c === "KeyF") && !e.shiftKey) {
    e.preventDefault();
    const selectedText = els.memoArea.value.substring(
      els.memoArea.selectionStart,
      els.memoArea.selectionEnd,
    );
    if (selectedText) {
      els.searchInput.value = selectedText;
      state.searchIdx = els.memoArea.selectionStart - 1;
      if (els.searchContainer.style.display !== "flex") {
        els.searchContainer.style.display = "flex";
      }
      els.searchInput.focus();
      performGlobalSearch("next");
    } else {
      toggleSearchUI();
    }
  } else if (c === "Tab" && !e.shiftKey && state.tabs.length > 1) {
    e.preventDefault();
    switchTab(
      state.tabs[
        (state.tabs.findIndex((t) => t.id === state.activeTabId) + 1) %
          state.tabs.length
      ].id,
    );
  } else if (c === "KeyE" && e.shiftKey) {
    e.preventDefault();
    exportMemo();
  } else if (c === "KeyS" && !e.shiftKey) {
    e.preventDefault();
    exportMemo();
  } else if (c === "KeyD") {
    e.preventDefault();
    insertUrl();
  } else if (c === "KeyK" && e.shiftKey) {
    e.preventDefault();
    duplicateCurrentTab();
  } else if (c === "KeyL" && e.shiftKey) {
    e.preventDefault();
    insertTime();
  } else if (c.startsWith("Digit") && c !== "Digit0") {
    const tabIndex = parseInt(c.replace("Digit", ""), 10) - 1;
    if (state.tabs[tabIndex]) {
      e.preventDefault();
      switchTab(state.tabs[tabIndex].id);
    }
  }
});

els.header.style.cursor = "grab";
els.header.addEventListener("mousedown", (e) => {
  if (isWindowMode || e.target.tagName === "BUTTON") return;
  state.dragging = true;
  state.startX = e.clientX;
  state.startY = e.clientY;
});
document.addEventListener("mousemove", (e) => {
  if (!state.dragging) return;
  if (
    Math.abs(e.clientX - state.startX) > 5 ||
    Math.abs(e.clientY - state.startY) > 5
  ) {
    state.dragging = false;
    openInWindow();
  }
});
document.addEventListener("mouseup", () => (state.dragging = false));

if (isWindowMode) {
  let rt;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      state.wWidth = window.outerWidth;
      state.wHeight = window.outerHeight;
      saveToStorage();
      syncBackdrop();
    }, 500);
  });
} else {
  const ro = new ResizeObserver((entries) => {
    window.requestAnimationFrame(() => {
      if (!entries?.length) return;
      const w = Math.max(260, els.memoArea.offsetWidth + 20);
      const h = Math.max(150, els.memoArea.offsetHeight + 100);

      document.documentElement.style.width = `${w}px`;
      document.documentElement.style.height = `${h}px`;
      document.body.style.width = "auto";
      document.body.style.height = "auto";
      document.body.style.minWidth = `${w}px`;
      document.body.style.minHeight = `${h}px`;
      syncBackdrop();
    });
    els.tabContainer.parentElement.style.width = `${els.memoArea.offsetWidth}px`;
  });

  ro.observe(els.memoArea);
  els.memoArea.addEventListener("mouseup", () => {
    if (
      state.mWidth !== els.memoArea.style.width ||
      state.mHeight !== els.memoArea.style.height
    ) {
      state.mWidth = els.memoArea.style.width;
      state.mHeight = els.memoArea.style.height;
      saveToStorage();
    }
  });
}
document.addEventListener("DOMContentLoaded", () => {
  const btnAddTab = document.getElementById("btn-demo-add-tab");
  const btnSearch = document.getElementById("btn-demo-search");

  if (btnAddTab) {
    btnAddTab.addEventListener("click", () => playDemo("addTab"));
  }
  if (btnSearch) {
    btnSearch.addEventListener("click", () => playDemo("search"));
  }
});
els.fileBtn.onclick = () => {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.onchange = async () => {
    if (!db || !input.files.length) return;
    for (const file of input.files) {
      const fileTag = getUniqueFileTag(file.name);
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").put(file, fileTag);
      tx.oncomplete = () => updateFiles();
      insertText(fileTag + "\n");
      await sendFileAtMaxSpeed(file, fileTag, file.name);
    }
  };
  input.click();
};

// 拡張機能（ポップアップ画面）が閉じられたときに不要ファイルを一括削除する処理
window.addEventListener("pagehide", () => {
  if (db) {
    const tx = db.transaction("files", "readonly");
    const req = tx.objectStore("files").getAllKeys();
    req.onsuccess = () => {
      const keys = req.result;
      const allText = state.tabs.map((tab) => tab.text).join("");
      keys.forEach((key) => {
        if (!allText.includes(key)) {
          const deleteTx = db.transaction("files", "readwrite");
          deleteTx.objectStore("files").delete(key);
        }
      });
    };
  }
});
init();
// 【差し替え】WORKER_URLの定義から最後（initの実行部分など含む）までを以下に置き換えてください
const WORKER_URL = "https://memo-signaling.tanakasan32400.workers.dev";
const MOBILE_SITE_URL = "https://tt100839.github.io/memo-help/mobile.html";

// 【修正】setupDataChannel 関数を以下のように書き換えてください
// 【修正】setupDataChannel 関数を以下に丸ごと差し替えてください
function setupDataChannel(dc) {
  syncDataChannel = dc;
  dc.binaryType = "arraybuffer";
  dc.onmessage = handleSyncMessage;

  dc.onopen = async () => {
    // ★ async を追加
    els.memoArea.placeholder = "";
    els.charCount.style.color = "";
    els.memoArea.style.backgroundColor = "";
    els.memoArea.readOnly = false;

    if (!isMobileMode) {
      saveToStorage();
      if (db) {
        const allText = state.tabs.map((t) => t.text).join("");
        const tx = db.transaction("files", "readonly");
        tx.objectStore("files").getAllKeys().onsuccess = async (e) => {
          // ★ async を追加
          const keys = e.target.result;
          const activeFiles = keys.filter((k) => allText.includes(k));

          // ★ forEachではなく for...of を使って「絶対に1つずつ順番に」送信する
          for (const tag of activeFiles) {
            const fileData = await new Promise((resolve) => {
              const req = db
                .transaction("files", "readonly")
                .objectStore("files")
                .get(tag);
              req.onsuccess = (ev) => resolve(ev.target.result);
              req.onerror = () => resolve(null);
            });
            if (fileData) {
              await sendFileAtMaxSpeed(
                fileData,
                tag,
                fileData.name || "shared_file",
              );
            }
          }
        };
      }
      const btn = document.getElementById("connect-btn");
      if (btn) {
        btn.textContent = "接続中(クリックで切断)";
        btn.style.backgroundColor = "#4caf50";
        btn.disabled = false;
      }
    }
  };

  dc.onclose = () => {
    els.memoArea.placeholder =
      "通信が切断されました。再接続するにはページを更新してください。";
    els.charCount.textContent = "【切断済】 " + els.charCount.textContent;
    els.charCount.style.color = "#f44336"; // 文字数を赤色にする

    if (!isMobileMode) {
      const btn = document.getElementById("connect-btn");
      if (btn) {
        btn.textContent = "スマホ接続(QR)"; // 初期状態に戻す
        btn.style.backgroundColor = "#34a853";
        btn.disabled = false;
      }
    } else {
      // スマホ側：背景をグレーにし、これ以上入力できないようにする
      els.memoArea.style.backgroundColor = "#f5f5f5";
      els.memoArea.readOnly = true;
    }

    syncPeerConnection = null;
    syncDataChannel = null;
  };

  dc.onerror = (error) => {
    console.error("DataChannel Error:", error);
    dc.close();
  };
}
// PC側：ボタンクリックで接続待ち
// 【修正】document.getElementById("connect-btn").onclick を以下に差し替えてください
document.getElementById("connect-btn").onclick = async () => {
  const connectBtn = document.getElementById("connect-btn");

  // 【追記】すでに通信が存在する場合は、接続を切断して初期状態に戻す
  if (syncPeerConnection) {
    syncPeerConnection.close();
    syncPeerConnection = null;
    if (syncDataChannel) {
      syncDataChannel.close();
      syncDataChannel = null;
    }
    connectBtn.textContent = "スマホ接続(QR)";
    connectBtn.style.backgroundColor = "#34a853";
    connectBtn.disabled = false;
    document.getElementById("qr-container").style.display = "none";
    els.charCount.style.color = "";
    els.memoArea.style.backgroundColor = "";
    els.memoArea.readOnly = false;
    updateCharCount();
    return;
  }

  connectBtn.disabled = true;
  connectBtn.textContent = "準備中(1/3)...";

  const sessionId = Math.floor(100000 + Math.random() * 900000).toString();
  const connectUrl = MOBILE_SITE_URL + "?id=" + sessionId;

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  syncPeerConnection = pc; // 【追記】切断操作のためにグローバル変数に保存する
  const dc = pc.createDataChannel("memo-channel");
  setupDataChannel(dc);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  connectBtn.textContent = "経路探索中(2/3)...";

  await new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") resolve();
    else {
      pc.addEventListener("icecandidate", (e) => {
        if (e.candidate) resolve(); // 経路が1つでも見つかれば即座に接続開始
      });
      setTimeout(resolve, 2000); // 念のためのタイムアウトを超短縮
    }
  });

  connectBtn.textContent = "サーバー登録中(3/3)...";
  try {
    const res = await fetch(WORKER_URL + "/offer?id=" + sessionId, {
      method: "POST",
      body: JSON.stringify(pc.localDescription),
    });
    if (!res.ok) throw new Error("Upload failed");
  } catch (err) {
    connectBtn.textContent = "サーバー接続エラー";
    connectBtn.disabled = false;
    syncPeerConnection = null;
    return;
  }

  document.getElementById("qr-image").src =
    "https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=" +
    encodeURIComponent(connectUrl);
  document.getElementById("session-id-text").textContent = "ID: " + sessionId;
  document.getElementById("qr-container").style.display = "block";
  connectBtn.textContent = "QRをスキャン(クリックで取消)";
  connectBtn.disabled = false; // 待機中もクリックでキャンセルできるように有効化

  const pollInterval = setInterval(async () => {
    // ユーザーが手動で切断した場合はポーリングを停止
    if (!syncPeerConnection) {
      clearInterval(pollInterval);
      return;
    }
    if (pc.signalingState === "stable") {
      clearInterval(pollInterval);
      return;
    }
    try {
      const res = await fetch(WORKER_URL + "/answer?id=" + sessionId);
      if (res.ok) {
        const answer = await res.json();
        await pc.setRemoteDescription(answer);
        clearInterval(pollInterval);
        setTimeout(() => {
          document.getElementById("qr-container").style.display = "none";
        }, 2000);
      }
    } catch (e) {}
  }, 2000);
};

// スマホ側：URLのIDから自動接続
async function checkMobileConnection() {
  const sessionId = new URLSearchParams(window.location.search).get("id");
  if (!sessionId || !window.location.pathname.endsWith("mobile.html")) return;

  els.memoArea.placeholder = "PCと接続を確立中(1/3)...";
  try {
    let res;
    // PCのアップロードを待つ
    for (let i = 0; i < 10; i++) {
      res = await fetch(WORKER_URL + "/offer?id=" + sessionId);
      if (res.ok) break;
      els.memoArea.placeholder = `PCと接続を確立中(1/3)... リトライ ${i + 1}/10`;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (!res || !res.ok) {
      els.memoArea.value = "期限切れです。PC側で再度QRを表示してください";
      return;
    }

    els.memoArea.placeholder = "経路探索中(2/3)...";
    const offer = await res.json();
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pc.ondatachannel = (e) => {
      setupDataChannel(e.channel);
    };

    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // ICE candidateの収集完了を最大2秒だけ待機
    await new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") resolve();
      else {
        // ★ PC側と同じように、最初の経路が見つかった瞬間に進むように変更
        pc.addEventListener("icecandidate", (e) => {
          if (e.candidate) resolve();
        });
        setTimeout(resolve, 2000); // 最大で2秒待つ
      }
    });

    els.memoArea.placeholder = "サーバー登録中(3/3)...";
    await fetch(WORKER_URL + "/answer?id=" + sessionId, {
      method: "POST",
      body: JSON.stringify(pc.localDescription),
    });

    els.memoArea.placeholder = "同期完了を待機しています...";
  } catch (err) {
    els.memoArea.value = "通信エラーが発生しました";
  }
}

init();
checkMobileConnection();
