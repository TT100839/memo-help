(() => {
  window.addEventListener("error", (e) => {
    if (
      e.message ===
        "ResizeObserver loop completed with undelivered notifications." ||
      e.message === "ResizeObserver loop limit exceeded"
    ) {
      e.stopImmediatePropagation();
    }
  });

  // --- 既存の定数・変数定義付近に追加 ---
  const isWindowMode =
    new URLSearchParams(window.location.search).has("mode") ||
    window.location.pathname.endsWith("mobile.html");
  const isMobileMode = window.location.pathname.includes("mobile.html");

  // ★追加: 切断UIをリセットする関数
  function resetDisconnectUI() {
    if (isMobileMode) return;
    const btn = document.getElementById("connect-btn");
    if (btn && btn.style.color) {
      // 色が変わっていたら戻す
      btn.title = "Connect to another device(Ctrl + Q)";
      btn.style.color = "";
    }
    if (els.memoArea.placeholder.includes("lost")) {
      els.memoArea.placeholder = "";
    }
    if (els.charCount.textContent.includes("lost")) {
      els.charCount.textContent = els.charCount.textContent.replace(
        "lost ",
        "",
      );
      els.charCount.style.color = "";
    }
  }
  const CHUNK_SIZE = 16 * 1024;
  const MAX_BUFFER = 256 * 1024;
  let incomingFile = [];
  let incomingFileInfo = null;
  const incomingFiles = {};
  const receivingFiles = {};
  let incomingFileSize = 0;

  let db;
  let syncDataChannel = null;
  let syncPeerConnection = null;
  let signalingPollInterval = null;
  const fileSendQueue = [];
  let isSendingFile = false;

  function enqueueFile(file, tag, fileName) {
    fileSendQueue.push({ file, tag, fileName });
    processFileQueue();
  }

  async function processFileQueue() {
    if (isSendingFile || fileSendQueue.length === 0) return;
    isSendingFile = true;

    while (fileSendQueue.length > 0) {
      const { file, tag, fileName } = fileSendQueue.shift();
      try {
        await sendFileAtMaxSpeed(file, tag, fileName);
      } catch (e) {
        console.error("File send error:", e);
      }
    }

    isSendingFile = false;
  }
  async function sendFileAtMaxSpeed(file, tag, fileName) {
    if (!syncDataChannel || syncDataChannel.readyState !== "open") return;

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
    const chunkSize = 16 * 1024; // 16KB

    const sendChunk = async () => {
      while (offset < arrayBuffer.byteLength) {
        if (syncDataChannel.bufferedAmount > 64 * 1024) {
          await Promise.race([
            new Promise((resolve) => {
              syncDataChannel.onbufferedamountlow = () => {
                syncDataChannel.onbufferedamountlow = null;
                resolve();
              };
            }),
            new Promise((resolve) => setTimeout(resolve, 500)),
          ]);
        }
        const chunk = arrayBuffer.slice(offset, offset + chunkSize);
        syncDataChannel.send(chunk);
        offset += chunkSize;

        // ★ 解決策2: チャンク送信の合間に非同期のインターバルを挟みテキスト通信の割り込みを許可する
        if (offset % (chunkSize * 20) === 0) {
          // requestAnimationFrameを用いることでブラウザのUI描画とパケット処理を両立させる
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
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
  function handleSyncMessage(event) {
    if (typeof event.data !== "string") {
      incomingFile.push(event.data);

      // プログレス表示を files-area 内の要素へ反映
      if (
        incomingFileInfo &&
        incomingFileInfo.size > 0 &&
        incomingFile.length % 50 === 0
      ) {
        const received = incomingFile.length * (16 * 1024);
        const percent = Math.min(
          100,
          Math.floor((received / incomingFileInfo.size) * 100),
        );

        if (receivingFiles[incomingFileInfo.tag]) {
          receivingFiles[incomingFileInfo.tag].percent = percent;
          const progressSpan = document.getElementById(
            `progress-${incomingFileInfo.tag}`,
          );
          if (progressSpan)
            progressSpan.textContent = `(Receiving ${percent}%)`;
        }
      }
      return;
    }

    try {
      let data = JSON.parse(event.data);

      // ★ ここから追加：テキスト分割データの結合処理
      if (data.type === "sync_state_start") {
        incomingTextChunks = [];
        return;
      }
      if (data.type === "sync_state_chunk") {
        incomingTextChunks.push(data.data);
        return;
      }
      if (data.type === "sync_state_end") {
        const fullText = incomingTextChunks.join("");
        incomingTextChunks = [];
        data = JSON.parse(fullText); // 結合したデータをパースし直し data 変数に上書き
      }
      if (data.type === "file_start") {
        incomingFileInfo = data;
        incomingFile = [];

        // ★ 読み込み開始を登録し、files-area に表示させる
        receivingFiles[data.tag] = { name: data.name, percent: 0 };
        updateFiles();
        return;
      }

      if (data.type === "file_end" && incomingFileInfo) {
        const fileTag = incomingFileInfo.tag;
        const mimeType = incomingFileInfo.mimeType;
        const chunks = incomingFile;

        incomingFile = [];
        incomingFileInfo = null;

        if (receivingFiles[fileTag]) {
          receivingFiles[fileTag].percent = "Processing...";
          const progressSpan = document.getElementById(`progress-${fileTag}`);
          if (progressSpan) progressSpan.textContent = `(Processing...)`;
        }

        setTimeout(() => {
          try {
            const blob = new Blob(chunks, { type: mimeType });
            const finishSave = () => {
              delete receivingFiles[fileTag]; // ★ 保存完了後に受信中リストから削除
              updateFiles();
            };

            if (db) {
              const tx = db.transaction("files", "readwrite");
              tx.objectStore("files").put(blob, fileTag);
              tx.oncomplete = finishSave;
              tx.onerror = () => {
                incomingFiles[fileTag] = blob;
                finishSave();
              };
            } else {
              incomingFiles[fileTag] = blob;
              finishSave();
            }
          } catch (e) {
            console.error("File processing error:", e);
            delete receivingFiles[fileTag];
            updateFiles();
          }
        }, 50);
        return;
      }

      // 以下既存の同期処理（sync_request, sync_state 等）はそのまま
      if (data.type === "sync_request" && !isMobileMode) {
        saveToStorage();
        return;
      }
      if (data.type === "ping" || data.type === "pong") return;

      if (data.type === "sync_state" && data.tabs && data.tabs.length > 0) {
        const activeTabBeforeSync = state.tabs.find(
          (t) => t.id === state.activeTabId,
        );
        const sameTabInIncoming = data.tabs.find(
          (t) => t.id === state.activeTabId,
        );

        if (
          activeTabBeforeSync &&
          sameTabInIncoming &&
          activeTabBeforeSync.text !== sameTabInIncoming.text
        ) {
          pushSnapshot();
        }

        state.tabs = data.tabs;
        state.activeTabId = data.activeTabId;
        if (isMobileMode) {
          // モバイルの場合は強制的にタブを切り替えてUIを再描画させる
          switchTab(state.activeTabId, true);
        } else {
          // PCの場合はカーソル飛びを防ぐための既存ロジックを維持
          const t = state.tabs.find((t) => t.id === state.activeTabId);
          if (
            els.memoArea.value !== (t ? t.text : "") &&
            document.activeElement !== els.memoArea
          ) {
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
          if (!isMobileMode) {
            chrome.storage.local.set({
              tabs: state.tabs,
              activeTabId: state.activeTabId,
            });
          }
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
  if (!isWindowMode && !isMobileMode && typeof localStorage !== "undefined") {
    try {
      const savedW =
        localStorage.getItem("memoW") || localStorage.getItem("lastPopW");
      const savedH =
        localStorage.getItem("memoH") || localStorage.getItem("lastPopH");
      if (savedW && savedH) {
        els.memoArea.style.width = savedW;
        els.memoArea.style.height = savedH;
        state.mWidth = savedW;
        state.mHeight = savedH;
        document.documentElement.style.width = savedW;
        document.documentElement.style.height = savedH;
        document.body.style.width = savedW;
        document.body.style.height = savedH;
        document.body.style.minWidth = savedW;
        document.body.style.minHeight = savedH;
      }
    } catch (e) {
      console.warn("localStorage access denied in incognito mode.");
    }
  }
  function disconnectSync() {
    if (signalingPollInterval) {
      clearInterval(signalingPollInterval);
      signalingPollInterval = null;
    }
    if (syncDataChannel) {
      syncDataChannel.onopen = null;
      syncDataChannel.onmessage = null;
      syncDataChannel.onclose = null;
      syncDataChannel.onerror = null;
      try {
        syncDataChannel.close();
      } catch (e) {}
      syncDataChannel = null;
    }
    if (syncPeerConnection) {
      syncPeerConnection.onicecandidate = null;
      syncPeerConnection.ondatachannel = null;
      syncPeerConnection.onconnectionstatechange = null;
      try {
        syncPeerConnection.close();
      } catch (e) {}
      syncPeerConnection = null;
    }
    incomingFile = [];
    incomingFileInfo = null;
    if (typeof fileSendQueue !== "undefined") {
      fileSendQueue.length = 0;
      isSendingFile = false;
    }
  }

  const initDB = () => {
    try {
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
      req.onerror = (e) => {
        console.warn("IndexedDB is disabled (e.g., incognito mode).");
        db = null; // メモリモードへ移行
        updateFiles();
      };
    } catch (e) {
      console.warn("IndexedDB access denied.");
      db = null;
    }
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
        state.tabs = res.tabs?.length
          ? res.tabs
          : [{ id: Date.now(), text: "" }];
        Object.assign(state, {
          activeTabId: res.activeTabId || state.activeTabId,
          wWidth: res.windowWidth || state.wWidth,
          wHeight: res.windowHeight || state.wHeight,
          mWidth: res.memoWidth || state.mWidth,
          mHeight: res.memoHeight || state.mHeight,
        });

        if (!state.tabs.some((t) => t.id === state.activeTabId)) {
          state.activeTabId = state.tabs[0].id;
        }
        applyModeLayout();
        switchTab(state.activeTabId);
        updateUndoRedo();
      },
    );
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.tabs) {
        state.tabs = changes.tabs.newValue || [];
        const currentTab = state.tabs.find((t) => t.id === state.activeTabId);

        // 追加: テキストエリアにフォーカスがない場合のみ更新を許可
        if (
          currentTab &&
          els.memoArea.value !== currentTab.text &&
          document.activeElement !== els.memoArea
        ) {
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

      els.tabContainer.parentElement.style.width = els.memoArea.style.width;
    }
  }

  function saveToStorage() {
    const currentTab = state.tabs.find((t) => t.id === state.activeTabId);
    if (currentTab && els.memoArea) {
      currentTab.scrollTop = els.memoArea.scrollTop;
      if (typeof els.memoArea.selectionStart === "number") {
        currentTab.selectionStart = els.memoArea.selectionStart;
        currentTab.selectionEnd = els.memoArea.selectionEnd;
      }
    }
    if (
      typeof chrome !== "undefined" &&
      chrome.storage &&
      chrome.storage.local
    ) {
      chrome.storage.local.set({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        memoWidth: state.mWidth,
        memoHeight: state.mHeight,
        windowWidth: state.wWidth,
        windowHeight: state.wHeight,
      });
    }
    if (!isWindowMode && !isMobileMode) {
      try {
        localStorage.setItem("memoW", state.mWidth);
        localStorage.setItem("memoH", state.mHeight);
      } catch (e) {
        console.warn("localStorage access denied in incognito mode.");
      }
    }
    if (syncDataChannel?.readyState === "open") {
      const statePayload = JSON.stringify({
        type: "sync_state",
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        searchVisible: els.searchContainer.style.display === "flex",
        searchValue: els.searchInput.value,
      });
      const chunkSize = 10000;
      syncDataChannel.send(JSON.stringify({ type: "sync_state_start" }));

      for (let i = 0; i < statePayload.length; i += chunkSize) {
        syncDataChannel.send(
          JSON.stringify({
            type: "sync_state_chunk",
            data: statePayload.slice(i, i + chunkSize),
          }),
        );
      }

      syncDataChannel.send(JSON.stringify({ type: "sync_state_end" }));
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
    const urls = els.memoArea.value.match(/https?:\/\/[^\s)\]。、]+/g) || [];

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
  function updateFiles() {
    if (!els.filesArea) return;

    const processFiles = (dbKeys = []) => {
      if (els.filesArea._blobUrls) {
        els.filesArea._blobUrls.forEach((url) => URL.revokeObjectURL(url));
      }
      els.filesArea._blobUrls = [];
      els.filesArea.innerHTML = "";

      const currentText = els.memoArea.value;
      const memoryKeys = Object.keys(incomingFiles);
      const receivingKeys = Object.keys(receivingFiles); // ★追加: 受信中のキーを取得

      // ★DB、メモリ、受信中のキーをすべて結合
      const allKeys = Array.from(
        new Set([...dbKeys, ...memoryKeys, ...receivingKeys]),
      );
      let activeFiles = allKeys.filter((key) => currentText.includes(key));

      activeFiles.sort(
        (a, b) => currentText.indexOf(a) - currentText.indexOf(b),
      );

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

        const wrapper = document.createElement("div");
        wrapper.className = "file-link";
        wrapper.style.display = "inline-flex";
        wrapper.style.alignItems = "center";
        wrapper.style.padding = "0px 4px 0px 0px";
        wrapper.style.gap = "2px";
        wrapper.style.marginBottom = "4px";

        const viewLink = document.createElement("a");
        viewLink.target = "_blank";
        viewLink.style.textDecoration = "none";
        viewLink.style.color = "inherit";
        viewLink.style.display = "flex";
        viewLink.style.alignItems = "center";
        viewLink.style.gap = "4px";
        viewLink.style.padding = "0px 4px";
        viewLink.style.borderRadius = "4px";
        viewLink.style.cursor = "pointer";

        // 基本のアイコン
        viewLink.innerHTML = `
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" class="link-icon">
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
            <polyline points="13 2 13 9 20 9"></polyline>
          </svg>
          <span class="link-text">${displayStr}</span>
        `;

        const isMobile = typeof isMobileMode !== "undefined" && isMobileMode;
        let downloadBtn = null;

        if (!isMobile) {
          downloadBtn = document.createElement("a");
          downloadBtn.download = displayStr;
          downloadBtn.title = "Download file";
          // (中略 - 既存のスタイル設定)
          downloadBtn.style.color = "inherit";
          downloadBtn.style.display = "flex";
          downloadBtn.style.alignItems = "center";
          downloadBtn.style.padding = "2px";
          downloadBtn.style.borderRadius = "4px";
          downloadBtn.style.transition = "background-color 0.2s";
          downloadBtn.style.cursor = "pointer";
          downloadBtn.onmouseenter = () =>
            (downloadBtn.style.backgroundColor = "rgba(130,130,130,0.2)");
          downloadBtn.onmouseleave = () =>
            (downloadBtn.style.backgroundColor = "transparent");
          downloadBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
          `;
        }

        const displayFile = (blob) => {
          const url = URL.createObjectURL(blob);
          els.filesArea._blobUrls.push(url);
          viewLink.href = url;
          if (downloadBtn) downloadBtn.href = url;

          if (blob.type && blob.type.startsWith("video/")) {
            viewLink.innerHTML = `
              <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" class="link-icon">
                <circle cx="12" cy="12" r="10"></circle>
                <polygon points="10 8 16 12 10 16 10 8"></polygon>
              </svg>
              <span class="link-text">${displayStr}</span>
            `;
          }

          wrapper.draggable = true;
          wrapper.addEventListener("dragstart", (e) => {
            const mimeType = blob.type || "application/octet-stream";
            e.dataTransfer.setData(
              "DownloadURL",
              `${mimeType}:${displayStr}:${url}`,
            );
          });
        };

        const alertMsg = (e) => {
          e.preventDefault();
          alert("File data not found");
        };

        // ★分岐を追加：受信中の場合はプログレスを表示しリンクを無効化
        if (receivingFiles && receivingFiles[fileTag]) {
          viewLink.style.opacity = "0.6";
          viewLink.style.cursor = "default";
          viewLink.innerHTML = `
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" class="link-icon">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            <span class="link-text">${displayStr}</span>
            <span id="progress-${fileTag}" style="font-size: 11px; margin-left: 4px; color: var(--accent-blue);">(${receivingFiles[fileTag].percent}%)</span>
          `;
          viewLink.onclick = (e) => e.preventDefault();
          if (downloadBtn) downloadBtn.style.display = "none";
        } else if (incomingFiles && incomingFiles[fileTag]) {
          displayFile(incomingFiles[fileTag]);
        } else if (db) {
          try {
            const getReq = db
              .transaction("files", "readonly")
              .objectStore("files")
              .get(fileTag);
            getReq.onsuccess = () => {
              if (getReq.result) displayFile(getReq.result);
              else {
                viewLink.onclick = alertMsg;
                if (downloadBtn) downloadBtn.onclick = alertMsg;
              }
            };
            getReq.onerror = () => {
              viewLink.onclick = alertMsg;
              if (downloadBtn) downloadBtn.onclick = alertMsg;
            };
          } catch (e) {
            viewLink.onclick = alertMsg;
            if (downloadBtn) downloadBtn.onclick = alertMsg;
          }
        } else {
          viewLink.onclick = alertMsg;
          if (downloadBtn) downloadBtn.onclick = alertMsg;
        }

        wrapper.appendChild(viewLink);
        if (downloadBtn) wrapper.appendChild(downloadBtn);

        els.filesArea.appendChild(wrapper);
      });
    };

    if (db) {
      try {
        const tx = db.transaction("files", "readonly");
        const req = tx.objectStore("files").getAllKeys();
        req.onsuccess = () => processFiles(req.result);
        req.onerror = () => processFiles([]);
      } catch (e) {
        processFiles([]);
      }
    } else {
      processFiles([]);
    }
  }
  function updateCharCount() {
    els.charCount.textContent = `${els.memoArea.value.length}`;
    els.charCount.style.color = "";
  }

  function renderTabs() {
    els.tabContainer.innerHTML = "";

    state.tabs.forEach((tab, i) => {
      const btn = document.createElement("button");

      const firstLine = tab.text
        ? tab.text.split(/\r?\n/)[0].trim().substring(0, 15)
        : "";
      const displayTitle = firstLine ? `${firstLine}` : `Tab ${i + 1}`; // タイトルがあればそれを、なければデフォルトのTab番号を表示

      Object.assign(btn, {
        textContent: i + 1,
        title: displayTitle, // ★修正：デフォルトのTab番号からプレビュー付きに変更
      });
      if (tab.id === state.activeTabId) btn.classList.add("active");

      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        state.contextTargetId = tab.id;
        els.contextMenu.style.left = `${e.clientX}px`;
        els.contextMenu.style.top = `${e.clientY}px`;
        els.contextMenu.style.display = "block";
      });

      btn.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        if (isMobileMode) {
          switchTab(tab.id);
          return;
        }

        let dragged = false;
        const startX = e.clientX;
        const startY = e.clientY;
        let placeholder = null;

        const onPointerMove = (moveEvent) => {
          if (!dragged) {
            if (
              Math.abs(moveEvent.clientX - startX) > 12 ||
              Math.abs(moveEvent.clientY - startY) > 12
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
            btn.style.left = `${moveEvent.clientX - btn.offsetWidth / 2}px`;
            btn.style.top = `${moveEvent.clientY - btn.offsetHeight / 2}px`;

            const elements = document.elementsFromPoint(
              moveEvent.clientX,
              moveEvent.clientY,
            );
            const targetTab = elements.find(
              (el) =>
                el.parentElement === els.tabContainer && el !== placeholder,
            );

            if (targetTab) {
              const targetRect = targetTab.getBoundingClientRect();
              if (moveEvent.clientX > targetRect.left + targetRect.width / 2) {
                els.tabContainer.insertBefore(
                  placeholder,
                  targetTab.nextSibling,
                );
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

            saveToStorage();
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

    // 【変更箇所】別のタブに切り替わる時だけ保存するように条件で囲む
    if (state.activeTabId !== id && state.activeTabId !== null) {
      const prevTab = state.tabs.find((t) => t.id === state.activeTabId);
      if (prevTab && typeof els.memoArea.selectionStart === "number") {
        prevTab.scrollTop = els.memoArea.scrollTop;
        prevTab.selectionStart = els.memoArea.selectionStart;
        prevTab.selectionEnd = els.memoArea.selectionEnd;
      }
    }

    state.activeTabId = id;
    const t = state.tabs.find((t) => t.id === id);
    els.memoArea.value = t ? t.text : "";

    // ★ 変更箇所1: setTimeoutの外にあった updateUI() を削除し描画処理だけ残す
    renderTabs();
    if (els.backdrop) els.backdrop.innerHTML = "";

    setTimeout(() => {
      if (t) {
        els.memoArea.focus();
        if (t.selectionStart !== undefined) {
          const safeStart = Math.min(
            t.selectionStart,
            els.memoArea.value.length,
          );
          const safeEnd = Math.min(t.selectionEnd, els.memoArea.value.length);
          els.memoArea.setSelectionRange(safeStart, safeEnd);
        }
        if (t.scrollTop !== undefined) {
          els.memoArea.scrollTop = t.scrollTop;
        }
      }
      // ★ 変更箇所2: カーソル復元が完了した後に updateUI() を実行する
      updateUI();
    }, 10);
  }
  function saveCursorPosition() {
    const t = state.tabs.find((t) => t.id === state.activeTabId);
    if (t && typeof els.memoArea.selectionStart === "number") {
      t.selectionStart = els.memoArea.selectionStart;
      t.selectionEnd = els.memoArea.selectionEnd;
      saveToStorage();
    }
  }

  els.memoArea.addEventListener("mouseup", saveCursorPosition);
  els.memoArea.addEventListener("keyup", (e) => {
    const moveKeys = [
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ];
    if (moveKeys.includes(e.code)) saveCursorPosition();
  });

  function addTab() {
    resetDisconnectUI();
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
        const targetIdx = state.tabs.findIndex(
          (t) => t.id === state.targetTabId,
        );
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

    let start = els.memoArea.selectionStart;
    let end = els.memoArea.selectionEnd;
    const val = els.memoArea.value;

    if (document.activeElement !== els.memoArea) {
      start = val.length;
      end = val.length;
    }

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

    const beforeText = text.slice(0, idx);
    const highlightText = text.slice(idx, idx + len);
    const afterText = text.slice(idx + len);

    els.backdrop.innerHTML = "";
    els.backdrop.appendChild(document.createTextNode(beforeText));

    const markEl = document.createElement("mark");
    markEl.textContent = highlightText;
    els.backdrop.appendChild(markEl);

    els.backdrop.appendChild(document.createTextNode(afterText));
    els.backdrop.appendChild(document.createElement("br"));

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
  els.modeSwitchBtn.onclick = openInWindow;
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
    // dbのチェックを外す
    if (!e.dataTransfer.files.length) return;
    for (const file of e.dataTransfer.files) {
      const fileTag = getUniqueFileTag(file.name);

      const finishSave = () => {
        updateFiles();
        insertText(fileTag + "\n");
        enqueueFile(file, fileTag, file.name);
      };

      if (db) {
        const tx = db.transaction("files", "readwrite");
        tx.objectStore("files").put(file, fileTag);
        tx.oncomplete = finishSave;
        tx.onerror = () => {
          incomingFiles[fileTag] = file;
          finishSave();
        };
      } else {
        incomingFiles[fileTag] = file;
        finishSave();
      }
    }
  });
  els.memoArea.addEventListener("paste", (e) => {
    // dbのチェックを外す
    if (!e.clipboardData || !e.clipboardData.items) return;

    const items = e.clipboardData.items;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf("image") !== -1) {
        const file = items[i].getAsFile();
        if (!file) continue;

        e.preventDefault();

        const d = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        const timestamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
        const ext = file.type.split("/")[1] || "png";
        const fileName = `screenshot_${timestamp}.${ext}`;

        const fileTag = getUniqueFileTag(fileName);

        const finishSave = async () => {
          insertText(fileTag + "\n");
          updateFiles();
          enqueueFile(file, fileTag, fileName);
        };

        if (db) {
          const tx = db.transaction("files", "readwrite");
          tx.objectStore("files").put(file, fileTag);
          tx.oncomplete = finishSave;
          tx.onerror = () => {
            incomingFiles[fileTag] = file;
            finishSave();
          };
        } else {
          incomingFiles[fileTag] = file;
          finishSave();
        }
      }
    }
  });
  els.memoArea.addEventListener("focus", resetDisconnectUI);
  els.memoArea.addEventListener("input", (e) => {
    resetDisconnectUI();
    if (e.inputType === "historyUndo") {
      handleHistory(true);
      return;
    }
    if (e.inputType === "historyRedo") {
      handleHistory(false);
      return;
    }

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
  function updateCursorPositionAndSave() {
    const t = state.tabs.find((t) => t.id === state.activeTabId);
    if (t && typeof els.memoArea.selectionStart === "number") {
      t.selectionStart = els.memoArea.selectionStart;
      t.selectionEnd = els.memoArea.selectionEnd;
      saveToStorage();
    }
  }
  els.memoArea.addEventListener("mouseup", updateCursorPositionAndSave);

  // 矢印キーなどでカーソルを移動した時
  els.memoArea.addEventListener("keyup", (e) => {
    const moveKeys = [
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ];
    if (moveKeys.includes(e.code)) {
      updateCursorPositionAndSave();
    }
  });
  els.memoArea.addEventListener("blur", updateCursorPositionAndSave);

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

  document.addEventListener("click", (e) => {
    if (els.contextMenu) els.contextMenu.style.display = "none";

    const qrContainer = document.getElementById("qr-container");
    const connectBtn = document.getElementById("connect-btn");

    if (qrContainer && connectBtn) {
      const isConnecting =
        qrContainer.style.display !== "none" ||
        connectBtn.title.includes("unconnect");
      const isOutsideClick =
        !connectBtn.contains(e.target) && !qrContainer.contains(e.target);

      if (isConnecting && isOutsideClick) {
        disconnectSync();
        connectBtn.title = "Connect to another device(Ctrl + Q)";
        connectBtn.style.color = "";
        qrContainer.style.display = "none";
        els.charCount.style.color = "";
        els.memoArea.style.backgroundColor = "";
        els.memoArea.readOnly = false;
        updateCharCount();
      }
    }
  });
  // IME変換中フラグ
  let isComposing = false;
  els.memoArea.addEventListener("compositionstart", () => {
    isComposing = true;
  });
  els.memoArea.addEventListener("compositionend", () => {
    isComposing = false;
  });

  document.addEventListener("keydown", (e) => {
    if (
      e.code === "Tab" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      document.activeElement === els.memoArea
    ) {
      e.preventDefault();
      // ★ IME変換中（日本語入力のTab確定）はスペース挿入しない
      if (!isComposing) {
        insertText("    ");
      }
      return;
    }
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
    } else if (c === "KeyQ" && !e.shiftKey) {
      e.preventDefault();
      const btn = document.getElementById("connect-btn");
      if (btn && btn.style.display !== "none") btn.click();
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
      }, 150);
    });
  } else {
    let isResizing = false;
    const ro = new ResizeObserver(() => {
      if (isResizing) return;
      isResizing = true;

      requestAnimationFrame(() => {
        const mw = els.memoArea.style.width;
        const mh = els.memoArea.style.height;
        if (mw && mh) {
          try {
            localStorage.setItem("memoW", mw);
            localStorage.setItem("memoH", mh);
          } catch (e) {}
          state.mWidth = mw;
          state.mHeight = mh;
        }
        const w = Math.max(260, els.memoArea.offsetWidth + 32);

        const headerH = els.header ? els.header.offsetHeight : 0;
        const footerH = document.getElementById("footer")
          ? document.getElementById("footer").offsetHeight
          : 0;

        const linksH =
          els.linksArea && els.linksArea.style.display !== "none"
            ? els.linksArea.offsetHeight + 4
            : 0;
        const filesH =
          els.filesArea && els.filesArea.style.display !== "none"
            ? els.filesArea.offsetHeight + 4
            : 0;

        const baseMargins = 28;

        const h = Math.max(
          150,
          headerH +
            els.memoArea.offsetHeight +
            footerH +
            linksH +
            filesH +
            baseMargins,
        );

        document.documentElement.style.width = `${w}px`;
        document.documentElement.style.height = `${h}px`;
        document.body.style.width = `${w}px`;
        document.body.style.height = `${h}px`;
        document.body.style.minWidth = `${w}px`;
        document.body.style.minHeight = `${h}px`;
        syncBackdrop();
        try {
          localStorage.setItem("lastPopW", `${w}px`);
          localStorage.setItem("lastPopH", `${h}px`);
        } catch (e) {}

        els.tabContainer.parentElement.style.width = `${els.memoArea.offsetWidth}px`;
        setTimeout(() => {
          isResizing = false;
        }, 5);
      });
    });

    ro.observe(els.memoArea);
    ro.observe(els.linksArea);
    ro.observe(els.filesArea);
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
      // dbのチェックを外す
      if (!input.files.length) return;
      for (const file of input.files) {
        const fileTag = getUniqueFileTag(file.name);

        const finishSave = () => {
          insertText(fileTag + "\n");
          updateFiles();
          enqueueFile(file, fileTag, file.name);
        };

        if (db) {
          const tx = db.transaction("files", "readwrite");
          tx.objectStore("files").put(file, fileTag);
          tx.oncomplete = finishSave;
          tx.onerror = () => {
            incomingFiles[fileTag] = file;
            finishSave();
          };
        } else {
          // DBがない場合はメモリに保持して送信へ進む
          incomingFiles[fileTag] = file;
          finishSave();
        }
      }
    };
    input.click();
  };
  window.addEventListener("pagehide", () => {
    saveToStorage();
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
  const WORKER_URL = "https://memo-signaling.tanakasan32400.workers.dev";
  const MOBILE_SITE_URL = "https://tt100839.github.io/memo-help/mobile.html";

  function setupDataChannel(dc) {
    syncDataChannel = dc;
    dc.binaryType = "arraybuffer";
    dc.onmessage = handleSyncMessage;

    let heartbeatInterval = null;
    let heartbeatTimeout = null;
    let isBackground = false;

    // ★タブの表示状態を監視
    document.addEventListener("visibilitychange", () => {
      isBackground = document.hidden;
    });

    const startHeartbeat = () => {
      stopHeartbeat();
      heartbeatInterval = setInterval(() => {
        if (!syncDataChannel || syncDataChannel.readyState !== "open") {
          stopHeartbeat();
          return;
        }
        try {
          syncDataChannel.send(JSON.stringify({ type: "ping" }));
          const waitTime = isBackground ? 120000 : 20000;
          heartbeatTimeout = setTimeout(() => {
            console.warn("Heartbeat timeout: disconnected");
            oncloseHandler();
          }, waitTime);
        } catch (e) {
          oncloseHandler();
        }
      }, 15000);
    };

    const stopHeartbeat = () => {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
        heartbeatTimeout = null;
      }
    };

    // pingメッセージ処理をhandleSyncMessageに追加
    const originalOnMessage = dc.onmessage;
    dc.onmessage = (event) => {
      // ping/pongをインターセプト
      if (typeof event.data === "string") {
        try {
          const d = JSON.parse(event.data);
          if (d.type === "ping") {
            if (syncDataChannel && syncDataChannel.readyState === "open") {
              syncDataChannel.send(JSON.stringify({ type: "pong" }));
            }
            return;
          }
          if (d.type === "pong") {
            if (heartbeatTimeout) {
              clearTimeout(heartbeatTimeout);
              heartbeatTimeout = null;
            }
            return;
          }
        } catch (e) {}
      }
      handleSyncMessage(event);
    };

    const onOpenHandler = async () => {
      els.memoArea.placeholder = "";
      els.charCount.style.color = "";
      els.memoArea.style.backgroundColor = "";
      els.memoArea.readOnly = false;

      startHeartbeat();

      if (!isMobileMode) {
        saveToStorage();
        if (db) {
          setTimeout(async () => {
            const allText = state.tabs.map((t) => t.text).join("");
            const tx = db.transaction("files", "readonly");
            tx.objectStore("files").getAllKeys().onsuccess = async (e) => {
              const keys = e.target.result;
              const activeFiles = keys.filter((k) => allText.includes(k));

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
                  enqueueFile(fileData, tag, fileData.name || "shared_file");
                }
              }
            };
          }, 1000);
        }
        const btn = document.getElementById("connect-btn");
        if (btn) {
          btn.title = "Connected to mobile (click to disconnect)";
          btn.style.color = "#0f9d58";
          btn.disabled = false;
        }
      } else {
        if (syncDataChannel.readyState === "open") {
          syncDataChannel.send(JSON.stringify({ type: "sync_request" }));
        }
      }
    };

    dc.onopen = onOpenHandler;
    if (dc.readyState === "open") {
      onOpenHandler();
    }

    const oncloseHandler = () => {
      stopHeartbeat();
      els.memoArea.placeholder =
        "Disconnected. Please show the QR code again to reconnect.";
      if (!els.charCount.textContent.includes("Disconnected")) {
        els.charCount.textContent = "Disconnected " + els.charCount.textContent;
      }
      els.charCount.style.color = "#f44336";

      if (!isMobileMode) {
        const btn = document.getElementById("connect-btn");
        if (btn) {
          btn.title = "Disconnected. Click to reconnect.";
          btn.style.color = "#f44336";
          btn.disabled = false;
        }
      } else {
        els.memoArea.style.backgroundColor = "#f5f5f5";
        els.memoArea.readOnly = true;
      }

      disconnectSync();
    };

    dc.onclose = oncloseHandler;

    if (syncPeerConnection) {
      syncPeerConnection.addEventListener("connectionstatechange", () => {
        if (!syncPeerConnection) return;
        const connState = syncPeerConnection.connectionState;
        if (
          connState === "disconnected" ||
          connState === "failed" ||
          connState === "closed"
        ) {
          oncloseHandler();
        }
      });
    }

    dc.onerror = (error) => {
      console.error("DataChannel Error:", error);
      oncloseHandler();
    };
  }
  document.getElementById("connect-btn").onclick = async () => {
    const connectBtn = document.getElementById("connect-btn");

    if (syncPeerConnection || syncDataChannel) {
      disconnectSync();
      connectBtn.title = "Connect to another device(Ctrl + Q)";
      connectBtn.style.color = "";
      document.getElementById("qr-container").style.display = "none";
      els.charCount.style.color = "";
      els.memoArea.style.backgroundColor = "";
      els.memoArea.readOnly = false;
      updateCharCount();
      return;
    }

    connectBtn.title = "Preparing... (1/3)";
    connectBtn.style.color = "#f4b400";
    connectBtn.disabled = true;

    const sessionId = crypto.randomUUID();
    const connectUrl = MOBILE_SITE_URL + "?id=" + sessionId;

    // ★ try/catchスコープ外でpcを使わないよう全体をtry内に
    let pc;
    try {
      pc = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          {
            urls: [
              "turn:openrelay.metered.ca:80",
              "turn:openrelay.metered.ca:443",
              "turn:openrelay.metered.ca:443?transport=tcp",
            ],
            username: "openrelayproject",
            credential: "openrelayproject",
          },
        ],
      });
    } catch (err) {
      console.error(err);
      connectBtn.title = "WebRTC initialization failed";
      connectBtn.style.color = "#f44336";
      connectBtn.disabled = false;
      alert(
        "Failed to initialize WebRTC. WebRTC may be restricted in secret mode. Please try again in normal mode.",
      );
      return;
    }

    syncPeerConnection = pc;
    const dc = pc.createDataChannel("memo-channel");
    setupDataChannel(dc);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (err) {
      console.error("Offer creation failed:", err);
      connectBtn.title = "Offer creation failed";
      connectBtn.style.color = "#f44336";
      connectBtn.disabled = false;
      disconnectSync();
      return;
    }

    connectBtn.title = "Exploring routes... (2/3)";
    // PC側・モバイル側の経路探索ブロックを以下に置き換え
    await new Promise((resolve) => {
      let resolved = false;
      let timeoutId;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        resolve();
      };

      if (pc.iceGatheringState === "complete") {
        finish();
      } else {
        pc.addEventListener("icecandidate", (e) => {
          if (e.candidate) {
            // srflx(STUN) または relay(TURN) が見つかったら、
            // 少しだけ待機(500ms)して複数の候補を確保してから早期終了する
            if (
              e.candidate.candidate.includes("srflx") ||
              e.candidate.candidate.includes("relay")
            ) {
              setTimeout(finish, 500);
            }
          } else {
            finish(); // null candidate は完了を意味する
          }
        });
        pc.addEventListener("icegatheringstatechange", () => {
          if (pc.iceGatheringState === "complete") finish();
        });
        // モバイル回線の遅延を考慮し最大待機は6秒に設定
        timeoutId = setTimeout(finish, 6000);
      }
    });

    connectBtn.title = "Registering with server... (3/3)";
    try {
      const res = await fetch(WORKER_URL + "/offer?id=" + sessionId, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pc.localDescription),
      });
      if (!res.ok) throw new Error("Upload failed: " + res.status);
    } catch (err) {
      connectBtn.title = "Server connection error";
      connectBtn.style.color = "#f44336";
      connectBtn.disabled = false;
      disconnectSync();
      return;
    }

    // ★QRコードをOffer登録直後に表示（ユーザーがすぐ読み取れるように）
    const qrCanvas = document.getElementById("qr-image");
    new QRious({
      element: qrCanvas,
      value: connectUrl,
      size: 150,
      background: "white",
      foreground: "black",
    });
    const sessionIdText = document.getElementById("session-id-text");
    if (sessionIdText) {
      sessionIdText.innerHTML = `<span style="font-size:11px;color:#555;">Waiting for connection...</span><br><span id="copy-url-btn" style="color:#007aff;text-decoration:underline;cursor:pointer;font-size:12px;">Copy URL</span>`;
      document.getElementById("copy-url-btn").onclick = (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(connectUrl).then(() => {
          document.getElementById("copy-url-btn").textContent = "Copied!";
          setTimeout(() => {
            const el = document.getElementById("copy-url-btn");
            if (el) el.textContent = "Copy URL";
          }, 2000);
        });
      };
    }
    document.getElementById("qr-container").style.display = "block";
    connectBtn.title = "Waiting for mobile connection...";
    connectBtn.style.color = "#4285f4";
    connectBtn.disabled = false;

    // ★answerをポーリング（2秒間隔、最大60秒）
    let pollCount = 0;
    const maxPolls = 30;
    signalingPollInterval = setInterval(async () => {
      pollCount++;
      if (!syncPeerConnection || pc.signalingState === "closed") {
        clearInterval(signalingPollInterval);
        return;
      }
      if (pc.signalingState === "stable") {
        clearInterval(signalingPollInterval);
        return;
      }
      if (pollCount > maxPolls) {
        clearInterval(signalingPollInterval);
        connectBtn.title = "接続タイムアウト(60秒)";
        connectBtn.style.color = "#f44336";
        document.getElementById("qr-container").style.display = "none";
        disconnectSync();
        return;
      }
      try {
        // ★修正: キャッシュを無効化して確実に最新のAnswerを取得する
        const res = await fetch(WORKER_URL + "/answer?id=" + sessionId, {
          cache: "no-store",
          headers: {
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
          },
        });
        if (res.ok) {
          const answer = await res.json();
          await pc.setRemoteDescription(answer);
          clearInterval(signalingPollInterval);
          const qr = document.getElementById("qr-container");
          if (qr) qr.style.display = "none";
        }
      } catch (e) {
        // ポーリング中のエラーは無視して継続
      }
    }, 2000);
  };

  async function checkMobileConnection() {
    const sessionId = new URLSearchParams(window.location.search).get("id");
    if (!sessionId || !window.location.pathname.endsWith("mobile.html")) return;

    els.memoArea.placeholder = "PCに接続中(1/3)...";
    els.memoArea.readOnly = true;
    els.memoArea.style.backgroundColor = "#f5f5f5";

    let res;
    // PCのofferアップロードを待つ（最大20秒）
    for (let i = 0; i < 10; i++) {
      try {
        res = await fetch(WORKER_URL + "/offer?id=" + sessionId, {
          cache: "no-store", // ★追加: キャッシュを読まず最新を取得
          headers: {
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
          },
        });
        if (res.ok) break;
      } catch (e) {}
      const dots = ".".repeat((i % 3) + 1);
      els.memoArea.placeholder = `Waiting for connection from PC${dots} (${i + 1}/10)`;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (!res || !res.ok) {
      els.memoArea.readOnly = false;
      els.memoArea.style.backgroundColor = "";
      els.memoArea.value =
        "Session not found. Please display the QR code again on the PC.";
      return;
    }

    els.memoArea.placeholder = "Exploring routes... (2/3)...";

    let offer;
    try {
      offer = await res.json();
    } catch (e) {
      els.memoArea.value = "Failed to parse server data. Please try again.";
      els.memoArea.readOnly = false;
      els.memoArea.style.backgroundColor = "";
      return;
    }

    let pc;
    try {
      pc = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          {
            urls: [
              "turn:openrelay.metered.ca:80",
              "turn:openrelay.metered.ca:443",
              "turn:openrelay.metered.ca:443?transport=tcp",
            ],
            username: "openrelayproject",
            credential: "openrelayproject",
          },
        ],
      });
    } catch (err) {
      console.error(err);
      els.memoArea.readOnly = false;
      els.memoArea.style.backgroundColor = "";
      els.memoArea.value =
        "WebRTCの初期化に失敗しました。シークレットモードでは一部のブラウザで制限があります。";
      return;
    }

    syncPeerConnection = pc;
    pc.ondatachannel = (e) => {
      setupDataChannel(e.channel);
    };

    try {
      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
    } catch (err) {
      console.error("Answer creation failed:", err);
      els.memoArea.value =
        "接続ネゴシエーションに失敗しました。再試行してください。";
      els.memoArea.readOnly = false;
      els.memoArea.style.backgroundColor = "";
      disconnectSync();
      return;
    }

    // 修正後
    // ICE gatheringを待つ（STUNで外部候補を取得するまで）
    await new Promise((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };

      if (pc.iceGatheringState === "complete") {
        finish();
      } else {
        pc.addEventListener("icecandidate", (e) => {
          if (e.candidate) {
            // srflx = STUNで取得した外部IP, relay = TURNリレー
            if (
              e.candidate.candidate.includes("srflx") ||
              e.candidate.candidate.includes("relay")
            ) {
              finish();
            }
          } else {
            // null candidate = gathering complete
            finish();
          }
        });
        pc.addEventListener("icegatheringstatechange", () => {
          if (pc.iceGatheringState === "complete") finish();
        });
        // ★タイムアウトを10秒に延長（モバイル回線対応）
        setTimeout(finish, 3000);
      }
    });

    els.memoArea.placeholder = "サーバーに登録中(3/3)...";
    try {
      const postRes = await fetch(WORKER_URL + "/answer?id=" + sessionId, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pc.localDescription),
      });
      if (!postRes.ok)
        throw new Error("Answer upload failed: " + postRes.status);
    } catch (err) {
      console.error(err);
      els.memoArea.value =
        "Answerのサーバー登録に失敗しました。再試行してください。";
      els.memoArea.readOnly = false;
      els.memoArea.style.backgroundColor = "";
      disconnectSync();
      return;
    }

    els.memoArea.placeholder = "同期完了を待機中...";
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed") {
        els.memoArea.placeholder =
          "接続に失敗しました。QRコードを再表示してください。";
        els.memoArea.readOnly = false;
        els.memoArea.style.backgroundColor = "";
        disconnectSync();
      }
      if (pc.connectionState === "connected") {
        els.memoArea.placeholder = "";
      }
    });
  }
  window.addEventListener("offline", () => {
    const btn = document.getElementById("connect-btn");
    if (btn) {
      btn.title = "Network disconnected. Please check your Wi-Fi.";
      btn.style.color = "#f44336";
    }
    if (syncPeerConnection || syncDataChannel) {
      els.memoArea.placeholder = "Error: Wi-Fi/Network disconnected.";
      disconnectSync();
    }
  });

  window.addEventListener("online", () => {
    const btn = document.getElementById("connect-btn");
    if (btn && btn.style.color === "rgb(244, 67, 54)") {
      btn.title = "Network restored. Ready to connect.";
      btn.style.color = "";
    }

    // ★追加: ネットワーク復帰（Wi-Fi⇔モバイル切り替え等）時にスマホ側なら自動再接続を試みる
    if (typeof isMobileMode !== "undefined" && isMobileMode) {
      if (!syncDataChannel || syncDataChannel.readyState !== "open") {
        const sessionId = new URLSearchParams(window.location.search).get("id");
        if (sessionId) {
          els.memoArea.placeholder =
            "ネットワークの切り替えを検知しました。再接続を試行中...";
          els.memoArea.readOnly = true;
          // ネットワークが完全に安定するまで1秒ほど待機して再接続
          setTimeout(() => {
            checkMobileConnection();
          }, 1000);
        }
      }
    }
  });

  checkMobileConnection();

  // ★追加：スマホのバックグラウンド復帰時の自動再接続ロジック
  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState === "visible" &&
      typeof isMobileMode !== "undefined" &&
      isMobileMode
    ) {
      // 画面が表示された際、通信経路が死んでいたら再接続を試みる
      if (!syncDataChannel || syncDataChannel.readyState !== "open") {
        const sessionId = new URLSearchParams(window.location.search).get("id");
        if (sessionId) {
          // 少しだけ待機して（OSのネットワーク復帰待ち）再接続を実行
          setTimeout(() => {
            els.memoArea.placeholder = "通信復帰を試行中...";
            checkMobileConnection();
          }, 1000);
        }
      }
    }
  });
})();
