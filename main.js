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
  win._op = null;
  win.on('closed', () => clearInterval(win._op));
  win.loadURL('app://viewer/renderer/index.html');
  return win;
}

function setMax(win, value) {
  if (value === win._max) return;
  if (value) {
    win._restore = win.getBounds();
    win.setBounds(screen.getDisplayMatching(win._restore).workArea);
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

// Window drag / resize run in the main process by polling the cursor, so they
// stay smooth even when the mouse outruns the window.
function startDrag(win) {
  stopOp(win);
  const start = screen.getCursorScreenPoint();
  let b = win.getBounds();
  let last = '';
  win._op = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(win._op);
    const p = screen.getCursorScreenPoint();
    const dx = p.x - start.x;
    const dy = p.y - start.y;
    if (win._max) {
      if (Math.hypot(dx, dy) < 6) return;
      // Pull the window out of maximized state, keeping it under the cursor.
      const r = win._restore;
      const relX = (start.x - b.x) / b.width;
      b = { x: Math.round(start.x - r.width * relX), y: b.y, width: r.width, height: r.height };
      win._max = false;
      win.webContents.send('win:maximized', false);
    }
    const next = { x: b.x + dx, y: b.y + dy, width: b.width, height: b.height };
    const key = `${next.x},${next.y}`;
    if (key !== last) {
      last = key;
      win.setBounds(next);
    }
  }, TICK);
}

function endDrag(win) {
  if (!win._op) return;
  stopOp(win);
  // Dropping the window on the top edge of a screen maximizes it.
  const p = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(p).workArea;
  if (p.y <= wa.y + 1 && !win._max) {
    win._restore = win.getBounds();
    win.setBounds(wa);
    win._max = true;
    win.webContents.send('win:maximized', true);
  }
}

function startResize(win, dir) {
  stopOp(win);
  if (win._max) return;
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
