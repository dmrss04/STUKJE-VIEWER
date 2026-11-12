import * as pdfjsLib from '/node_modules/pdfjs-dist/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.mjs';

const $ = (s) => document.querySelector(s);
const frame = $('#frame');
const emptyEl = $('#empty');
const pdfEl = $('#pdf');
const pagesEl = $('#pages');
const imgView = $('#img');
const imgEl = $('#image');
const hud = $('#hud');
const controls = $('#controls');
const vthumb = $('#vthumb');
const hthumb = $('#hthumb');

const DRAG_STRIP = 44; // invisible title bar height
const CONTROL_ZONE = { w: 190, h: 60 }; // top-right hover area that reveals buttons
const PT = 96 / 72; // PDF points -> CSS px
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif',
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
let mode = 'empty'; // 'empty' | 'pdf' | 'image'

// ---------- HUD

let hudTimer;
function showHud(text) {
  hud.textContent = text;
  hud.classList.add('show');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => hud.classList.remove('show'), 900);
}

// ---------- window chrome

api.onMaximized((v) => {
  document.body.classList.toggle('max', v);
  $('#b-max').title = v ? 'Restore' : 'Maximize';
});

$('#b-min').addEventListener('click', () => api.minimize());
$('#b-max').addEventListener('click', () => api.toggleMax());
$('#b-close').addEventListener('click', () => api.close());

let dragging = false;
addEventListener('mousemove', (e) => {
  const inZone = e.clientY < CONTROL_ZONE.h && e.clientX > innerWidth - CONTROL_ZONE.w;
  controls.classList.toggle('show', inZone && !dragging);
});
document.documentElement.addEventListener('mouseleave', () => controls.classList.remove('show'));

function capture(e, onEnd) {
  const target = e.currentTarget;
  target.setPointerCapture(e.pointerId);
  const end = () => {
    target.removeEventListener('pointerup', end);
    target.removeEventListener('lostpointercapture', end);
    onEnd();
  };
  target.addEventListener('pointerup', end);
  target.addEventListener('lostpointercapture', end);
}

for (const edge of document.querySelectorAll('.edge')) {
  edge.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    api.resizeStart(edge.dataset.dir);
    capture(e, () => api.resizeEnd());
  });
}

// One dispatcher for presses on the document: the top strip drags the window,
// anywhere else pans (images only).
frame.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('#controls, .edge, .thumb')) return;
  const inStrip = mode === 'empty' || e.clientY < DRAG_STRIP;
  if (inStrip) {
    e.preventDefault();
    dragging = true;
    controls.classList.remove('show');
    api.dragStart();
    capture(e, () => {
      dragging = false;
      api.dragEnd();
    });
  } else if (mode === 'image') {
    startImagePan(e);
  }
});

frame.addEventListener('dblclick', (e) => {
  if (e.target.closest('#controls, .edge, .thumb')) return;
  if (mode === 'empty') return openDialog();
  if (e.clientY < DRAG_STRIP) return api.toggleMax();
  if (mode === 'image') toggleImageZoom(e.clientX, e.clientY);
});

// ---------- loading

function setMode(m) {
  mode = m;
  emptyEl.classList.toggle('hidden', m !== 'empty');
  pdfEl.classList.toggle('hidden', m !== 'pdf');
  imgView.classList.toggle('hidden', m !== 'image');
  updateThumbs();
}

async function loadPayload(file) {
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
  try {
    if (ext === 'pdf') await openPdf(data);
    else await openImage(data, ext);
    document.title = file.name;
  } catch (err) {
    console.error(err);
    showHud(`Could not open ${file.name}`);
  }
}

async function openDialog() {
  loadPayload(await api.openDialog());
}

function closeCurrent() {
  closePdf();
  closeImage();
}

// ---------- PDF

let pdfDoc = null;
let pages = [];
let scale = 1;
let pdfFit = true;
let renderTimer;
let loadToken = 0;

const io = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const p = pages[+entry.target.dataset.i];
      if (!p) continue;
      p.visible = entry.isIntersecting;
      if (p.visible) {
        if (!p.canvas) renderPage(p);
      } else {
        releasePage(p);
      }
    }
  },
  { root: pdfEl, rootMargin: '150% 50%' },
);

