/* ═══════════════════════════════════════════════════════════════════
   Dashboard — app.js
   Handles: tab navigation, clock, server status, signature pad,
            document signing, eHRAF check, schedule analysis,
            reports listing, dynamic form filler.
═══════════════════════════════════════════════════════════════════ */

'use strict';

// ── Utilities ──────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast align-items-center text-bg-${type} border-0 show`;
  el.role = 'alert';
  el.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${msg}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto"
              data-bs-dismiss="toast"></button>
    </div>`;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}
const showToast = toast;

function statusAlert(containerId, msg, type = 'info') {
  const el = document.getElementById(containerId);
  el.innerHTML = `<div class="alert alert-${type} status-alert mb-0">${msg}</div>`;
}

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data: json };
}

// ── Folder / multi-file collection ─────────────────────────────────

async function _entryToFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function _traverseEntry(entry, out) {
  if (entry.isFile) {
    const f = await _entryToFile(entry);
    const ext = f.name.split('.').pop().toLowerCase();
    if (['pdf', 'docx'].includes(ext)) out.push(f);
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const child of batch) await _traverseEntry(child, out);
    } while (batch.length > 0);
  }
}

async function _filesFromDataTransfer(dt) {
  const out = [];
  if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
    for (const item of dt.items) {
      const entry = item.webkitGetAsEntry();
      if (entry) await _traverseEntry(entry, out);
    }
  } else {
    for (const f of dt.files) {
      const ext = f.name.split('.').pop().toLowerCase();
      if (['pdf', 'docx'].includes(ext)) out.push(f);
    }
  }
  return out;
}

// ── Clock & server status ──────────────────────────────────────────

function startClock() {
  const el = document.getElementById('clock');
  const tick = () => {
    const now = new Date();
    el.textContent = now.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  };
  tick();
  setInterval(tick, 30000);
}

async function checkServerStatus() {
  const dot = document.getElementById('statusDot');
  try {
    const { ok } = await apiFetch('/api/status');
    dot.className = `status-dot ${ok ? 'status-ok' : 'status-error'}`;
    dot.title = ok ? 'Server online' : 'Server error';
  } catch {
    dot.className = 'status-dot status-error';
    dot.title = 'Cannot reach server';
  }
}

// ── Tab navigation ─────────────────────────────────────────────────

function initTabs() {
  const links = document.querySelectorAll('#sideNav .nav-link');
  const panes = document.querySelectorAll('.tab-pane');

  function activate(tabName) {
    links.forEach(l => l.classList.toggle('active', l.dataset.tab === tabName));
    panes.forEach(p => {
      const active = p.id === `tab-${tabName}`;
      p.classList.toggle('d-none', !active);
      p.classList.toggle('active', active);
    });
    if (tabName === 'reports') loadReports();
    if (tabName === 'autopen') loadSignedHistory();
    }

  links.forEach(l => l.addEventListener('click', e => {
    e.preventDefault();
    activate(l.dataset.tab);
  }));

  activate('autopen');
}

// ══════════════════════════════════════════════════════════════════
// AUTOPEN — Signature pad
// ══════════════════════════════════════════════════════════════════

let isDrawing = false;
let lastX = 0, lastY = 0;

function initSignaturePad() {
  const canvas    = document.getElementById('sigCanvas');
  const ctx       = canvas.getContext('2d');
  const ph        = document.getElementById('sigPlaceholder');
  const colorPick = document.getElementById('sigColor');
  const weightIn  = document.getElementById('sigWeight');

  function scale() {
    const rect = canvas.getBoundingClientRect();
    canvas.width  = rect.width  * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    ctx.lineCap   = 'round';
    ctx.lineJoin  = 'round';
  }
  scale();
  window.addEventListener('resize', scale);

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const src  = e.touches ? e.touches[0] : e;
    return [src.clientX - rect.left, src.clientY - rect.top];
  }

  function startDraw(e) {
    e.preventDefault();
    isDrawing = true;
    [lastX, lastY] = getPos(e);
    ph.classList.add('hidden');
  }

  function draw(e) {
    if (!isDrawing) return;
    e.preventDefault();
    const [x, y] = getPos(e);
    ctx.beginPath();
    ctx.strokeStyle = colorPick.value;
    ctx.lineWidth   = +weightIn.value;
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();
    [lastX, lastY] = [x, y];
  }

  function endDraw() { isDrawing = false; }

  canvas.addEventListener('mousedown',  startDraw);
  canvas.addEventListener('mousemove',  draw);
  canvas.addEventListener('mouseup',    endDraw);
  canvas.addEventListener('mouseleave', endDraw);
  canvas.addEventListener('touchstart', startDraw, { passive: false });
  canvas.addEventListener('touchmove',  draw,      { passive: false });
  canvas.addEventListener('touchend',   endDraw);

  document.getElementById('btnClearCanvas').addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ph.classList.remove('hidden');
  });

  return canvas;
}

// Signature input tabs (draw / upload / type / script)
function initSigInputTabs() {
  const panels = { draw: 'sigDrawPanel', upload: 'sigUploadPanel', type: 'sigTypePanel', script: 'sigScriptPanel' };

  document.querySelectorAll('[data-sigtab]').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      document.querySelectorAll('[data-sigtab]').forEach(l => l.classList.remove('active'));
      link.classList.add('active');
      const tab = link.dataset.sigtab;
      Object.entries(panels).forEach(([key, id]) =>
        document.getElementById(id).classList.toggle('d-none', key !== tab)
      );
    });
  });

  // Upload zone: image file
  const imgInput = document.getElementById('sigImageInput');
  imgInput.addEventListener('change', () => {
    const file = imgInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const preview = document.getElementById('sigUploadPreview');
      document.getElementById('sigPreviewImg').src = ev.target.result;
      preview.classList.remove('d-none');
    };
    reader.readAsDataURL(file);
  });

  const zone = document.getElementById('sigUploadZone');
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) {
      const dt = new DataTransfer();
      dt.items.add(f);
      imgInput.files = dt.files;
      imgInput.dispatchEvent(new Event('change'));
    }
  });

  // Type panel
  const typeCanvas  = document.getElementById('sigTypeCanvas');
  const typeCtx     = typeCanvas.getContext('2d');
  function renderTypeCanvas() {
    const text    = document.getElementById('sigTypeText').value;
    const font    = document.getElementById('sigTypeFont').value;
    const size    = document.getElementById('sigTypeFontSize').value;
    const color   = document.getElementById('sigTypeColor').value;
    const italic  = document.getElementById('sigTypeItalic').checked ? 'italic ' : '';
    typeCtx.clearRect(0, 0, typeCanvas.width, typeCanvas.height);
    if (!text) return;
    typeCtx.font = `${italic}${size}px ${font}`;
    typeCtx.fillStyle = color;
    typeCtx.textBaseline = 'middle';
    typeCtx.fillText(text, 16, typeCanvas.height / 2);
  }
  ['sigTypeText','sigTypeFont','sigTypeFontSize','sigTypeColor','sigTypeItalic'].forEach(id =>
    document.getElementById(id).addEventListener('input', renderTypeCanvas)
  );

  // Script panel
  const scriptCanvas = document.getElementById('sigScriptCanvas');
  const scriptCtx    = scriptCanvas.getContext('2d');
  function renderScriptCanvas() {
    const text   = document.getElementById('sigScriptText').value;
    const font   = document.getElementById('sigScriptStyle').value;
    const size   = document.getElementById('sigScriptSize').value;
    const color  = document.getElementById('sigScriptColor').value;
    const slant  = document.getElementById('sigScriptSlant').checked;
    scriptCtx.clearRect(0, 0, scriptCanvas.width, scriptCanvas.height);
    if (!text) return;
    scriptCtx.save();
    if (slant) {
      scriptCtx.transform(1, 0, -0.18, 1, 20, 0);
    }
    scriptCtx.font = `italic ${size}px ${font}`;
    scriptCtx.fillStyle = color;
    scriptCtx.textBaseline = 'middle';
    scriptCtx.fillText(text, 16, scriptCanvas.height / 2);
    scriptCtx.restore();
  }
  ['sigScriptText','sigScriptStyle','sigScriptSize','sigScriptColor','sigScriptSlant'].forEach(id =>
    document.getElementById(id).addEventListener('input', renderScriptCanvas)
  );
}

function getSignatureDataUrl() {
  const activeTab = document.querySelector('[data-sigtab].active')?.dataset.sigtab || 'draw';
  if (activeTab === 'upload') {
    return document.getElementById('sigPreviewImg').src || null;
  }
  if (activeTab === 'type') {
    const c = document.getElementById('sigTypeCanvas');
    return isCanvasBlank(c) ? null : c.toDataURL('image/png');
  }
  if (activeTab === 'script') {
    const c = document.getElementById('sigScriptCanvas');
    return isCanvasBlank(c) ? null : c.toDataURL('image/png');
  }
  const canvas = document.getElementById('sigCanvas');
  return isCanvasBlank(canvas) ? null : canvas.toDataURL('image/png');
}

function isCanvasBlank(canvas) {
  const blank = document.createElement('canvas');
  blank.width = canvas.width;
  blank.height = canvas.height;
  return canvas.toDataURL('image/png') === blank.toDataURL('image/png');
}

async function loadSavedSignature() {
  const { data } = await apiFetch('/api/autopen/signature');
  const savedSection  = document.getElementById('savedSigSection');
  const noSigNotice   = document.getElementById('noSigNotice');
  const badge         = document.getElementById('sigSavedBadge');
  if (data.has_signature) {
    document.getElementById('savedSigImg').src = data.signature;
    savedSection.classList.remove('d-none');
    noSigNotice.classList.add('d-none');
    badge.classList.remove('d-none');
  } else {
    savedSection.classList.add('d-none');
    noSigNotice.classList.remove('d-none');
    badge.classList.add('d-none');
  }
}

function initSignatureActions() {
  document.getElementById('btnSaveSig').addEventListener('click', async () => {
    const sig = getSignatureDataUrl();
    if (!sig) { toast('Please draw or upload a signature first.', 'warning'); return; }
    const { ok, data } = await apiFetch('/api/autopen/signature', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: sig }),
    });
    if (ok) { toast('Signature saved!'); loadSavedSignature(); }
    else    { toast(data.error || 'Failed to save signature', 'danger'); }
  });

  document.getElementById('btnClearSig').addEventListener('click', async () => {
    if (!confirm('Remove saved signature?')) return;
    await apiFetch('/api/autopen/signature', { method: 'DELETE' });
    loadSavedSignature();
    toast('Signature cleared', 'secondary');
  });
}

// ══════════════════════════════════════════════════════════════════
// AUTOPEN — Placement controls
// ══════════════════════════════════════════════════════════════════

let placements = [{ page: 0, x: 0.55, y: 0.05, width: 0.30, height: 0.08 }];

function renderPlacements() {
  const list = document.getElementById('placementList');
  list.innerHTML = '';

  placements.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'placement-row';
    row.innerHTML = `
      <div>
        <label>Page</label>
        <input type="number" class="form-control form-control-sm" min="1" value="${p.page + 1}"
               data-idx="${i}" data-field="page" />
      </div>
      <div>
        <label>Left %</label>
        <input type="number" class="form-control form-control-sm" min="0" max="100" step="1"
               value="${Math.round(p.x * 100)}" data-idx="${i}" data-field="x" />
      </div>
      <div>
        <label>Bottom %</label>
        <input type="number" class="form-control form-control-sm" min="0" max="100" step="1"
               value="${Math.round(p.y * 100)}" data-idx="${i}" data-field="y" />
      </div>
      <div>
        <label>Width %</label>
        <input type="number" class="form-control form-control-sm" min="5" max="100" step="1"
               value="${Math.round(p.width * 100)}" data-idx="${i}" data-field="width" />
      </div>
      <div>
        <label>Height %</label>
        <input type="number" class="form-control form-control-sm" min="2" max="50" step="1"
               value="${Math.round(p.height * 100)}" data-idx="${i}" data-field="height" />
      </div>
      <div style="padding-top:18px">
        <button class="btn btn-sm btn-outline-danger" data-remove="${i}">
          <i class="bi bi-trash"></i>
        </button>
      </div>`;
    list.appendChild(row);
  });

  list.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('change', () => {
      const idx   = +inp.dataset.idx;
      const field = inp.dataset.field;
      let val = parseFloat(inp.value);
      if (field === 'page') {
        placements[idx].page = Math.max(0, Math.round(val) - 1);
      } else {
        placements[idx][field] = val / 100;
      }
      updatePlacementSummary();
    });
  });

  list.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      placements.splice(+btn.dataset.remove, 1);
      if (!placements.length) placements = [{ page: 0, x: 0.55, y: 0.05, width: 0.30, height: 0.08 }];
      renderPlacements();
      updatePlacementSummary();
    });
  });

  updatePlacementSummary();
}

function updatePlacementSummary() {
  const s = placements.map(p =>
    `Page ${p.page + 1} @ (${Math.round(p.x * 100)}%, ${Math.round(p.y * 100)}%)`
  ).join(' · ');
  document.getElementById('placementSummary').textContent = s;
}

function initPlacementControls() {
  renderPlacements();
  document.getElementById('btnAddPlacement').addEventListener('click', () => {
    placements.push({ page: 0, x: 0.55, y: 0.05, width: 0.30, height: 0.08 });
    renderPlacements();
  });
}

// ══════════════════════════════════════════════════════════════════
// AUTOPEN — Document signing
// ══════════════════════════════════════════════════════════════════

let selectedFiles = [];

function initDocUpload() {
  const zone        = document.getElementById('docDropZone');
  const fileInput   = document.getElementById('docFileInput');
  const folderInput = document.getElementById('docFolderInput');

  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', async e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const files = await _filesFromDataTransfer(e.dataTransfer);
    addFiles(files);
  });

  fileInput.addEventListener('change',   () => addFiles([...fileInput.files]));
  folderInput.addEventListener('change', () => addFiles([...folderInput.files].filter(f => {
    const ext = f.name.split('.').pop().toLowerCase();
    return ['pdf', 'docx'].includes(ext);
  })));

  function addFiles(files) {
    files.forEach(f => {
      const ext = f.name.split('.').pop().toLowerCase();
      if (!['pdf', 'docx'].includes(ext)) {
        toast(`${f.name}: only PDF and DOCX are supported`, 'warning');
        return;
      }
      if (!selectedFiles.find(x => x.name === f.name && x.size === f.size)) {
        selectedFiles.push(f);
      }
    });
    renderFileList();
  }

  function renderFileList() {
    const wrap = document.getElementById('selectedFiles');
    const list = document.getElementById('fileList');
    if (!selectedFiles.length) { wrap.classList.add('d-none'); return; }
    wrap.classList.remove('d-none');
    list.innerHTML = selectedFiles.map((f, i) => `
      <li class="list-group-item d-flex align-items-center gap-2 py-1 px-2">
        <i class="bi ${f.name.endsWith('.pdf') ? 'bi-file-earmark-pdf text-danger' : 'bi-file-earmark-word text-primary'}"></i>
        <span class="flex-fill small">${f.name}</span>
        <small class="text-muted">${(f.size / 1024).toFixed(0)} KB</small>
        <button class="btn btn-link btn-sm p-0 text-danger" data-remove="${i}">
          <i class="bi bi-x-lg"></i>
        </button>
      </li>`).join('');
    list.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedFiles.splice(+btn.dataset.remove, 1);
        renderFileList();
      });
    });
  }
}

async function signDocuments() {
  if (!selectedFiles.length) { toast('Please select at least one file.', 'warning'); return; }

  const progressWrap = document.getElementById('signProgress');
  const bar          = document.getElementById('signProgressBar');
  const label        = document.getElementById('signProgressLabel');
  progressWrap.classList.remove('d-none');

  const fd = new FormData();

  if (selectedFiles.length === 1) {
    // ── Single file: upload → form-type select modal ──────────────────────
    fd.append('file', selectedFiles[0]);
    bar.style.width = '40%';
    label.textContent = `Signing ${selectedFiles[0].name}…`;
    const { ok, data } = await apiFetch('/api/autopen/sign', { method: 'POST', body: fd });
    bar.style.width = '100%';
    setTimeout(() => progressWrap.classList.add('d-none'), 400);
    if (ok && data.needs_placement) {
      openFormTypeSelect(data);
    } else if (!ok) {
      toast(data.error || 'Could not prepare document', 'danger');
    }
  } else {
    // ── Multiple files: upload all first, then show form-type select once ──
    selectedFiles.forEach(f => fd.append('files', f));
    bar.style.width = '30%';
    label.textContent = `Uploading ${selectedFiles.length} files…`;
    const { ok, data } = await apiFetch('/api/autopen/upload-batch', { method: 'POST', body: fd });
    bar.style.width = '60%';
    setTimeout(() => progressWrap.classList.add('d-none'), 400);
    if (ok) {
      // Reuse the same form-type select modal; store batch info in _ftSelectData
      openFormTypeSelect({
        saved_filenames:   data.saved_filenames,   // array — signals batch mode
        file_count:        data.file_count,
        form_types:        data.form_types,
        // single-file fields left undefined so the modal knows it's batch
        saved_filename:    null,
        page_count:        null,
        suggested_placement: null,
        suggestion_source:   null,
        suggested_form_name: '',
      });
    } else {
      toast(data.error || 'Upload failed', 'danger');
    }
  }

  setTimeout(() => progressWrap.classList.add('d-none'), 2000);
}

async function signDocumentsBatch(files) {
  const progressWrap  = document.getElementById('signProgress');
  const bar           = document.getElementById('signProgressBar');
  const label         = document.getElementById('signProgressLabel');
  const batchResults  = document.getElementById('batchResults');

  progressWrap.classList.remove('d-none');
  bar.style.width = '20%';
  label.textContent = `Uploading ${files.length} file(s)…`;
  batchResults.classList.add('d-none');

  const fd = new FormData();
  files.forEach(f => fd.append('files', f));

  bar.style.width = '50%';
  label.textContent = 'Signing matched files…';

  const { ok, data } = await apiFetch('/api/autopen/sign-batch', {
    method: 'POST',
    body: fd,
  });

  bar.style.width = '100%';
  setTimeout(() => progressWrap.classList.add('d-none'), 500);

  if (!ok) {
    toast(data.error || 'Batch signing failed', 'danger');
    return;
  }

  _renderBatchResults(data.signed || [], data.unmatched || []);
}

function _renderBatchResults(signed, unmatched) {
  const wrap = document.getElementById('batchResults');
  wrap.classList.remove('d-none');

  // ── Signed ──────────────────────────────────────────────────────
  const signedSec   = document.getElementById('batchSignedSection');
  const signedList  = document.getElementById('batchSignedList');
  const signedCount = document.getElementById('batchSignedCount');

  if (signed.length) {
    signedCount.textContent = signed.length;
    signedList.innerHTML = signed.map(r => `
      <li class="list-group-item d-flex align-items-center gap-2 py-1 px-2">
        <i class="bi bi-file-earmark-pdf text-danger"></i>
        <span class="flex-fill small text-truncate">${escHtml(r.original_name)}</span>
        <span class="badge bg-primary me-1" title="Form type used">${escHtml(r.form_type)}</span>
        <a href="/api/autopen/download/${encodeURIComponent(r.signed_name)}"
           class="btn btn-sm btn-outline-primary py-0" download>
          <i class="bi bi-download"></i>
        </a>
      </li>`).join('');
    signedSec.classList.remove('d-none');
  } else {
    signedSec.classList.add('d-none');
  }

  // ── Unmatched ────────────────────────────────────────────────────
  const unmatchedSec   = document.getElementById('batchUnmatchedSection');
  const unmatchedList  = document.getElementById('batchUnmatchedList');
  const unmatchedCount = document.getElementById('batchUnmatchedCount');

  if (unmatched.length) {
    unmatchedCount.textContent = unmatched.length;
    unmatchedList.innerHTML = '';

    unmatched.forEach((u, idx) => {
      const card = document.createElement('div');
      card.className = 'border rounded p-2 d-flex align-items-center gap-2 bg-white';
      card.dataset.idx = idx;
      card.innerHTML = `
        <i class="bi bi-file-earmark-pdf text-muted fs-5"></i>
        <div class="flex-fill min-width-0">
          <div class="small fw-semibold text-truncate">${escHtml(u.original_name)}</div>
          ${u.suggested_form_name
            ? `<div class="small text-muted">Detected: ${escHtml(u.suggested_form_name)}</div>`
            : '<div class="small text-muted fst-italic">Form type not recognised</div>'}
          ${u.error ? `<div class="small text-danger">${escHtml(u.error)}</div>` : ''}
        </div>
        <button class="btn btn-sm btn-warning flex-shrink-0 batch-place-btn"
                data-idx="${idx}">
          <i class="bi bi-cursor me-1"></i>Place Signature
        </button>`;
      unmatchedList.appendChild(card);
    });

    // Wire up "Place Signature" buttons
    unmatchedList.querySelectorAll('.batch-place-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const u = unmatched[+btn.dataset.idx];
        _pp.isNewFormType     = true;
        _pp.suggestedFormName = u.suggested_form_name || '';
        // After signing, move this card to the signed section
        _pp._batchCard        = btn.closest('[data-idx]');
        _pp._batchUnmatched   = u;
        openPlacementPicker(
          u.saved_filename,
          u.page_count,
          u.suggested_placement,
          u.suggested_placement ? 'detected' : null,
        );
      });
    });

    unmatchedSec.classList.remove('d-none');
  } else {
    unmatchedSec.classList.add('d-none');
  }

  // Summary toast
  const total = signed.length + unmatched.length;
  if (signed.length && !unmatched.length) {
    toast(`All ${signed.length} file(s) signed automatically`);
  } else if (signed.length) {
    toast(`${signed.length} of ${total} signed automatically — ${unmatched.length} need manual placement`, 'info');
  } else {
    toast(`No form types matched — please place signatures manually`, 'warning');
  }

  loadSignedHistory();
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function loadSignedHistory() {
  const { ok, data } = await apiFetch('/api/autopen/documents');
  const tbody = document.getElementById('signedDocsTbody');
  if (!ok || !data.documents.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-muted text-center py-3">No signed documents yet</td></tr>';
    return;
  }
  tbody.innerHTML = data.documents.map(d => `
    <tr>
      <td><i class="bi bi-file-earmark-pdf text-danger me-1"></i>${d.filename}</td>
      <td>${d.size_kb} KB</td>
      <td>${d.created}</td>
      <td class="text-end">
        <a href="/api/autopen/download/${encodeURIComponent(d.filename)}"
           class="btn btn-sm btn-outline-primary" download>
          <i class="bi bi-download me-1"></i>Download
        </a>
      </td>
    </tr>`).join('');
}

// ══════════════════════════════════════════════════════════════════
// eHRAF Quality Check
// ══════════════════════════════════════════════════════════════════

function initEhraf() {
  document.getElementById('ehrafForm').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const btn  = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Running…';
    statusAlert('ehrafStatus', '<span class="spinner-border spinner-border-sm me-2"></span>Running quality check…', 'info');

    const fd = new FormData(form);
    const { ok, data } = await apiFetch('/api/ehraf/run', { method: 'POST', body: fd });
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-play-fill me-1"></i>Run Quality Check';

    if (ok) {
      statusAlert('ehrafStatus',
        `<i class="bi bi-check-circle-fill me-1"></i>Report generated:
         <a href="/api/reports/download/${encodeURIComponent(data.report)}" class="alert-link" download>${data.report}</a>`,
        'success');
    } else {
      statusAlert('ehrafStatus', `<i class="bi bi-x-circle-fill me-1"></i>${data.error || 'Unknown error'}`, 'danger');
    }
  });
}

// ══════════════════════════════════════════════════════════════════
// Schedule Analysis
// ══════════════════════════════════════════════════════════════════

function initSchedule() {
  document.getElementById('scheduleForm').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const btn  = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Running…';
    statusAlert('scheduleStatus', '<span class="spinner-border spinner-border-sm me-2"></span>Analyzing schedule…', 'info');

    const fd = new FormData(form);
    const { ok, data } = await apiFetch('/api/schedule/run', { method: 'POST', body: fd });
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-play-fill me-1"></i>Run Analysis';

    if (ok) {
      statusAlert('scheduleStatus',
        `<i class="bi bi-check-circle-fill me-1"></i>Report generated:
         <a href="/api/reports/download/${encodeURIComponent(data.report)}" class="alert-link" download>${data.report}</a>`,
        'success');
    } else {
      statusAlert('scheduleStatus', `<i class="bi bi-x-circle-fill me-1"></i>${data.error || 'Unknown error'}`, 'danger');
    }
  });
}

// ══════════════════════════════════════════════════════════════════
// Reports tab
// ══════════════════════════════════════════════════════════════════

async function loadReports() {
  const { ok, data } = await apiFetch('/api/reports');
  const tbody = document.getElementById('reportsTbody');
  if (!ok || !data.reports.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-muted text-center py-3">No reports yet</td></tr>';
    return;
  }
  tbody.innerHTML = data.reports.map(r => `
    <tr>
      <td><i class="bi bi-file-earmark-spreadsheet text-success me-1"></i>${r.filename}</td>
      <td>${r.size_kb} KB</td>
      <td>${r.created}</td>
      <td class="text-end">
        <a href="/api/reports/download/${encodeURIComponent(r.filename)}"
           class="btn btn-sm btn-outline-primary" download>
          <i class="bi bi-download me-1"></i>Download
        </a>
      </td>
    </tr>`).join('');
}

// eHRAF Generator
// ══════════════════════════════════════════════════════════════════

const SEASON_DEFAULTS = {
  Fall:   [{ code: '1',   start: '', end: '' }],
  Spring: [{ code: '1',   start: '', end: '' }],
  Summer: [{ code: '5W1', start: '', end: '' }, { code: '5W2', start: '', end: '' }],
  Winter: [{ code: '1',   start: '', end: '' }],
};

const SEASON_LABEL = {
  Fall: 'Semester + 8-Week Sessions', Spring: 'Semester + 8-Week Sessions',
  Summer: 'Sub-Session Dates', Winter: 'Session Dates',
};

const SEASON_PLACEHOLDER = {
  Fall: '8W1 / 8W2', Spring: '8W1 / 8W2', Summer: '5W1 / 8W1', Winter: '1',
};

function initEhrafGen() {
  document.getElementById('ehrafSeason').addEventListener('change', _ehrafSeasonChange);
  document.getElementById('btnAddSession').addEventListener('click', () => _ehrafAddSessionRow());
  document.getElementById('btnGenerateEhraf').addEventListener('click', generateEhraf);
  _ehrafSeasonChange();
}

function _ehrafSeasonChange() {
  const season = document.getElementById('ehrafSeason').value;
  document.getElementById('ehrafDatesLabel').textContent = SEASON_LABEL[season] || 'Session Dates';
  // Reset rows to defaults for this season
  const tbody = document.getElementById('ehrafSessionRows');
  tbody.innerHTML = '';
  (SEASON_DEFAULTS[season] || []).forEach(s => _ehrafAddSessionRow(s));
}

function _ehrafAddSessionRow(preset = {}) {
  const season = document.getElementById('ehrafSeason').value;
  const ph = SEASON_PLACEHOLDER[season] || '8W1';
  const tbody = document.getElementById('ehrafSessionRows');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="form-control form-control-sm ehraf-sess-code"
               value="${escHtml(preset.code || '')}" placeholder="${ph}"></td>
    <td><input type="date" class="form-control form-control-sm ehraf-sess-start"
               value="${escHtml(preset.start || '')}"></td>
    <td><input type="date" class="form-control form-control-sm ehraf-sess-end"
               value="${escHtml(preset.end || '')}"></td>
    <td><button class="btn btn-outline-danger btn-sm px-1 py-0"
                onclick="this.closest('tr').remove()"><i class="bi bi-x"></i></button></td>`;
  tbody.appendChild(tr);
}

