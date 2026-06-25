/* ============================================================
   AutoHotkey v2 Script Builder
   ------------------------------------------------------------
   Application state lives in `state`. Everything else reads or
   mutates it. The queue is rendered from `state.queue` each
   time it changes. Cropped images are stored as data URLs so
   they can later be re-encoded as PNG files inside the zip.
   ============================================================ */

const state = {
  screenshot: null,        // { image: HTMLImageElement, naturalW, naturalH }
  queue: [],               // ordered list of action objects
  selectedItemId: null,    // currently being edited in middle panel
  pendingCrop: null,       // crop awaiting "Add to Queue"
  exitBehavior: 'log',     // 'log' | 'nolog'
  saveScreenshots: true,   // save a screenshot after each step to logs/<timestamp>/
  justAddedId: null,       // briefly flagged for flash-in animation on render
  recropTargetId: null,    // when set, the next crop replaces this item's image
};

let nextId = 1;
const newId = () => `act_${nextId++}`;

// Shortcut DOM helper
const $ = (id) => document.getElementById(id);

/* ============================================================
   SECTION 0 — Persistence (autosave) + undo
   ============================================================ */

const AUTOSAVE_KEY = 'ahk_builder_autosave_v1';
const undoStack = [];
const UNDO_LIMIT = 50;

// Serialize the parts of state worth persisting / undoing.
function snapshotState() {
  return JSON.stringify({
    queue: state.queue,
    exitBehavior: state.exitBehavior,
    saveScreenshots: state.saveScreenshots,
    nextId,
  });
}

// Restore from a snapshot string (used by undo and autosave restore).
function restoreSnapshot(json) {
  const data = JSON.parse(json);
  state.queue = sanitizeLoadedQueue(data.queue || []);
  state.exitBehavior = data.exitBehavior || 'log';
  state.saveScreenshots = data.saveScreenshots !== false;
  if (typeof data.nextId === 'number') nextId = data.nextId;
  if ($('exitBehavior')) $('exitBehavior').value = state.exitBehavior;
  if ($('saveScreenshots')) $('saveScreenshots').checked = state.saveScreenshots;
}

// Write current state to localStorage (best-effort; ignores quota errors).
function autosave() {
  try {
    localStorage.setItem(AUTOSAVE_KEY, snapshotState());
  } catch (err) {
    // localStorage may be unavailable (private mode / file:// in some browsers).
    // Autosave is a convenience, so we silently continue.
  }
}

// Push the *current* state onto the undo stack before a mutation.
// Call this immediately BEFORE changing state.
function pushUndo() {
  undoStack.push(snapshotState());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function undo() {
  if (undoStack.length === 0) return;
  const prev = undoStack.pop();
  restoreSnapshot(prev);
  state.selectedItemId = null;
  closeItemEditor();
  hideCropPreview();
  renderQueue();
  autosave();
}

// Standard wrapper: snapshot for undo, then mutate (via callback), then
// render + autosave. Keeps every mutation consistent.
function commitChange(mutateFn) {
  pushUndo();
  mutateFn();
  renderQueue();
  autosave();
}

/* ============================================================
   SECTION 1 — Screenshot import and display
   ============================================================ */

const dropZone = $('dropZone');
const fileInput = $('fileInput');
const screenshotCanvas = $('screenshotCanvas');
const ctx = screenshotCanvas.getContext('2d');

$('browseBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) loadScreenshotFile(e.target.files[0]);
});

['dragenter', 'dragover'].forEach(ev =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach(ev =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  })
);
dropZone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) loadScreenshotFile(file);
});

// Paste a screenshot from the clipboard (Ctrl+V anywhere on the page,
// except inside text inputs where the user is editing fields).
document.addEventListener('paste', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
    return; // Don't hijack paste in editable fields
  }
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.type && it.type.startsWith('image/')) {
      const file = it.getAsFile();
      if (file) {
        loadScreenshotFile(file);
        e.preventDefault();
        return;
      }
    }
  }
});

function loadScreenshotFile(file) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      state.screenshot = {
        image: img,
        naturalW: img.naturalWidth,
        naturalH: img.naturalHeight,
      };
      // Unhide the workspace first so the viewport has a real width when
      // we compute the fit-to-width zoom.
      dropZone.classList.add('hidden');
      $('screenshotArea').classList.remove('hidden');
      drawScreenshot();
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

function drawScreenshot() {
  const img = state.screenshot.image;
  // The canvas keeps the image's natural size internally so crop pixel
  // coords match the original screenshot precisely. Zoom only changes the
  // CSS display size of the canvas (see applyZoom).
  screenshotCanvas.width = img.naturalWidth;
  screenshotCanvas.height = img.naturalHeight;
  ctx.drawImage(img, 0, 0);
  zoomFitToWidth();   // start at a sensible fit
}

/* ============================================================
   SECTION 1b — Zoom controls
   ============================================================ */

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.25;   // multiplicative step per click
let zoomFactor = 1;

// Apply the current zoom factor by setting the canvas's CSS display size.
// The internal resolution is unchanged, so selection math (which reads
// getBoundingClientRect) stays correct at any zoom.
function applyZoom() {
  if (!state.screenshot) return;
  zoomFactor = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomFactor));
  const w = screenshotCanvas.width * zoomFactor;
  const h = screenshotCanvas.height * zoomFactor;
  screenshotCanvas.style.width = w + 'px';
  screenshotCanvas.style.height = h + 'px';
  $('zoomLevel').textContent = Math.round(zoomFactor * 100) + '%';
  // Keep the on-screen selection box aligned with the (re-sized) canvas.
  if (currentRect) showSelectionBox();
}

// Set zoom so the image fits the viewport width.
function zoomFitToWidth() {
  if (!state.screenshot) return;
  const viewport = $('canvasViewport');
  const available = viewport.clientWidth - 4; // small padding allowance
  zoomFactor = available / screenshotCanvas.width;
  applyZoom();
}

// Zoom centered on a specific viewport point (px relative to viewport).
function zoomAtPoint(newFactor, viewportX, viewportY) {
  const viewport = $('canvasViewport');
  // Position within the scrollable content before zoom.
  const contentX = viewport.scrollLeft + viewportX;
  const contentY = viewport.scrollTop + viewportY;
  const ratio = newFactor / zoomFactor;
  zoomFactor = newFactor;
  applyZoom();
  // After resize, adjust scroll so the same image point stays under cursor.
  viewport.scrollLeft = contentX * ratio - viewportX;
  viewport.scrollTop = contentY * ratio - viewportY;
}

$('zoomInBtn').addEventListener('click', () => { zoomFactor *= ZOOM_STEP; applyZoom(); });
$('zoomOutBtn').addEventListener('click', () => { zoomFactor /= ZOOM_STEP; applyZoom(); });
$('zoom100Btn').addEventListener('click', () => { zoomFactor = 1; applyZoom(); });
$('zoomFitBtn').addEventListener('click', zoomFitToWidth);

// Ctrl + mouse wheel zooms toward the cursor.
$('canvasViewport').addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;       // normal scroll without Ctrl
  e.preventDefault();
  const viewport = $('canvasViewport');
  const vRect = viewport.getBoundingClientRect();
  const vx = e.clientX - vRect.left;
  const vy = e.clientY - vRect.top;
  const dir = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
  let target = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomFactor * dir));
  zoomAtPoint(target, vx, vy);
}, { passive: false });

$('clearScreenshotBtn').addEventListener('click', () => {
  state.screenshot = null;
  $('screenshotArea').classList.add('hidden');
  dropZone.classList.remove('hidden');
  hideCropPreview();
});

/* ============================================================
   SECTION 2 — Drawing the selection rectangle
   ============================================================ */

const selectionBox = $('selectionBox');
let dragStart = null;     // {x, y} in CSS pixels relative to canvas
let currentRect = null;   // {x, y, w, h} in *canvas* pixels (natural)

screenshotCanvas.addEventListener('mousedown', (e) => {
  const { x, y } = canvasCoords(e);
  dragStart = { x, y };
  currentRect = { x, y, w: 0, h: 0 };
  showSelectionBox();
});

screenshotCanvas.addEventListener('mousemove', (e) => {
  if (!dragStart) return;
  const { x, y } = canvasCoords(e);
  currentRect = {
    x: Math.min(dragStart.x, x),
    y: Math.min(dragStart.y, y),
    w: Math.abs(x - dragStart.x),
    h: Math.abs(y - dragStart.y),
  };
  showSelectionBox();
});

window.addEventListener('mouseup', () => {
  if (!dragStart) return;
  dragStart = null;
  if (currentRect && currentRect.w > 4 && currentRect.h > 4) {
    showCropPreview(currentRect);
  } else {
    selectionBox.classList.add('hidden');
    currentRect = null;
  }
});

// Convert a mouse event into canvas (natural-image) pixel coordinates.
// The canvas has fixed internal dimensions but CSS may scale it.
function canvasCoords(e) {
  const rect = screenshotCanvas.getBoundingClientRect();
  const scaleX = screenshotCanvas.width / rect.width;
  const scaleY = screenshotCanvas.height / rect.height;
  return {
    x: Math.round((e.clientX - rect.left) * scaleX),
    y: Math.round((e.clientY - rect.top) * scaleY),
  };
}