function closePdf() {
  loadToken++;
  clearTimeout(renderTimer);
  for (const p of pages) {
    io.unobserve(p.el);
    p.task?.cancel();
  }
  pages = [];
  pagesEl.replaceChildren();
  pdfDoc?.destroy();
  pdfDoc = null;
}

async function openPdf(data) {
  const doc = await pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    cMapUrl: new URL('/node_modules/pdfjs-dist/cmaps/', location.href).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('/node_modules/pdfjs-dist/standard_fonts/', location.href).href,
  }).promise;
  closeCurrent();
  pdfDoc = doc;
  const token = loadToken;

  const first = await doc.getPage(1);
  const vp = first.getViewport({ scale: 1 });
  pages = Array.from({ length: doc.numPages }, (_, i) => {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.i = i;
    pagesEl.appendChild(el);
    return { el, page: i === 0 ? first : null, w: vp.width, h: vp.height, canvas: null, task: null, rendered: 0, visible: false };
  });

  pdfFit = true;
  setMode('pdf');
  await api.fit(vp.width * PT, vp.height * PT);
  fitPdf();
  pdfEl.scrollTo(0, 0);
  pdfEl.focus();
  for (const p of pages) io.observe(p.el);

  // Load the remaining pages in the background; sizes may differ from page 1.
  for (let i = 1; i < pages.length; i++) {
    const page = await doc.getPage(i + 1);
    if (token !== loadToken) return;
    const p = pages[i];
    const v = page.getViewport({ scale: 1 });
    p.page = page;
    if (v.width !== p.w || v.height !== p.h) {
      const anchor = pdfEl.scrollTop;
      p.w = v.width;
      p.h = v.height;
      if (pdfFit) fitPdf();
      else layoutPages();
      pdfEl.scrollTop = anchor;
    }
    if (p.visible) renderPage(p);
  }
}

function maxPageWidth() {
  return pages.reduce((m, p) => Math.max(m, p.w), 0) || 1;
}

function layoutPages() {
  for (const p of pages) {
    p.el.style.width = `${Math.round(p.w * PT * scale)}px`;
    p.el.style.height = `${Math.round(p.h * PT * scale)}px`;
  }
  updateThumbs();
}

function fitPdf() {
  if (!pages.length) return;
  scale = pdfEl.clientWidth / (maxPageWidth() * PT);
  layoutPages();
  scheduleRender();
}

function zoomPdf(next, cx = pdfEl.clientWidth / 2, cy = pdfEl.clientHeight / 2) {
  const minScale = Math.min(MIN_ZOOM, pdfEl.clientWidth / (maxPageWidth() * PT));
  next = clamp(next, minScale, MAX_ZOOM);
  if (next === scale) return;
  const r = next / scale;
  const x = pdfEl.scrollLeft + cx;
  const y = pdfEl.scrollTop + cy;
  scale = next;
  pdfFit = false;
  layoutPages();
  pdfEl.scrollLeft = x * r - cx;
  pdfEl.scrollTop = y * r - cy;
  scheduleRender();
  showHud(`${Math.round(scale * 100)}%`);
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => pages.forEach((p) => p.visible && renderPage(p)), 120);
}

async function renderPage(p) {
  if (!p.page || !p.visible) return;
  const target = scale * PT * devicePixelRatio;
  if (p.rendered === target) return;
  p.task?.cancel();

  // Cap canvas size so deep zooms don't exhaust memory.
  let s = target;
  const maxPixels = 24e6;
  if (p.w * p.h * s * s > maxPixels) s = Math.sqrt(maxPixels / (p.w * p.h));

  const viewport = p.page.getViewport({ scale: s });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const task = p.page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport });
  p.task = task;
  try {
    await task.promise;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.error(err);
    return;
  }
  if (p.task !== task) return;
  p.task = null;
  // Swap in the new canvas only when ready, so zooming never flashes white.
  p.canvas?.remove();
  p.el.appendChild(canvas);
  p.canvas = canvas;
  p.rendered = target;
}

function releasePage(p) {
  p.task?.cancel();
  p.task = null;
  p.canvas?.remove();
  p.canvas = null;
  p.rendered = 0;
}