function _ehrafGetSessions() {
  return [...document.querySelectorAll('#ehrafSessionRows tr')].map(tr => ({
    code:  tr.querySelector('.ehraf-sess-code').value.trim(),
    start: tr.querySelector('.ehraf-sess-start').value.trim(),
    end:   tr.querySelector('.ehraf-sess-end').value.trim(),
  })).filter(s => s.code);
}

async function generateEhraf() {
  const schedFile = document.getElementById('ehrafScheduleFile').files[0];
  if (!schedFile) { toast('Please select a schedule file', 'warning'); return; }

  const sessions = _ehrafGetSessions();
  if (!sessions.length) { toast('Add at least one session', 'warning'); return; }

  const btn = document.getElementById('btnGenerateEhraf');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Generating…';

  const fd = new FormData();
  fd.append('season',        document.getElementById('ehrafSeason').value);
  fd.append('year',          document.getElementById('ehrafYear').value);
  fd.append('sessions',      JSON.stringify(sessions));
  fd.append('schedule_file', schedFile);
  const prevSchedFile = document.getElementById('ehrafPrevScheduleFile').files[0];
  if (prevSchedFile) fd.append('prev_schedule_file', prevSchedFile);
  const instrFile = document.getElementById('ehrafInstrFile').files[0];
  if (instrFile) fd.append('instructor_file', instrFile);

  try {
    const resp = await fetch('/api/ehraf/generate-payroll', { method: 'POST', body: fd });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error || resp.statusText);
    }
    const blob = await resp.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const season = document.getElementById('ehrafSeason').value;
    const year   = document.getElementById('ehrafYear').value;
    a.href = url; a.download = `EHRAF_${season}${year}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);

    document.getElementById('ehrafPreview').innerHTML = `
      <i class="bi bi-check-circle-fill text-success fs-1 mb-3"></i>
      <div class="fw-semibold">EHRAF_${season}${year}.xlsx downloaded</div>
      <div class="small text-muted mt-1">Check your Downloads folder.</div>`;
  } catch (e) {
    toast('Generation failed: ' + e.message, 'danger');
    document.getElementById('ehrafPreview').innerHTML = `
      <i class="bi bi-exclamation-triangle-fill text-danger fs-1 mb-3"></i>
      <div>${escHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-download me-2"></i>Generate &amp; Download';
  }
}

// ══════════════════════════════════════════════════════════════════
// AUTOPEN — Manual placement picker
// ══════════════════════════════════════════════════════════════════

// Returns the best available signer name for pre-filling AutoPen text fields.
// Returns the best available signer name for pre-filling AutoPen text fields.
// Checks ppSignerName input, or empty string.
function _autopenSignerName() {
  const inp = document.getElementById('ppSignerName');
  return (inp && inp.value.trim()) ? inp.value.trim() : '';
}

const _pp = {
  savedFilename:      null,
  pageCount:          1,
  currentPage:        0,           // 0-indexed
  fieldType:          'signature', // 'signature' | 'name' | 'date'
  placement:          null,    // { page, x, y, width, height }  — signature (legacy, points at active)
  placements:         [],      // array of sig placements (multi-box support)
  activeSigIdx:       0,       // index into placements[] currently being edited
  namePlacements:     [],      // array of name text placements
  datePlacements:     [],      // array of date text placements
  activeNameIdx:      0,       // active slot in namePlacements
  activeDateIdx:      0,       // active slot in datePlacements
  textStamps:         [],      // [{page, x, y, font_size, text}, ...] — free-form text stamps
  activeTextStampIdx: 0,       // which text stamp slot is active
  suggestion:         null,    // server-supplied suggestion (first box)
  suggestionSource:   null,    // 'memory' | 'detected' | null
  suggestedFormName:  '',      // suggested name extracted from PDF title/heading
  isNewFormType:      true,    // false when signing via a known form type
  confirmedPlacement: null,    // stored after signing for the save dialog
  batch:              null,    // {saved_filenames, file_count} or null
  modal:              null,
};

function openPlacementPicker(savedFilename, pageCount, suggestions, suggestionSource, batchOptions = null, customCallback = null, prefillSignerName = null) {
  _pp.savedFilename    = savedFilename;
  _pp.pageCount        = pageCount || 1;
  _pp.currentPage      = 0;
  _pp.fieldType        = 'signature';
  _pp.suggestionSource = suggestionSource || null;
  _pp.batch            = batchOptions ? { ...batchOptions, currentIndex: 0, signedFiles: [] } : null;

  // Reset results panel / restore signing controls
  document.getElementById('ppBatchResults')?.classList.add('d-none');
  document.getElementById('ppSigningControls')?.classList.remove('d-none');
  _pp.customCallback   = customCallback || null; // optional fn(placement, signerName) for non-standard flows

  // Seed name/date placements from form type (batch) or start empty (single/new)
  const _seedName = batchOptions?.name_placement;
  const _seedDate = batchOptions?.date_placement;
  _pp.namePlacements = _seedName ? [{ ..._seedName }] : [];
  _pp.datePlacements = _seedDate ? [{ ..._seedDate }] : [];
  _pp.activeNameIdx  = 0;
  _pp.activeDateIdx  = 0;

  if (prefillSignerName) {
    const sn = document.getElementById('ppSignerName');
    if (sn && !sn.value.trim()) sn.value = prefillSignerName;
  }

  // Normalise suggestions → array of placement dicts
  const sArr = Array.isArray(suggestions)
    ? suggestions
    : (suggestions ? [suggestions] : []);
  _pp.placements      = sArr.map(s => ({ ...s }));
  _pp.activeSigIdx    = 0;
  // Keep legacy _pp.placement pointing at active box for form-type-save compat
  _pp.placement       = _pp.placements[0] || null;
  _pp.suggestion      = sArr[0] || null;

  if (!_pp.modal) {
    _pp.modal = new bootstrap.Modal(document.getElementById('placementPickerModal'));
  }

  // Seed text stamp positions from form type (text content is empty — user fills at signing time)
  const _seedTextPls = batchOptions?.text_placements;
  _pp.textStamps         = Array.isArray(_seedTextPls) && _seedTextPls.length
    ? _seedTextPls.map(tp => ({ ...tp, text: tp.text || '' }))
    : [];
  _pp.activeTextStampIdx = 0;

  // Reset field type radio to Signature
  const ftSig = document.getElementById('ppFtSig');
  if (ftSig) ftSig.checked = true;
  _ppUpdateFieldTypeUI('signature');
  _ppUpdateTextFillPanel();

  // Sync W/H sliders from first suggestion
  const firstSug = sArr[0];
  if (firstSug) {
    const w = Math.round((firstSug.width  || 0.28) * 100);
    const h = Math.round((firstSug.height || 0.08) * 100);
    const wSlider = document.getElementById('ppSigWidth');
    const hSlider = document.getElementById('ppSigHeight');
    wSlider.value = Math.min(Math.max(w, +wSlider.min), +wSlider.max);
    hSlider.value = Math.min(Math.max(h, +hSlider.min), +hSlider.max);
    document.getElementById('ppSigWidthLabel').textContent  = wSlider.value + '%';
    document.getElementById('ppSigHeightLabel').textContent = hSlider.value + '%';
  }

  // Pre-populate signer name
  const ppNameInp = document.getElementById('ppSignerName');
  if (ppNameInp && !ppNameInp.value) ppNameInp.value = _autopenSignerName();

  // Instruction text
  const multiBox  = _pp.placements.length > 1;
  const hasSug    = _pp.placements.length > 0;
  document.getElementById('ppInstruction').innerHTML = hasSug
    ? (multiBox
        ? `${_ppSuggestionBadge(suggestionSource)}${_pp.placements.length} spots detected — click to adjust, use ↔ to switch`
        : _ppSuggestionBadge(suggestionSource) + ' — click to move, or confirm as-is')
    : 'Click anywhere to place Signature';

  // Confirm button label
  const confirmBtn = document.getElementById('ppConfirmBtn');
  confirmBtn.disabled = _pp.placements.filter(Boolean).length === 0;
  if (_pp.batch) {
    _ppUpdateBatchBtn();
  } else {
    confirmBtn.innerHTML = '<i class="bi bi-pen-fill me-1"></i>Sign Here';
  }

  // Modal title
  const title = document.getElementById('ppModalLabel');
  if (title) {
    title.innerHTML = _pp.batch
      ? `<i class="bi bi-cursor me-2"></i>File 1 of ${_pp.batch.file_count} <span class="badge text-bg-secondary ms-1">${_pp.savedFilename.replace(/^\d{8}_\d{6}_[^_]+_/, '')}</span>`
      : '<i class="bi bi-cursor me-2"></i>Click to Place Signature';
  }

  _ppUpdatePlacementNote();
  _pp.modal.show();

  // Navigate to the page that has the first detected sig box
  const startPage = (_pp.placements[0] && _pp.placements[0].page != null)
    ? _pp.placements[0].page : 0;
  _ppLoadPage(startPage);
}