function showSelectionBox() {
  if (!currentRect) return;
  const rect = screenshotCanvas.getBoundingClientRect();
  const scaleX = rect.width / screenshotCanvas.width;
  const scaleY = rect.height / screenshotCanvas.height;
  const wrap = screenshotCanvas.parentElement.getBoundingClientRect();
  selectionBox.style.left = (rect.left - wrap.left + currentRect.x * scaleX) + 'px';
  selectionBox.style.top = (rect.top - wrap.top + currentRect.y * scaleY) + 'px';
  selectionBox.style.width = (currentRect.w * scaleX) + 'px';
  selectionBox.style.height = (currentRect.h * scaleY) + 'px';
  selectionBox.classList.remove('hidden');
}

/* ============================================================
   SECTION 3 — Crop preview and adding crops to the queue
   ============================================================ */

const cropCanvas = $('cropCanvas');
const cropCtx = cropCanvas.getContext('2d');

function showCropPreview(rect) {
  cropCanvas.width = rect.w;
  cropCanvas.height = rect.h;
  cropCtx.drawImage(
    state.screenshot.image,
    rect.x, rect.y, rect.w, rect.h,
    0, 0, rect.w, rect.h
  );
  const dataUrl = cropCanvas.toDataURL('image/png');

  // Re-crop mode: replace an existing item's image instead of starting a new crop.
  if (state.recropTargetId) {
    const target = state.queue.find(i => i.id === state.recropTargetId);
    state.recropTargetId = null;
    if (target) {
      commitChange(() => {
        target.imageData = dataUrl;
        // Reset click position since the image bounds changed.
        if (target.type === 'click_image') { target.clickX = null; target.clickY = null; }
      });
      selectionBox.classList.add('hidden');
      flashItem(target.id);
      return;
    }
  }

  state.pendingCrop = {
    rect,
    dataUrl,
    clickX: null,  // null = center; otherwise pixel offset from top-left of the image
    clickY: null,
  };
  $('editorPlaceholder').classList.add('hidden');
  $('itemEditor').classList.add('hidden');
  $('cropPreviewArea').classList.remove('hidden');
  $('cropName').value = '';
  $('cropTolerance').value = 30;
  $('cropToleranceValue').textContent = '30';
  $('cropMaxWait').value = 10;
  $('cropSkipCount').value = 1;
  $('cropActionType').value = 'click_image';
  $('cropSkipCountLabel').classList.add('hidden');
  updateCropClickMarker();
  updateClickPosHint();
  $('cropName').focus();
}

// Click on the crop canvas → set the click position.
cropCanvas.addEventListener('click', (e) => {
  if (!state.pendingCrop) return;
  const rect = cropCanvas.getBoundingClientRect();
  const scaleX = cropCanvas.width / rect.width;
  const scaleY = cropCanvas.height / rect.height;
  state.pendingCrop.clickX = Math.round((e.clientX - rect.left) * scaleX);
  state.pendingCrop.clickY = Math.round((e.clientY - rect.top) * scaleY);
  updateCropClickMarker();
  updateClickPosHint();
});

$('resetClickPosBtn').addEventListener('click', () => {
  if (!state.pendingCrop) return;
  state.pendingCrop.clickX = null;
  state.pendingCrop.clickY = null;
  updateCropClickMarker();
  updateClickPosHint();
});

// Place the click marker on top of the crop canvas at the chosen position.
function updateCropClickMarker() {
  const marker = $('cropClickMarker');
  const resetBtn = $('resetClickPosBtn');
  const isClickAction = $('cropActionType').value === 'click_image';
  if (!state.pendingCrop || !isClickAction) {
    marker.classList.add('hidden');
    resetBtn.classList.add('hidden');
    return;
  }
  const cropRect = cropCanvas.getBoundingClientRect();
  const wrapRect = cropCanvas.parentElement.getBoundingClientRect();
  const scaleX = cropRect.width / cropCanvas.width;
  const scaleY = cropRect.height / cropCanvas.height;
  // Default to center of image when clickX/Y not set yet.
  const x = state.pendingCrop.clickX ?? cropCanvas.width / 2;
  const y = state.pendingCrop.clickY ?? cropCanvas.height / 2;
  marker.style.left = (cropRect.left - wrapRect.left + x * scaleX) + 'px';
  marker.style.top = (cropRect.top - wrapRect.top + y * scaleY) + 'px';
  marker.classList.remove('hidden');
  // Only show the reset button if the user has explicitly moved away from center.
  resetBtn.classList.toggle('hidden', state.pendingCrop.clickX === null);
}

function updateClickPosHint() {
  const hint = $('clickPosHint');
  const isClickAction = $('cropActionType').value === 'click_image';
  if (!isClickAction) {
    hint.classList.add('hidden');
    return;
  }
  hint.classList.remove('hidden');
  if (state.pendingCrop && state.pendingCrop.clickX !== null) {
    hint.textContent = `Will click at (${state.pendingCrop.clickX}, ${state.pendingCrop.clickY}) from top-left of the image.`;
  } else {
    hint.textContent = 'Click on the preview to set where the script should click. Defaults to center.';
  }
}

function hideCropPreview() {
  $('cropPreviewArea').classList.add('hidden');
  selectionBox.classList.add('hidden');
  $('cropClickMarker').classList.add('hidden');
  $('resetClickPosBtn').classList.add('hidden');
  state.pendingCrop = null;
  if (!state.selectedItemId) $('editorPlaceholder').classList.remove('hidden');
}

$('cancelCropBtn').addEventListener('click', hideCropPreview);

// Live-update the slider readout next to the crop tolerance slider.
$('cropTolerance').addEventListener('input', (e) => {
  $('cropToleranceValue').textContent = e.target.value;
});

// Toggle skip-count field visibility when action type changes in the crop editor.
$('cropActionType').addEventListener('change', () => {
  const isSkip = $('cropActionType').value === 'skip_if_not_found';
  $('cropSkipCountLabel').classList.toggle('hidden', !isSkip);
  // The click marker only applies to click_image actions.
  updateCropClickMarker();
  updateClickPosHint();
});

$('addCropToQueueBtn').addEventListener('click', () => {
  if (!state.pendingCrop) return;
  const name = ($('cropName').value || `image_${state.queue.length + 1}`)
    .trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  const actionType = $('cropActionType').value;
  const tolerance = parseInt($('cropTolerance').value, 10) || 0;
  const maxWait = parseInt($('cropMaxWait').value, 10) || 10;
  const skipCount = Math.max(1, parseInt($('cropSkipCount').value, 10) || 1);

  const item = {
    id: newId(),
    type: actionType,
    imageName: name,
    imageData: state.pendingCrop.dataUrl,
    tolerance,
    maxWait,
  };
  if (actionType === 'click_image') {
    item.clickType = 'left';
    item.clickX = state.pendingCrop.clickX;  // null or a pixel offset
    item.clickY = state.pendingCrop.clickY;
  }
  if (actionType === 'skip_if_not_found') item.skipCount = skipCount;

  insertItem(item);
  hideCropPreview();
  flashItem(item.id);
});

/* ============================================================
   SECTION 4 — Non-image actions (modal picker)
   ============================================================ */

$('addNonImageActionBtn').addEventListener('click', () => {
  $('actionPickerModal').classList.remove('hidden');
});
$('closeActionPicker').addEventListener('click', () => {
  $('actionPickerModal').classList.add('hidden');
});

document.querySelectorAll('.modal-action').forEach(btn => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.type;
    $('actionPickerModal').classList.add('hidden');
    const item = createDefaultItem(type);
    insertItem(item);
    flashItem(item.id);
    selectItem(item.id);
  });
});

// Insert a new item after the currently selected step, or append to the end
// if nothing is selected. Wraps the change for undo + autosave.
function insertItem(item) {
  pushUndo();
  if (state.selectedItemId) {
    const idx = state.queue.findIndex(i => i.id === state.selectedItemId);
    if (idx >= 0) {
      state.queue.splice(idx + 1, 0, item);
      autosave();
      return;
    }
  }
  state.queue.push(item);
  autosave();
}

function createDefaultItem(type) {
  const base = { id: newId(), type };
  switch (type) {
    case 'launch':
      return { ...base, target: '', isUrl: false };
    case 'window_max':
      return { ...base, mode: 'maximize', windowTitle: 'A' }; // 'A' = active window in AHK
    case 'close_windows':
      return { ...base, mode: 'all', windowTitle: '', exclusions: '' };
    case 'wait_seconds':
      return { ...base, seconds: 2 };
    case 'type_text':
      return { ...base, text: '' };
    case 'send_keys':
      return { ...base, ctrl: false, alt: false, shift: false, win: false, key: '' };
    case 'log':
      return { ...base, message: '' };
    case 'comment':
      return { ...base, text: '' };
    default:
      return base;
  }
}

/* ============================================================
   SECTION 5 — Queue rendering + actions (reorder, remove, edit)
   ============================================================ */