function currentPage() {
  const mid = pdfEl.scrollTop + pdfEl.clientHeight / 2;
  let i = 0;
  while (i < pages.length - 1 && pages[i + 1].el.offsetTop <= mid) i++;
  return i + 1;
}

let lastPage = 0;
pdfEl.addEventListener('scroll', () => {
  updateThumbs(true);
  const n = currentPage();
  if (n !== lastPage) {
    lastPage = n;
    if (pages.length > 1) showHud(`${n} / ${pages.length}`);
  }
});

pdfEl.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const r = pdfEl.getBoundingClientRect();
    zoomPdf(scale * Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
  },
  { passive: false },
);

// ---------- overlay scrollbars (PDF)

let thumbTimer;
function updateThumbs(reveal = false) {
  const active = mode === 'pdf';
  const { scrollTop, scrollLeft, scrollHeight, scrollWidth, clientHeight, clientWidth } = pdfEl;
  const hasV = active && scrollHeight > clientHeight + 1;
  const hasH = active && scrollWidth > clientWidth + 1;
  vthumb.style.display = hasV ? '' : 'none';
  hthumb.style.display = hasH ? '' : 'none';
  if (hasV) {
    const h = Math.max(30, (clientHeight / scrollHeight) * clientHeight);
    vthumb.style.height = `${h}px`;
    vthumb.style.top = `${(scrollTop / (scrollHeight - clientHeight)) * (clientHeight - h)}px`;
  }
  if (hasH) {
    const w = Math.max(30, (clientWidth / scrollWidth) * clientWidth);
    hthumb.style.width = `${w}px`;
    hthumb.style.left = `${(scrollLeft / (scrollWidth - clientWidth)) * (clientWidth - w)}px`;
  }
  if (reveal) revealThumbs();
}

function revealThumbs() {
  vthumb.classList.add('show');
  hthumb.classList.add('show');
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    if (!vthumb.matches(':hover, .active')) vthumb.classList.remove('show');
    if (!hthumb.matches(':hover, .active')) hthumb.classList.remove('show');
  }, 1000);
}

addEventListener('mousemove', (e) => {
  if (mode !== 'pdf') return;
  if (e.clientX > innerWidth - 16 || e.clientY > innerHeight - 16) revealThumbs();
});

function thumbDrag(thumb, axis) {
  thumb.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = axis === 'y' ? e.clientY : e.clientX;
    const startScroll = axis === 'y' ? pdfEl.scrollTop : pdfEl.scrollLeft;
    const ratio =
      axis === 'y'
        ? (pdfEl.scrollHeight - pdfEl.clientHeight) / (pdfEl.clientHeight - thumb.offsetHeight)
        : (pdfEl.scrollWidth - pdfEl.clientWidth) / (pdfEl.clientWidth - thumb.offsetWidth);
    const move = (ev) => {
      const d = ((axis === 'y' ? ev.clientY : ev.clientX) - start) * ratio;
      if (axis === 'y') pdfEl.scrollTop = startScroll + d;
      else pdfEl.scrollLeft = startScroll + d;
    };
    thumb.classList.add('active');
    thumb.addEventListener('pointermove', move);
    capture(e, () => {
      thumb.classList.remove('active');
      thumb.removeEventListener('pointermove', move);
      revealThumbs();
    });
  });
}
thumbDrag(vthumb, 'y');
thumbDrag(hthumb, 'x');

// ---------- images

let iw = 0, ih = 0, is = 1, ix = 0, iy = 0;
let imgFit = true;
let imgUrl = null;

function closeImage() {
  if (imgUrl) URL.revokeObjectURL(imgUrl);
  imgUrl = null;
  imgEl.removeAttribute('src');
}

async function openImage(data, ext) {
  const url = URL.createObjectURL(new Blob([data], { type: MIME[ext] || '' }));
  const probe = new Image();
  probe.src = url;
  await probe.decode();
  closeCurrent();
  imgUrl = url;
  imgEl.src = url;
  iw = probe.naturalWidth || 800;
  ih = probe.naturalHeight || 600;
  imgEl.style.width = `${iw}px`;
  imgEl.style.height = `${ih}px`;
  imgFit = true;
  setMode('image');
  await api.fit(iw, ih);
  fitImage();
  imgView.focus();
}

