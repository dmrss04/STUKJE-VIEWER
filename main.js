const { app, BrowserWindow, ipcMain, dialog, screen, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const EXTS = ['pdf', 'png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'];
const MIN_W = 200;
const MIN_H = 150;
const TICK = 1000 / 120;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const isSupported = (p) => EXTS.includes(path.extname(p).slice(1).toLowerCase());

function fileFromArgv(argv) {
  return argv.slice(1).find((a) => {
    if (a.startsWith('-')) return false;
    try {
      return fs.statSync(a).isFile() && isSupported(a);
    } catch {
      return false;
    }
  });
}

function readPayload(filePath) {
  if (!filePath) return null;
  return { name: path.basename(filePath), data: fs.readFileSync(filePath) };
}

// ---------- windows

function createWindow(filePath) {
  const win = new BrowserWindow({
    width: 520,
    height: 340,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win._file = filePath || null;
  win._max = false;
  win._snap = null;
  win._op = null;
  win.on('closed', () => {
    clearInterval(win._op);
    // The hidden preview window would otherwise keep the app alive.
    const others = BrowserWindow.getAllWindows().filter((w) => w !== preview);
    if (!others.length && preview && !preview.isDestroyed()) preview.destroy();
  });
  win.loadURL('app://viewer/renderer/index.html');
  return win;
}

function setMax(win, value) {
  if (value === win._max) return;
  if (value) {
    if (!win._snap) win._restore = win.getBounds();
    win.setBounds(screen.getDisplayMatching(win.getBounds()).workArea);
    win._snap = null;
  } else if (win._restore) {
    win.setBounds(win._restore);
  }
  win._max = value;
  win.webContents.send('win:maximized', value);
}

function stopOp(win) {
  clearInterval(win._op);
  win._op = null;
}

// ---------- snapping

const SNAP_EDGE = 6; // px from a screen edge that triggers a snap
const SNAP_CORNER = 140; // px along an edge that counts as a corner

// Which snap zone (if any) the cursor is in, and the work area it targets.
function snapZoneAt(p) {
  const d = screen.getDisplayNearestPoint(p);
  const b = d.bounds;
  const wa = d.workArea;
  const left = p.x <= b.x + SNAP_EDGE - 1;
  const right = p.x >= b.x + b.width - SNAP_EDGE;
  const top = p.y <= b.y + SNAP_EDGE - 1;
  const bottom = p.y >= b.y + b.height - SNAP_EDGE;
  const nearTop = p.y < wa.y + SNAP_CORNER;
  const nearBottom = p.y > wa.y + wa.height - SNAP_CORNER;
  const nearLeft = p.x < wa.x + SNAP_CORNER;
  const nearRight = p.x > wa.x + wa.width - SNAP_CORNER;
  let zone = null;
  if (left) zone = nearTop ? 'tl' : nearBottom ? 'bl' : 'l';
  else if (right) zone = nearTop ? 'tr' : nearBottom ? 'br' : 'r';
  else if (top) zone = nearLeft ? 'tl' : nearRight ? 'tr' : 'max';
  else if (bottom) zone = nearLeft ? 'bl' : nearRight ? 'br' : null;
  return zone ? { zone, wa } : null;
}

function snapRect(zone, wa) {
  const hw = Math.round(wa.width / 2);
  const hh = Math.round(wa.height / 2);
  const L = { x: wa.x, width: hw };
  const R = { x: wa.x + hw, width: wa.width - hw };
  const T = { y: wa.y, height: hh };
  const B = { y: wa.y + hh, height: wa.height - hh };
  const F = { y: wa.y, height: wa.height };
  switch (zone) {
    case 'max': return { ...wa };
    case 'l': return { ...L, ...F };
    case 'r': return { ...R, ...F };
    case 'tl': return { ...L, ...T };
    case 'tr': return { ...R, ...T };
    case 'bl': return { ...L, ...B };
    case 'br': return { ...R, ...B };
  }
  return null;
}

// A click-through, translucent window that previews where the snap will land.
let preview = null;
function showPreview(rect, owner) {
  if (!preview || preview.isDestroyed()) {
    preview = new BrowserWindow({
      ...rect,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      backgroundColor: '#00000000',
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    preview.setIgnoreMouseEvents(true);
    preview.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          '<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}' +
            'div{position:absolute;inset:8px;border-radius:10px;background:rgba(255,255,255,.14);' +
            'border:1px solid rgba(255,255,255,.45);box-shadow:0 0 0 1px rgba(0,0,0,.25);' +
            'backdrop-filter:blur(2px)}</style><div></div>'
        )
    );
  }
  preview.setBounds(rect);
  if (!preview.isVisible()) preview.showInactive();
  owner.moveTop(); // keep the dragged window above its preview
}

function hidePreview() {
  if (preview && !preview.isDestroyed()) preview.hide();
}

function snapTo(win, zone, wa) {
  if (zone === 'max') {
    if (!win._snap && !win._max) win._restore = win.getBounds();
    win.setBounds(wa);
    win._snap = null;
    win._max = true;
    win.webContents.send('win:maximized', true);
    return;
  }
  if (!win._snap && !win._max) win._restore = win.getBounds();
  win.setBounds(snapRect(zone, wa));
  win._snap = zone;
  if (win._max) {
    win._max = false;
    win.webContents.send('win:maximized', false);
  }
}

// ---------- tiling

const TILE_GAP = 10; // px around and between tiled windows, so the rounded corners show

const viewers = () =>
  BrowserWindow.getAllWindows()
    .filter((w) => w !== preview && !w.isDestroyed())
    .sort((a, b) => a.id - b.id);

// Grid cells for n windows: 'cols' puts them side by side, 'rows' stacks them.
function tileRects(n, layout, wa) {
  const across = n <= 3 ? n : Math.ceil(Math.sqrt(n));
  const lines = Math.ceil(n / across);
  const rects = [];
  for (let i = 0; i < n; i++) {
    const line = Math.floor(i / across);
    const inLine = line === lines - 1 ? n - line * across : across; // last line fills its width
    const pos = i - line * across;
    const [cols, rows, c, r] = layout === 'cols' ? [inLine, lines, pos, line] : [lines, inLine, line, pos];
    const w = (wa.width - TILE_GAP * (cols + 1)) / cols;
    const h = (wa.height - TILE_GAP * (rows + 1)) / rows;
    const x = Math.round(wa.x + TILE_GAP + c * (w + TILE_GAP));
    const y = Math.round(wa.y + TILE_GAP + r * (h + TILE_GAP));
    rects.push({ x, y, width: Math.round(w), height: Math.round(h) });
  }
  return rects;
}

// Each press cycles: side by side -> stacked -> back to where they were.
function tileAll(from) {
  const wins = viewers();
  const all = (snap) => wins.every((w) => w._snap === snap);
  const next = all('tile-cols') ? 'rows' : all('tile-rows') ? 'restore' : 'cols';
  if (next === 'restore') {
    for (const w of wins) {
      if (w._restore) w.setBounds(w._restore);
      w._snap = null;
    }
    return;
  }
  const wa = screen.getDisplayMatching(from.getBounds()).workArea;
  tileRects(wins.length, next, wa).forEach((rect, i) => {
    const w = wins[i];
    if (w.isMinimized()) w.restore();
    if (!w._snap && !w._max) w._restore = w.getBounds();
    if (w._max) {
      w._max = false;
      w.webContents.send('win:maximized', false);
    }
    w.setBounds(rect);
    w._snap = `tile-${next}`;
  });
  from.focus();
}

// Window drag / resize run in the main process by polling the cursor, so they
// stay smooth even when the mouse outruns the window.
function startDrag(win) {
  stopOp(win);
  const start = screen.getCursorScreenPoint();
  let b = win.getBounds();
  let last = '';
  let lastZone = '';
  win._op = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(win._op);
    const p = screen.getCursorScreenPoint();
    const dx = p.x - start.x;
    const dy = p.y - start.y;
    if (win._max || win._snap) {
      if (Math.hypot(dx, dy) < 6) return;
      // Pull the window out of maximized/snapped state, keeping it under the cursor.
      const r = win._restore || b;
      const relX = (start.x - b.x) / b.width;
      const relY = Math.min(start.y - b.y, r.height - 10);
      b = { x: Math.round(start.x - r.width * relX), y: start.y - relY, width: r.width, height: r.height };
      if (win._max) win.webContents.send('win:maximized', false);
      win._max = false;
      win._snap = null;
    }
    const next = { x: b.x + dx, y: b.y + dy, width: b.width, height: b.height };
    const key = `${next.x},${next.y}`;
    if (key !== last) {
      last = key;
      win.setBounds(next);
    }
    const hit = snapZoneAt(p);
    const zoneKey = hit ? `${hit.zone}@${hit.wa.x},${hit.wa.y}` : '';
    if (zoneKey !== lastZone) {
      lastZone = zoneKey;
      if (hit) showPreview(snapRect(hit.zone, hit.wa), win);
      else hidePreview();
    }
  }, TICK);
}

function endDrag(win) {
  if (!win._op) return;
  stopOp(win);
  hidePreview();
  // Dropping the window on a screen edge or corner snaps it there.
  const hit = snapZoneAt(screen.getCursorScreenPoint());
  if (hit && !win._max && !win._snap) snapTo(win, hit.zone, hit.wa);
}

function startResize(win, dir) {
  stopOp(win);
  if (win._max) return;
  win._snap = null; // a resized snapped window becomes a normal window
  const start = screen.getCursorScreenPoint();
  const b = win.getBounds();
  let last = '';
  win._op = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(win._op);
    const p = screen.getCursorScreenPoint();
    const dx = p.x - start.x;
    const dy = p.y - start.y;
    let { x, y, width, height } = b;
    if (dir.includes('e')) width = Math.max(MIN_W, b.width + dx);
    if (dir.includes('s')) height = Math.max(MIN_H, b.height + dy);
    if (dir.includes('w')) {
      width = Math.max(MIN_W, b.width - dx);
      x = b.x + b.width - width;
    }
    if (dir.includes('n')) {
      height = Math.max(MIN_H, b.height - dy);
      y = b.y + b.height - height;
    }
    const key = `${x},${y},${width},${height}`;
    if (key !== last) {
      last = key;
      win.setBounds({ x, y, width, height });
    }
  }, TICK);
}

