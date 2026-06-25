# AutoHotkey v2 Script Builder

A local, browser-based tool for visually creating AutoHotkey v2 automation
scripts. Crop UI elements out of a screenshot, arrange actions in a queue,
and export a ready-to-run `.ahk` script plus its image assets.

## Running the app

This is a static web app — no install, no build step.

1. Download or clone this folder.
2. Open `index.html` in any modern browser (Chrome, Edge, Firefox).
3. That's it. Everything runs locally; no data leaves your machine.

If your browser blocks the JSZip CDN (offline use), download
`https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js`,
save it next to `app.js`, and change the `<script src>` line in
`index.html` to `jszip.min.js`.

## How to use it

1. **Load a screenshot.** Drag-and-drop a PNG/JPG into the workspace,
   click "Choose File", or **paste a screenshot from the clipboard**
   with <kbd>Ctrl+V</kbd> (handy after Win+Shift+S). A full-screen
   capture works best because the generated script searches the whole
   screen.
2. **Crop a UI element.** Click and drag on the screenshot to draw a
   rectangle around a button, icon, or label. The crop preview appears
   in the middle panel. **Zoom** with the toolbar buttons (− / + / Fit /
   1:1) or **Ctrl + scroll** to zoom toward the cursor — useful for
   precisely selecting small targets when you've dropped in a full
   screen capture. Selection stays pixel-accurate at any zoom level.
3. **Name and add it.** Give the crop a short name (e.g. `submit_button`),
   choose whether it should be a *click*, *wait until appears*, or
   *skip if not found* action, set tolerance and timeout, then click
   **Add to Queue**.
4. **Add non-image actions.** Use the **+ Add Action** button at the top
   to add: launching a program or URL, maximizing a window, waiting a
   fixed number of seconds, typing text, sending a key combo, or
   logging a message.
5. **Reorder and edit.** In the queue (right side), click an item to edit
   it. **Drag the ⠿ handle** to reorder, or use ▲ / ▼ and ✕. Items inside
   a "skip if not found" block are visually indented; click the ▾ on a
   skip step to **collapse/expand** its children. The **⛶ button** on an
   image step lets you **re-crop** it (load the screenshot first).
   **Tip:** when a step is selected, new steps insert right after it.

### Keyboard shortcuts

- **Ctrl/Cmd + Z** — undo the last change
- **Ctrl/Cmd + D** — duplicate the selected step
- **Delete / Backspace** — remove the selected step
- **↑ / ↓** — move the selection up/down the queue
- **Esc** — cancel a pending crop or close a dialog

### Other conveniences

- **Autosave.** Your work is saved to the browser automatically; if you
  close the tab and come back, you'll be offered to restore the last
  session. (This is separate from Save Project, which downloads a file
  you can keep or share.)
- **Preview Script.** See the exact generated `automation.ahk` in a
  modal before exporting, with a copy-to-clipboard button.
- **Estimated runtime.** The queue shows a rough runtime estimate
  (fixed waits plus worst-case image-search timeouts).
- **Comments / dividers.** Add a non-executing "Comment / section
  divider" step to label phases of a long workflow; it renders as a
  comment block in the script.
6. **Save your project.** Click **Save Project** to download a JSON file
   containing the queue and all cropped images. Use **Load Project** to
   restore it later.
7. **Pick an exit behavior and logging.** Choose whether the finished
   script saves a log file, and whether each step should save a
   screenshot of the screen.
8. **Export.** Click **Export Package**. You get a `.zip` containing:
   - `automation.ahk` — the generated script
   - `images/` — every cropped PNG
   - `README.txt` — runtime instructions

## Per-run logs and screenshots

Every time `automation.ahk` runs, it creates a new timestamped folder
under `logs/` next to the script:

```
logs/
├── 2026-06-06_14-00-00/
│   ├── automation_log.txt          (text log of this run)
│   ├── step_001_close_windows.png  (screen state after step 1)
│   ├── step_002_launch.png
│   └── ...
├── 2026-06-06_15-00-00/
│   └── ...
```

This is designed for scripts that run repeatedly (e.g. hourly via
Task Scheduler). Each run is captured independently so you can compare
results across runs and see exactly what the screen looked like when
each step ran. Screenshots are off by default and can be enabled via
the **"Save a screenshot after each step"** checkbox in the queue panel.

**Disk usage:** each 1080p PNG is roughly 1–3 MB. Hourly runs over
weeks will accumulate; periodically delete old `logs/<timestamp>/`
subfolders to reclaim space.

## Action types

- **Launch program / URL** — `Run(...)` an executable path or open a URL.
- **Maximize / fullscreen** — `WinMaximize` an existing window, or send
  `F11` for browser-style fullscreen.