function renderQueue() {
  const list = $('queueList');
  list.innerHTML = '';

  updateWaitTimeSummary();

  if (state.queue.length === 0) {
    $('queueEmpty').classList.remove('hidden');
    updateAddButtonLabels();
    return;
  }
  $('queueEmpty').classList.add('hidden');

  // Track open skip blocks so we can visually nest items inside them.
  // Each entry: { closeAfterIdx, collapsed }
  const openSkips = [];

  state.queue.forEach((item, idx) => {
    // Close blocks whose conditional range has ended before this index.
    while (openSkips.length && openSkips[openSkips.length - 1].closeAfterIdx < idx) {
      openSkips.pop();
    }
    const depth = openSkips.length;
    // If any enclosing skip block is collapsed, hide this child row.
    const hiddenByCollapse = openSkips.some(s => s.collapsed);

    if (!hiddenByCollapse) {
      const li = buildQueueRow(item, idx, depth);
      list.appendChild(li);
    }

    // After rendering, open a new block if this item is a skip anchor.
    if (item.type === 'skip_if_not_found') {
      openSkips.push({
        closeAfterIdx: idx + (item.skipCount || 0),
        collapsed: !!item.collapsed,
      });
    }
  });

  updateAddButtonLabels();
}

// Build a single queue <li> row with all its controls and drag handlers.
function buildQueueRow(item, idx, depth) {
  const li = document.createElement('li');
  li.className = 'queue-item';
  li.draggable = true;
  li.dataset.idx = idx;
  if (depth > 0) li.classList.add('nested');
  if (item.type === 'skip_if_not_found') li.classList.add('skip-anchor');
  if (item.type === 'comment') li.classList.add('comment-row');
  if (item.id === state.selectedItemId) li.classList.add('selected');
  if (item.id === state.justAddedId) li.classList.add('just-added');
  li.style.marginLeft = (depth * 18) + 'px';

  // Collapse toggle (only for skip anchors)
  const collapseBtn = item.type === 'skip_if_not_found'
    ? `<button class="qi-collapse" title="${item.collapsed ? 'Expand' : 'Collapse'}">${item.collapsed ? '▸' : '▾'}</button>`
    : '';

  // Comment rows render differently — no thumbnail, italic label, no type sub.
  if (item.type === 'comment') {
    li.innerHTML = `
      <span class="qi-drag" title="Drag to reorder">⠿</span>
      <span class="qi-num">${idx + 1}</span>
      <span class="qi-comment-label">${escapeHtml(item.text || '(empty comment)')}</span>
      <span class="qi-controls">
        <button class="qi-btn up" title="Move up">▲</button>
        <button class="qi-btn down" title="Move down">▼</button>
        <button class="qi-btn del" title="Remove">✕</button>
      </span>
    `;
  } else {
    const recropBtn = item.imageData
      ? `<button class="qi-btn recrop" title="Re-crop this image">⛶</button>`
      : '';
    li.innerHTML = `
      <span class="qi-drag" title="Drag to reorder">⠿</span>
      ${collapseBtn}
      <span class="qi-num">${idx + 1}</span>
      ${queueItemThumbnailHtml(item)}
      <span class="qi-label">
        <strong>${escapeHtml(humanLabel(item))}</strong>
        <span class="qi-type">${humanType(item.type)}</span>
      </span>
      <span class="qi-controls">
        ${recropBtn}
        <button class="qi-btn up" title="Move up">▲</button>
        <button class="qi-btn down" title="Move down">▼</button>
        <button class="qi-btn del" title="Remove">✕</button>
      </span>
    `;
  }

  li.addEventListener('click', (e) => {
    if (e.target.closest('.qi-controls') || e.target.closest('.qi-collapse') || e.target.closest('.qi-drag')) return;
    selectItem(item.id);
  });
  const collapseEl = li.querySelector('.qi-collapse');
  if (collapseEl) {
    collapseEl.addEventListener('click', (e) => {
      e.stopPropagation();
      item.collapsed = !item.collapsed;
      renderQueue();
      autosave();
    });
  }
  const recropEl = li.querySelector('.recrop');
  if (recropEl) {
    recropEl.addEventListener('click', (e) => {
      e.stopPropagation();
      startRecrop(item.id);
    });
  }
  li.querySelector('.up').addEventListener('click', (e) => { e.stopPropagation(); moveItem(idx, -1); });
  li.querySelector('.down').addEventListener('click', (e) => { e.stopPropagation(); moveItem(idx, +1); });
  li.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); removeItem(item.id); });

  attachDragHandlers(li, idx);
  return li;
}

/* === Drag to reorder === */
let dragSrcIdx = null;

function attachDragHandlers(li, idx) {
  li.addEventListener('dragstart', (e) => {
    dragSrcIdx = idx;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox needs data set to initiate drag
    try { e.dataTransfer.setData('text/plain', String(idx)); } catch (_) {}
  });
  li.addEventListener('dragend', () => {
    dragSrcIdx = null;
    document.querySelectorAll('.queue-item').forEach(el =>
      el.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom'));
  });
  li.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = li.getBoundingClientRect();
    const after = (e.clientY - rect.top) > rect.height / 2;
    li.classList.toggle('drag-over-bottom', after);
    li.classList.toggle('drag-over-top', !after);
  });
  li.addEventListener('dragleave', () => {
    li.classList.remove('drag-over-top', 'drag-over-bottom');
  });
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragSrcIdx === null) return;
    const rect = li.getBoundingClientRect();
    const after = (e.clientY - rect.top) > rect.height / 2;
    let targetIdx = idx + (after ? 1 : 0);
    reorderItem(dragSrcIdx, targetIdx);
  });
}

// Move an item from one index to a new index (insertion point).
function reorderItem(fromIdx, toIdx) {
  if (fromIdx === toIdx || fromIdx === toIdx - 1) return;
  commitChange(() => {
    const [moved] = state.queue.splice(fromIdx, 1);
    // Adjust target if removing the earlier item shifted indices.
    if (fromIdx < toIdx) toIdx--;
    state.queue.splice(toIdx, 0, moved);
  });
}

function moveItem(idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= state.queue.length) return;
  commitChange(() => {
    [state.queue[idx], state.queue[j]] = [state.queue[j], state.queue[idx]];
  });
}

// Briefly mark an item so it animates in when rendered.
function flashItem(id) {
  state.justAddedId = id;
  renderQueue();
  setTimeout(() => { state.justAddedId = null; }, 800);
}

// Escape text for safe insertion as HTML text content.
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Estimate total wait time across the queue (fixed waits + image timeouts).
// This is a rough upper bound: image searches return as soon as they match,
// but in the worst case they run until their max-wait timeout.
function estimateWaitSeconds() {
  let fixed = 0;   // definite waits (Sleep)
  let worst = 0;   // additional worst-case (image timeouts)
  for (const item of state.queue) {
    switch (item.type) {
      case 'wait_seconds':
        fixed += Number(item.seconds) || 0;
        break;
      case 'launch':
        fixed += 1.5; // the built-in Sleep after Run()
        break;
      case 'wait_for_image':
      case 'click_image':
      case 'skip_if_not_found':
        worst += Number(item.maxWait) || 0;
        break;
    }
  }
  return { fixed, worst };
}

function updateWaitTimeSummary() {
  const el = $('waitSummary');
  if (!el) return;
  if (state.queue.length === 0) { el.textContent = ''; return; }
  const { fixed, worst } = estimateWaitSeconds();
  const fmt = (s) => s >= 60 ? `${Math.floor(s/60)}m ${Math.round(s%60)}s` : `${Math.round(s)}s`;
  if (worst > 0) {
    el.textContent = `Est. runtime: ~${fmt(fixed)} fixed + up to ${fmt(worst)} waiting for images`;
  } else {
    el.textContent = `Est. runtime: ~${fmt(fixed)}`;
  }
}

// Re-crop an existing image step: requires the screenshot to be loaded.
function startRecrop(itemId) {
  const item = state.queue.find(i => i.id === itemId);
  if (!item) return;
  if (!state.screenshot) {
    alert('Load the original screenshot first (Load Different Screenshot), then re-crop.');
    return;
  }
  state.recropTargetId = itemId;
  // Reuse the crop selection flow; when the user finishes a selection,
  // showCropPreview detects recropTargetId and offers to apply it.
  $('editorPlaceholder').classList.add('hidden');
  alert('Draw a new rectangle on the screenshot to replace this step\u2019s image.');
}

// Reflect the current insertion position in the "+ Add" button labels.
function updateAddButtonLabels() {
  const addBtn = $('addNonImageActionBtn');
  const cropBtn = $('addCropToQueueBtn');
  let suffix = '';
  if (state.selectedItemId) {
    const idx = state.queue.findIndex(i => i.id === state.selectedItemId);
    if (idx >= 0) suffix = ` after #${idx + 1}`;
  }
  addBtn.textContent = `+ Add Step${suffix}`;
  if (cropBtn) cropBtn.textContent = suffix ? `Add to Steps${suffix}` : 'Add to Steps';
}

// Thumbnail data for non-image actions: a glyph + category color class.
function thumbForType(type) {
  switch (type) {
    case 'launch':        return { glyph: '▶', cat: 'program' };
    case 'window_max':    return { glyph: '▣', cat: 'program' };
    case 'close_windows': return { glyph: '✕', cat: 'program' };
    case 'type_text':     return { glyph: 'T', cat: 'input' };
    case 'send_keys':     return { glyph: '⌘', cat: 'input' };
    case 'wait_seconds':  return { glyph: '◷', cat: 'flow' };
    case 'log':           return { glyph: '≡', cat: 'meta' };
    default:              return { glyph: '?', cat: 'meta' };
  }
}

