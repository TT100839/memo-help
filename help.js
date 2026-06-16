const isWindowMode = false;
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
  helpBtn: document.getElementById("help-btn"), // ヘルプボタンを追加
  connectBtn: document.getElementById("connect-btn"), // スマホ接続ボタンを追加 (Add smartphone connection button)
  qrContainer: document.getElementById("qr-container"),
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
  mWidth: "100%",
  mHeight: "350px",
  wWidth: 420,
  wHeight: 550,
  contextTargetId: null,
  targetTabId: null,
};

let db;
const initDB = () => {
  const req = indexedDB.open("DemoMemoFilesDB", 1);
  req.onupgradeneeded = (e) => {
    db = e.target.result;
    if (!db.objectStoreNames.contains("files")) db.createObjectStore("files");
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
  state.tabs = [{ id: Date.now(), text: "" }];
  state.activeTabId = state.tabs[0].id;
  applyModeLayout();
  switchTab(state.activeTabId);
  updateUndoRedo();
}

function applyModeLayout() {
  els.memoArea.style.width = state.mWidth;
  els.memoArea.style.height = state.mHeight;
  els.memoArea.style.maxHeight = "480px";
  els.tabContainer.parentElement.style.width = "100%";
}

function saveToStorage() {}

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
      <span class="link-text">${displayStr}</span>
    `;
    els.linksArea.appendChild(a);
  });
}

function updateFiles() {
  if (!els.filesArea || !db) return;
  const tx = db.transaction("files", "readonly");
  const req = tx.objectStore("files").getAllKeys();

  req.onsuccess = () => {
    els.filesArea.innerHTML = "";
    const keys = req.result;
    const currentText = els.memoArea.value;
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

      const btn = document.createElement("button");
      btn.className = "file-link";
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" class="link-icon">
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
          <polyline points="13 2 13 9 20 9"></polyline>
        </svg>
        <span class="link-text">${displayStr}</span>
      `;

      btn.onclick = () => {
        const getReq = db
          .transaction("files", "readonly")
          .objectStore("files")
          .get(fileTag);
        getReq.onsuccess = () => {
          if (getReq.result) {
            const url = URL.createObjectURL(getReq.result);
            window.open(url, "_blank");
            setTimeout(() => URL.revokeObjectURL(url), 10000);
          }
        };
      };
      els.filesArea.appendChild(btn);
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
    Object.assign(btn, { textContent: i + 1, title: `Tab ${i + 1}` });
    if (tab.id === state.activeTabId) btn.classList.add("active");

    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      state.contextTargetId = tab.id;
      const rect = btn.getBoundingClientRect();
      const demoRect = document
        .getElementById("demo-window")
        .getBoundingClientRect();
      els.contextMenu.style.left = `${rect.left - demoRect.left}px`;
      els.contextMenu.style.top = `${rect.bottom - demoRect.top}px`;
      els.contextMenu.style.display = "block";
    });

    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || isPlaying) return;
      let dragged = false;
      const startX = e.clientX,
        startY = e.clientY;
      let placeholder = null;

      const onPointerMove = (moveEvent) => {
        if (
          !dragged &&
          (Math.abs(moveEvent.clientX - startX) > 3 ||
            Math.abs(moveEvent.clientY - startY) > 3)
        ) {
          dragged = true;
          const rect = btn.getBoundingClientRect();
          placeholder = document.createElement("button");
          placeholder.style.width = `${rect.width}px`;
          placeholder.style.height = `${rect.height}px`;
          placeholder.style.opacity = "0";
          els.tabContainer.insertBefore(placeholder, btn);

          btn.classList.add("tab-dragging");
          btn.style.width = `${rect.width}px`;
          document.body.appendChild(btn);
        }

        if (dragged) {
          btn.style.left = `${moveEvent.clientX - btn.offsetWidth / 2}px`;
          btn.style.top = `${moveEvent.clientY - btn.offsetHeight / 2}px`;
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
            const children = Array.from(els.tabContainer.children);
            const newIndex = children.indexOf(placeholder);
            const [movedTab] = state.tabs.splice(i, 1);
            state.tabs.splice(newIndex, 0, movedTab);
            placeholder.remove();
          }
          btn.remove();
          renderTabs();
        } else {
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
  const id = Date.now() + Math.random();
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
      if (targetIdx !== -1) closeDir = targetIdx < idx ? "left" : "right";
      else state.targetTabId = null;
    } else if (idx === state.tabs.length - 1) closeDir = "left";

    nextId =
      closeDir === "left"
        ? state.tabs[idx > 0 ? idx - 1 : idx + 1].id
        : state.tabs[idx < state.tabs.length - 1 ? idx + 1 : idx - 1].id;
    if (nextId === state.targetTabId) state.targetTabId = null;
  }

  const btn = els.tabContainer.children[idx];
  if (btn) {
    btn.style.width = `${btn.offsetWidth}px`;
    btn.classList.add("removing");
    setTimeout(() => executeRemove(id, nextId), 20);
  } else executeRemove(id, nextId);
}