function applyImage() {
  const vw = imgView.clientWidth;
  const vh = imgView.clientHeight;
  const w = iw * is;
  const h = ih * is;
  // Center along an axis when smaller than the view, otherwise keep edges in view.
  ix = w <= vw ? (vw - w) / 2 : clamp(ix, vw - w, 0);
  iy = h <= vh ? (vh - h) / 2 : clamp(iy, vh - h, 0);
  imgEl.style.transform = `translate(${ix}px, ${iy}px) scale(${is})`;
  imgEl.classList.toggle('pixelated', is >= 4);
}

function fitScale() {
  return Math.min(imgView.clientWidth / iw, imgView.clientHeight / ih);
}

function fitImage() {
  is = fitScale();
  applyImage();
}

function zoomImage(next, cx = imgView.clientWidth / 2, cy = imgView.clientHeight / 2) {
  next = clamp(next, Math.min(MIN_ZOOM, fitScale()), Math.max(MAX_ZOOM * 3, fitScale()));
  if (next === is) return;
  ix = cx - ((cx - ix) * next) / is;
  iy = cy - ((cy - iy) * next) / is;
  is = next;
  imgFit = false;
  applyImage();
  showHud(`${Math.round(is * 100)}%`);
}

function toggleImageZoom(cx, cy) {
  if (Math.abs(is - fitScale()) < 0.001) {
    zoomImage(Math.max(1, fitScale() * 2), cx, cy);
  } else {
    imgFit = true;
    fitImage();
    showHud('Fit');
  }
}

function startImagePan(e) {
  e.preventDefault();
  const sx = e.clientX - ix;
  const sy = e.clientY - iy;
  const move = (ev) => {
    ix = ev.clientX - sx;
    iy = ev.clientY - sy;
    applyImage();
  };
  imgView.classList.add('panning');
  frame.addEventListener('pointermove', move);
  capture(e, () => {
    imgView.classList.remove('panning');
    frame.removeEventListener('pointermove', move);
  });
}

imgView.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const r = imgView.getBoundingClientRect();
    const k = e.ctrlKey ? 0.004 : 0.0018;
    zoomImage(is * Math.exp(-e.deltaY * k), e.clientX - r.left, e.clientY - r.top);
  },
  { passive: false },
);

// ---------- resize handling

new ResizeObserver(() => {
  if (mode === 'pdf') {
    if (pdfFit) fitPdf();
    else updateThumbs();
  } else if (mode === 'image') {
    if (imgFit) fitImage();
    else applyImage();
  }
}).observe(frame);

// ---------- keyboard

function zoomBy(f) {
  if (mode === 'pdf') zoomPdf(scale * f);
  else if (mode === 'image') zoomImage(is * f);
}

function resetZoom() {
  if (mode === 'pdf') {
    pdfFit = true;
    fitPdf();
  } else if (mode === 'image') {
    imgFit = true;
    fitImage();
  }
  showHud('Fit');
}

addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'o') return e.preventDefault(), openDialog();
  if (ctrl && e.key.toLowerCase() === 'w') return api.close();
  if (ctrl && e.key.toLowerCase() === 't') return e.preventDefault(), api.tile();
  if (ctrl && (e.key === '=' || e.key === '+')) return e.preventDefault(), zoomBy(1.2);
  if (ctrl && e.key === '-') return e.preventDefault(), zoomBy(1 / 1.2);
  if (ctrl && e.key === '0') return e.preventDefault(), resetZoom();
  if (ctrl && e.key === '1') {
    e.preventDefault();
    if (mode === 'pdf') zoomPdf(1);
    else if (mode === 'image') zoomImage(1);
    return;
  }
  if (e.key === 'F11') return e.preventDefault(), api.toggleMax();
  if (mode === 'pdf' && !ctrl) {
    if (e.key === 'Home') return pdfEl.scrollTo({ top: 0 });
    if (e.key === 'End') return pdfEl.scrollTo({ top: pdfEl.scrollHeight });
  }
});

// ---------- drag & drop

let dragDepth = 0;
addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (++dragDepth === 1) document.body.classList.add('dragover');
});
addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragover');
  }
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  loadPayload({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
});

// ---------- start

(async () => {
  const file = await api.initialFile();
  if (file) await loadPayload(file);
  if (mode === 'empty') await api.fit(520, 340);
})();