// Whitelist for image data URLs. Project files (and autosaved state) are
// untrusted input — a shared .json could carry an `imageData` string crafted
// to break out of an attribute and inject markup when interpolated into
// innerHTML. We only ever accept a base64 PNG/JPEG/GIF/WebP data URL.
const SAFE_IMAGE_DATA = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]*$/i;

function isSafeImageData(s) {
  return typeof s === 'string' && SAFE_IMAGE_DATA.test(s);
}

// Scrub a queue loaded from an untrusted source (project file / localStorage):
// drop any imageData that isn't a recognized image data URL so it can never
// reach an innerHTML sink. Mutates in place and returns the array.
function sanitizeLoadedQueue(queue) {
  if (!Array.isArray(queue)) return [];
  for (const item of queue) {
    if (item && 'imageData' in item && !isSafeImageData(item.imageData)) {
      delete item.imageData;
    }
  }
  return queue;
}

function queueItemThumbnailHtml(item) {
  // Validate the data URL AND escape it as an attribute value — belt and
  // suspenders, so a malformed value can never become executable markup.
  if (isSafeImageData(item.imageData)) {
    return `<div class="qi-thumb"><img src="${escapeAttr(item.imageData)}" alt=""></div>`;
  }
  const { glyph, cat } = thumbForType(item.type);
  return `<div class="qi-thumb icon cat-${cat}">${glyph}</div>`;
}

// Return image-bearing actions in the queue, excluding the one being edited.
function imageActionsExcluding(itemId) {
  return state.queue.filter(a =>
    a.id !== itemId && a.imageData && a.imageName &&
    (a.type === 'click_image' || a.type === 'wait_for_image' || a.type === 'skip_if_not_found')
  );
}

// Look up a queue action by its imageName (used when resolving searchWithin
// references at generation time).
function findActionByImageName(name) {
  if (!name) return null;
  return state.queue.find(a => a.imageName === name) || null;
}

// Build the <option>s for the "Search within" dropdown.
function searchWithinOptionsHtml(item) {
  const options = imageActionsExcluding(item.id);
  let html = `<option value="">(Full screen — no parent region)</option>`;
  for (const a of options) {
    const sel = a.imageName === item.searchWithin ? ' selected' : '';
    html += `<option value="${escapeAttr(a.imageName)}"${sel}>${escapeAttr(a.imageName)}</option>`;
  }
  return html;
}

function removeItem(id) {
  commitChange(() => {
    state.queue = state.queue.filter(i => i.id !== id);
    if (state.selectedItemId === id) {
      state.selectedItemId = null;
      $('itemEditor').classList.add('hidden');
      $('editorPlaceholder').classList.remove('hidden');
    }
  });
}

function humanType(type) {
  return {
    launch: 'Launch program / URL',
    window_max: 'Maximize / fullscreen window',
    close_windows: 'Close window(s)',
    click_image: 'Find image & click',
    wait_seconds: 'Wait fixed seconds',
    wait_for_image: 'Wait until image appears',
    skip_if_not_found: 'Skip next N steps if image not found',
    type_text: 'Type text',
    send_keys: 'Send key combo',
    log: 'Log message',
    comment: 'Comment / divider',
  }[type] || type;
}

function humanLabel(item) {
  switch (item.type) {
    case 'launch': return item.target || '(no target set)';
    case 'window_max': return `${item.mode} → ${item.windowTitle || 'A'}`;
    case 'close_windows':
      return item.mode === 'all'
        ? `Close all windows${item.exclusions ? ` (except ${item.exclusions})` : ''}`
        : `Close window: ${item.windowTitle || '(no title set)'}`;
    case 'click_image': {
      const variant = item.clickType && item.clickType !== 'left' ? ` (${item.clickType})` : '';
      const within = item.searchWithin ? ` in "${item.searchWithin}"` : '';
      const pos = (item.clickX != null) ? ` @(${item.clickX},${item.clickY})` : '';
      return `Click "${item.imageName}"${variant}${within}${pos}`;
    }
    case 'wait_seconds': return `Wait ${item.seconds}s`;
    case 'wait_for_image':
      return `Wait for "${item.imageName}"${item.searchWithin ? ` in "${item.searchWithin}"` : ''}`;
    case 'skip_if_not_found':
      return `Skip next ${item.skipCount} if "${item.imageName}"${item.searchWithin ? ` in "${item.searchWithin}"` : ''} not found`;
    case 'type_text': return `Type: ${item.text || '(empty)'}`;
    case 'send_keys': return `Send: ${describeKeyCombo(item)}`;
    case 'log': return item.message || '(empty message)';
    case 'comment': return item.text || '(empty comment)';
    default: return item.type;
  }
}

// Human-readable label for a key combo (UI only — not the AHK string).
function describeKeyCombo(item) {
  const parts = [];
  if (item.ctrl) parts.push('Ctrl');
  if (item.alt) parts.push('Alt');
  if (item.shift) parts.push('Shift');
  if (item.win) parts.push('Win');
  if (item.key) parts.push(item.key);
  return parts.length ? parts.join('+') : '(no key set)';
}

/* ============================================================
   SECTION 6 — Action editor (middle panel)
   ============================================================ */

function selectItem(id) {
  state.selectedItemId = id;
  const item = state.queue.find(i => i.id === id);
  if (!item) return;
  hideCropPreview();
  $('editorPlaceholder').classList.add('hidden');
  $('itemEditor').classList.remove('hidden');
  renderItemEditor(item);
  renderQueue();
}

function closeItemEditor() {
  state.selectedItemId = null;
  $('itemEditor').classList.add('hidden');
  $('editorPlaceholder').classList.remove('hidden');
  renderQueue();
}

$('closeEditorBtn').addEventListener('click', closeItemEditor);