function _ppSuggestionBadge(source) {
  if (source === 'memory')   return '<span class="badge bg-primary me-1">Remembered</span>';
  if (source === 'detected') return '<span class="badge bg-success me-1">Auto-detected</span>';
  return '';
}

function _ppShowBatchResults(signedFiles) {
  // Hide the signing controls, show the download results panel
  document.getElementById('ppSigningControls').classList.add('d-none');
  document.getElementById('ppBatchResults').classList.remove('d-none');

  const list = document.getElementById('ppBatchResultsList');
  list.innerHTML = signedFiles.map(({ signed, original }) => {
    // Strip timestamp prefix for a readable label
    const label = original.replace(/^\d{8}_\d{6}_[^_]+_/, '') || signed;
    return `<a href="/api/autopen/download/${encodeURIComponent(signed)}"
               download="${escHtml(signed)}"
               class="btn btn-sm btn-outline-primary d-flex align-items-center gap-1"
               title="${escHtml(signed)}">
      <i class="bi bi-file-earmark-arrow-down"></i>
      <span style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(label)}</span>
    </a>`;
  }).join('');

  // "Download All" triggers every file
  document.getElementById('ppDownloadAllBtn').onclick = () => {
    signedFiles.forEach(({ signed }) =>
      triggerDownload('/api/autopen/download/' + encodeURIComponent(signed), signed)
    );
  };
}

function _ppUpdateBatchBtn() {
  if (!_pp.batch) return;
  const btn        = document.getElementById('ppConfirmBtn');
  const signAllBtn = document.getElementById('ppSignAllBtn');
  const idx        = _pp.batch.currentIndex || 0;
  const total      = _pp.batch.file_count;
  const remaining  = total - idx;   // files not yet signed (including current)
  const isLast     = remaining <= 1;

  btn.innerHTML = isLast
    ? '<i class="bi bi-pen-fill me-1"></i>Sign &amp; Finish'
    : `<i class="bi bi-pen-fill me-1"></i>Sign This &amp; Next <span class="badge bg-light text-dark ms-1">${idx + 1}/${total}</span>`;

  // Show "Sign All" only when there are multiple files left to sign
  if (signAllBtn) {
    if (!isLast) {
      signAllBtn.classList.remove('d-none');
      signAllBtn.innerHTML = `<i class="bi bi-pen-fill me-1"></i>Sign All <span class="badge bg-light text-dark ms-1">${remaining}</span>`;
    } else {
      signAllBtn.classList.add('d-none');
    }
  }
}

async function _ppSignAll() {
  if (!_pp.batch) return;

  const allPlacements  = _pp.placements.filter(Boolean);
  if (!allPlacements.length) { toast('Place the signature box first.', 'warning'); return; }

  const signerName     = (document.getElementById('ppSignerName')?.value || '').trim();
  const namePlacements = _pp.namePlacements.filter(Boolean);
  const datePlacements = _pp.datePlacements.filter(Boolean);

  const confirmBtn = document.getElementById('ppConfirmBtn');
  const signAllBtn = document.getElementById('ppSignAllBtn');
  confirmBtn.disabled = true;
  signAllBtn.disabled = true;

  const batch    = _pp.batch;
  const startIdx = batch.currentIndex || 0;
  const total    = batch.file_count;
  if (!batch.signedFiles) batch.signedFiles = [];

  for (let i = startIdx; i < total; i++) {
    const filename = batch.saved_filenames[i];
    signAllBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>Signing ${i + 1} of ${total}…`;

    const { ok, data } = await apiFetch('/api/autopen/sign-placement', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        saved_filename:  filename,
        placements:      allPlacements,
        signer_name:     signerName,
        name_placements: namePlacements,
        date_placements: datePlacements,
      }),
    });

    if (ok) {
      batch.signedFiles.push({ signed: data.filename, original: filename });
      loadSignedHistory();
    } else {
      batch.signedFiles.push({ signed: null, original: filename, error: data?.error || 'Signing failed' });
      toast(`File ${i + 1}/${total} failed: ${data?.error || 'unknown error'}`, 'danger');
    }
  }

  // Mark batch as complete and show results
  batch.currentIndex = total;
  _ppShowBatchResults(batch.signedFiles);
}

async function _ppLoadPage(pageNum) {
  const img     = document.getElementById('ppPageImg');
  const spinner = document.getElementById('ppSpinner');
  const label   = document.getElementById('ppPageLabel');

  img.classList.add('d-none');
  spinner.classList.remove('d-none');
  // Hide all overlays while loading
  ['ppSigOverlay','ppNameOverlay','ppDateOverlay'].forEach(id => {
    document.getElementById(id).classList.add('d-none');
  });

  label.textContent = `Page ${pageNum + 1} of ${_pp.pageCount}`;
  document.getElementById('ppPrevPage').disabled = pageNum === 0;
  document.getElementById('ppNextPage').disabled = pageNum >= _pp.pageCount - 1;

  try {
    const url  = `/api/autopen/preview/${encodeURIComponent(_pp.savedFilename)}/${pageNum}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob  = await resp.blob();
    const objUrl = URL.createObjectURL(blob);

    img.onload = () => {
      spinner.classList.add('d-none');
      img.classList.remove('d-none');

      _ppDrawAllSigBoxes(pageNum);
      _ppDrawAllTextOverlays(pageNum);
      _ppDrawAllTextAnnotations(pageNum);

      _ppUpdatePlacementNote();
    };
    img.src = objUrl;
  } catch (e) {
    spinner.textContent = 'Failed to load page: ' + e.message;
  }

  _pp.currentPage = pageNum;
}

// ── Overlay renderers ────────────────────────────────────────────────────────

function _ppDrawSigOverlay(placement) {
  const img     = document.getElementById('ppPageImg');
  const overlay = document.getElementById('ppSigOverlay');
  const w = img.clientWidth;
  const h = img.clientHeight;

  overlay.style.left   = (placement.x * w) + 'px';
  overlay.style.top    = ((1 - placement.y - placement.height) * h) + 'px';
  overlay.style.width  = (placement.width  * w) + 'px';
  overlay.style.height = (placement.height * h) + 'px';
  overlay.classList.remove('d-none');
}

function _ppDrawAllSigBoxes(pageNum) {
  // Remove dynamically-created extra sig overlays from previous render
  document.querySelectorAll('.pp-extra-sig').forEach(el => el.remove());

  const wrapper = document.getElementById('ppPageWrapper');
  const img     = document.getElementById('ppPageImg');
  if (!img || !img.clientWidth) return;
  const w = img.clientWidth;
  const h = img.clientHeight;

  _pp.placements.forEach((pl, idx) => {
    if (!pl || pl.page !== pageNum) return;
    if (idx === _pp.activeSigIdx) {
      _ppDrawSigOverlay(pl);   // existing blue dashed box
    } else {
      // Dimmed static overlay for non-active boxes
      const div = document.createElement('div');
      div.className = 'position-absolute pp-extra-sig';
      Object.assign(div.style, {
        border:         '2px dashed rgba(13,110,253,0.4)',
        background:     'rgba(13,110,253,0.06)',
        pointerEvents:  'none',
        boxSizing:      'border-box',
        left:           (pl.x * w) + 'px',
        top:            ((1 - pl.y - pl.height) * h) + 'px',
        width:          (pl.width * w) + 'px',
        height:         (pl.height * h) + 'px',
      });
      div.innerHTML = `<div class="d-flex align-items-center justify-content-center h-100">
        <span class="small text-primary" style="opacity:0.45">Sig ${idx + 1}</span>
      </div>`;
      wrapper.appendChild(div);
    }
  });

  _ppUpdateSwitchBox();
}

// Returns the active array + active index for whichever field type is current
function _ppGetActiveArray() {
  if (_pp.fieldType === 'name') return { arr: _pp.namePlacements, idx: _pp.activeNameIdx, label: 'Name' };
  if (_pp.fieldType === 'date') return { arr: _pp.datePlacements, idx: _pp.activeDateIdx, label: 'Date' };
  if (_pp.fieldType === 'text') {
    return { arr: _pp.textStamps, idx: _pp.activeTextStampIdx, label: 'Text' };
  }
  return { arr: _pp.placements, idx: _pp.activeSigIdx, label: 'Sig' };
}

function _ppUpdateSwitchBox() {
  const switchBtn   = document.getElementById('ppSwitchBox');
  const switchLabel = document.getElementById('ppSwitchBoxLabel');
  const addBtn      = document.getElementById('ppAddBox');
  const removeBtn   = document.getElementById('ppRemoveBox');

  if (_pp.fieldType === 'text') {
    const total = _pp.textStamps.filter(Boolean).length;
    if (switchBtn) switchBtn.classList.toggle('d-none', total <= 1);
    if (switchLabel && total > 1) switchLabel.textContent = `Text ${_pp.activeTextStampIdx + 1}/${total}`;
    if (addBtn)    addBtn.textContent    = '+ Add Text';
    if (removeBtn) removeBtn.classList.toggle('d-none', total === 0);
  } else {
    const { arr, idx, label } = _ppGetActiveArray();
    const total = arr.filter(Boolean).length;
    if (switchBtn) switchBtn.classList.toggle('d-none', total <= 1);
    if (switchLabel && total > 1) switchLabel.textContent = `${label} ${idx + 1}/${total}`;
    if (addBtn)    addBtn.textContent    = `+ Add ${label}`;
    if (removeBtn) removeBtn.classList.toggle('d-none', total === 0);
  }
}

// TEXT_BOX_H: fraction of page height used as visual height for text field overlays
const _PP_TEXT_H = 0.035;

// _ppDrawAllTextOverlays — renders ALL name and date placement boxes for the given page.
// The active box of each type uses the named static overlay (green/orange).
// Non-active boxes get dynamically created dimmed divs (.pp-extra-name / .pp-extra-date).
function _ppDrawAllTextOverlays(pageNum) {
  const img     = document.getElementById('ppPageImg');
  const wrapper = document.getElementById('ppPageWrapper');
  if (!img || !img.clientWidth) return;
  const w = img.clientWidth;
  const h = img.clientHeight;

  // Remove all previously created extra text overlays
  wrapper.querySelectorAll('.pp-extra-name, .pp-extra-date').forEach(el => el.remove());

  // Hide the static overlays first; we'll re-show them for the active box
  document.getElementById('ppNameOverlay').classList.add('d-none');
  document.getElementById('ppDateOverlay').classList.add('d-none');

  const _drawTextBox = (pl, isActive, staticOverlayId, extraClass, color, label) => {
    if (!pl || pl.page !== pageNum) return;
    const plWidth  = pl.width  || 0.25;
    const plHeight = pl.height || _PP_TEXT_H;
    const top  = ((1 - pl.y - plHeight) * h) + 'px';
    const left = (pl.x * w) + 'px';
    const wd   = (plWidth * w) + 'px';
    const ht   = (plHeight * h) + 'px';
    if (isActive) {
      const overlay = document.getElementById(staticOverlayId);
      overlay.style.left   = left;
      overlay.style.top    = top;
      overlay.style.width  = wd;
      overlay.style.height = ht;
      overlay.classList.remove('d-none');
    } else {
      const div = document.createElement('div');
      div.className = `position-absolute ${extraClass}`;
      Object.assign(div.style, {
        border:        `2px dashed ${color}55`,
        background:    `${color}11`,
        pointerEvents: 'none',
        boxSizing:     'border-box',
        left, top, width: wd, height: ht,
      });
      div.innerHTML = `<span class="small px-1" style="color:${color};opacity:.45">${label}</span>`;
      wrapper.appendChild(div);
    }
  };

  _pp.namePlacements.forEach((pl, i) =>
    _drawTextBox(pl, i === _pp.activeNameIdx, 'ppNameOverlay', 'pp-extra-name', '#198754',
      `Name ${_pp.namePlacements.length > 1 ? i + 1 : ''}`)
  );
  _pp.datePlacements.forEach((pl, i) =>
    _drawTextBox(pl, i === _pp.activeDateIdx, 'ppDateOverlay', 'pp-extra-date', '#fd7e14',
      `Date ${_pp.datePlacements.length > 1 ? i + 1 : ''}`)
  );
}

// ── Text annotation overlay renderer ────────────────────────────────────────
function _ppDrawAllTextAnnotations(pageNum) {
  const wrapper = document.getElementById('ppPageWrapper');
  const img     = document.getElementById('ppPageImg');
  if (!img || !img.clientWidth) return;
  const w = img.clientWidth;
  const h = img.clientHeight;

  wrapper.querySelectorAll('.pp-extra-text').forEach(el => el.remove());

  const color = '#6f42c1'; // purple
  (_pp.textStamps || []).forEach((stamp, i) => {
    if (!stamp || stamp.page !== pageNum) return;
    const stampWidth  = stamp.width  || 0.30;
    const stampHeight = stamp.height || _PP_TEXT_H;
    const top      = ((1 - stamp.y - stampHeight) * h) + 'px';
    const left     = (stamp.x * w) + 'px';
    const wd       = (stampWidth * w) + 'px';
    const ht       = (stampHeight * h) + 'px';
    const isActive = i === _pp.activeTextStampIdx;
    const div = document.createElement('div');
    div.className = 'position-absolute pp-extra-text';
    Object.assign(div.style, {
      border:        `2px dashed ${color}`,
      background:    `${color}1a`,
      pointerEvents: 'none',
      boxSizing:     'border-box',
      opacity:       isActive ? '1' : '0.45',
      left, top, width: wd, height: ht,
    });
    const preview = stamp.text.length > 16 ? stamp.text.slice(0, 15) + '…' : stamp.text;
    div.innerHTML = `<span class="small px-1 fw-semibold" style="color:${color}">${escHtml(preview)}</span>`;
    wrapper.appendChild(div);
  });
  _ppUpdateTextFillPanel();
}

// ── Text fill panel ──────────────────────────────────────────────────────────
// Shows labelled inputs for every text stamp so the user can fill/edit text
// without having to cycle through the picker slots manually.
function _ppUpdateTextFillPanel() {
  const panel  = document.getElementById('ppTextFillPanel');
  const inputs = document.getElementById('ppTextFillInputs');
  if (!panel || !inputs) return;

  const stamps = (_pp.textStamps || []).filter(Boolean);
  if (!stamps.length) {
    panel.classList.add('d-none');
    return;
  }

  panel.classList.remove('d-none');

  // Rebuild inputs (preserve focus by comparing count)
  const existing = inputs.querySelectorAll('input[data-stamp-idx]');
  if (existing.length !== stamps.length) {
    inputs.innerHTML = '';
    stamps.forEach((stamp, i) => {
      const row = document.createElement('div');
      row.className = 'd-flex align-items-center gap-2';

      const lbl = document.createElement('label');
      lbl.className = 'small text-nowrap mb-0';
      lbl.style.minWidth = '80px';
      lbl.style.color = '#6f42c1';
      lbl.textContent = stamp.label || `Field ${i + 1}`;

      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'form-control form-control-sm';
      inp.dataset.stampIdx = i;
      inp.placeholder = stamp.label ? `Enter ${stamp.label}…` : `Text for field ${i + 1}…`;
      inp.value = stamp.text || '';
      inp.addEventListener('input', function () {
        const idx = parseInt(this.dataset.stampIdx, 10);
        if (_pp.textStamps[idx]) {
          _pp.textStamps[idx].text = this.value;
          _ppDrawAllTextAnnotations(_pp.currentPage);
        }
      });

      row.appendChild(lbl);
      row.appendChild(inp);
      inputs.appendChild(row);
    });
  } else {
    // Just sync values without rebuilding (preserves focus/cursor)
    existing.forEach(inp => {
      const idx = parseInt(inp.dataset.stampIdx, 10);
      if (_pp.textStamps[idx] && document.activeElement !== inp) {
        inp.value = _pp.textStamps[idx].text || '';
      }
    });
  }
}