// Size the window to the content's aspect ratio, as large as fits comfortably.
function fitTo(win, w, h) {
  const wasVisible = win.isVisible();
  if (win._max) {
    win._max = false;
    win.webContents.send('win:maximized', false);
  }
  win._snap = null;
  const cur = win.getBounds();
  const anchor = wasVisible
    ? { x: cur.x + cur.width / 2, y: cur.y + cur.height / 2 }
    : screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) }).workArea;
  const s = Math.min((wa.width * 0.85) / w, (wa.height * 0.9) / h, 1);
  const width = Math.max(MIN_W, Math.round(w * s));
  const height = Math.max(MIN_H, Math.round(h * s));
  const cx = wasVisible ? anchor.x : wa.x + wa.width / 2;
  const cy = wasVisible ? anchor.y : wa.y + wa.height / 2;
  const x = Math.round(Math.min(Math.max(cx - width / 2, wa.x), wa.x + wa.width - width));
  const y = Math.round(Math.min(Math.max(cy - height / 2, wa.y), wa.y + wa.height - height));
  win.setBounds({ x, y, width, height });
  if (!wasVisible) win.show();
}

// ---------- ipc

const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

ipcMain.handle('file:initial', (e) => {
  const win = winOf(e);
  try {
    return readPayload(win._file);
  } catch {
    return null;
  }
});