function renderItemEditor(item) {
  const f = $('itemEditorFields');
  f.innerHTML = '';

  const field = (label, inputHtml) => {
    const wrap = document.createElement('label');
    wrap.innerHTML = `${label}${inputHtml}`;
    f.appendChild(wrap);
  };

  // Slider with live numeric readout and Strict/Loose labels.
  const toleranceSlider = (val) => `
    <div class="slider-row">
      <input type="range" data-key="tolerance" value="${val}" min="0" max="150">
      <span class="slider-value">${val}</span>
    </div>
    <div class="slider-labels"><span>Strict</span><span>Loose</span></div>
  `;

  switch (item.type) {
    case 'launch':
      field('Program path or URL',
        `<input type="text" class="field-mono" data-key="target" value="${escapeAttr(item.target)}"
                placeholder="C:\\Path\\app.exe or https://example.com">`);
      field('Treat as URL (open in default browser)',
        `<input type="checkbox" data-key="isUrl" ${item.isUrl ? 'checked' : ''}>`);
      break;

    case 'window_max':
      field('Mode',
        `<select data-key="mode">
           <option value="maximize" ${item.mode==='maximize'?'selected':''}>Maximize</option>
           <option value="fullscreen" ${item.mode==='fullscreen'?'selected':''}>Fullscreen (send F11)</option>
         </select>`);
      field('Window title or class (use "A" for active window)',
        `<input type="text" class="field-mono" data-key="windowTitle" value="${escapeAttr(item.windowTitle)}">`);
      break;

    case 'close_windows':
      field('Mode',
        `<select data-key="mode">
           <option value="all" ${item.mode==='all'?'selected':''}>Close all open windows (reset state)</option>
           <option value="specific" ${item.mode==='specific'?'selected':''}>Close one specific window</option>
         </select>`);
      field('Specific window title (used only in "specific" mode, partial match)',
        `<input type="text" class="field-mono" data-key="windowTitle" value="${escapeAttr(item.windowTitle)}" placeholder="e.g. Notepad">`);
      field('Exclusions (used only in "all" mode, comma-separated, partial match)',
        `<input type="text" class="field-mono" data-key="exclusions" value="${escapeAttr(item.exclusions)}" placeholder="e.g. Chrome, Visual Studio Code">`);
      break;

    case 'click_image':
      field('Image name',
        `<input type="text" class="field-mono" data-key="imageName" value="${escapeAttr(item.imageName)}">`);
      field('Click type',
        `<select data-key="clickType">
           <option value="left" ${(item.clickType||'left')==='left'?'selected':''}>Left click</option>
           <option value="right" ${item.clickType==='right'?'selected':''}>Right click</option>
           <option value="double" ${item.clickType==='double'?'selected':''}>Double click</option>
           <option value="middle" ${item.clickType==='middle'?'selected':''}>Middle click</option>
         </select>`);
      field('Click position',
        `<div class="edit-click-pos">
           <div class="crop-with-marker">
             <canvas class="edit-click-canvas" data-key-img="imageName"></canvas>
             <div class="click-marker edit-click-marker hidden"></div>
           </div>
           <p class="hint edit-click-hint"></p>
           <button type="button" class="btn btn-subtle edit-click-reset hidden">Reset to center</button>
         </div>`);
      field('Search within image (parent region)',
        `<select data-key="searchWithin">${searchWithinOptionsHtml(item)}</select>`);
      field('Tolerance', toleranceSlider(item.tolerance));
      field('Max wait seconds',
        `<input type="number" data-key="maxWait" value="${item.maxWait}" min="0">`);
      break;

    case 'wait_for_image':
      field('Image name',
        `<input type="text" class="field-mono" data-key="imageName" value="${escapeAttr(item.imageName)}">`);
      field('Search within image (parent region)',
        `<select data-key="searchWithin">${searchWithinOptionsHtml(item)}</select>`);
      field('Tolerance', toleranceSlider(item.tolerance));
      field('Max wait seconds',
        `<input type="number" data-key="maxWait" value="${item.maxWait}" min="0">`);
      break;

    case 'skip_if_not_found':
      field('Image name',
        `<input type="text" class="field-mono" data-key="imageName" value="${escapeAttr(item.imageName)}">`);
      field('Skip count (steps to skip if image not found)',
        `<input type="number" data-key="skipCount" value="${item.skipCount}" min="1">`);
      field('Search within image (parent region)',
        `<select data-key="searchWithin">${searchWithinOptionsHtml(item)}</select>`);
      field('Tolerance', toleranceSlider(item.tolerance));
      field('Max wait seconds (how long to look before deciding "not found")',
        `<input type="number" data-key="maxWait" value="${item.maxWait}" min="0">`);
      break;

    case 'wait_seconds':
      field('Seconds to wait',
        `<input type="number" data-key="seconds" value="${item.seconds}" min="0" step="0.1">`);
      break;

    case 'type_text':
      field('Text to type',
        `<textarea class="field-mono" data-key="text" rows="3">${escapeAttr(item.text)}</textarea>`);
      break;

    case 'send_keys':
      field('Modifiers',
        `<span style="display:inline-flex; gap:14px; align-items:center; margin-top:4px;">
           <label style="margin:0; font-weight:500;"><input type="checkbox" data-key="ctrl" ${item.ctrl?'checked':''}> Ctrl</label>
           <label style="margin:0; font-weight:500;"><input type="checkbox" data-key="alt" ${item.alt?'checked':''}> Alt</label>
           <label style="margin:0; font-weight:500;"><input type="checkbox" data-key="shift" ${item.shift?'checked':''}> Shift</label>
           <label style="margin:0; font-weight:500;"><input type="checkbox" data-key="win" ${item.win?'checked':''}> Win</label>
         </span>`);
      field('Key (e.g. "t", "Enter", "Tab", "F5", "Esc")',
        `<input type="text" class="field-mono" data-key="key" value="${escapeAttr(item.key)}" placeholder="t">`);
      break;

    case 'log':
      field('Message to log',
        `<input type="text" data-key="message" value="${escapeAttr(item.message)}">`);
      break;

    case 'comment':
      field('Comment / section label (does not run — for organizing the queue)',
        `<input type="text" data-key="text" value="${escapeAttr(item.text)}" placeholder="— Login phase —">`);
      break;
  }

  // Wire any range sliders for live value updates.
  f.querySelectorAll('input[type="range"]').forEach(el => {
    const valueEl = el.parentElement.querySelector('.slider-value');
    if (valueEl) {
      el.addEventListener('input', () => { valueEl.textContent = el.value; });
    }
  });

  // For click_image: render the cropped image into the canvas and let the
  // user click anywhere on it to set the click point. Stored as
  // item.clickX / item.clickY in pixel coords from top-left of the image.
  // null means "default to center".
  if (item.type === 'click_image') {
    const canvas = f.querySelector('.edit-click-canvas');
    const marker = f.querySelector('.edit-click-marker');
    const hint = f.querySelector('.edit-click-hint');
    const reset = f.querySelector('.edit-click-reset');
    if (canvas && item.imageData) {
      const img = new Image();
      img.onload = () => {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        // Limit display size in case the crop is big.
        canvas.style.maxWidth = '100%';
        canvas.style.maxHeight = '180px';
        canvas.style.cursor = 'crosshair';
        canvas.style.border = '1px solid var(--border)';
        canvas.style.borderRadius = 'var(--r-sm)';
        canvas.style.background = 'var(--bg-grain)';
        positionEditClickMarker(canvas, marker, item, hint, reset);
      };
      img.src = item.imageData;

      canvas.addEventListener('click', (e) => {
        const r = canvas.getBoundingClientRect();
        const sx = canvas.width / r.width;
        const sy = canvas.height / r.height;
        item.clickX = Math.round((e.clientX - r.left) * sx);
        item.clickY = Math.round((e.clientY - r.top) * sy);
        positionEditClickMarker(canvas, marker, item, hint, reset);
        renderQueue();
      });

      reset.addEventListener('click', () => {
        item.clickX = null;
        item.clickY = null;
        positionEditClickMarker(canvas, marker, item, hint, reset);
        renderQueue();
      });
    }
  }
}

// Helper: place the marker on the editor's click canvas based on current
// item.clickX/clickY (or center when null), and update the hint + reset btn.
function positionEditClickMarker(canvas, marker, item, hint, reset) {
  if (!canvas.width || !canvas.height) return;
  const cRect = canvas.getBoundingClientRect();
  const wRect = canvas.parentElement.getBoundingClientRect();
  const sx = cRect.width / canvas.width;
  const sy = cRect.height / canvas.height;
  const x = item.clickX ?? canvas.width / 2;
  const y = item.clickY ?? canvas.height / 2;
  marker.style.left = (cRect.left - wRect.left + x * sx) + 'px';
  marker.style.top = (cRect.top - wRect.top + y * sy) + 'px';
  marker.classList.remove('hidden');
  if (hint) {
    hint.textContent = (item.clickX !== null && item.clickX !== undefined)
      ? `Will click at (${item.clickX}, ${item.clickY}) from top-left of the image.`
      : 'Click on the preview to set where the script should click. Defaults to center.';
  }
  if (reset) {
    reset.classList.toggle('hidden', item.clickX === null || item.clickX === undefined);
  }
}

$('saveItemBtn').addEventListener('click', () => {
  const item = state.queue.find(i => i.id === state.selectedItemId);
  if (!item) return;
  commitChange(() => {
    $('itemEditorFields').querySelectorAll('[data-key]').forEach(el => {
      const key = el.dataset.key;
      let val;
      if (el.type === 'checkbox') val = el.checked;
      else if (el.type === 'number') val = parseFloat(el.value) || 0;
      else val = el.value;
      item[key] = val;
    });
  });
});