function _ppUpdatePlacementNote() {
  const validPls  = _pp.placements.filter(Boolean);
  const validName = _pp.namePlacements.filter(Boolean);
  const validDate = _pp.datePlacements.filter(Boolean);
  const parts = [];
  if (validPls.length === 1) {
    parts.push(`Sig: p${validPls[0].page + 1}`);
  } else {
    validPls.forEach((pl, i) => parts.push(`Sig ${i + 1}: p${pl.page + 1}`));
  }
  if (validName.length === 1) {
    parts.push(`Name: p${validName[0].page + 1}`);
  } else {
    validName.forEach((pl, i) => parts.push(`Name ${i + 1}: p${pl.page + 1}`));
  }
  if (validDate.length === 1) {
    parts.push(`Date: p${validDate[0].page + 1}`);
  } else {
    validDate.forEach((pl, i) => parts.push(`Date ${i + 1}: p${pl.page + 1}`));
  }

  // Text stamps
  const validStamps = (_pp.textStamps || []).filter(Boolean);
  if (validStamps.length === 1) {
    parts.push(`Text: p${validStamps[0].page + 1}`);
  } else {
    validStamps.forEach((s, i) => parts.push(`Text ${i + 1}: p${s.page + 1}`));
  }

  document.getElementById('ppPlacementNote').innerHTML =
    parts.length ? parts.join(' · ') : 'Signature: not placed';

  document.getElementById('ppConfirmBtn').disabled = validPls.length === 0;
}

function _ppUpdateFieldTypeUI(fieldType) {
  const isSig  = fieldType === 'signature';
  const isText = fieldType === 'text';
  const isName = fieldType === 'name';
  const isDate = fieldType === 'date';
  
  // Show width/height sliders for all field types now
  document.getElementById('ppSigWidthGroup').classList.remove('d-none');
  
  // Font size only for text fields (name, date, text)
  document.getElementById('ppFontSizeGroup').classList.toggle('d-none', isSig);
  
  // Text value input only for custom text stamps
  document.getElementById('ppTextValueGroup')?.classList.toggle('d-none', !isText);

  // Update slider labels based on field type
  const widthLabel = isSig ? 'Width %' : 'Width %';
  const heightLabel = isSig ? 'Height %' : 'Height %';
  
  if (fieldType === 'text') {
    document.getElementById('ppInstruction').textContent =
      'Type your text above, then click the page to stamp it';
  } else {
    const instructions = {
      signature: 'Click to place Signature — or use + Add Sig to stack multiple',
      name:      'Click to place Name — or use + Add Name to stack multiple',
      date:      'Click to place Date — or use + Add Date to stack multiple',
    };
    document.getElementById('ppInstruction').textContent =
      instructions[fieldType] || instructions.signature;
  }

  _ppUpdateSwitchBox();
}

function _ppOnClick(e) {
  const img  = document.getElementById('ppPageImg');
  const rect = img.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;
  const w = img.clientWidth;
  const h = img.clientHeight;

  if (_pp.fieldType === 'signature') {
    const sigWidthFrac  = document.getElementById('ppSigWidth').value / 100;
    const sigHeightFrac = document.getElementById('ppSigHeight').value / 100;
    const left = Math.max(0, Math.min(clickX - (sigWidthFrac * w) / 2, w * (1 - sigWidthFrac)));
    const top  = Math.max(0, Math.min(clickY, h * (1 - sigHeightFrac)));
    const pl = {
      page:   _pp.currentPage,
      x:      left / w,
      y:      Math.max(0, 1 - (top / h) - sigHeightFrac),
      width:  sigWidthFrac,
      height: sigHeightFrac,
    };
    // Ensure array slot exists
    while (_pp.placements.length <= _pp.activeSigIdx) _pp.placements.push(null);
    _pp.placements[_pp.activeSigIdx] = pl;
    _pp.placement = pl;   // legacy compat
    _ppDrawAllSigBoxes(_pp.currentPage);

  } else {
    // Use sliders for width/height for all text field types
    const textWidthFrac  = document.getElementById('ppSigWidth').value / 100;
    const textHeightFrac = document.getElementById('ppSigHeight').value / 100;
    const left = Math.max(0, Math.min(clickX - (textWidthFrac * w) / 2, w * (1 - textWidthFrac)));
    const top  = Math.max(0, Math.min(clickY, h * (1 - textHeightFrac)));
    const x_frac = left / w;
    const y_pdf  = Math.max(0, 1 - (top / h) - textHeightFrac);
    const fontSize = parseInt(document.getElementById('ppFontSize').value, 10) || 11;

    const textPlacement = { 
      page: _pp.currentPage, 
      x: x_frac, 
      y: y_pdf, 
      width: textWidthFrac,
      height: textHeightFrac,
      font_size: fontSize 
    };

    if (_pp.fieldType === 'name') {
      while (_pp.namePlacements.length <= _pp.activeNameIdx) _pp.namePlacements.push(null);
      _pp.namePlacements[_pp.activeNameIdx] = textPlacement;
    } else if (_pp.fieldType === 'date') {
      while (_pp.datePlacements.length <= _pp.activeDateIdx) _pp.datePlacements.push(null);
      _pp.datePlacements[_pp.activeDateIdx] = textPlacement;
    } else if (_pp.fieldType === 'text') {
      const text = (document.getElementById('ppTextValue')?.value || '').trim();
      if (!text) { showToast('Type some text first.', 'warning'); return; }
      const label = (document.getElementById('ppTextLabel')?.value || '').trim();
      const stamp = {
        page: _pp.currentPage,
        x: x_frac,
        y: y_pdf,
        width: textWidthFrac,
        height: textHeightFrac,
        font_size: fontSize,
        text,
        label,
      };
      while (_pp.textStamps.length <= _pp.activeTextStampIdx) _pp.textStamps.push(null);
      _pp.textStamps[_pp.activeTextStampIdx] = stamp;
      _ppDrawAllTextAnnotations(_pp.currentPage);
      _ppUpdateSwitchBox();
      _ppUpdatePlacementNote();
      return;
    }
    _ppDrawAllTextOverlays(_pp.currentPage);
    _ppUpdateSwitchBox();
  }

  _ppUpdatePlacementNote();
}

// Sync sliders to the active placement of the current field type
function _ppSyncSlidersToActiveField() {
  const wSlider = document.getElementById('ppSigWidth');
  const hSlider = document.getElementById('ppSigHeight');
  let active = null;
  
  if (_pp.fieldType === 'signature') {
    active = _pp.placements[_pp.activeSigIdx];
  } else if (_pp.fieldType === 'name') {
    active = _pp.namePlacements[_pp.activeNameIdx];
  } else if (_pp.fieldType === 'date') {
    active = _pp.datePlacements[_pp.activeDateIdx];
  } else if (_pp.fieldType === 'text') {
    active = _pp.textStamps[_pp.activeTextStampIdx];
  }
  
  if (active) {
    // Use placement's width/height if available, otherwise use defaults
    const w = Math.round((active.width  || 0.28) * 100);
    const h = Math.round((active.height || 0.08) * 100);
    wSlider.value = Math.min(Math.max(w, +wSlider.min), +wSlider.max);
    hSlider.value = Math.min(Math.max(h, +hSlider.min), +hSlider.max);
  } else {
    // No active placement, use defaults based on field type
    if (_pp.fieldType === 'signature') {
      wSlider.value = 28;  // 0.28 * 100
      hSlider.value = 8;   // 0.08 * 100
    } else {
      wSlider.value = 25;  // 0.25 * 100
      hSlider.value = 4;   // 0.035 * 100 ≈ 4
    }
  }
  
  document.getElementById('ppSigWidthLabel').textContent  = wSlider.value + '%';
  document.getElementById('ppSigHeightLabel').textContent = hSlider.value + '%';
}