ipcMain.handle('file:open', async (e) => {
  const win = winOf(e);
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'PDFs and images', extensions: EXTS },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return readPayload(res.filePaths[0]);
});

ipcMain.handle('win:fit', (e, w, h) => fitTo(winOf(e), w, h));
ipcMain.on('win:min', (e) => winOf(e).minimize());
ipcMain.on('win:close', (e) => winOf(e).close());
ipcMain.on('win:toggleMax', (e) => {
  const win = winOf(e);
  setMax(win, !win._max);
});
ipcMain.on('win:tile', (e) => tileAll(winOf(e)));
ipcMain.on('win:dragStart', (e) => startDrag(winOf(e)));
ipcMain.on('win:dragEnd', (e) => endDrag(winOf(e)));
ipcMain.on('win:resizeStart', (e, dir) => startResize(winOf(e), String(dir)));
ipcMain.on('win:resizeEnd', (e) => stopOp(winOf(e)));

// ---------- app

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => createWindow(fileFromArgv(argv)));

  app.whenReady().then(() => {
    const root = path.resolve(__dirname);
    protocol.handle('app', (req) => {
      const { pathname } = new URL(req.url);
      const target = path.normalize(path.join(root, decodeURIComponent(pathname)));
      if (!target.startsWith(root)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(target).toString());
    });
    createWindow(fileFromArgv(process.argv));
  });

  app.on('window-all-closed', () => app.quit());
}
