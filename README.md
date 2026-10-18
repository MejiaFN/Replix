# Replix

A Medal-style clipping and recording app for Windows. Replix quietly keeps the
last 30 to 300 seconds of your screen and audio. Press a hotkey and
that moment is saved as a clip.

- **Replay buffer + hotkey clip**: press **F8** to save the last 60 s (you can change the length)
- **Full recording**: press **F9** to start or stop recording a whole session
- **Library**: browse, play, trim, rename and delete clips (deleted clips go to the Recycle Bin)
- **Settings**: hotkeys, clip length, display, resolution, FPS, quality, encoder, game/system audio + mic, save folder
- Runs from the tray, and closing the window keeps it clipping in the background

## Download (for players)

Grab **`Replix-Setup-1.0.0.exe`** (installer: Start menu + desktop shortcut) or
**`Replix-Portable-1.0.0.exe`** (no install, just run it). Nothing else is needed.

Windows may show "Windows protected your PC" because the app isn't code-signed;
click **More info → Run anyway**.

## Building the .exe (for you)

```bash
npm.cmd install
```
```bash
npm.cmd run dist
```

The two exe files appear in the `dist` folder. Each build clears out the previous version's files first, so `dist` only ever holds the newest version. Upload those (e.g. to a GitHub Release, itch.io or Google Drive).

> If the build fails with "Cannot create symbolic link", turn on Windows **Developer Mode**
> (Settings → System → For developers) and run it again.

## Publishing an update

Replix checks GitHub Releases for new versions. When one is out, the sidebar
shows **⬇ Download update** and then **↻ Restart & update**, and the installed
app updates itself in place. (Only the **Setup** version can update. The portable exe
can't update itself.)

One-time setup:
1. Create a **public** GitHub repo named `replix`.
2. (Already set: updates come from `github.com/MejiaFN/Replix`.)

Each time you publish an update:
1. Bump `"version"` in `package.json` (e.g. `1.1.0` → `1.2.0`). Updates are detected by this number.
2. Run `npm.cmd run dist`.
3. On GitHub, go to your repo → **Releases** → **Draft a new release**, set the tag to `v1.2.0`, and upload these
   3 files from `dist`: `Replix-Setup-1.2.0.exe`, `Replix-Setup-1.2.0.exe.blockmap` and `latest.yml`
   (you can add the portable exe too). Then click **Publish release**.

Everyone's Replix will offer the update within a few hours, or right away if they click **Check for updates**.

## Running from source (one time setup)

1. Install **Node.js LTS** from https://nodejs.org (just click Next through the installer).
2. Open a terminal in this `replix` folder and run:

```bash
npm install
```

This downloads Electron and a bundled copy of FFmpeg. You don't need to install anything else.

> If npm says that install scripts were not approved, run `npm install-scripts approve electron ffmpeg-static` and then run `npm install` again.

## Run

```bash
npm start
```

Replix opens and turns the replay buffer on automatically. When the dot at the
top is glowing cyan, press **F8** at any time and a "Clip saved" popup appears
in the top-right corner.

Clips are saved to `Videos\Replix` by default. Click **Open folder** in the
Library to see them.

## Tips

- **Hotkey doesn't work?** Another app may already be using that key (Medal,
  ShadowPlay and Steam often claim F-keys). Go to Settings, click the hotkey
  box, press a different combo (e.g. `Alt+F10`), then click Save.
- **Games in exclusive fullscreen**: capture works best with *borderless
  windowed* mode. The popup may not show over exclusive fullscreen, but the clip still saves.
- **Smaller files**: set Quality to Medium or Low, or Resolution to 720p.
- **Replix's own audio** (e.g. playing a clip in the Library) is captured too,
  because Replix records everything you hear.

## How it works

The app is **Electron + FFmpeg**. I picked this stack because:

- FFmpeg's `ddagrab` (Desktop Duplication API) captures the screen with very little overhead, and it falls back
  to `gdigrab` automatically if needed. Encoding uses your GPU (NVENC / AMF / QuickSync), with CPU x264 as the last resort.
  Replix picks the best encoder automatically.
- System audio is captured through Chromium's WASAPI loopback (`getDisplayMedia`
  with `audio: 'loopback'`), so you don't need "Stereo Mix" or a virtual cable.
  The mic is added with WebAudio, and the mixed PCM is piped into FFmpeg.
- **Replay buffer**: FFmpeg writes 2-second `.ts` segments to `%TEMP%\replix\buffer`, reusing the same files in a loop.
  Saving a clip joins the newest segments with stream copy, without re-encoding, so it takes about a second.
- **Recording**: the same encode is tee'd into an `.mkv` file, which survives a crash, and it is remuxed to `.mp4` when you stop.
- **Trim**: re-encodes only the selected range so the cuts are frame-accurate. It saves a new file and leaves the original alone.

```
src/
  main.js          app, tray, hotkeys, IPC
  recorder.js      FFmpeg capture / buffer / clip / record / trim
  settings.js      settings (stored in %APPDATA%\replix\settings.json)
  audio/           hidden window: loopback + mic -> PCM
  ui/              library, player/trimmer, settings, toast popup
```