function initPlacementPicker() {
  document.getElementById('ppPrevPage').addEventListener('click', () => {
    if (_pp.currentPage > 0) _ppLoadPage(_pp.currentPage - 1);
  });
  document.getElementById('ppNextPage').addEventListener('click', () => {
    if (_pp.currentPage < _pp.pageCount - 1) _ppLoadPage(_pp.currentPage + 1);
  });

  document.getElementById('ppSigWidth').addEventListener('input', function () {
    document.getElementById('ppSigWidthLabel').textContent = this.value + '%';
    const widthFrac = this.value / 100;
    
    // Update width based on current field type
    if (_pp.fieldType === 'signature') {
      const active = _pp.placements[_pp.activeSigIdx];
      if (active) {
        active.width = widthFrac;
        _ppDrawAllSigBoxes(_pp.currentPage);
      }
    } else if (_pp.fieldType === 'name') {
      const active = _pp.namePlacements[_pp.activeNameIdx];
      if (active) {
        active.width = widthFrac;
        _ppDrawAllTextOverlays(_pp.currentPage);
      }
    } else if (_pp.fieldType === 'date') {
      const active = _pp.datePlacements[_pp.activeDateIdx];
      if (active) {
        active.width = widthFrac;
        _ppDrawAllTextOverlays(_pp.currentPage);
      }
    } else if (_pp.fieldType === 'text') {
      const active = _pp.textStamps[_pp.activeTextStampIdx];
      if (active) {
        active.width = widthFrac;
        _ppDrawAllTextAnnotations(_pp.currentPage);
      }
    }
    _ppUpdatePlacementNote();
  });

  document.getElementById('ppSigHeight').addEventListener('input', function () {
    document.getElementById('ppSigHeightLabel').textContent = this.value + '%';
    const heightFrac = this.value / 100;
    
    // Update height based on current field type
    if (_pp.fieldType === 'signature') {
      const active = _pp.placements[_pp.activeSigIdx];
      if (active) {
        active.height = heightFrac;
        _ppDrawAllSigBoxes(_pp.currentPage);
      }
    } else if (_pp.fieldType === 'name') {
      const active = _pp.namePlacements[_pp.activeNameIdx];
      if (active) {
        active.height = heightFrac;
        _ppDrawAllTextOverlays(_pp.currentPage);
      }
    } else if (_pp.fieldType === 'date') {
      const active = _pp.datePlacements[_pp.activeDateIdx];
      if (active) {
        active.height = heightFrac;
        _ppDrawAllTextOverlays(_pp.currentPage);
      }
    } else if (_pp.fieldType === 'text') {
      const active = _pp.textStamps[_pp.activeTextStampIdx];
      if (active) {
        active.height = heightFrac;
        _ppDrawAllTextAnnotations(_pp.currentPage);
      }
    }
    _ppUpdatePlacementNote();
  });

  // Field type radio buttons
  document.querySelectorAll('input[name="ppFieldType"]').forEach(radio => {
    radio.addEventListener('change', function () {
      _pp.fieldType = this.value;
      _ppUpdateFieldTypeUI(this.value);
      
      // Sync sliders to the active placement of the newly selected field type
      _ppSyncSlidersToActiveField();
    });
  });

  document.getElementById('ppPageImg').addEventListener('click', _ppOnClick);

  // Switch between boxes of the currently active field type
  document.getElementById('ppSwitchBox')?.addEventListener('click', () => {
    const { arr, label } = _ppGetActiveArray();
    const validCount = arr.filter(Boolean).length;
    if (validCount <= 1) return;

    if (_pp.fieldType === 'name') {
      _pp.activeNameIdx = (_pp.activeNameIdx + 1) % arr.length;
      const pl = arr[_pp.activeNameIdx];
      if (pl && pl.page !== _pp.currentPage) _ppLoadPage(pl.page);
      else _ppDrawAllTextOverlays(_pp.currentPage);
    } else if (_pp.fieldType === 'date') {
      _pp.activeDateIdx = (_pp.activeDateIdx + 1) % arr.length;
      const pl = arr[_pp.activeDateIdx];
      if (pl && pl.page !== _pp.currentPage) _ppLoadPage(pl.page);
      else _ppDrawAllTextOverlays(_pp.currentPage);
    } else if (_pp.fieldType === 'text') {
      const validCount = _pp.textStamps.filter(Boolean).length;
      if (validCount > 1) {
        _pp.activeTextStampIdx = (_pp.activeTextStampIdx + 1) % _pp.textStamps.length;
        const s = _pp.textStamps[_pp.activeTextStampIdx];
        if (s && s.page !== _pp.currentPage) _ppLoadPage(s.page);
        else _ppDrawAllTextAnnotations(_pp.currentPage);
      }
    } else {
      _pp.activeSigIdx = (_pp.activeSigIdx + 1) % arr.length;
      const pl = arr[_pp.activeSigIdx];
      if (pl && pl.page !== _pp.currentPage) _ppLoadPage(pl.page);
      else _ppDrawAllSigBoxes(_pp.currentPage);
      _pp.placement = arr[_pp.activeSigIdx] || null;  // legacy compat
    }
    _ppSyncSlidersToActiveField();
    _ppUpdateSwitchBox();
    _ppUpdatePlacementNote();
  });

  // Add a new empty slot for the current field type
  document.getElementById('ppAddBox')?.addEventListener('click', () => {
    if (_pp.fieldType === 'name') {
      _pp.namePlacements.push(null);
      _pp.activeNameIdx = _pp.namePlacements.length - 1;
    } else if (_pp.fieldType === 'date') {
      _pp.datePlacements.push(null);
      _pp.activeDateIdx = _pp.datePlacements.length - 1;
    } else if (_pp.fieldType === 'text') {
      _pp.textStamps.push(null);
      _pp.activeTextStampIdx = _pp.textStamps.length - 1;
    } else {
      _pp.placements.push(null);
      _pp.activeSigIdx = _pp.placements.length - 1;
      _pp.placement = null;
    }
    _ppUpdateSwitchBox();
    _ppUpdatePlacementNote();
    const typeLabel = _pp.fieldType === 'name' ? 'Name'
      : _pp.fieldType === 'date' ? 'Date'
      : _pp.fieldType === 'text' ? 'Text'
      : 'Signature';
    document.getElementById('ppInstruction').textContent = `Click to place new ${typeLabel} box`;
  });

  // Remove the active box for the current field type
  document.getElementById('ppRemoveBox')?.addEventListener('click', () => {
    if (_pp.fieldType === 'name') {
      _pp.namePlacements.splice(_pp.activeNameIdx, 1);
      _pp.activeNameIdx = Math.max(0, _pp.activeNameIdx - 1);
      _ppDrawAllTextOverlays(_pp.currentPage);
    } else if (_pp.fieldType === 'date') {
      _pp.datePlacements.splice(_pp.activeDateIdx, 1);
      _pp.activeDateIdx = Math.max(0, _pp.activeDateIdx - 1);
      _ppDrawAllTextOverlays(_pp.currentPage);
    } else if (_pp.fieldType === 'text') {
      _pp.textStamps.splice(_pp.activeTextStampIdx, 1);
      _pp.activeTextStampIdx = Math.max(0, _pp.activeTextStampIdx - 1);
      _ppDrawAllTextAnnotations(_pp.currentPage);
    } else {
      _pp.placements.splice(_pp.activeSigIdx, 1);
      _pp.activeSigIdx = Math.max(0, _pp.activeSigIdx - 1);
      _pp.placement = _pp.placements[_pp.activeSigIdx] || null;
      _ppDrawAllSigBoxes(_pp.currentPage);
    }
    _ppUpdateSwitchBox();
    _ppUpdatePlacementNote();
  });

  document.getElementById('ppSignAllBtn').addEventListener('click', _ppSignAll);

  document.getElementById('ppConfirmBtn').addEventListener('click', async () => {
    const allPlacements = _pp.placements.filter(Boolean);
    if (!allPlacements.length) return;
    const btn = document.getElementById('ppConfirmBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Signing…';

    const signerName = (document.getElementById('ppSignerName')?.value || '').trim();

    if (_pp.customCallback) {
      // ── Custom callback mode (e.g. Check Request) ────────────────────────
      _pp.modal.hide();
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-pen-fill me-1"></i>Sign Here';
      await _pp.customCallback(allPlacements[0], signerName);
      return;
    }

    if (_pp.batch) {
      // ── Batch mode: sign current file, then advance to next ─────────────
      const idx   = _pp.batch.currentIndex || 0;
      const total = _pp.batch.file_count;
      const filename = _pp.savedFilename;

      const { ok, data } = await apiFetch('/api/autopen/sign-placement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          saved_filename: filename,
          placements:     allPlacements,
          signer_name:    signerName,
          name_placements: _pp.namePlacements.filter(Boolean),
          date_placements: _pp.datePlacements.filter(Boolean),
          text_annotations: (_pp.textStamps || []).filter(Boolean),
        }),
      });

      if (!ok) {
        btn.disabled = false;
        _ppUpdateBatchBtn();
        toast(data.error || 'Signing failed', 'danger');
        return;
      }

      // Accumulate signed filename (no auto-download)
      if (!_pp.batch.signedFiles) _pp.batch.signedFiles = [];
      _pp.batch.signedFiles.push({ signed: data.filename, original: filename });
      loadSignedHistory();

      const nextIdx = idx + 1;
      if (nextIdx >= total) {
        // All done — show results panel instead of closing
        _ppShowBatchResults(_pp.batch.signedFiles);
        return;
      }

      // Advance: detect placements for the next file and refresh the picker
      const nextFilename = _pp.batch.saved_filenames[nextIdx];
      btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>Loading ${nextIdx + 1} of ${total}…`;

      const { ok: dok, data: ddata } = await apiFetch('/api/autopen/detect-placements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          saved_filename: nextFilename,
          form_type_name: _pp.batch.form_type_name || '',
        }),
      });

      if (!dok) {
        btn.disabled = false;
        _ppUpdateBatchBtn();
        toast(ddata.error || 'Could not load next document', 'danger');
        return;
      }

      // Update picker state for the next file in place (modal stays open)
      _pp.batch.currentIndex = nextIdx;
      _pp.savedFilename      = nextFilename;
      _pp.pageCount          = ddata.page_count || 1;

      const sArr = Array.isArray(ddata.placements) ? ddata.placements : (ddata.placements ? [ddata.placements] : []);
      _pp.placements   = sArr.map(s => ({ ...s }));
      _pp.activeSigIdx = 0;
      _pp.placement    = _pp.placements[0] || null;

      // Restore name/date from form type (not reset to empty — they were set once
      // when the batch started and must apply to every file in the batch).
      const _batchName = _pp.batch.name_placement;
      const _batchDate = _pp.batch.date_placement;
      _pp.namePlacements = _batchName ? [{ ..._batchName }] : [];
      _pp.datePlacements = _batchDate ? [{ ..._batchDate }] : [];
      _pp.activeNameIdx  = 0;
      _pp.activeDateIdx  = 0;

      // Sync sliders from new suggestion
      const firstSug = sArr[0];
      if (firstSug) {
        const w = Math.round((firstSug.width  || 0.28) * 100);
        const h = Math.round((firstSug.height || 0.08) * 100);
        const wSlider = document.getElementById('ppSigWidth');
        const hSlider = document.getElementById('ppSigHeight');
        wSlider.value = Math.min(Math.max(w, +wSlider.min), +wSlider.max);
        hSlider.value = Math.min(Math.max(h, +hSlider.min), +hSlider.max);
        document.getElementById('ppSigWidthLabel').textContent  = wSlider.value + '%';
        document.getElementById('ppSigHeightLabel').textContent = hSlider.value + '%';
      }

      // Update title and instruction
      const title = document.getElementById('ppModalLabel');
      if (title) {
        title.innerHTML = `<i class="bi bi-cursor me-2"></i>File ${nextIdx + 1} of ${total} <span class="badge text-bg-secondary ms-1">${nextFilename.replace(/^\d{8}_\d{6}_[^_]+_/, '')}</span>`;
      }
      document.getElementById('ppInstruction').innerHTML = sArr.length > 1
        ? `${_ppSuggestionBadge(ddata.suggestion_source)}${sArr.length} spots detected — click to adjust`
        : (sArr.length === 1
            ? _ppSuggestionBadge(ddata.suggestion_source) + ' — click to move, or confirm as-is'
            : 'Click anywhere to place Signature');

      btn.disabled = false;
      _ppUpdateBatchBtn();
      _ppUpdatePlacementNote();

      // Navigate to first detected page
      const startPage = (_pp.placements[0] && _pp.placements[0].page != null) ? _pp.placements[0].page : 0;
      _ppLoadPage(startPage);
      return;
    }

    // ── Single file mode ─────────────────────────────────────────────────
    const { ok, data } = await apiFetch('/api/autopen/sign-placement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        saved_filename:  _pp.savedFilename,
        placements:      allPlacements,
        signer_name:     signerName,
        name_placements: _pp.namePlacements.filter(Boolean),
        date_placements: _pp.datePlacements.filter(Boolean),
        text_annotations: (_pp.textStamps || []).filter(Boolean),
      }),
    });

    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-pen-fill me-1"></i>Sign Here';

    if (ok) {
      _pp.modal.hide();
      const stamped = data.stamped || ['signature'];
      toast(`Signed — stamped: ${stamped.join(' + ')}`);
      triggerDownload('/api/autopen/download/' + encodeURIComponent(data.filename), data.filename);
      loadSignedHistory();
      if (_pp.isNewFormType) {
        _pp.confirmedPlacement = allPlacements[0];
        _pp.confirmedNamePl    = _pp.namePlacements[0] || null;
        _pp.confirmedDatePl    = _pp.datePlacements[0] || null;
        _openFormTypeSaveDialog();
      }
      // If this was a batch unmatched file, move its card to the signed list
      if (_pp._batchCard && _pp._batchUnmatched) {
        const u       = _pp._batchUnmatched;
        const card    = _pp._batchCard;
        const signedList    = document.getElementById('batchSignedList');
        const signedSec     = document.getElementById('batchSignedSection');
        const signedCountEl = document.getElementById('batchSignedCount');
        const unmatchedCountEl = document.getElementById('batchUnmatchedCount');

        // Add to signed list
        const li = document.createElement('li');
        li.className = 'list-group-item d-flex align-items-center gap-2 py-1 px-2';
        li.innerHTML = `
          <i class="bi bi-file-earmark-pdf text-danger"></i>
          <span class="flex-fill small text-truncate">${escHtml(u.original_name)}</span>
          <span class="badge bg-secondary me-1">manual</span>
          <a href="/api/autopen/download/${encodeURIComponent(data.filename)}"
             class="btn btn-sm btn-outline-primary py-0" download>
            <i class="bi bi-download"></i>
          </a>`;
        signedList.appendChild(li);
        signedSec.classList.remove('d-none');
        signedCountEl.textContent = signedList.children.length;

        // Remove from unmatched
        card.remove();
        const remaining = document.querySelectorAll('#batchUnmatchedList [data-idx]').length;
        if (unmatchedCountEl) unmatchedCountEl.textContent = remaining;
        if (!remaining) document.getElementById('batchUnmatchedSection').classList.add('d-none');

        _pp._batchCard      = null;
        _pp._batchUnmatched = null;
      }
    } else {
      toast(data.error || 'Signing failed', 'danger');
    }
  });
}

// ══════════════════════════════════════════════════════════════════
// AUTOPEN — Form type selection & save dialogs
// ══════════════════════════════════════════════════════════════════

let _ftSelectModal = null;
let _ftSelectData  = null;  // stores data from sign response

function openFormTypeSelect(data) {
  _ftSelectData = data;

  const isBatch = Array.isArray(data.saved_filenames);

  // Update modal title / hint for batch vs single
  const modalTitle = document.querySelector('#formTypeSelectModal .modal-title');
  if (modalTitle) {
    modalTitle.innerHTML = isBatch
      ? `<i class="bi bi-tags me-2"></i>Select Form Type <span class="badge text-bg-secondary ms-1">${data.file_count} files</span>`
      : '<i class="bi bi-tag me-2"></i>Select Form Type';
  }
  const hint = document.getElementById('ftSelectHint');
  if (hint) {
    hint.textContent = isBatch
      ? 'Pick a saved type, or leave blank for auto-detect. A preview will be shown before signing.'
      : 'Choose a saved type to sign instantly, or pick a new location.';
  }

  const dropdown = document.getElementById('ftSelectDropdown');
  // In batch mode the "new form type" option doesn't apply (no picker for batches)
  dropdown.innerHTML = isBatch
    ? '<option value="">— Auto-detect (preview will be shown) —</option>'
    : '<option value="">— New form type (I\'ll pick the location) —</option>';
  (data.form_types || []).forEach(ft => {
    const opt = document.createElement('option');
    opt.value = ft.name;
    const extras = [];
    if (ft.name_placement) extras.push('Name');
    if (ft.date_placement) extras.push('Date');
    opt.textContent = extras.length
      ? `${ft.name}  [+ ${extras.join(' + ')}]`
      : ft.name;
    opt.dataset.hasName = ft.name_placement ? '1' : '';
    opt.dataset.hasDate = ft.date_placement ? '1' : '';
    dropdown.appendChild(opt);
  });

  // Update "Will stamp" summary + name row + warnings based on selected option
  const nameRow      = document.getElementById('ftSignerNameRow');
  const stampSummary = document.getElementById('ftStampSummary');
  const noDateWarn   = document.getElementById('ftNoDateWarning');
  const deleteBtn    = document.getElementById('ftDeleteBtn');

  function _updateFormTypeHints() {
    const sel      = dropdown.options[dropdown.selectedIndex];
    const hasName  = sel && sel.dataset.hasName === '1';
    const hasDate  = sel && sel.dataset.hasDate === '1';
    const isNew    = !sel || sel.value === '';

    // Show/hide signer name input
    if (nameRow) nameRow.classList.toggle('d-none', !hasName);

    // Build "Will stamp" chips
    if (stampSummary) {
      if (isNew) {
        stampSummary.innerHTML = '';
      } else {
        const chips = [
          '<span class="badge text-bg-primary me-1"><i class="bi bi-pen-fill me-1"></i>Signature</span>',
        ];
        if (hasDate) chips.push('<span class="badge text-bg-warning me-1"><i class="bi bi-calendar-fill me-1"></i>Date (today)</span>');
        if (hasName) chips.push('<span class="badge text-bg-success me-1"><i class="bi bi-person-fill me-1"></i>Printed Name</span>');
        stampSummary.innerHTML = '<span class="me-1 text-muted">Will stamp:</span>' + chips.join('');
      }
    }

    // Show warning if no date configured (and a form type IS selected)
    if (noDateWarn) noDateWarn.classList.toggle('d-none', isNew || hasDate);

    // Show Delete button only when a saved form type is selected
    if (deleteBtn) deleteBtn.classList.toggle('d-none', isNew);
  }

  dropdown.onchange = _updateFormTypeHints;
  _updateFormTypeHints();

  // Delete button: remove the selected form type after confirmation
  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      const sel = dropdown.options[dropdown.selectedIndex];
      if (!sel || !sel.value) return;
      const name = sel.value;
      if (!confirm(`Delete form type "${name}"? This cannot be undone.`)) return;
      const { ok, data } = await apiFetch(
        `/api/autopen/form-types/${encodeURIComponent(name)}`,
        { method: 'DELETE' }
      );
      if (ok) {
        toast(`"${name}" deleted`);
        // Remove from dropdown and reset
        sel.remove();
        dropdown.value = '';
        _updateFormTypeHints();
        loadFormTypes();   // refresh the settings panel list too
      } else {
        toast(data?.error || 'Delete failed', 'danger');
      }
    };
  }

  // Pre-populate name from autopen config
  const nameInput = document.getElementById('ftSignerNameInput');
  if (nameInput) nameInput.value = _autopenSignerName();

  // "Re-save with date & name" button → dismiss select modal, open placement picker
  // Pre-fills the picker with the existing form type's placement so user just adds date/name
  const reconfigBtn = document.getElementById('ftReconfigureBtn');
  if (reconfigBtn) {
    reconfigBtn.onclick = () => {
      const sel = dropdown.options[dropdown.selectedIndex];
      if (!sel || !sel.value) return;
      const ftName   = sel.value;
      const ftEntry  = (_ftSelectData.form_types || []).find(ft => ft.name === ftName);
      const existingPl = ftEntry ? ftEntry.placement : null;
      _ftSelectModal.hide();
      _pp.isNewFormType     = true;
      _pp.suggestedFormName = ftName;
      openPlacementPicker(
        _ftSelectData.saved_filename,
        _ftSelectData.page_count,
        existingPl || _ftSelectData.suggested_placement,
        existingPl ? 'memory' : _ftSelectData.suggestion_source,
      );
    };
  }

  if (!_ftSelectModal) {
    _ftSelectModal = new bootstrap.Modal(document.getElementById('formTypeSelectModal'));
  }
  _ftSelectModal.show();
}

async function _ftSelectContinue() {
  const dropdown   = document.getElementById('ftSelectDropdown');
  const selected   = dropdown.value;
  const signerName = (document.getElementById('ftSignerNameInput')?.value || '').trim();
  const isBatch    = Array.isArray(_ftSelectData.saved_filenames);
  _ftSelectModal.hide();

  if (!selected && !isBatch) {
    // Single file new form type — open placement picker
    _pp.isNewFormType      = true;
    _pp.suggestedFormName  = _ftSelectData.suggested_form_name || '';
    openPlacementPicker(
      _ftSelectData.saved_filename,
      _ftSelectData.page_count,
      _ftSelectData.suggested_placement,
      _ftSelectData.suggestion_source,
    );
    return;
  }
  // (if !selected && isBatch, fall through to batch block which handles auto-detect)

  // ── Signed with a known form type ──────────────────────────────────────
  _pp.isNewFormType = false;
  const btn = document.getElementById('btnSignDocs');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Signing…';

  if (isBatch) {
    // ── Batch: detect placements for first file → open preview picker ─────
    const firstFilename = _ftSelectData.saved_filenames[0];
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Loading preview…';

    const { ok: dok, data: ddata } = await apiFetch('/api/autopen/detect-placements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        saved_filename: firstFilename,
        form_type_name: selected || '',
      }),
    });

    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-pen-fill me-2"></i>Sign Documents';

    if (!dok) {
      toast(ddata.error || 'Could not load document preview', 'danger');
      return;
    }

    // Look up the selected form type's name/date placements so the picker
    // can pre-fill them — and restore them on every file advance.
    const ftEntry = selected
      ? (_ftSelectData.form_types || []).find(ft => ft.name === selected)
      : null;

    openPlacementPicker(
      firstFilename,
      ddata.page_count,
      ddata.placements,
      ddata.suggestion_source || 'detected',
      {
        saved_filenames: _ftSelectData.saved_filenames,
        file_count:      _ftSelectData.file_count,
        form_type_name:  selected || '',
        // Carry name/date through the whole batch so each file gets them
        name_placement:  ftEntry?.name_placement  || null,
        date_placement:  ftEntry?.date_placement  || null,
        text_placements: ftEntry?.text_placements || [],
      },
      null,        // customCallback
      signerName   // prefillSignerName
    );
    return;

  } else {
    // ── Single file: sign with the selected form type ─────────────────────
    // If the form type has text placements, open the picker so the user can fill them in
    const _ftForText = selected
      ? (_ftSelectData.form_types || []).find(ft => ft.name === selected)
      : null;
    if (_ftForText?.text_placements?.length) {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-pen-fill me-2"></i>Sign &amp; Download';
      _pp.isNewFormType = false;
      // Detect placements for this file first
      const { ok: dok, data: ddata } = await apiFetch('/api/autopen/detect-placements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          saved_filename: _ftSelectData.saved_filename,
          form_type_name: selected || '',
        }),
      });
      if (!dok) { toast(ddata?.error || 'Could not load preview', 'danger'); return; }
      openPlacementPicker(
        _ftSelectData.saved_filename,
        ddata.page_count,
        ddata.placements,
        ddata.suggestion_source || 'detected',
        {
          saved_filenames: [_ftSelectData.saved_filename],
          file_count: 1,
          form_type_name: selected || '',
          name_placement: _ftForText?.name_placement || null,
          date_placement: _ftForText?.date_placement || null,
          text_placements: _ftForText.text_placements,
        },
        null,
        signerName
      );
      return;
    }

    const { ok, data } = await apiFetch('/api/autopen/sign-with-form-type', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        saved_filename: _ftSelectData.saved_filename,
        form_type_name: selected,
        signer_name:    signerName,
      }),
    });

    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-pen-fill me-2"></i>Sign &amp; Download';

    if (ok) {
      const stamped = data.stamped || ['signature'];
      toast(`Signed with "${selected}" — stamped: ${stamped.join(' + ')}`);
      triggerDownload('/api/autopen/download/' + encodeURIComponent(data.filename), data.filename);
      loadSignedHistory();
    } else {
      toast(data.error || 'Signing failed', 'danger');
    }
  }
}

let _ftSaveModal = null;

function _openFormTypeSaveDialog() {
  // Reset to step 1
  document.getElementById('ftSaveStep1').classList.remove('d-none');
  document.getElementById('ftSaveStep2').classList.add('d-none');
  document.getElementById('ftSaveStatus').textContent = '';
  document.getElementById('ftSaveNameInput').value = _pp.suggestedFormName || '';

  // Build placement summary
  const parts = ['<i class="bi bi-pen-fill text-primary me-1"></i>Signature'];
  if (_pp.confirmedNamePl) parts.push('<i class="bi bi-person-fill text-success me-1"></i>Printed Name');
  if (_pp.confirmedDatePl) parts.push('<i class="bi bi-calendar-fill me-1" style="color:#fd7e14"></i>Date');
  const _validTextStamps = (_pp.textStamps || []).filter(Boolean);
  if (_validTextStamps.length) parts.push(`<i class="bi bi-type me-1" style="color:#6f42c1"></i>Text fields (${_validTextStamps.length})`);
  const sumEl = document.getElementById('ftSavePlacementSummary');
  if (sumEl) sumEl.innerHTML = 'Fields to remember: ' + parts.join(' · ');

  if (!_ftSaveModal) {
    _ftSaveModal = new bootstrap.Modal(document.getElementById('formTypeSaveModal'));
  }
  _ftSaveModal.show();
}

function _initFormTypeSaveModal() {
  // Step 1 → Step 2: "Yes, remember it" goes straight to naming (no longer asks about position variability,
  // since anchor-relative memory handles forms where the sig field may shift)
  document.getElementById('ftSaveYesBtn').addEventListener('click', () => {
    document.getElementById('ftSaveStep1').classList.add('d-none');
    document.getElementById('ftSaveStep2').classList.remove('d-none');
    document.getElementById('ftSaveNameInput').focus();
  });

  document.getElementById('ftSaveConfirmBtn').addEventListener('click', async () => {
    const name = document.getElementById('ftSaveNameInput').value.trim();
    if (!name) {
      document.getElementById('ftSaveStatus').textContent = 'Please enter a name.';
      return;
    }
    const btn = document.getElementById('ftSaveConfirmBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving…';

    const { ok, data } = await apiFetch('/api/autopen/form-types', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        placement:       _pp.confirmedPlacement,
        name_placement:  _pp.confirmedNamePl  || null,
        date_placement:  _pp.confirmedDatePl  || null,
        text_placements: (_pp.textStamps || []).filter(Boolean).map(s => ({
          page:       s.page,
          x:          s.x,
          y:          s.y,
          width:      s.width  || 0.25,
          height:     s.height || 0.035,
          font_size:  s.font_size || 11,
          label:      s.label || '',
        })),
        saved_filename: _pp.savedFilename || '',
      }),
    });

    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-floppy-fill me-2"></i>Save Form Type';

    if (ok) {
      _ftSaveModal.hide();
      toast(`Form type "${name}" saved — future documents will be signed automatically`);
      loadFormTypes();
    } else {
      document.getElementById('ftSaveStatus').textContent = data.error || 'Save failed';
    }
  });
}

async function loadFormTypes() {
  const { ok, data } = await apiFetch('/api/autopen/form-types');
  const list   = document.getElementById('formTypesList');
  const empty  = document.getElementById('formTypesEmpty');
  if (!ok || !data.form_types.length) {
    list.classList.add('d-none');
    empty.classList.remove('d-none');
    return;
  }
  empty.classList.add('d-none');
  list.classList.remove('d-none');

  // Store ft data keyed by index so we avoid JSON-in-attribute escaping issues
  const _ftStore = {};
  list.innerHTML = data.form_types.map((ft, idx) => {
    _ftStore[idx] = ft;
    const badges = [];
    if (ft.name_placement) badges.push('<span class="badge text-bg-success ms-1 fw-normal" style="font-size:.7em">Name</span>');
    if (ft.date_placement) badges.push('<span class="badge text-bg-warning ms-1 fw-normal" style="font-size:.7em">Date</span>');
    if (ft.text_placements?.length) badges.push(`<span class="badge ms-1 fw-normal" style="font-size:.7em;background:#6f42c1;color:#fff">${ft.text_placements.length} Text</span>`);
    return `
    <li class="list-group-item d-flex align-items-center gap-2 py-2 px-3">
      <i class="bi bi-bookmark-fill text-primary"></i>
      <span class="flex-fill fw-semibold small">${escHtml(ft.name)}${badges.join('')}</span>
      <span class="text-muted small me-2">${escHtml(ft.created)}</span>
      <button class="btn btn-link btn-sm p-0 text-secondary me-1" data-edit-idx="${idx}" title="Edit">
        <i class="bi bi-pencil"></i>
      </button>
      <button class="btn btn-link btn-sm p-0 text-danger" data-delete-ft="${escHtml(ft.name)}" title="Delete">
        <i class="bi bi-trash"></i>
      </button>
    </li>`;
  }).join('');

  list.querySelectorAll('[data-delete-ft]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.deleteFt;
      if (!confirm(`Delete form type "${name}"?`)) return;
      const { ok } = await apiFetch(`/api/autopen/form-types/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (ok) { toast(`"${name}" deleted`); loadFormTypes(); }
      else toast('Delete failed', 'danger');
    });
  });

  list.querySelectorAll('[data-edit-idx]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ft = _ftStore[+btn.dataset.editIdx];
      if (ft) openFormTypeEdit(ft);
    });
  });
}