- **Close window(s) — reset state** — either close *all* visible windows
  (with an optional exclusion list of titles to keep open) or close
  *one* specific window by title. Useful as a first step to ensure
  every run starts from the same clean state. The "all" mode protects
  the Windows taskbar and desktop so they aren't killed by accident.
- **Find image and click** — `ImageSearch`, then click. Supports
  **left**, **right**, **double**, or **middle** click. After cropping,
  click anywhere on the preview to set a **custom click point**
  (e.g. to hit a small icon inside a larger captured region); defaults
  to the center of the match.
- **Wait until image appears** — polls `ImageSearch` until the image is
  found or the timeout elapses.
- **Skip next N steps if image not found** — wraps the next N queue
  items in an `if FindImage().found { ... }` block. Perfect for popups
  and cookie banners that may or may not appear. Skip blocks can nest.

### Searching within a parent region

Any of the three image-search actions above can optionally use another
image in the queue as a **parent region**. The script will find the
parent first, then only search for the child image inside the parent's
pixel bounds. Useful when:
- The same icon (e.g. a "✕" close button) appears in multiple windows
  and you need to target a specific one.
- You want to make a search faster and more reliable by limiting it to
  a known area.
- The screen has visually similar UI elements that would cause false
  matches across the full screen.

Set the **Search within image** dropdown in the step editor to pick
any other image-bearing step in the queue. If the parent isn't found
at runtime, the step is logged and skipped (rather than crashing).
- **Wait fixed seconds** — `Sleep(ms)`.
- **Type text** — `SendText(...)`, which sends literal text without
  interpreting `{`, `^`, etc. as special characters.
- **Send key combo** — `Send(...)` with modifiers (Ctrl/Alt/Shift/Win)
  plus a key. Examples: `t`, `Enter`, `Tab`, `F5`, `Esc`.
- **Log message** — adds a line to the runtime log.

## Running the exported script

1. Install **AutoHotkey v2** from <https://www.autohotkey.com/>.
2. Unzip the exported package somewhere on your PC.
3. Double-click `automation.ahk`.

**Emergency abort while the script is running:**
- Press <kbd>Esc</kbd> for an immediate exit.
- Press <kbd>Shift</kbd>+<kbd>C</kbd> to log
  `"Script terminated by user"` and exit gracefully (the log file is
  saved if you chose the "save log" exit behavior).

Note: <kbd>Shift</kbd>+<kbd>C</kbd> is registered as a *global* hotkey
while the script is running, meaning any capital C typed anywhere on
your computer will terminate the automation. That's usually fine for
short scripts; for longer ones, just avoid touching the keyboard while
they run, or use <kbd>Esc</kbd> when you're focused on the target app.

The script searches the screen for each cropped image using
`ImageSearch`, clicks the center of matches, and either waits or
errors out gracefully when an image can't be found.

## Safety & trust

This is a fully client-side tool — nothing you load is uploaded anywhere.
Two things are still worth knowing:

- **Review exported scripts before running them.** The generated
  `automation.ahk` can close windows, launch programs, type text, and send
  keystrokes on your machine. Use **Preview Script** to read exactly what it
  will do, and treat a `.ahk` file like any other executable.
- **Only open project files (`.json`) you trust.** A project file embeds your
  cropped **screenshots**, so don't share one that captured sensitive
  on-screen content. Likewise, only load project files from people you trust —
  the app validates embedded image data on import, but a project still
  describes automation that will run on your computer.

## Tips

- **Same display scaling.** ImageSearch matches pixels exactly (with a
  configurable tolerance). Run the automation on the same monitor +
  Windows display scaling that the screenshot came from. Otherwise
  increase tolerance, or recapture.
- **Crop tight.** Smaller crops match faster and are more robust to
  surrounding UI changes. Crop only the distinctive part of a button.
- **Tolerance.** Start with `30`. Increase if matches fail; decrease if
  the wrong region matches.

## Limitations / future ideas

- ImageSearch searches the entire primary monitor. Multi-monitor users
  may want to add a region selector per action.
- No undo stack — deletions are immediate.
- Skip blocks only support "skip if NOT found". The inverse ("skip if
  found") could be added as a sibling action.
- No loops yet — repeating a sub-sequence requires duplicating steps.
- Variables / captured values (e.g. OCR a number, type it later) would
  let this evolve from a macro recorder into a real automation tool.
- The middle-click image dimension lookup relies on `LoadPicture` +
  `GetObject`; on rare PNG variants this may return zero. The script
  still finds the image, it just clicks the top-left instead of center
  in that edge case.

## Files

```
ahk-builder/
├── index.html   UI structure
├── style.css    Styles
├── app.js       All app logic (~2,000 lines, plain JS)
└── README.md    This file
```