function executeRemove(id, nextId) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx !== -1) {
    state.deleted.push({ origIdx: idx, data: state.tabs[idx] });
    state.tabs.splice(idx, 1);
  }
  if (state.targetTabId === id) state.targetTabId = null;
  if (state.activeTabId === id) switchTab(nextId, true);
  else {
    renderTabs();
    updateUI();
  }
}

function getSnapshot() {
  return { tabs: structuredClone(state.tabs), activeTabId: state.activeTabId };
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
  const d = new Date(),
    pad = (n) => String(n).padStart(2, "0");
  insertText(
    `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  );
}

function insertUrl() {
  insertText("[現在開いているページのURL](https://example.com)\n");
}

function exportMemo() {
  const text = els.memoArea.value;
  if (!text) return;
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  Object.assign(a, { href: url, download: "memo.txt" }).click();
  URL.revokeObjectURL(url);
}

function openInWindow() {
  alert(
    "【デモ表示】ウィンドウモードへの切替機能です（ヘルプ画面内ではシミュレーション動作となります）",
  );
}

function toggleSearchUI() {
  const isHidden =
    els.searchContainer.style.display === "none" ||
    !els.searchContainer.style.display;
  els.searchContainer.style.display = isHidden ? "flex" : "none";
  if (isHidden) els.searchInput.focus();
  else {
    if (els.backdrop) els.backdrop.innerHTML = "";
    els.memoArea.focus();
  }
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
        applyHighlight(rawText, found, query.length);
        els.memoArea.setSelectionRange(found, found + query.length);
        state.searchIdx = found;
        els.searchInput.focus();
      }, 10);
      return;
    }
  }
}

function applyHighlight(text, idx, len) {
  if (!els.backdrop) return;
  const esc = (s) =>
    s.replace(
      /[&<>"']/g,
      (m) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[m],
    );
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
  });
}

els.addTabBtn.onclick = addTab;
els.removeTabBtn.onclick = removeCurrentTab;
els.timeBtn.onclick = insertTime;
els.urlBtn.onclick = insertUrl;
[els.searchBtn, els.searchCloseBtn].forEach(
  (btn) => (btn.onclick = toggleSearchUI),
);
els.modeSwitchBtn.onclick = openInWindow;
els.undoBtn.onclick = () => handleHistory(true);
els.redoBtn.onclick = () => handleHistory(false);
els.exportBtn.onclick = exportMemo;
els.searchPrevBtn.onclick = () => performGlobalSearch("prev");
els.searchNextBtn.onclick = () => performGlobalSearch("next");

els.menuDuplicate.onclick = () => {
  const idx = state.tabs.findIndex((t) => t.id === state.contextTargetId);
  if (idx === -1) return;
  insertTabAt(idx + 1, state.tabs[idx].text);
  els.contextMenu.style.display = "none";
};
els.menuAddRight.onclick = () => {
  const idx = state.tabs.findIndex((t) => t.id === state.contextTargetId);
  if (idx === -1) return;
  insertTabAt(idx + 1, "");
  els.contextMenu.style.display = "none";
};
els.menuRemove.onclick = () => {
  removeTabById(state.contextTargetId);
  els.contextMenu.style.display = "none";
};

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
els.searchInput.addEventListener("input", () => (state.searchIdx = -1));
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

// フリー操作時のショートカット登録用
document.addEventListener("keydown", (e) => {
  if (isPlaying) return;
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
    openInWindow();
  } else if ((c === "KeyH" || c === "KeyF") && !e.shiftKey) {
    e.preventDefault();
    const selectedText = els.memoArea.value.substring(
      els.memoArea.selectionStart,
      els.memoArea.selectionEnd,
    );
    if (selectedText) {
      els.searchInput.value = selectedText;
      state.searchIdx = els.memoArea.selectionStart - 1;
      if (els.searchContainer.style.display !== "flex")
        els.searchContainer.style.display = "flex";
      els.searchInput.focus();
      performGlobalSearch("next");
    } else toggleSearchUI();
  }
});

els.fileBtn.onclick = () => {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.onchange = () => {
    if (!db || !input.files.length) return;
    for (const file of input.files) {
      const fileTag = getUniqueFileTag(file.name);
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").put(file, fileTag);
      insertText(fileTag + "\n");
    }
  };
  input.click();
};

init();

// =========================================
// チュートリアル（デモ）制御用の追加コード（リセット機能完全版）
// =========================================
let isPlaying = false;
let currentAbortController = null;

// シグナル付きウェイト
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort);
  });
}

// ユーザーのアクション（クリック/キーボード/右クリック）をインターセプト待机する
function waitForUserAction(
  element,
  triggerKeys,
  allowedEvents = ["click"],
  signal = null,
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Aborted"));

    const eventHandler = (e) => {
      e.stopPropagation();
      e.preventDefault();
      finish();
    };
    const keyHandler = (e) => {
      if ((e.ctrlKey || e.metaKey) && triggerKeys.includes(e.code)) {
        e.stopPropagation();
        e.preventDefault();
        finish();
      }
    };
    const onAbort = () => {
      allowedEvents.forEach((evt) =>
        element.removeEventListener(evt, eventHandler, true),
      );
      window.removeEventListener("keydown", keyHandler, true);
      element.classList.remove("demo-highlight");
      reject(new Error("Aborted"));
    };
    const finish = () => {
      allowedEvents.forEach((evt) =>
        element.removeEventListener(evt, eventHandler, true),
      );
      window.removeEventListener("keydown", keyHandler, true);
      signal?.removeEventListener("abort", onAbort);
      element.classList.remove("demo-highlight");
      resolve();
    };

    element.classList.add("demo-highlight");
    allowedEvents.forEach((evt) =>
      element.addEventListener(evt, eventHandler, true),
    );
    window.addEventListener("keydown", keyHandler, true);
    signal?.addEventListener("abort", onAbort);
  });
}

// 自動タイピング（append=trueで上書きせず追記）
async function typeText(text, speed = 25, append = false, signal = null) {
  const adjustedSpeed = speed * 0.3;
  els.memoArea.focus();
  if (!append) els.memoArea.value = "";

  for (let i = 0; i < text.length; i++) {
    if (signal?.aborted) throw new Error("Aborted");
    els.memoArea.value += text[i];
    const t = state.tabs.find((t) => t.id === state.activeTabId);
    if (t) t.text = els.memoArea.value;
    updateVisuals();
    await sleep(adjustedSpeed, signal);
  }
}

// デモ初期化＆ゴミ残りの完全クリア
function resetDemo() {
  state.tabs = [{ id: Date.now(), text: "" }];
  switchTab(state.tabs[0].id);
  state.history = [];
  state.redo = [];
  updateUndoRedo();
  if (els.searchContainer.style.display === "flex") toggleSearchUI();
  els.searchInput.value = "";
  els.backdrop.innerHTML = "";
  els.contextMenu.style.display = "none";
  if (els.qrContainer) els.qrContainer.style.display = "none";

  const targets = [
    els.addTabBtn,
    els.searchBtn,
    els.undoBtn,
    els.timeBtn,
    els.exportBtn,
    els.modeSwitchBtn,
    els.connectBtn,
  ];
  targets.forEach((el) => {
    if (el) {
      el.classList.remove("demo-highlight");
      el.style.pointerEvents = "";
    }
  });
}

// メインデモシナリオ実行管理
// メインデモシナリオ実行管理
async function playDemo(type) {
  // すでに実行中のデモがあれば即座にアボート（リセット）
  if (currentAbortController) currentAbortController.abort();

  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;
  isPlaying = true;

  document.getElementById("memo-container").style.pointerEvents = "none";
  document.getElementById("header").style.pointerEvents = "none";
  if (document.getElementById("footer"))
    document.getElementById("footer").style.pointerEvents = "none";
  resetDemo();

  try {
    if (type === "addTab") {
      const intro =
        "タブの追加は、右上の「＋」ボタンをクリックして実行できます。\n\n光っている「＋」ボタンをクリックして次へ進んでください。";
      await typeText(intro, 20, false, signal);

      els.addTabBtn.style.pointerEvents = "auto";
      await waitForUserAction(
        els.addTabBtn,
        ["KeyT", "KeyN"],
        ["click"],
        signal,
      );
      els.addTabBtn.style.pointerEvents = "";

      addTab();
      await sleep(300, signal);

      const tipText =
        "新しいタブが追加されました！\n「－」ボタンを押すと現在選択中のタブを削除できます。\n\nヘルプ画面では使えないですが、ショートカットもあります。\nCtrl + T または Ctrl + N で新規タブ\nCtrl + W でタブを閉じる";
      await typeText(tipText, 20, true, signal);
    } else if (type === "dragTab") {
      state.tabs = [
        { id: Date.now(), text: "1番目のタブです。" },
        { id: Date.now() + 1, text: "2番目のタブです。" },
        { id: Date.now() + 2, text: "3番目のタブです。" },
      ];
      switchTab(state.tabs[0].id);

      const intro =
        "タブの並び替えは、上部のタブボタンをドラッグ＆ドロップして実行できます。\n\n『1』『2』『3』のタブをマウスで長押ししながら、左右に動かしてみてください。";
      await typeText(intro, 20, false, signal);
    } else if (type === "contextTab") {
      const intro =
        "タブのメニューは、タブボタンを「右クリック」して開くことができます。\n\n光っている『1』番のタブボタンを右クリックして次へ進んでください。";
      await typeText(intro, 20, false, signal);

      const firstTabBtn = els.tabContainer.children[0];
      if (firstTabBtn) {
        firstTabBtn.style.pointerEvents = "auto";
        await waitForUserAction(firstTabBtn, [], ["contextmenu"], signal);
        firstTabBtn.style.pointerEvents = "";

        state.contextTargetId = state.tabs[0].id;
        const rect = firstTabBtn.getBoundingClientRect();
        const demoRect = document
          .getElementById("demo-window")
          .getBoundingClientRect();
        els.contextMenu.style.left = `${rect.left - demoRect.left}px`;
        els.contextMenu.style.top = `${rect.bottom - demoRect.top}px`;
        els.contextMenu.style.display = "block";
        await sleep(300, signal);
      }

      const tipText =
        "\n\nメニューが表示されました！\n「Duplicate」でタブを複製、「Add Right」で右に空タブを追加できます。\n\nヘルプ画面では使えないですが、ショートカットもあります。\nCtrl + Shift + K で現在のタブを複製";
      await typeText(tipText, 20, true, signal);
    } else if (type === "search") {
      const intro =
        "検索機能は、右上の「虫眼鏡」ボタンをクリックして実行できます。\n\n光っている虫眼鏡ボタンをクリックして次へ進んでください。";
      await typeText(intro, 20, false, signal);

      els.searchBtn.style.pointerEvents = "auto";
      await waitForUserAction(
        els.searchBtn,
        ["KeyF", "KeyH"],
        ["click"],
        signal,
      );
      els.searchBtn.style.pointerEvents = "";

      toggleSearchUI();
      await sleep(300, signal);

      await typeText(
        "これは検索ハイライトのテスト文章です。\n",
        0,
        false,
        signal,
      );
      els.searchInput.value = "テスト";
      await sleep(300, signal);
      performGlobalSearch("next");

      const tipText =
        "\nキーワードを入力するとマッチ位置（テスト）が光ります。\n↑や↓キー、Enterキーで検索結果を移動できます。\n\nヘルプ画面では使えないですが、ショートカットもあります。\nCtrl + F または Ctrl + H で検索窓を開く\nEsc で検索窓を閉じる\n";
      await typeText(tipText, 20, true, signal);
    } else if (type === "history") {
      const intro =
        "メモの入力履歴は自動保存されます。誤操作で消しても元に戻せます。\n\n";
      await typeText(intro, 20, false, signal);

      pushSnapshot();

      const tip =
        "右上の「左矢印(Undo)」ボタンをクリックして次へ進んでください。";
      await typeText(tip, 20, true, signal);

      els.undoBtn.style.pointerEvents = "auto";
      await waitForUserAction(els.undoBtn, ["KeyZ"], ["click"], signal);
      els.undoBtn.style.pointerEvents = "";

      handleHistory(true);
      await sleep(300, signal);

      const tip2 =
        "履歴が巻き戻りました！\n隣の右矢印ボタンでやり直し(Redo)も可能です。\n\nヘルプ画面では使えないですが、ショートカットもあります。\nCtrl + Z で元に戻す(Undo)\nCtrl + Y または Ctrl + Shift + Z でやり直し(Redo)";
      await typeText(tip2, 20, true, signal);
    } else if (type === "insert") {
      const intro =
        "フッターのボタンから、作業効率を高める情報を挿入できます。\n\n下部の光っている「Time」ボタンをクリックして次へ進んでください。\n";
      await typeText(intro, 20, false, signal);

      els.timeBtn.style.pointerEvents = "auto";
      if (document.getElementById("footer"))
        document.getElementById("footer").style.pointerEvents = "auto";
      await waitForUserAction(els.timeBtn, [], ["click"], signal);
      els.timeBtn.style.pointerEvents = "";

      insertTime();
      await sleep(500, signal);

      const tip =
        "\n\nタイムスタンプが挿入されました！\nURLボタンやFileボタンも便利です。\n\nヘルプ画面では使えないですが、ショートカットもあります。\nCtrl + D で開いているページのURLを挿入\nCtrl + Shift + L で時刻を挿入";
      await typeText(tip, 20, true, signal);
    } else if (type === "export") {
      const intro =
        "memo\nメモの内容は、テキストファイル(.txt)として保存できます。\n\n光っている右下の「Export」ボタンをクリックして次へ進んでください。";
      await typeText(intro, 20, false, signal);

      els.exportBtn.style.pointerEvents = "auto";
      if (document.getElementById("footer"))
        document.getElementById("footer").style.pointerEvents = "auto";
      await waitForUserAction(els.exportBtn, ["KeyS"], ["click"], signal);
      els.exportBtn.style.pointerEvents = "";

      exportMemo();
      await sleep(500, signal);

      const tip =
        "\n\nメモの最初の1行目がファイル名になってダウンロードされます。\n\nヘルプ画面では使えないですが、ショートカットもあります。\nCtrl + S または Ctrl + Shift + E でエクスポート";
      await typeText(tip, 20, true, signal);
    } else if (type === "window") {
      const intro =
        "メモ帳を独立した別ウィンドウとして分離させることができます。\n\n光っている「⧉」ボタンをクリックして次へ進んでください。";
      await typeText(intro, 20, false, signal);

      els.modeSwitchBtn.style.pointerEvents = "auto";
      await waitForUserAction(els.modeSwitchBtn, ["KeyP"], ["click"], signal);
      els.modeSwitchBtn.style.pointerEvents = "";

      openInWindow();
      await sleep(500, signal);

      const tip =
        "\n\nデスクトップの隅に常駐させておきたい場合に便利です。\n\nヘルプ画面では使えないですが、ショートカットもあります。\nCtrl + P でウィンドウモード切替";
      await typeText(tip, 20, true, signal);
    } else if (type === "qr") {
      const intro =
        "スマホと連携して、メモをリアルタイムに同期できます\n\n光っている下部の「スマホ接続」ボタンをクリックして次へ進んでください";
      await typeText(intro, 20, false, signal);

      if (els.connectBtn) {
        els.connectBtn.style.pointerEvents = "auto";
        if (document.getElementById("footer"))
          document.getElementById("footer").style.pointerEvents = "auto";
        await waitForUserAction(els.connectBtn, ["KeyQ"], ["click"], signal);
        els.connectBtn.style.pointerEvents = "";

        if (els.qrContainer) els.qrContainer.style.display = "block";
      }

      await sleep(500, signal);

      const tip =
        "\n\nQRコードが表示されました\nスマホのカメラで読み取ると、同じネットワーク内でなくてもWebRTC(Web Real-Time Communication)技術を使って同期されます\n\nショートカットもあります\nCtrl + Q で接続メニューを開閉できます";
      await typeText(tip, 20, true, signal);
    } else if (type === "shortcuts") {
      const intro = "【ショートカットキー完全一覧】\n\n";

      const list =
        "◆ タブの操作\n" +
        "Ctrl + T または Ctrl + N ： 新規タブを追加\n" +
        "Ctrl + Shift + T または Ctrl + Shift + N ： 削除したタブを復元\n" +
        "Ctrl + W ： 現在のタブを削除\n" +
        "Ctrl + Shift + K ： 現在のタブを複製\n" +
        "Ctrl + Tab ： 次のタブへ切り替え\n" +
        "Ctrl + 1〜9 (数字) ： 指定した番号のタブへ移動\n\n" +
        "◆ メモの編集と挿入\n" +
        "Ctrl + Z ： 元に戻す (Undo)\n" +
        "Ctrl + Y または Ctrl + Shift + Z ： やり直し (Redo)\n" +
        "Ctrl + D ： 現在見ているページのURLを挿入\n" +
        "Ctrl + Shift + L ： 現在の時刻を挿入\n\n" +
        "◆ 検索とその他の機能\n" +
        "Ctrl + F または Ctrl + H ： 検索窓を開く\n" +
        "Esc ： 検索窓を閉じる\n" +
        "Ctrl + S または Ctrl + Shift + E ： メモをエクスポート\n" +
        "Ctrl + P ： ウィンドウモード切替\n\n" +
        "※ヘルプ画面ではブラウザの機能が優先されるため一部使えません。実際のショートカットは拡張機能のポップアップ画面にてご利用ください！";
      els.memoArea.value += list;
      const t = state.tabs.find((t) => t.id === state.activeTabId);
      if (t) t.text = els.memoArea.value;
      updateVisuals();
    }
  } catch (e) {
    if (e.message === "Aborted") {
      console.log("デモが別メニューへリセットされました");
      return;
    }
    throw e;
  } finally {
    // 自身がアボートされずに完走した最終デモである場合のみロックを解除する
    if (currentAbortController?.signal === signal) {
      document.getElementById("memo-container").style.pointerEvents = "auto";
      document.getElementById("header").style.pointerEvents = "auto";
      if (document.getElementById("footer"))
        document.getElementById("footer").style.pointerEvents = "auto";
      isPlaying = false;
    }
  }
}

// イベントリスナーのセットアップ
document.addEventListener("DOMContentLoaded", () => {
  const map = {
    "btn-demo-add-tab": "addTab",
    "btn-demo-drag-tab": "dragTab",
    "btn-demo-context-tab": "contextTab",
    "btn-demo-search": "search",
    "btn-demo-history": "history",
    "btn-demo-insert": "insert",
    "btn-demo-export": "export",
    "btn-demo-window": "window",
    "btn-demo-shortcuts": "shortcuts",
    "btn-demo-qr": "qr",
  };

  for (const [id, type] of Object.entries(map)) {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener("click", () => playDemo(type));
  }
});

// デモ実行中の誤タイピング等をブロック
window.addEventListener(
  "keydown",
  (e) => {
    if (isPlaying) {
      const isCmdOrCtrl = e.ctrlKey || e.metaKey;
      const allowed = [
        "KeyT",
        "KeyN",
        "KeyF",
        "KeyH",
        "KeyZ",
        "KeyY",
        "KeyS",
        "KeyP",
      ];
      if (!(isCmdOrCtrl && allowed.includes(e.code))) {
        e.stopPropagation();
        e.preventDefault();
      }
    }
  },
  true,
);