// ── Form-type edit modal ────────────────────────────────────────────────────

let _editFtData = null;   // ft object being edited

function openFormTypeEdit(ft) {
  _editFtData = { ...ft };

  document.getElementById('editFtOriginalName').value = ft.name;
  document.getElementById('editFtName').value         = ft.name;

  // Summarise placements
  const lines = [];
  const p = ft.placement;
  if (p) lines.push(`Signature — page ${(p.page||0)+1}, (${Math.round(p.x*100)}%, ${Math.round(p.y*100)}%)`);
  const np = ft.name_placement;
  if (np) lines.push(`Name — page ${(np.page||0)+1}, (${Math.round(np.x*100)}%, ${Math.round(np.y*100)}%)`);
  const dp = ft.date_placement;
  if (dp) lines.push(`Date — page ${(dp.page||0)+1}, (${Math.round(dp.x*100)}%, ${Math.round(dp.y*100)}%)`);
  (ft.text_placements || []).forEach((tp, i) => {
    const lbl = tp.label ? ` "${tp.label}"` : ` ${i + 1}`;
    lines.push(`Text field${lbl} — page ${(tp.page||0)+1}, (${Math.round(tp.x*100)}%, ${Math.round(tp.y*100)}%)`);
  });
  document.getElementById('editFtPlacementSummary').innerHTML =
    lines.length ? lines.map(l => `<div>${l}</div>`).join('') : '<em>No placements stored</em>';

  const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('editFtModal'));
  modal.show();
}

function _initEditFtModal() {
  const saveBtn     = document.getElementById('editFtSaveBtn');
  const recalBtn    = document.getElementById('editFtRecalibrate');
  const fileInput   = document.getElementById('editFtFileInput');

  saveBtn.addEventListener('click', async () => {
    const origName = document.getElementById('editFtOriginalName').value;
    const newName  = document.getElementById('editFtName').value.trim();
    if (!newName) { toast('Name cannot be empty', 'warning'); return; }

    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving…';
    const { ok, data } = await apiFetch(
      `/api/autopen/form-types/${encodeURIComponent(origName)}`,
      { method: 'PATCH', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ new_name: newName }) }
    );
    saveBtn.disabled = false;
    saveBtn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Save Changes';
    if (ok) {
      toast(`Renamed to "${newName}"`);
      bootstrap.Modal.getInstance(document.getElementById('editFtModal'))?.hide();
      loadFormTypes();
    } else {
      toast(data?.error || 'Save failed', 'danger');
    }
  });

  // Re-calibrate: let the user upload a PDF and go through the placement picker
  recalBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    fileInput.value = '';

    // Upload the PDF to get a saved_filename, then open the placement picker
    const fd = new FormData();
    fd.append('file', f);
    recalBtn.disabled = true;
    recalBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Uploading…';

    const { ok, data } = await apiFetch('/api/autopen/sign', {
      method: 'POST',
      body: fd,
    });
    recalBtn.disabled = false;
    recalBtn.innerHTML = '<i class="bi bi-crosshair me-1"></i>Re-calibrate placements…';

    if (!ok) { toast(data?.error || 'Upload failed', 'danger'); return; }

    // Close this modal, open placement picker, then save under the (possibly renamed) name
    bootstrap.Modal.getInstance(document.getElementById('editFtModal'))?.hide();

    const origName = document.getElementById('editFtOriginalName').value;
    const curName  = document.getElementById('editFtName').value.trim() || origName;

    openPlacementPicker(
      data.saved_filename,
      data.page_count,
      data.suggested_placement,
      data.suggestion_source,
      null,   // batchOptions
      async (placementSig /*, signerName — not used for form-type calibration */) => {
        // Gather all placements from _pp state (the picker sets these before calling back)
        const body = {
          name:            origName,
          placement:       placementSig,
          name_placement:  _pp.namePlacements.filter(Boolean)[0] || null,
          date_placement:  _pp.datePlacements.filter(Boolean)[0] || null,
          text_placements: (_pp.textStamps || []).filter(Boolean).map(s => ({
            page: s.page, x: s.x, y: s.y,
            width: s.width || 0.25, height: s.height || 0.035,
            font_size: s.font_size || 11, label: s.label || '',
          })),
          saved_filename:  data.saved_filename,
        };
        const { ok: saveOk } = await apiFetch('/api/autopen/form-types', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!saveOk) { toast('Could not save placements', 'danger'); return; }

        // Rename if the user changed the name in the edit modal
        if (curName !== origName) {
          await apiFetch(`/api/autopen/form-types/${encodeURIComponent(origName)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ new_name: curName }),
          });
        }
        toast(`"${curName}" updated`);
        loadFormTypes();
      },
      null    // prefillSignerName
    );
  });
}

// ── Clear signed history ─────────────────────────────────────────────────────

async function clearSignedHistory() {
  if (!confirm('Delete all files from the signed history? This cannot be undone.')) return;
  const { ok, data } = await apiFetch('/api/autopen/signed/all', { method: 'DELETE' });
  if (ok) {
    toast(`Cleared ${data.deleted} signed file(s)`);
    loadSignedHistory();
  } else {
    toast('Clear failed', 'danger');
  }
}

// ── Clear upload queue ───────────────────────────────────────────────────────

async function clearUploadQueue() {
  selectedFiles = [];
  // Hide the file list UI directly (renderFileList is a closure inside initDocUpload)
  const wrap = document.getElementById('selectedFiles');
  const list = document.getElementById('fileList');
  if (wrap) wrap.classList.add('d-none');
  if (list) list.innerHTML = '';
  // Also purge server-side uploads
  await apiFetch('/api/autopen/uploads/all', { method: 'DELETE' });
  toast('Upload queue cleared');
}

// ══════════════════════════════════════════════════════════════════
// CHECK REQUEST
// ══════════════════════════════════════════════════════════════════

let _crSavedFilename = null;   // filled PDF waiting for signature placement

function initCheckRequest() {
  // Check template status
  _crCheckTemplate();

  // Vendor dropdown change → auto-fill address fields
  document.getElementById('crVendorSelect').addEventListener('change', _crVendorSelected);

  // Delete vendor button
  document.getElementById('crDeleteVendorBtn').addEventListener('click', _crDeleteVendor);

  // "Remember this vendor" checkbox toggles label input
  document.getElementById('crSaveVendor').addEventListener('change', function () {
    document.getElementById('crVendorLabel').classList.toggle('d-none', !this.checked);
  });

  // Upload template
  document.getElementById('crUploadTemplateBtn').addEventListener('click', _crUploadTemplate);

  // Generate & place signature
  document.getElementById('crGenerateBtn').addEventListener('click', _crGenerate);

  // Refresh vendors
  document.getElementById('crRefreshVendors').addEventListener('click', _crLoadVendors);
}

async function _crCheckTemplate() {
  try {
    const r = await fetch('/api/check-request/template-status');
    const data = await r.json();
    document.getElementById('crNoTemplate').classList.toggle('d-none', data.has_template);
    document.getElementById('crFormWrap').classList.toggle('d-none', !data.has_template);
    if (data.has_template) _crLoadVendors();
  } catch (e) {
    console.error('CR template check failed', e);
  }
}

async function _crUploadTemplate() {
  const input = document.getElementById('crTemplateInput');
  if (!input.files.length) { showToast('Select a PDF first.', 'warning'); return; }
  const fd = new FormData();
  fd.append('template', input.files[0]);
  const btn = document.getElementById('crUploadTemplateBtn');
  btn.disabled = true;
  try {
    const r = await fetch('/api/check-request/upload-template', { method: 'POST', body: fd });
    const data = await r.json();
    if (data.ok) {
      showToast('Template uploaded.', 'success');
      _crCheckTemplate();
    } else {
      showToast(data.error || 'Upload failed.', 'danger');
    }
  } catch (e) {
    showToast('Upload error: ' + e, 'danger');
  } finally {
    btn.disabled = false;
  }
}

async function _crLoadVendors() {
  try {
    const r = await fetch('/api/check-request/vendors');
    const data = await r.json();
    _crRenderVendors(data.vendors || {});
  } catch (e) {
    console.error('Failed to load vendors', e);
  }
}

function _crRenderVendors(vendors) {
  const sel = document.getElementById('crVendorSelect');
  const list = document.getElementById('crVendorList');
  const empty = document.getElementById('crVendorListEmpty');

  // Rebuild dropdown
  sel.innerHTML = '<option value="">— Select a saved vendor —</option>';
  Object.keys(vendors).sort().forEach(label => {
    const opt = document.createElement('option');
    opt.value = label;
    opt.textContent = label;
    sel.appendChild(opt);
  });

  // Rebuild list card
  const labels = Object.keys(vendors).sort();
  if (labels.length === 0) {
    list.classList.add('d-none');
    empty.classList.remove('d-none');
  } else {
    empty.classList.add('d-none');
    list.classList.remove('d-none');
    list.innerHTML = labels.map(label => {
      const v = vendors[label];
      return `<li class="list-group-item py-2 px-3">
        <div class="fw-semibold small">${escHtml(label)}</div>
        <div class="text-muted" style="font-size:.78rem">
          ${escHtml(v.payee || '')}
          ${v.address ? ' · ' + escHtml(v.address) : ''}
          ${v.city ? ', ' + escHtml(v.city) : ''}
          ${v.state ? ' ' + escHtml(v.state) : ''}
          ${v.zip ? ' ' + escHtml(v.zip) : ''}
        </div>
      </li>`;
    }).join('');
  }
}

function _crVendorSelected() {
  const sel = document.getElementById('crVendorSelect');
  const label = sel.value;
  document.getElementById('crDeleteVendorBtn').disabled = !label;
  if (!label) return;
  // Fetch full vendor list and fill fields
  fetch('/api/check-request/vendors')
    .then(r => r.json())
    .then(data => {
      const v = (data.vendors || {})[label];
      if (!v) return;
      document.getElementById('crPayee').value   = v.payee   || '';
      document.getElementById('crAddress').value = v.address || '';
      document.getElementById('crCity').value    = v.city    || '';
      document.getElementById('crState').value   = v.state   || '';
      document.getElementById('crZip').value     = v.zip     || '';
    });
}

async function _crDeleteVendor() {
  const label = document.getElementById('crVendorSelect').value;
  if (!label) return;
  if (!confirm(`Delete vendor "${label}"?`)) return;
  try {
    const r = await fetch(`/api/check-request/vendors/${encodeURIComponent(label)}`, { method: 'DELETE' });
    const data = await r.json();
    if (data.ok) {
      showToast(`Vendor "${label}" deleted.`, 'success');
      _crRenderVendors(data.vendors || {});
      document.getElementById('crDeleteVendorBtn').disabled = true;
    }
  } catch (e) {
    showToast('Delete failed: ' + e, 'danger');
  }
}

async function _crGenerate() {
  const btn    = document.getElementById('crGenerateBtn');
  const status = document.getElementById('crStatus');

  // Validate required fields
  const payee     = document.getElementById('crPayee').value.trim();
  const amount    = document.getElementById('crAmount').value.trim();
  const printName = document.getElementById('crPrintName').value.trim();
  if (!payee)     { showToast('Payee name is required.', 'warning'); return; }
  if (!amount)    { showToast('Amount is required.', 'warning'); return; }
  if (!printName) { showToast('Print name (requester) is required.', 'warning'); return; }

  // Build check type booleans
  const checkType = document.querySelector('input[name="crCheckType"]:checked')?.value || 'depository';

  const body = {
    check_type:    checkType,
    when_ready:    document.getElementById('crWhenReady').checked,
    mail_check:    document.getElementById('crMailCheck').checked,
    amount,
    date:          document.getElementById('crDate').value,
    date_required: document.getElementById('crDateRequired').value,
    payee,
    address:       document.getElementById('crAddress').value.trim(),
    city:          document.getElementById('crCity').value.trim(),
    state:         document.getElementById('crState').value.trim(),
    zip:           document.getElementById('crZip').value.trim(),
    desc1:         document.getElementById('crDesc1').value.trim(),
    desc2:         document.getElementById('crDesc2').value.trim(),
    desc3:         document.getElementById('crDesc3').value.trim(),
    print_name:    printName,
    sign_date:     document.getElementById('crSignDate').value,
    phone:         document.getElementById('crPhone').value.trim(),
    save_vendor:   document.getElementById('crSaveVendor').checked,
    vendor_label:  document.getElementById('crVendorLabel').value.trim() || payee,
  };

  btn.disabled = true;
  status.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Generating form…';

  try {
    const r = await fetch('/api/check-request/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!data.ok) {
      status.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle me-1"></i>${escHtml(data.error || 'Error')}</span>`;
      return;
    }

    _crSavedFilename = data.saved_filename;
    status.innerHTML = '<span class="text-success"><i class="bi bi-check-circle me-1"></i>Form generated — opening placement picker…</span>';

    // Reload vendor list in case vendor was saved
    if (body.save_vendor) _crLoadVendors();

    // Open placement picker for this file
    // First detect placements, then open picker
    const detectR = await fetch('/api/autopen/detect-placements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ saved_filename: _crSavedFilename }),
    });
    const detectData = await detectR.json();

    const signerName = document.getElementById('crSignerName').value.trim() ||
                       printName;

    // Open placement picker with a special onConfirm callback for check request
    openPlacementPicker(
      _crSavedFilename,
      detectData.page_count || 1,
      detectData.placements || [],
      detectData.suggestion_source || 'default',
      null,                      // not batch
      _crOnPlacementConfirmed,   // custom confirm callback
      signerName
    );

    status.innerHTML = '';
  } catch (e) {
    status.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle me-1"></i>${escHtml(String(e))}</span>`;
  } finally {
    btn.disabled = false;
  }
}

async function _crOnPlacementConfirmed(placement, signerName) {
  // Called by placement picker confirm when opened from Check Request
  const status = document.getElementById('crStatus');
  status.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Signing and downloading…';

  try {
    const r = await fetch('/api/check-request/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        saved_filename: _crSavedFilename,
        placement,
        signer_name: signerName,
      }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      status.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle me-1"></i>${escHtml(data.error || 'Sign failed')}</span>`;
      return;
    }
    // Trigger download
    const blob = await r.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'check_request_signed.pdf';
    a.click();
    URL.revokeObjectURL(url);
    status.innerHTML = '<span class="text-success"><i class="bi bi-check-circle me-1"></i>Signed PDF downloaded.</span>';
    _crSavedFilename = null;
  } catch (e) {
    status.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle me-1"></i>${escHtml(String(e))}</span>`;
  }
}