function escapeAttr(s) {
  return String(s ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/* ============================================================
   SECTION 7 — Global settings
   ============================================================ */

$('exitBehavior').addEventListener('change', (e) => {
  state.exitBehavior = e.target.value;
  autosave();
});

$('saveScreenshots').addEventListener('change', (e) => {
  state.saveScreenshots = e.target.checked;
  autosave();
});

/* ============================================================
   SECTION 8 — AutoHotkey v2 script generation
   ------------------------------------------------------------
   Notes on AHK v2 syntax used:
     - #Requires AutoHotkey v2.0
     - Functions defined with `name(params) { ... }`
     - String concatenation with `.`, comparisons with `=`
     - ImageSearch is called as a function:
         ImageSearch(&OutX, &OutY, X1, Y1, X2, Y2, ImageFile)
     - Try / Catch for ImageSearch errors
     - FileAppend(text, filename) for logging
     - WinMaximize, Run, MsgBox, Sleep all v2 forms
   ============================================================ */

function generateAhkScript() {
  const lines = [];
  const push = (...ss) => {
    if (ss.length === 0) lines.push('');
    else ss.forEach(s => lines.push(s));
  };

  push('; ============================================================');
  push('; Auto-generated by AHK v2 Script Builder');
  push('; Generated: ' + new Date().toISOString());
  push('; ============================================================');
  push('#Requires AutoHotkey v2.0');
  push('#SingleInstance Force');
  push('SetWorkingDir(A_ScriptDir)');
  push('');
  push('; --- Emergency abort hotkeys ---');
  push('; Press Esc for an immediate exit.');
  push('; Press Shift+C to log "Script terminated by user" and exit gracefully.');
  push('*Esc::ExitApp()');
  push('+c:: {');
  if (state.exitBehavior === 'log') {
    push('    global LogBuffer, LogFile');
    push('    LogMsg("Script terminated by user")');
    if (state.saveScreenshots) push('    try TakeStepScreenshot(998, "user_abort")');
    push('    try FileAppend(LogBuffer, LogFile)');
  } else {
    push('    LogMsg("Script terminated by user")');
    if (state.saveScreenshots) push('    try TakeStepScreenshot(998, "user_abort")');
  }
  push('    ExitApp()');
  push('}');
  push('');
  push('; --- Configuration ---');
  push('ImagesFolder := A_ScriptDir . "\\images"');
  push('');
  push('; Each run gets its own timestamped folder under logs/ so hourly runs');
  push('; don\'t overwrite each other. The log file and any per-step');
  push('; screenshots both live in that folder.');
  push('LogsBaseFolder := A_ScriptDir . "\\logs"');
  push('RunTimestamp := FormatTime(, "yyyy-MM-dd_HH-mm-ss")');
  push('RunFolder := LogsBaseFolder . "\\" . RunTimestamp');
  push('try DirCreate(RunFolder)');
  push('LogFile := RunFolder . "\\automation_log.txt"');
  push('LogBuffer := ""');
  push('');
  if (state.saveScreenshots) {
    push('; --- Initialize GDI+ for screen capture ---');
    push('GdipStartupInput := Buffer(24, 0)');
    push('NumPut("UInt", 1, GdipStartupInput, 0)  ; GdiplusVersion = 1');
    push('GdipToken := 0');
    push('DllCall("LoadLibrary", "Str", "gdiplus")');
    push('DllCall("gdiplus\\GdiplusStartup", "Ptr*", &GdipToken, "Ptr", GdipStartupInput.Ptr, "Ptr", 0)');
    push('');
  }

  // Helper functions for the generated script
  push('; --- Helper functions ---');
  push('LogMsg(msg) {');
  push('    global LogBuffer');
  push('    timestamp := FormatTime(, "yyyy-MM-dd HH:mm:ss")');
  push('    line := "[" . timestamp . "] " . msg');
  push('    LogBuffer .= line . "`n"');
  push('    OutputDebug(line)');
  push('}');
  push('');
  push('; Find an image on screen. Retries until maxSeconds elapses.');
  push('; Optionally restrict search to a region (x1, y1, x2, y2);');
  push('; pass -1 for x2/y2 to default to the full screen.');
  push('; Returns object {found:true,x:..,y:..} or {found:false}.');
  push('FindImage(imagePath, tolerance := 30, maxSeconds := 10, x1 := 0, y1 := 0, x2 := -1, y2 := -1) {');
  push('    if (x2 < 0)');
  push('        x2 := A_ScreenWidth');
  push('    if (y2 < 0)');
  push('        y2 := A_ScreenHeight');
  push('    endTime := A_TickCount + (maxSeconds * 1000)');
  push('    foundX := 0, foundY := 0');
  push('    Loop {');
  push('        try {');
  push('            if ImageSearch(&foundX, &foundY, x1, y1, x2, y2, "*" . tolerance . " " . imagePath)');
  push('                return {found: true, x: foundX, y: foundY}');
  push('        } catch as err {');
  push('            LogMsg("ImageSearch error: " . err.Message)');
  push('        }');
  push('        if (A_TickCount > endTime)');
  push('            return {found: false, x: 0, y: 0}');
  push('        Sleep(250)');
  push('    }');
  push('}');
  push('');
  push('; Click at a matched image. By default clicks the center of the match;');
  push('; pass offsetX/offsetY >= 0 to click at a specific point relative to the');
  push('; top-left of the matched image. Optionally restricts the search to a');
  push('; region defined by (x1, y1, x2, y2) — use -1 for x2/y2 to default to');
  push('; the full screen. clickOpts is passed through to Click() — e.g. "Right",');
  push('; "Left 2" (double), or "" for default left click.');
  push('ClickImageAt(imagePath, tolerance := 30, maxSeconds := 10, clickOpts := ""');
  push('           , offsetX := -1, offsetY := -1');
  push('           , x1 := 0, y1 := 0, x2 := -1, y2 := -1) {');
  push('    result := FindImage(imagePath, tolerance, maxSeconds, x1, y1, x2, y2)');
  push('    if !result.found {');
  push('        LogMsg("Image not found: " . imagePath)');
  push('        MsgBox("Could not find image:`n" . imagePath, "Automation", "Icon!")');
  push('        return false');
  push('    }');
  push('    if (offsetX < 0 || offsetY < 0) {');
  push('        dims := GetImageSize(imagePath)');
  push('        cx := result.x + (dims.w // 2)');
  push('        cy := result.y + (dims.h // 2)');
  push('    } else {');
  push('        cx := result.x + offsetX');
  push('        cy := result.y + offsetY');
  push('    }');
  push('    MouseMove(cx, cy, 2)');
  push('    if clickOpts = ""');
  push('        Click()');
  push('    else');
  push('        Click(clickOpts)');
  push('    LogMsg("Clicked " . imagePath . " at " . cx . "," . cy . " (" . (clickOpts = "" ? "left" : clickOpts) . ")")');
  push('    return true');
  push('}');
  push('');
  push('; Read PNG width/height by loading it via GDI+ wrapper through LoadPicture.');
  push('GetImageSize(imagePath) {');
  push('    hBM := LoadPicture(imagePath, "", &type)');
  push('    if !hBM');
  push('        return {w: 0, h: 0}');
  push('    bm := Buffer(24, 0)');
  push('    DllCall("GetObject", "ptr", hBM, "int", 24, "ptr", bm.Ptr)');
  push('    w := NumGet(bm, 4, "int")');
  push('    h := NumGet(bm, 8, "int")');
  push('    DllCall("DeleteObject", "ptr", hBM)');
  push('    return {w: w, h: Abs(h)}');
  push('}');
  push('');
  push('WaitForImage(imagePath, tolerance := 30, maxSeconds := 10, x1 := 0, y1 := 0, x2 := -1, y2 := -1) {');
  push('    LogMsg("Waiting for image: " . imagePath)');
  push('    result := FindImage(imagePath, tolerance, maxSeconds, x1, y1, x2, y2)');
  push('    if !result.found {');
  push('        LogMsg("Timed out waiting for: " . imagePath)');
  push('        MsgBox("Timed out waiting for image:`n" . imagePath, "Automation", "Icon!")');
  push('        return false');
  push('    }');
  push('    LogMsg("Image appeared: " . imagePath)');
  push('    return true');
  push('}');
  push('');
  push('; Close all visible top-level windows. Skips shell windows (taskbar,');
  push('; desktop). `exclusions` is a comma-separated string of partial titles');
  push('; to leave alone.');
  push('CloseAllWindows(exclusions := "") {');
  push('    excludeList := StrSplit(exclusions, ",", " ")');
  push('    for hwnd in WinGetList() {');
  push('        try {');
  push('            if !DllCall("IsWindowVisible", "ptr", hwnd)');
  push('                continue');
  push('            winTitle := WinGetTitle("ahk_id " . hwnd)');
  push('            if (winTitle = "")');
  push('                continue');
  push('            winCls := WinGetClass("ahk_id " . hwnd)');
  push('            ; Skip Windows shell components so we don\'t kill the taskbar/desktop');
  push('            if (winCls = "Progman" || winCls = "WorkerW"');
  push('                || winCls = "Shell_TrayWnd" || winCls = "Shell_SecondaryTrayWnd")');
  push('                continue');
  push('            ; Respect user exclusions (partial, case-insensitive match)');
  push('            skipIt := false');
  push('            for excl in excludeList {');
  push('                if (excl != "" && InStr(winTitle, excl))');
  push('                    skipIt := true');
  push('            }');
  push('            if skipIt');
  push('                continue');
  push('            LogMsg("Closing window: " . winTitle)');
  push('            WinClose("ahk_id " . hwnd)');
  push('        } catch as err {');
  push('            LogMsg("Could not close a window: " . err.Message)');
  push('        }');
  push('    }');
  push('    Sleep(500)  ; brief settle time so the next step starts on a quiet desktop');
  push('}');
  push('');

  if (state.saveScreenshots) {
    push('; Capture the primary screen to a PNG via GDI+. Returns true on success.');
    push('CaptureScreenToFile(filename) {');
    push('    try {');
    push('        w := A_ScreenWidth, h := A_ScreenHeight');
    push('        hDDC := DllCall("GetDC", "Ptr", 0, "Ptr")');
    push('        if !hDDC');
    push('            throw Error("GetDC failed")');
    push('        hCDC := DllCall("CreateCompatibleDC", "Ptr", hDDC, "Ptr")');
    push('        hBM := DllCall("CreateCompatibleBitmap", "Ptr", hDDC, "Int", w, "Int", h, "Ptr")');
    push('        hOldBM := DllCall("SelectObject", "Ptr", hCDC, "Ptr", hBM, "Ptr")');
    push('        DllCall("BitBlt", "Ptr", hCDC, "Int", 0, "Int", 0, "Int", w, "Int", h');
    push('              , "Ptr", hDDC, "Int", 0, "Int", 0, "UInt", 0x00CC0020)  ; SRCCOPY');
    push('        pBitmap := 0');
    push('        DllCall("gdiplus\\GdipCreateBitmapFromHBITMAP", "Ptr", hBM, "Ptr", 0, "Ptr*", &pBitmap)');
    push('        pngClsid := Buffer(16, 0)');
    push('        DllCall("ole32\\CLSIDFromString", "WStr", "{557CF406-1A04-11D3-9A73-0000F81EF32E}"');
    push('              , "Ptr", pngClsid.Ptr)  ; PNG encoder');
    push('        DllCall("gdiplus\\GdipSaveImageToFile", "Ptr", pBitmap, "WStr", filename');
    push('              , "Ptr", pngClsid.Ptr, "Ptr", 0)');
    push('        DllCall("gdiplus\\GdipDisposeImage", "Ptr", pBitmap)');
    push('        DllCall("SelectObject", "Ptr", hCDC, "Ptr", hOldBM)');
    push('        DllCall("DeleteObject", "Ptr", hBM)');
    push('        DllCall("DeleteDC", "Ptr", hCDC)');
    push('        DllCall("ReleaseDC", "Ptr", 0, "Ptr", hDDC)');
    push('        return true');
    push('    } catch as err {');
    push('        try LogMsg("Screenshot failed: " . err.Message)');
    push('        return false');
    push('    }');
    push('}');
    push('');
    push('; Save a screenshot to the current run folder, named by step number + action.');
    push('TakeStepScreenshot(stepNum, actionLabel) {');
    push('    global RunFolder');
    push('    if !DirExist(RunFolder)');
    push('        return');
    push('    name := "step_" . Format("{:03}", stepNum) . "_" . actionLabel . ".png"');
    push('    CaptureScreenToFile(RunFolder . "\\" . name)');
    push('    LogMsg("Saved screenshot: " . name)');
    push('}');
    push('');
  }

  // The main routine
  push('; --- Main automation ---');
  push('LogMsg("Automation started")');
  push('try {');

  // Walk the queue, tracking open skip-if-not-found blocks so we can
  // emit `if ... { ... }` wrappers with correctly-balanced braces and
  // indentation. Each open block has `closeAfterIdx` (the last queue
  // index that lives inside it) and `indentLevel` (depth of the brace).
  const openSkips = [];
  const closeOpenBlocksUntil = (idx) => {
    while (openSkips.length && openSkips[openSkips.length - 1].closeAfterIdx < idx) {
      const blk = openSkips.pop();
      push('    ' + '    '.repeat(blk.indentLevel) + '}');
    }
  };

  state.queue.forEach((item, idx) => {
    closeOpenBlocksUntil(idx);

    const depth = openSkips.length;
    const baseIndent = '    ' + '    '.repeat(depth);
    const stepNum = idx + 1;

    push('');
    push(baseIndent + `; Step ${stepNum}: ${humanType(item.type)} — ${humanLabel(item).replace(/\r?\n/g, ' ')}`);

    if (item.type === 'skip_if_not_found') {
      const path = `ImagesFolder . "\\${item.imageName}.png"`;
      const varName = `skipCheck_${stepNum}`;
      const parent = item.searchWithin ? findActionByImageName(item.searchWithin) : null;

      if (parent) {
        // Two-stage search: find the parent first, then check the child inside its bounds.
        const parentPath = `ImagesFolder . "\\${parent.imageName}.png"`;
        push(baseIndent + `parentResult := FindImage(${parentPath}, ${parent.tolerance | 0}, ${parent.maxWait | 0})`);
        push(baseIndent + `if !parentResult.found {`);
        push(baseIndent + `    LogMsg("Parent image not found: ${parent.imageName}, treating skip check as: not found")`);
        push(baseIndent + `    ${varName} := false`);
        push(baseIndent + `} else {`);
        push(baseIndent + `    pDims := GetImageSize(${parentPath})`);
        push(baseIndent + `    LogMsg("Checking for image: " . ${path} . " within parent " . ${ahkString(parent.imageName)})`);
        push(baseIndent + `    ${varName} := FindImage(${path}, ${item.tolerance | 0}, ${item.maxWait | 0}, parentResult.x, parentResult.y, parentResult.x + pDims.w, parentResult.y + pDims.h).found`);
        push(baseIndent + `}`);
      } else {
        if (item.searchWithin) {
          push(baseIndent + `; WARNING: searchWithin "${item.searchWithin}" not found in queue; using full-screen search`);
        }
        push(baseIndent + `LogMsg("Checking for image: " . ${path})`);
        push(baseIndent + `${varName} := FindImage(${path}, ${item.tolerance | 0}, ${item.maxWait | 0}).found`);
      }

      if (state.saveScreenshots) {
        push(baseIndent + `TakeStepScreenshot(${stepNum}, "skip_if_not_found")`);
      }
      push(baseIndent + `if ${varName} {`);
      openSkips.push({
        closeAfterIdx: idx + (item.skipCount || 0),
        indentLevel: depth,
      });
    } else {
      // For image-search actions (click_image / wait_for_image), the
      // user may specify a parent image to search within. We emit a
      // parent-find prelude and then the step body with region args.
      const usesSearchWithin = item.searchWithin
        && (item.type === 'click_image' || item.type === 'wait_for_image');

      if (usesSearchWithin) {
        const parent = findActionByImageName(item.searchWithin);
        if (parent) {
          const parentPath = `ImagesFolder . "\\${parent.imageName}.png"`;
          push(baseIndent + `parentResult := FindImage(${parentPath}, ${parent.tolerance | 0}, ${parent.maxWait | 0})`);
          push(baseIndent + `if !parentResult.found {`);
          push(baseIndent + `    LogMsg("Parent image not found: ${parent.imageName}, skipping step ${stepNum}")`);
          push(baseIndent + `} else {`);
          push(baseIndent + `    pDims := GetImageSize(${parentPath})`);
          const regionArgs = `, parentResult.x, parentResult.y, parentResult.x + pDims.w, parentResult.y + pDims.h`;
          generateStep(item, regionArgs).forEach(l => push(baseIndent + '    ' + l));
          push(baseIndent + `}`);
        } else {
          push(baseIndent + `; WARNING: searchWithin "${item.searchWithin}" not found in queue; using full-screen search`);
          generateStep(item).forEach(l => push(baseIndent + l));
        }
      } else {
        generateStep(item).forEach(l => push(baseIndent + l));
      }

      if (state.saveScreenshots && item.type !== 'comment') {
        push(baseIndent + `TakeStepScreenshot(${stepNum}, "${item.type}")`);
      }
    }
  });

  // Close any remaining skip blocks at end of queue.
  while (openSkips.length) {
    const blk = openSkips.pop();
    push('    ' + '    '.repeat(blk.indentLevel) + '}');
  }

  if (state.saveScreenshots) {
    push('');
    push('    ; Final state screenshot');
    push('    TakeStepScreenshot(999, "final_state")');
  }

  push('');
  push('    LogMsg("Automation finished successfully")');
  push('} catch as err {');
  push('    LogMsg("Fatal error: " . err.Message)');
  push('    MsgBox("Automation failed: " . err.Message, "Error", "Icon!")');
  push('}');
  push('');

  // Exit behavior
  if (state.exitBehavior === 'log') {
    push('; Save the log and exit');
    push('try FileAppend(LogBuffer, LogFile)');
    push('ExitApp()');
  } else {
    push('; Exit without saving a log');
    push('ExitApp()');
  }

  return lines.join('\r\n');
}

// Generate AHK lines for a single queue item.
// regionArgs is an optional AHK-string fragment like ", parentResult.x, parentResult.y, ..."
// that gets appended to the search-call argument list when the caller has set
// up a parent region (searchWithin). Empty string = full-screen search.
function generateStep(item, regionArgs = '') {
  switch (item.type) {

    case 'launch': {
      const target = ahkString(item.target);
      if (item.isUrl) {
        return [
          `LogMsg("Opening URL: " . ${target})`,
          `Run(${target})`,
          `Sleep(1500)`,
        ];
      }
      return [
        `LogMsg("Launching: " . ${target})`,
        `Run(${target})`,
        `Sleep(1500)`,
      ];
    }

    case 'window_max': {
      const title = ahkString(item.windowTitle || 'A');
      if (item.mode === 'fullscreen') {
        return [
          `LogMsg("Sending F11 (fullscreen) to: " . ${title})`,
          `try WinActivate(${title})`,
          `Sleep(300)`,
          `Send("{F11}")`,
        ];
      }
      return [
        `LogMsg("Maximizing window: " . ${title})`,
        `try WinActivate(${title})`,
        `Sleep(200)`,
        `try WinMaximize(${title})`,
      ];
    }

    case 'close_windows': {
      if (item.mode === 'all') {
        const exclLabel = item.exclusions ? ` (excluding: ${item.exclusions})` : '';
        return [
          `LogMsg("Closing all open windows${exclLabel}")`,
          `CloseAllWindows(${ahkString(item.exclusions || '')})`,
        ];
      }
      const title = ahkString(item.windowTitle || '');
      return [
        `LogMsg("Closing window: " . ${title})`,
        `try WinClose(${title})`,
        `Sleep(300)`,
      ];
    }

    case 'click_image': {
      const path = `ImagesFolder . "\\${item.imageName}.png"`;
      const clickOpts = ahkClickOpts(item.clickType || 'left');
      const offX = (item.clickX != null) ? item.clickX : -1;
      const offY = (item.clickY != null) ? item.clickY : -1;
      return [
        `if !ClickImageAt(${path}, ${item.tolerance|0}, ${item.maxWait|0}, ${clickOpts}, ${offX}, ${offY}${regionArgs})`,
        `    LogMsg("Skipping further actions due to missing image: ${item.imageName}")`,
      ];
    }

    case 'wait_for_image': {
      const path = `ImagesFolder . "\\${item.imageName}.png"`;
      return [
        `WaitForImage(${path}, ${item.tolerance|0}, ${item.maxWait|0}${regionArgs})`,
      ];
    }

    case 'wait_seconds': {
      const ms = Math.max(0, Math.round(item.seconds * 1000));
      return [
        `LogMsg("Waiting ${item.seconds} seconds")`,
        `Sleep(${ms})`,
      ];
    }

    case 'type_text': {
      const text = ahkString(item.text || '');
      return [
        `LogMsg("Typing text (" . StrLen(${text}) . " chars)")`,
        `SendText(${text})`,
      ];
    }

    case 'send_keys': {
      const combo = buildAhkKeyCombo(item);
      if (!combo) return [`; (send_keys: no key configured, skipping)`];
      return [
        `LogMsg("Sending keys: " . ${ahkString(describeKeyCombo(item))})`,
        `Send(${ahkString(combo)})`,
      ];
    }

    case 'log': {
      return [`LogMsg(${ahkString(item.message)})`];
    }

    case 'comment': {
      // Non-executing — emit as an AHK comment block for readability.
      const text = (item.text || '').replace(/\r?\n/g, ' ');
      return [
        `; ----------------------------------------------------------`,
        `; ${text}`,
        `; ----------------------------------------------------------`,
      ];
    }

    default:
      return [`; (unknown action type: ${item.type})`];
  }
}

// Convert UI click type to the string passed to AHK's Click() function.
function ahkClickOpts(type) {
  switch (type) {
    case 'right':  return '"Right"';
    case 'double': return '"Left 2"';
    case 'middle': return '"Middle"';
    default:       return '""';     // empty = default left click
  }
}

// Build an AHK key string from modifier checkboxes + a key name.
// Single chars stay bare ("t", "5"); multi-char and special-char keys
// get wrapped in braces ({Enter}, {F5}, {+}).
function buildAhkKeyCombo(item) {
  let key = (item.key || '').trim();
  if (!key && !item.ctrl && !item.alt && !item.shift && !item.win) return '';

  let mods = '';
  if (item.ctrl)  mods += '^';
  if (item.alt)   mods += '!';
  if (item.shift) mods += '+';
  if (item.win)   mods += '#';

  if (!key) return mods; // e.g. just holding modifier (rare)

  let keyPart;
  if (key.length === 1) {
    // Single character: brace-wrap if it collides with AHK modifier syntax.
    keyPart = /[+!^#{}]/.test(key) ? `{${key}}` : key;
  } else {
    keyPart = `{${key}}`;
  }
  return mods + keyPart;
}

// Escape a JS string for safe use as an AHK v2 double-quoted string literal.
function ahkString(s) {
  const escaped = String(s ?? '')
    .replace(/`/g, '``')
    .replace(/"/g, '`"')
    .replace(/\r/g, '`r')
    .replace(/\n/g, '`n');
  return `"${escaped}"`;
}

/* ============================================================
   SECTION 9 — Export as ZIP package
   ============================================================ */

$('previewScriptBtn').addEventListener('click', () => {
  if (state.queue.length === 0) {
    alert('Queue is empty — add at least one step to preview the script.');
    return;
  }
  $('scriptPreviewCode').textContent = generateAhkScript();
  $('scriptPreviewModal').classList.remove('hidden');
});
$('closeScriptPreview').addEventListener('click', () => {
  $('scriptPreviewModal').classList.add('hidden');
});
$('copyScriptBtn').addEventListener('click', async () => {
  const text = $('scriptPreviewCode').textContent;
  try {
    await navigator.clipboard.writeText(text);
    $('copyScriptBtn').textContent = 'Copied!';
    setTimeout(() => { $('copyScriptBtn').textContent = 'Copy to Clipboard'; }, 1500);
  } catch (_) {
    // Fallback: select the text for manual copy
    const range = document.createRange();
    range.selectNodeContents($('scriptPreviewCode'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
});

$('exportBtn').addEventListener('click', async () => {
  if (state.queue.length === 0) {
    alert('Queue is empty — add at least one action before exporting.');
    return;
  }

  const zip = new JSZip();
  const script = generateAhkScript();
  zip.file('automation.ahk', script);

  // Cropped images go inside /images
  const imgFolder = zip.folder('images');
  for (const item of state.queue) {
    if (item.imageData) {
      const base64 = item.imageData.split(',')[1];
      imgFolder.file(`${item.imageName}.png`, base64, { base64: true });
    }
  }

  zip.file('README.txt', buildReadme());

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ahk_automation_${Date.now()}.zip`;
  a.click();
  URL.revokeObjectURL(url);
});

function buildReadme() {
  return [
    'AutoHotkey v2 Automation Package',
    '================================',
    '',
    'Contents:',
    '  automation.ahk   - The generated script (AutoHotkey v2)',
    '  images/          - Cropped images used by ImageSearch',
    '  logs/            - Created at runtime; each run gets its own',
    '                     timestamped subfolder containing:',
    '                       automation_log.txt - text log of the run',
    '                       step_NNN_<type>.png - screenshot after each step',
    '                                            (only if "save screenshots" was enabled)',
    '',
    'How to run:',
    '  1. Install AutoHotkey v2 from https://www.autohotkey.com/',
    '  2. Extract this zip to a folder of your choice.',
    '  3. Double-click automation.ahk to run it.',
    '',
    'Scheduling (e.g. running every hour):',
    '  Use Windows Task Scheduler. Create a Basic Task,',
    '  set the trigger (e.g. hourly), and point the action at',
    '  the automation.ahk file. Each run will save into its own',
    '  logs/<timestamp>/ folder.',
    '',
    'Emergency abort:',
    '  - Press Esc at any time for an immediate exit.',
    '  - Press Shift+C to log "Script terminated by user" and exit',
    '    gracefully (saves the log file and a final screenshot if those',
    '    features were enabled at build time).',
    '  Note: Shift+C is a global hotkey while the script runs, so any',
    '  capital C typed anywhere on your PC will end the automation.',
    '',
    'Disk usage note:',
    '  If "save screenshot after each step" is enabled, each run produces',
    '  one PNG per step (~1-3 MB each). Hourly runs over weeks add up.',
    '  Periodically delete old subfolders from logs/ to reclaim space.',
    '',
    'Notes:',
    '  - The script searches the entire primary screen for each image.',
    '  - Adjust the "tolerance" value in the script if matches are missed',
    '    (higher = more lenient). The default is set per-action.',
    '  - Image paths are relative to the script location, so keep the',
    '    "images" folder next to automation.ahk.',
    '',
  ].join('\r\n');
}

/* ============================================================
   SECTION 9b — Save / load project as JSON
   ============================================================ */

$('saveProjectBtn').addEventListener('click', () => {
  const data = {
    version: 1,
    exitBehavior: state.exitBehavior,
    saveScreenshots: state.saveScreenshots,
    queue: state.queue,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ahk_project_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$('loadProjectBtn').addEventListener('click', () => $('projectFileInput').click());

$('projectFileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data || !Array.isArray(data.queue)) {
        throw new Error('File does not contain a valid project (missing "queue" array).');
      }
      pushUndo(); // loading is undoable
      // Replace state. Strip any unsafe imageData first; remaining fields are
      // validated lazily by the renderers / generator.
      state.queue = sanitizeLoadedQueue(data.queue);
      state.exitBehavior = data.exitBehavior || 'log';
      state.saveScreenshots = data.saveScreenshots !== false; // default true
      $('exitBehavior').value = state.exitBehavior;
      $('saveScreenshots').checked = state.saveScreenshots;
      // Re-seed the id counter so newly-added items don't collide.
      const maxN = state.queue.reduce((m, it) => {
        const n = parseInt(String(it.id || '').replace('act_', ''), 10);
        return isNaN(n) ? m : Math.max(m, n);
      }, 0);
      nextId = maxN + 1;
      closeItemEditor();
      hideCropPreview();
      renderQueue();
      autosave();
    } catch (err) {
      alert('Failed to load project: ' + err.message);
    }
  };
  reader.readAsText(file);
  // Reset the input so loading the same file twice in a row still fires `change`.
  e.target.value = '';
});

/* ============================================================
   SECTION 10 — Keyboard shortcuts
   ============================================================ */

document.addEventListener('keydown', (e) => {
  // Don't intercept when typing in a field.
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

  // Esc cancels a pending crop (works even outside fields).
  if (e.key === 'Escape') {
    if (state.recropTargetId) { state.recropTargetId = null; }
    if (state.pendingCrop) { hideCropPreview(); }
    if (!$('actionPickerModal').classList.contains('hidden')) {
      $('actionPickerModal').classList.add('hidden');
    }
    return;
  }

  if (typing) return;

  // Ctrl/Cmd + Z → undo
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
    return;
  }
  // Ctrl/Cmd + D → duplicate selected step
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    duplicateSelected();
    return;
  }
  // Delete / Backspace → remove selected step
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedItemId) {
    e.preventDefault();
    removeItem(state.selectedItemId);
    return;
  }
  // Arrow up/down → move selection through the queue
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && state.queue.length) {
    e.preventDefault();
    const idx = state.queue.findIndex(i => i.id === state.selectedItemId);
    let next;
    if (idx < 0) next = 0;
    else next = e.key === 'ArrowDown' ? Math.min(idx + 1, state.queue.length - 1)
                                      : Math.max(idx - 1, 0);
    selectItem(state.queue[next].id);
  }
});

// Duplicate the selected step, inserting the copy right after it.
function duplicateSelected() {
  const idx = state.queue.findIndex(i => i.id === state.selectedItemId);
  if (idx < 0) return;
  const copy = JSON.parse(JSON.stringify(state.queue[idx]));
  copy.id = newId();
  if (copy.imageName) copy.imageName = copy.imageName + '_copy';
  commitChange(() => {
    state.queue.splice(idx + 1, 0, copy);
  });
  flashItem(copy.id);
  selectItem(copy.id);
}

/* ============================================================
   SECTION 11 — Initial render + autosave restore
   ============================================================ */

(function initAutosaveRestore() {
  let saved = null;
  try { saved = localStorage.getItem(AUTOSAVE_KEY); } catch (_) {}
  if (saved) {
    try {
      const data = JSON.parse(saved);
      if (data && Array.isArray(data.queue) && data.queue.length > 0) {
        if (confirm('Restore your last session? (Click Cancel to start fresh.)')) {
          restoreSnapshot(saved);
        } else {
          try { localStorage.removeItem(AUTOSAVE_KEY); } catch (_) {}
        }
      }
    } catch (_) {}
  }
  renderQueue();
})();
