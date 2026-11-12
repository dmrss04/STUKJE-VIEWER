<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-white.svg">
    <img src="assets/logo-black.svg" width="96" alt="Stukje Viewer logo">
  </picture>
</p>

<h1 align="center">Stukje Viewer</h1>

<p align="center">
  A borderless PDF and image viewer for Windows.<br>
  No title bar, no toolbar, no frame. Just the document, with softly rounded corners.
</p>

<p align="center">
  <a href="../../releases/latest"><b>Download for Windows</b></a>
</p>

---

## Why

Most viewers put more chrome around a file than the file itself. Stukje Viewer shows only the page or picture. The window controls and title bar are still there, just invisible until you need them.

## Features

- **Only the document.** The window opens at the file's own shape and shows nothing else.
- **Invisible title bar.** Grab the top strip of the document to move the window. Double-click it to maximize, or drag it to the top of the screen.
- **Snap to edges and corners.** Drag the window to the left or right edge to fill half the screen, or into a corner to fill a quarter. A preview shows where it will land; drag it away to get the old size back.
- **Tile with one key.** With several files open, `Ctrl+T` lays every window out side by side, press again to stack them, and once more to put them back. Small gaps keep the rounded corners visible. `Alt+arrow` swaps the active window with its neighbour to reorder them.
- **Controls that appear on demand.** Minimize, maximize and close fade in only when the mouse reaches the top-right corner.
- **PDFs.** Smooth scrolling, sharp rendering at any zoom, a brief page indicator (`3 / 12`), and a scrollbar that only shows up while you scroll.
- **Images.** Zoom toward the cursor, drag to pan, double-click to switch between fit and zoomed. PNG, JPG, GIF, WebP, BMP, SVG, ICO and AVIF.
- **Drop to open.** Drag a file onto any window to swap it in. Each file opened from Explorer gets its own window.
- **Resizable** from any edge or corner.

## Install

1. Download `Stukje-Viewer-Setup-1.2.0.exe` from the [latest release](../../releases/latest).
2. Run it. Windows SmartScreen may warn because the installer isn't code-signed. Choose **More info → Run anyway**.
3. Right-click a PDF or image → **Open with** → **Stukje Viewer**. Tick *Always use this app* to make it the default.

## Controls

| Action | Mouse | Keyboard |
| --- | --- | --- |
| Move window | Drag the top of the document | |
| Snap to half / quarter | Drag to a screen edge / corner | |
| Tile all windows | | `Ctrl+T` (side by side → stacked → back) |
| Swap with neighbouring window | | `Alt+←` `→` `↑` `↓` (tiled or snapped windows) |
| Maximize / restore | Double-click the top of the document | `F11` |
| Minimize, maximize, close | Hover the top-right corner | `Ctrl+W` closes |
| Zoom | `Ctrl` + scroll (PDF), scroll (image), pinch | `Ctrl` `+` / `Ctrl` `-` |
| Fit to window | Double-click (image) | `Ctrl+0` |
| Actual size | | `Ctrl+1` |
| Pan | Scroll (PDF), drag (image) | Arrows, `PgUp` / `PgDn`, `Home` / `End` |
| Open a file | Drop it on the window, or double-click the empty window | `Ctrl+O` |

## Build from source

Requires [Node.js](https://nodejs.org) 20 or newer.

```sh
git clone https://github.com/dmrss04/STUKJE-VIEWER.git
cd STUKJE-VIEWER
npm install
npm start                       # run the viewer
npm start -- "C:\path\file.pdf" # open a file directly
npm run dist                    # build the installer into dist/
```

## How it's made

- [Electron](https://www.electronjs.org) provides a frameless, transparent window. The rounded corners are drawn by the page itself.
- [pdf.js](https://mozilla.github.io/pdf.js/) renders PDFs. Pages render only near the viewport and re-render sharply after zooming.
- Moving and resizing the window are handled in the main process by tracking the cursor, so the hidden title bar never blocks scrolling.

| File | Role |
| --- | --- |
| `main.js` | Window creation, drag, snap, resize, maximize, file opening |
| `preload.js` | The small API the page can use |
| `renderer/` | The viewer: PDF and image views, hover controls, zoom |
| `assets/` | Logo and app icon |

## Known limits

- Windows Snap layouts and `Win` + arrow keys don't apply, since the window has no native title bar.
- You can't select text in PDFs.

## License

[MIT](LICENSE)