// ══ TRAVEL VOUCHER ════════════════════════════════════════════════

function initTravelVoucher() {
  _tvCheckTemplate();
  document.getElementById('tvUploadTemplateBtn').addEventListener('click', _tvUploadTemplate);
  document.getElementById('tvSaveProfileBtn').addEventListener('click', _tvSaveProfile);
  document.getElementById('tvAddDayBtn').addEventListener('click', _tvAddDay);
  document.getElementById('tvGenerateBtn').addEventListener('click', _tvGenerate);

  // Collapse chevron toggle
  document.getElementById('tvProfileBody').addEventListener('hide.bs.collapse', () => {
    document.getElementById('tvProfileChevron').className = 'bi bi-chevron-down';
  });
  document.getElementById('tvProfileBody').addEventListener('show.bs.collapse', () => {
    document.getElementById('tvProfileChevron').className = 'bi bi-chevron-up';
  });

  // Wire up the first (static) day card
  _tvWireDayCard(document.querySelector('#tvDaysContainer .tv-day-card'));

  _tvLoadProfile();
}

async function _tvCheckTemplate() {
  try {
    const r    = await fetch('/api/travel/template-status');
    const data = await r.json();
    document.getElementById('tvNoTemplate').classList.toggle('d-none',  data.has_template);
    document.getElementById('tvFormWrap').classList.toggle('d-none', !data.has_template);
  } catch (e) {
    console.error('TV template check failed', e);
    // On error, show the upload notice so the user isn't left with a blank page
    document.getElementById('tvNoTemplate').classList.remove('d-none');
  }
}

async function _tvLoadProfile() {
  try {
    const r    = await fetch('/api/travel/profile');
    const data = await r.json();
    const p    = data.profile || {};
    document.getElementById('tvProfName').value      = p.name      || '';
    document.getElementById('tvProfAddr1').value     = p.address1  || '';
    document.getElementById('tvProfAddr2').value     = p.address2  || '';
    document.getElementById('tvProfCity').value      = p.city      || '';
    document.getElementById('tvProfState').value     = p.state     || '';
    document.getElementById('tvProfZip').value       = p.zip       || '';
    document.getElementById('tvProfMileage').value   = p.mileage_rate || '0.70';
    document.getElementById('tvProfSignDate').value  = p.sign_date  || '';
    if (p.is_citizen === false) {
      document.getElementById('tvCitizenNo').checked  = true;
    } else {
      document.getElementById('tvCitizenYes').checked = true;
    }
    // Pre-fill signature date on first day card from profile
    const firstCard = document.querySelector('#tvDaysContainer .tv-day-card');
    if (firstCard) {
      const sd = firstCard.querySelector('.tv-sign-date');
      if (sd && !sd.value) sd.value = p.sign_date || '';
    }
  } catch (e) {
    console.error('TV profile load failed', e);
  }
}

async function _tvSaveProfile() {
  const btn = document.getElementById('tvSaveProfileBtn');
  btn.disabled = true;
  try {
    const body = {
      name:         document.getElementById('tvProfName').value.trim(),
      address1:     document.getElementById('tvProfAddr1').value.trim(),
      address2:     document.getElementById('tvProfAddr2').value.trim(),
      city:         document.getElementById('tvProfCity').value.trim(),
      state:        document.getElementById('tvProfState').value.trim(),
      zip:          document.getElementById('tvProfZip').value.trim(),
      mileage_rate: document.getElementById('tvProfMileage').value.trim(),
      sign_date:    document.getElementById('tvProfSignDate').value.trim(),
      is_citizen:   document.getElementById('tvCitizenYes').checked,
    };
    const r    = await fetch('/api/travel/profile/save', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await r.json();
    if (data.ok) {
      showToast('Profile saved.', 'success');
      const saved = document.getElementById('tvProfileSaved');
      saved.classList.remove('d-none');
      setTimeout(() => saved.classList.add('d-none'), 3000);
    } else {
      showToast(data.error || 'Save failed.', 'danger');
    }
  } catch (e) {
    showToast('Save error: ' + e, 'danger');
  } finally {
    btn.disabled = false;
  }
}

async function _tvUploadTemplate() {
  const input = document.getElementById('tvTemplateInput');
  if (!input.files.length) { showToast('Select a PDF first.', 'warning'); return; }
  const fd  = new FormData();
  fd.append('template', input.files[0]);
  const btn = document.getElementById('tvUploadTemplateBtn');
  btn.disabled = true;
  try {
    const r    = await fetch('/api/travel/upload-template', { method: 'POST', body: fd });
    const data = await r.json();
    if (data.ok) {
      showToast('Template uploaded.', 'success');
      _tvCheckTemplate();
    } else {
      showToast(data.error || 'Upload failed.', 'danger');
    }
  } catch (e) {
    showToast('Upload error: ' + e, 'danger');
  } finally {
    btn.disabled = false;
  }
}

// ── Day card management ────────────────────────────────────────────

function _tvWireDayCard(card) {
  // Remove-day button
  card.querySelector('.tv-remove-day-btn').addEventListener('click', () => _tvRemoveDay(card));

  // Add-row buttons
  card.querySelectorAll('.tv-add-row-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = btn.closest('.tv-expense-section');
      _tvAddExpenseRow(section);
    });
  });

  // Auto-purpose from date + candidate
  card.querySelector('.tv-trip-date').addEventListener('input',  () => _tvMaybeAutoFillPurpose(card));
  card.querySelector('.tv-candidate').addEventListener('input',  () => _tvMaybeAutoFillPurpose(card));
  card.querySelector('.tv-purpose').addEventListener('input', function () {
    this.dataset.auto = 'false';
  });
}

function _tvMaybeAutoFillPurpose(card) {
  const purposeEl = card.querySelector('.tv-purpose');
  if (purposeEl.dataset.auto !== 'true') return;
  const date      = card.querySelector('.tv-trip-date').value.trim();
  const candidate = card.querySelector('.tv-candidate').value.trim();
  if (date || candidate) {
    purposeEl.value = `Hiring expenses - Job Talk: ${candidate} on ${date}`;
  }
}

function _tvAddDay() {
  const container = document.getElementById('tvDaysContainer');
  const cards     = container.querySelectorAll('.tv-day-card');
  const n         = cards.length;

  // Clone the first card as a template
  const tpl  = cards[0];
  const clone = tpl.cloneNode(true);

  // Reset all inputs/textareas in the clone
  clone.querySelectorAll('input, textarea').forEach(el => {
    if (el.type === 'radio' || el.type === 'checkbox') {
      el.checked = el.defaultChecked;
    } else {
      el.value = el.defaultValue || '';
    }
    if (el.classList.contains('tv-purpose')) {
      el.dataset.auto = 'true';
    }
  });

  // Clear all expense table bodies
  clone.querySelectorAll('.tv-expense-table tbody').forEach(tb => { tb.innerHTML = ''; });

  // Pre-fill departure/destination defaults
  clone.querySelector('.tv-departure').value  = '';
  clone.querySelector('.tv-destination').value = 'New York, NY';

  // Pre-fill sign date from profile
  const profileSignDate = document.getElementById('tvProfSignDate').value.trim();
  if (profileSignDate) clone.querySelector('.tv-sign-date').value = profileSignDate;

  // Update day label
  clone.querySelector('.tv-day-label').textContent = `Day ${n + 1}`;

  // Update day total
  clone.querySelector('.tv-day-total').textContent = 'Total: $0.00';

  // Show remove buttons on all cards now that there are ≥ 2
  container.querySelectorAll('.tv-remove-day-btn').forEach(b => b.classList.remove('d-none'));

  container.appendChild(clone);
  _tvWireDayCard(clone);
  _tvRenumberDays();
}

function _tvRemoveDay(card) {
  const container = document.getElementById('tvDaysContainer');
  if (container.querySelectorAll('.tv-day-card').length <= 1) return;
  card.remove();
  _tvRenumberDays();
  // Hide remove button if only one day left
  if (container.querySelectorAll('.tv-day-card').length === 1) {
    container.querySelector('.tv-remove-day-btn').classList.add('d-none');
  }
}

function _tvRenumberDays() {
  document.querySelectorAll('#tvDaysContainer .tv-day-card').forEach((card, i) => {
    const dateVal = card.querySelector('.tv-trip-date').value.trim();
    const label   = dateVal ? `Day ${i + 1} — ${dateVal}` : `Day ${i + 1}`;
    card.querySelector('.tv-day-label').textContent = label;
  });
}

// ── Expense row management ─────────────────────────────────────────

function _tvAddExpenseRow(section) {
  const tbody = section.querySelector('.tv-expense-table tbody');
  const tr    = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="form-control form-control-sm tv-exp-desc" placeholder="Description" /></td>
    <td>
      <div class="input-group input-group-sm">
        <span class="input-group-text">$</span>
        <input type="number" class="form-control tv-exp-amount" min="0" step="0.01" placeholder="0.00" />
      </div>
    </td>
    <td class="text-center">
      <button type="button" class="btn btn-sm btn-outline-danger tv-remove-row-btn" title="Remove row">
        <i class="bi bi-x"></i>
      </button>
    </td>`;
  tr.querySelector('.tv-remove-row-btn').addEventListener('click', () => _tvRemoveExpenseRow(tr));
  tr.querySelector('.tv-exp-amount').addEventListener('input', () => {
    const card = section.closest('.tv-day-card');
    _tvUpdateDayTotal(card);
  });
  tbody.appendChild(tr);
}

function _tvRemoveExpenseRow(tr) {
  const card = tr.closest('.tv-day-card');
  tr.remove();
  _tvUpdateDayTotal(card);
}

function _tvUpdateDayTotal(card) {
  let total = 0;
  card.querySelectorAll('.tv-exp-amount').forEach(inp => {
    const v = parseFloat(inp.value);
    if (!isNaN(v)) total += v;
  });
  card.querySelector('.tv-day-total').textContent = `Total: $${total.toFixed(2)}`;
}

// ── Build day data ────────────────────────────────────────────────

function _tvBuildDayData(card) {
  const categoryMap = {
    meals:          [],
    transportation: [],
    lodging:        [],
    local_travel:   [],
  };
  card.querySelectorAll('.tv-expense-section').forEach(section => {
    const cat  = section.dataset.category;
    section.querySelectorAll('.tv-expense-table tbody tr').forEach(tr => {
      const desc   = tr.querySelector('.tv-exp-desc')?.value.trim()   || '';
      const amount = parseFloat(tr.querySelector('.tv-exp-amount')?.value) || 0;
      if (desc || amount) {
        categoryMap[cat].push({ desc, amount });
      }
    });
  });
  return {
    trip_date:        card.querySelector('.tv-trip-date').value.trim(),
    candidate:        card.querySelector('.tv-candidate').value.trim(),
    departure_city:   card.querySelector('.tv-departure').value.trim(),
    destination_city: card.querySelector('.tv-destination').value.trim(),
    purpose:          card.querySelector('.tv-purpose').value.trim(),
    sign_date:        card.querySelector('.tv-sign-date').value.trim(),
    ...categoryMap,
  };
}

// ── Generate ──────────────────────────────────────────────────────

async function _tvGenerate() {
  const btn    = document.getElementById('tvGenerateBtn');
  const status = document.getElementById('tvStatus');
  const resWrap = document.getElementById('tvResults');
  const resList = document.getElementById('tvResultList');

  // Build traveler from profile form
  const traveler = {
    name:         document.getElementById('tvProfName').value.trim(),
    address1:     document.getElementById('tvProfAddr1').value.trim(),
    address2:     document.getElementById('tvProfAddr2').value.trim(),
    city:         document.getElementById('tvProfCity').value.trim(),
    state:        document.getElementById('tvProfState').value.trim(),
    zip:          document.getElementById('tvProfZip').value.trim(),
    mileage_rate: document.getElementById('tvProfMileage').value.trim(),
    sign_date:    document.getElementById('tvProfSignDate').value.trim(),
    is_citizen:   document.getElementById('tvCitizenYes').checked,
  };

  if (!traveler.name) { showToast('Name is required in the profile.', 'warning'); return; }

  // Collect days
  const days = [];
  document.querySelectorAll('#tvDaysContainer .tv-day-card').forEach(card => {
    days.push(_tvBuildDayData(card));
  });

  if (!days.length) { showToast('Add at least one expense day.', 'warning'); return; }
  if (!days[0].trip_date) { showToast('Trip Date is required on Day 1.', 'warning'); return; }

  btn.disabled = true;
  resWrap.classList.add('d-none');
  status.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Generating vouchers…';

  try {
    const r    = await fetch('/api/travel/generate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ traveler, days }),
    });
    const data = await r.json();

    if (data.error) {
      status.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle me-1"></i>${escHtml(data.error)}</span>`;
      return;
    }

    const results = data.results || [];
    const anyOk   = results.some(r => r.success);

    if (anyOk) {
      status.innerHTML = `<span class="text-success"><i class="bi bi-check-circle me-1"></i>Done — ${results.filter(r => r.success).length} voucher(s) generated.</span>`;
    } else {
      status.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle me-1"></i>All vouchers failed. Check errors below.</span>`;
    }

    resList.innerHTML = results.map((res, idx) => {
      if (res.success) {
        return `<li class="list-group-item" id="tvResultItem${idx}">
          <div class="d-flex align-items-center justify-content-between gap-2 flex-wrap">
            <span><i class="bi bi-file-earmark-pdf text-danger me-1"></i>${escHtml(res.day_label)} — <strong>$${Number(res.total).toFixed(2)}</strong></span>
            <div class="d-flex gap-2 align-items-center">
              <a href="/api/travel/download/${encodeURIComponent(res.saved_filename)}"
                 download="${escHtml(res.saved_filename)}"
                 class="btn btn-sm btn-outline-secondary">
                <i class="bi bi-file-earmark-arrow-down me-1"></i>Unsigned
              </a>
              <button class="btn btn-sm btn-primary" data-tv-sign-idx="${idx}">
                <i class="bi bi-pen-fill me-1"></i>Sign &amp; Download
              </button>
            </div>
          </div>
          <div class="tv-sign-status small mt-1"></div>
        </li>`;
      } else {
        return `<li class="list-group-item list-group-item-danger">
          <i class="bi bi-x-circle me-1"></i>${escHtml(res.day_label)} — Error: ${escHtml(res.error || 'Unknown error')}
        </li>`;
      }
    }).join('');

    // Wire up Sign & Download buttons
    const okResults = results.filter(r => r.success);
    resList.querySelectorAll('[data-tv-sign-idx]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = +btn.dataset.tvSignIdx;
        const res = results[idx];
        if (!res) return;
        await _tvOpenSignPicker(res, btn);
      });
    });

    resWrap.classList.remove('d-none');
  } catch (e) {
    status.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle me-1"></i>${escHtml(String(e))}</span>`;
  } finally {
    btn.disabled = false;
  }
}

async function _tvOpenSignPicker(res, triggerBtn) {
  // Detect placements on the generated PDF, then open the placement picker.
  // On confirm, sign via autopen and trigger a download of the signed copy.
  const statusEl = triggerBtn.closest('li')?.querySelector('.tv-sign-status');
  const setStatus = (html) => { if (statusEl) statusEl.innerHTML = html; };

  triggerBtn.disabled = true;
  setStatus('<span class="spinner-border spinner-border-sm me-1"></span>Preparing picker…');

  try {
    const { ok: dOk, data: dData } = await apiFetch('/api/autopen/detect-placements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ saved_filename: res.saved_filename }),
    });
    if (!dOk) {
      setStatus(`<span class="text-danger">${escHtml(dData?.error || 'Could not load preview')}</span>`);
      triggerBtn.disabled = false;
      return;
    }

    setStatus('');

    openPlacementPicker(
      res.saved_filename,
      dData.page_count || 1,
      dData.placements || [],
      dData.suggestion_source || 'detected',
      null,   // not batch
      async (placement, signerName) => {
        // Sign the voucher and download
        setStatus('<span class="spinner-border spinner-border-sm me-1"></span>Signing…');
        const { ok, data } = await apiFetch('/api/autopen/sign-placement', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            saved_filename:  res.saved_filename,
            placements:      [placement],
            signer_name:     signerName,
            name_placements: _pp.namePlacements.filter(Boolean),
            date_placements: _pp.datePlacements.filter(Boolean),
          }),
        });
        if (!ok) {
          setStatus(`<span class="text-danger"><i class="bi bi-x-circle me-1"></i>${escHtml(data?.error || 'Signing failed')}</span>`);
          triggerBtn.disabled = false;
          return;
        }
        // Download signed PDF
        const signedName = data.filename;
        const a = document.createElement('a');
        a.href     = `/api/autopen/download/${encodeURIComponent(signedName)}`;
        a.download = signedName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setStatus(`<span class="text-success"><i class="bi bi-check-circle me-1"></i>Signed &amp; downloaded.</span>`);
        triggerBtn.textContent = 'Re-sign';
        triggerBtn.disabled = false;
        loadSignedHistory();
      },
      null    // prefillSignerName
    );
  } catch (e) {
    setStatus(`<span class="text-danger">${escHtml(String(e))}</span>`);
    triggerBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Room Config (Schedule Analysis)
// ---------------------------------------------------------------------------

async function openRoomModal() {
  const { ok, data } = await apiFetch('/api/schedule/rooms');
  if (!ok) return;
  const list = document.getElementById('roomList');
  list.innerHTML = '';
  (data.rooms || []).forEach(r => addRoomRow(r.name, r.capacity));
  new bootstrap.Modal(document.getElementById('roomConfigModal')).show();
}

function addRoomRow(name = '', capacity = '') {
  const list = document.getElementById('roomList');
  const row = document.createElement('div');
  row.className = 'd-flex gap-2 mb-2 align-items-center room-row';
  row.innerHTML = `
    <input type="text" class="form-control form-control-sm room-name" placeholder="Room name (e.g. NB-6.61)" value="${name}">
    <input type="number" class="form-control form-control-sm room-cap" placeholder="Cap" style="width:90px" value="${capacity}">
    <button class="btn btn-sm btn-outline-danger" onclick="this.closest('.room-row').remove()">
      <i class="bi bi-trash"></i>
    </button>`;
  list.appendChild(row);
}

async function saveRooms() {
  const rows = document.querySelectorAll('.room-row');
  const rooms = [];
  rows.forEach(row => {
    const name = row.querySelector('.room-name').value.trim();
    const cap  = parseInt(row.querySelector('.room-cap').value, 10);
    if (name && cap > 0) rooms.push({ name, capacity: cap });
  });
  const { ok } = await apiFetch('/api/schedule/rooms/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rooms),
  });
  if (ok) {
    bootstrap.Modal.getInstance(document.getElementById('roomConfigModal')).hide();
    toast(`Saved ${rooms.length} room(s)`);
  }
}

// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// DYNAMIC FORM FILLER
// ══════════════════════════════════════════════════════════════════

// ── Render field mapping table rows ────────────────────────────────
function _ffFieldRows(fields) {
  return fields.map((f, i) => `
    <tr>
      <td class="text-muted small">${escHtml(f.pdf_name)}</td>
      <td><span class="badge text-bg-secondary">${escHtml(f.field_type)}</span></td>
      <td>
        <input type="text" class="form-control form-control-sm ff-label"
               data-idx="${i}" value="${escHtml(f.label)}" />
      </td>
      <td>
        <input type="text" class="form-control form-control-sm ff-default"
               data-idx="${i}" value="${escHtml(f.default || '')}"
               placeholder="leave blank or 'today'" />
      </td>
    </tr>`).join('');
}

function _ffReadFieldsFromTable(tbody, originalFields) {
  return originalFields.map((f, i) => {
    const labelEl   = tbody.querySelector(`.ff-label[data-idx="${i}"]`);
    const defaultEl = tbody.querySelector(`.ff-default[data-idx="${i}"]`);
    return {
      ...f,
      label:   labelEl   ? labelEl.value.trim()   : f.label,
      default: defaultEl ? defaultEl.value.trim() : f.default,
    };
  });
}

// ── Build a tab pane for a saved template ──────────────────────────
function _ffBuildPane(template) {
  const tabId = `tab-ff-${CSS.escape(template.name)}`;
  const pane  = document.createElement('div');
  pane.id        = `tab-ff-${template.name}`;
  pane.className = 'tab-pane d-none';

  const today = new Date().toISOString().slice(0, 10);

  const fieldInputs = template.fields.map(f => {
    const val = f.default === 'today' ? today : escHtml(f.default || '');
    if (f.field_type === 'checkbox') {
      return `
        <div class="mb-3 form-check">
          <input class="form-check-input ff-field-input" type="checkbox"
                 id="ff-${escHtml(template.name)}-${escHtml(f.pdf_name)}"
                 data-pdf-name="${escHtml(f.pdf_name)}"
                 ${f.default === 'true' ? 'checked' : ''} />
          <label class="form-check-label fw-semibold"
                 for="ff-${escHtml(template.name)}-${escHtml(f.pdf_name)}">
            ${escHtml(f.label)}
          </label>
        </div>`;
    }
    return `
      <div class="mb-3">
        <label class="form-label fw-semibold">${escHtml(f.label)}</label>
        <input type="text" class="form-control ff-field-input"
               data-pdf-name="${escHtml(f.pdf_name)}"
               value="${val}" />
      </div>`;
  }).join('');

  pane.innerHTML = `
    <div class="page-header mb-4 d-flex align-items-start justify-content-between">
      <div>
        <h2><i class="bi bi-file-earmark-fill me-2"></i>${escHtml(template.name)}</h2>
        <p class="text-muted mb-0">Fill out and sign the ${escHtml(template.name)} form.</p>
      </div>
      <div class="d-flex gap-2">
        <button class="btn btn-sm btn-outline-secondary ff-edit-btn" data-ff-name="${escHtml(template.name)}">
          <i class="bi bi-pencil me-1"></i>Edit Fields
        </button>
        <button class="btn btn-sm btn-outline-danger ff-delete-btn" data-ff-name="${escHtml(template.name)}">
          <i class="bi bi-trash me-1"></i>Delete
        </button>
      </div>
    </div>

    <div class="row g-4">
      <div class="col-lg-7">
        <div class="card">
          <div class="card-header"><i class="bi bi-pencil-square me-1"></i>Form Fields</div>
          <div class="card-body">
            ${fieldInputs}
            <div class="mb-3">
              <label class="form-label fw-semibold">Signer Name <span class="text-muted fw-normal small">(for signature)</span></label>
              <input type="text" class="form-control ff-signer-name" placeholder="Your name" />
            </div>
          </div>
        </div>
      </div>
      <div class="col-lg-5">
        <div class="card">
          <div class="card-header"><i class="bi bi-play-fill me-1"></i>Generate</div>
          <div class="card-body d-flex flex-column gap-3">
            <button class="btn btn-success ff-generate-btn" data-ff-name="${escHtml(template.name)}">
              <i class="bi bi-file-earmark-arrow-down me-1"></i>Generate &amp; Place Signature
            </button>
            <div class="ff-status small"></div>
          </div>
        </div>
      </div>
    </div>`;

  // Wire buttons
  pane.querySelector('.ff-edit-btn').addEventListener('click', () => openEditFormModal(template.name));
  pane.querySelector('.ff-delete-btn').addEventListener('click', () => _ffDelete(template.name));
  pane.querySelector('.ff-generate-btn').addEventListener('click', () => _ffGenerate(pane, template));

  return pane;
}

// ── Inject sidebar link ─────────────────────────────────────────────
function _ffAddSidebarLink(name) {
  const container = document.getElementById('dynamicFormLinks');
  // Remove existing link for this name if present
  const existing = container.querySelector(`[data-tab="ff-${CSS.escape(name)}"]`);
  if (existing) existing.remove();

  const link = document.createElement('a');
  link.className   = 'nav-link';
  link.href        = '#';
  link.role        = 'tab';
  link.dataset.tab = `ff-${name}`;
  link.innerHTML   = `<i class="bi bi-file-earmark-fill"></i><span>${escHtml(name)}</span>`;
  link.addEventListener('click', e => {
    e.preventDefault();
    _ffActivateTab(name);
  });
  container.appendChild(link);
}

function _ffActivateTab(name) {
  // Deactivate all nav links
  document.querySelectorAll('#sideNav .nav-link').forEach(l => l.classList.remove('active'));
  // Activate this one
  const link = document.querySelector(`[data-tab="ff-${CSS.escape(name)}"]`);
  if (link) link.classList.add('active');
  // Hide all panes
  document.querySelectorAll('.tab-pane').forEach(p => {
    p.classList.add('d-none');
    p.classList.remove('active');
  });
  // Show this pane
  const pane = document.getElementById(`tab-ff-${name}`);
  if (pane) { pane.classList.remove('d-none'); pane.classList.add('active'); }
}

// ── Load all saved templates and inject into sidebar + content ──────
async function loadFormTemplates() {
  try {
    const r    = await fetch('/api/form-filler/templates');
    const data = await r.json();
    const paneContainer = document.getElementById('dynamicFormPanes');

    (data.templates || []).forEach(template => {
      _ffAddSidebarLink(template.name);
      // Remove existing pane if present
      const existing = document.getElementById(`tab-ff-${template.name}`);
      if (existing) existing.remove();
      paneContainer.appendChild(_ffBuildPane(template));
    });
  } catch (e) {
    console.error('Failed to load form templates', e);
  }
}

// ── Generate ────────────────────────────────────────────────────────
async function _ffGenerate(pane, template) {
  const status     = pane.querySelector('.ff-status');
  const btn        = pane.querySelector('.ff-generate-btn');
  const signerName = pane.querySelector('.ff-signer-name').value.trim();

  // Collect field values
  const field_values = {};
  pane.querySelectorAll('.ff-field-input').forEach(inp => {
    const pdfName = inp.dataset.pdfName;
    field_values[pdfName] = inp.type === 'checkbox'
      ? (inp.checked ? 'Yes' : 'Off')
      : inp.value;
  });

  btn.disabled = true;
  status.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Generating…';

  try {
    const r    = await fetch(`/api/form-filler/templates/${encodeURIComponent(template.name)}/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ field_values, signer_name: signerName }),
    });
    const data = await r.json();

    if (!data.ok) {
      status.innerHTML = `<span class="text-danger">${escHtml(data.error || 'Error')}</span>`;
      return;
    }

    status.innerHTML = '<span class="text-success"><i class="bi bi-check-circle me-1"></i>Form generated — opening placement picker…</span>';

    // Detect placements then open picker
    const detectR    = await fetch('/api/autopen/detect-placements', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ saved_filename: data.saved_filename }),
    });
    const detectData = await detectR.json();

    openPlacementPicker(
      data.saved_filename,
      detectData.page_count || 1,
      detectData.placements || [],
      detectData.suggestion_source || 'default',
      null,
      async (placement, sName) => {
        // Sign and download
        const signR = await fetch('/api/autopen/sign-placement', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            saved_filename: data.saved_filename,
            placement,
            signer_name: sName,
          }),
        });
        if (signR.ok) {
          const blob = await signR.blob();
          const url  = URL.createObjectURL(blob);
          const a    = document.createElement('a');
          a.href = url; a.download = data.saved_filename;
          a.click(); URL.revokeObjectURL(url);
          status.innerHTML = '<span class="text-success"><i class="bi bi-check-circle me-1"></i>Signed and downloaded.</span>';
          loadSignedHistory();
        } else {
          status.innerHTML = '<span class="text-danger">Signing failed.</span>';
        }
      },
      signerName
    );

    status.innerHTML = '';
  } catch (e) {
    status.innerHTML = `<span class="text-danger">${escHtml(String(e))}</span>`;
  } finally {
    btn.disabled = false;
  }
}

// ── Delete ──────────────────────────────────────────────────────────
async function _ffDelete(name) {
  if (!confirm(`Delete template "${name}"? This cannot be undone.`)) return;
  const r = await fetch(`/api/form-filler/templates/${encodeURIComponent(name)}/delete`, { method: 'DELETE' });
  const data = await r.json();
  if (data.ok) {
    // Remove sidebar link and pane
    const link = document.querySelector(`[data-tab="ff-${CSS.escape(name)}"]`);
    if (link) link.remove();
    const pane = document.getElementById(`tab-ff-${name}`);
    if (pane) pane.remove();
    // Activate autopen tab
    document.querySelector('[data-tab="autopen"]').click();
    showToast(`"${name}" deleted.`, 'success');
  } else {
    showToast(data.error || 'Delete failed.', 'danger');
  }
}

// ── Add Form Modal ──────────────────────────────────────────────────
let _ffInspectedFields = [];

function initAddFormModal() {
  const modal     = new bootstrap.Modal(document.getElementById('addFormModal'));
  const step1     = document.getElementById('addFormStep1');
  const step2     = document.getElementById('addFormStep2');
  const step1Btn  = document.getElementById('addFormStep1Btn');
  const step2Btn  = document.getElementById('addFormStep2Btn');
  const status    = document.getElementById('addFormStep1Status');

  document.getElementById('btnAddFormTemplate').addEventListener('click', () => {
    // Reset modal
    step1.classList.remove('d-none');
    step2.classList.add('d-none');
    step1Btn.classList.remove('d-none');
    step2Btn.classList.add('d-none');
    document.getElementById('addFormName').value = '';
    document.getElementById('addFormFile').value = '';
    document.getElementById('addFormFieldBody').innerHTML = '';
    status.innerHTML = '';
    _ffInspectedFields = [];
    modal.show();
  });

  step1Btn.addEventListener('click', async () => {
    const name = document.getElementById('addFormName').value.trim();
    const file = document.getElementById('addFormFile').files[0];
    if (!name) { status.innerHTML = '<span class="text-danger">Name is required.</span>'; return; }
    if (!file) { status.innerHTML = '<span class="text-danger">Select a PDF.</span>'; return; }

    step1Btn.disabled = true;
    status.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Uploading and inspecting fields…';

    const fd = new FormData();
    fd.append('name', name);
    fd.append('template', file);

    try {
      const r    = await fetch('/api/form-filler/upload', { method: 'POST', body: fd });
      const data = await r.json();
      if (!data.ok) { status.innerHTML = `<span class="text-danger">${escHtml(data.error)}</span>`; return; }

      _ffInspectedFields = data.fields;
      document.getElementById('addFormFieldBody').innerHTML = _ffFieldRows(data.fields);
      step1.classList.add('d-none');
      step2.classList.remove('d-none');
      step1Btn.classList.add('d-none');
      step2Btn.classList.remove('d-none');
      status.innerHTML = '';
    } catch (e) {
      status.innerHTML = `<span class="text-danger">${escHtml(String(e))}</span>`;
    } finally {
      step1Btn.disabled = false;
    }
  });

  step2Btn.addEventListener('click', async () => {
    const name   = document.getElementById('addFormName').value.trim();
    const tbody  = document.getElementById('addFormFieldBody');
    const fields = _ffReadFieldsFromTable(tbody, _ffInspectedFields);

    step2Btn.disabled = true;
    try {
      const r    = await fetch(`/api/form-filler/templates/${encodeURIComponent(name)}/update`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fields }),
      });
      const data = await r.json();
      if (!data.ok) { showToast(data.error || 'Save failed.', 'danger'); return; }

      // Reload templates and add to sidebar
      const getR     = await fetch(`/api/form-filler/templates/${encodeURIComponent(name)}`);
      const getData  = await getR.json();
      const template = getData.template;

      _ffAddSidebarLink(name);
      const existing = document.getElementById(`tab-ff-${name}`);
      if (existing) existing.remove();
      document.getElementById('dynamicFormPanes').appendChild(_ffBuildPane(template));

      modal.hide();
      showToast(`"${name}" added.`, 'success');
      _ffActivateTab(name);
    } catch (e) {
      showToast(String(e), 'danger');
    } finally {
      step2Btn.disabled = false;
    }
  });
}

// ── Edit Form Modal ─────────────────────────────────────────────────
let _ffEditName   = null;
let _ffEditFields = [];

async function openEditFormModal(name) {
  const r    = await fetch(`/api/form-filler/templates/${encodeURIComponent(name)}`);
  const data = await r.json();
  if (!data.template) { showToast('Template not found.', 'danger'); return; }

  _ffEditName   = name;
  _ffEditFields = data.template.fields;

  document.getElementById('editFormModalName').textContent = name;
  document.getElementById('editFormFieldBody').innerHTML   = _ffFieldRows(_ffEditFields);

  new bootstrap.Modal(document.getElementById('editFormModal')).show();
}

function initEditFormModal() {
  document.getElementById('editFormSaveBtn').addEventListener('click', async () => {
    const tbody  = document.getElementById('editFormFieldBody');
    const fields = _ffReadFieldsFromTable(tbody, _ffEditFields);
    const btn    = document.getElementById('editFormSaveBtn');
    btn.disabled = true;

    try {
      const r    = await fetch(`/api/form-filler/templates/${encodeURIComponent(_ffEditName)}/update`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fields }),
      });
      const data = await r.json();
      if (!data.ok) { showToast(data.error || 'Save failed.', 'danger'); return; }

      // Rebuild pane with updated fields
      const getR     = await fetch(`/api/form-filler/templates/${encodeURIComponent(_ffEditName)}`);
      const getData  = await getR.json();
      const template = getData.template;

      const existing = document.getElementById(`tab-ff-${_ffEditName}`);
      if (existing) existing.remove();
      document.getElementById('dynamicFormPanes').appendChild(_ffBuildPane(template));

      bootstrap.Modal.getInstance(document.getElementById('editFormModal')).hide();
      showToast('Field mappings saved.', 'success');
    } catch (e) {
      showToast(String(e), 'danger');
    } finally {
      btn.disabled = false;
    }
  });
}


// Boot
// ══════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  startClock();
  checkServerStatus();
  setInterval(checkServerStatus, 60000);

  initTabs();
  initSignaturePad();
  initSigInputTabs();
  initSignatureActions();
  initPlacementControls();
  initPlacementPicker();
  initDocUpload();
  initEhraf();
  initSchedule();
  initEhrafGen();
  initCheckRequest();
  initTravelVoucher();
  _initFormTypeSaveModal();
  _initEditFtModal();
  loadSavedSignature();
  loadSignedHistory();
  loadFormTypes();

  document.getElementById('btnRefreshHistory').addEventListener('click', loadSignedHistory);
  document.getElementById('btnClearHistory').addEventListener('click', clearSignedHistory);
  document.getElementById('btnRefreshReports').addEventListener('click', loadReports);
  document.getElementById('btnSignDocs').addEventListener('click', signDocuments);
  document.getElementById('btnClearQueue').addEventListener('click', clearUploadQueue);
  document.getElementById('ftSelectContinueBtn').addEventListener('click', _ftSelectContinue);
  document.getElementById('btnRefreshFormTypes').addEventListener('click', loadFormTypes);

  initAddFormModal();
  initEditFormModal();
  loadFormTemplates();
});
