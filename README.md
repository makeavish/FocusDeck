<p align="center">
  <img src="src/icons/icon.svg" alt="FocusDeck Icon" width="128" height="128">
</p>

# FocusDeck: Intentional Feed

FocusDeck is a WebExtensions MV3 extension for X.com that makes feed browsing intentional.

## Install FocusDeck

[![Install on Firefox](https://img.shields.io/badge/Install%20on-Firefox-FF7139?style=for-the-badge&logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/en-US/firefox/addon/focusdeck-intentional-feed/)
[![Install on Chrome](https://img.shields.io/badge/Install%20on-Chrome-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/focusdeck-intentional-fee/pnfjneofemgjgapbomggpgpkedocpibp?hl=en)

## Extension Behavior

- Native X post UI is preserved (no custom post cards/decks).
- Feed access is session-gated; if no session is active, feed posts are hidden and a start-session popover is shown.
- During a session, only the focused post is visible; all other feed items are hidden.
- Optional Following-tab bypass lets FocusDeck step aside on X's `Following` timeline without affecting `For you`.
- Promoted/ad units are hidden across supported X/Twitter routes (including idle or site-disabled states).
- Right sidebar modules are hidden while feed focus UI is active on feed routes.
- On fresh session start, focus begins at the first visible feed post; ongoing viewport changes can move focus to the nearest visible post.
- Floating action pill includes `Open`, `Save`, and `Hide`.
- After a posts-limit session ends, only previously viewed posts remain explorable; non-viewed posts are blocked, blurred, and non-clickable while general feed-side UI remains visible.

## What's New in 0.3.0

- Improved X permalink resolution so the `Open` action lands on the intended post more reliably.
- Added an optional distraction filter for X/Twitter chrome, including left-nav `Explore`, `Follow`, `Premium`, and most of the right rail while preserving Search.
- Added a `Bypass FocusDeck on Following` setting so X's `Following` tab can scroll normally while `For you` remains session-gated.
- Preserved paused-session state correctly when moving between `Following`, detail routes, and the managed feed.
- Improved tab-change detection for X's home timeline so bypass state updates more reliably.

## Screenshots

<p align="center">
  <img src="store/screenshots/4-session-start.png" alt="Start Session Prompt" width="45%">
  <img src="store/screenshots/2-blocked-posts.png" alt="Focused Post View" width="45%">
</p>
<p align="center">
  <img src="store/screenshots/3-daily-limit.png" alt="Daily Limit Reached" width="45%">
  <img src="store/screenshots/1-settings.png" alt="Settings Page" width="45%">
</p>

## Session and Route Handling

- Session start supports by-post limits (`10 / 20 / 30 / custom`).
- When total daily post limit is enabled, session post limit selection is capped by remaining posts for the day.
- Opening post details/thread/media pauses session automatically.
- Returning to feed resumes automatically and restores focus when possible.
- Leaving feed routes pauses session quietly.
- Posts-limit completion switches to viewed-only explore mode on the current feed while keeping feed-side UI visible.
- Daily limit reached shows a dedicated modal with `Close Feed` and `Settings` (`Close Feed` closes the active tab).
- Start-session and daily-limit blocking modals lock page scrolling until dismissed.

## Settings (Current)

Clicking the extension icon opens Settings directly (no popup).

Available settings:
- Theme: `System`, `Light mode`, `Dark mode`
- Distraction Filter: `Hide distracting elements`
- Total daily post limit (global, local-only, resets at local browser midnight)
- Following Feed: `Bypass FocusDeck on Following`
- Session maintenance actions: clear unfinished session, reset today's usage

## Safety and Policy Guardrails

- `Open`, `Save`, and `Hide` only run from explicit user gestures.
- `Save` and `Hide` actions are rate-limited (minimum 1 second between actions).
- No background automation, no bulk actions.
- No remote code loading.
- Core behavior does not require extension-owned network calls.
- Usage tracking is local-only (`storage.local`).

## Platform and Scope

- Primary: Chrome MV3
- Supported build target: Firefox (same codebase)
- Current content-script scope: `x.com` and `twitter.com` routes

Note: Adapter skeletons for HN/Reddit/LinkedIn are in-repo for future expansion, but the current version is X-focused.

## Tech Stack

- TypeScript
- Vite build pipeline
- `webextension-polyfill`
- Minimal dependencies

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Build bundles:

```bash
npm run build:chrome
npm run build:firefox
```

3. Load unpacked extension:
- Chrome: `chrome://extensions` -> Enable Developer Mode -> Load unpacked -> select `dist/chrome`
- Firefox: `about:debugging#/runtime/this-firefox` -> Load Temporary Add-on -> select `dist/firefox/manifest.json`

## Keyboard Shortcuts

- `J` / `ArrowDown`: next focused post
- `K` / `ArrowUp`: previous focused post
- `O`: open focused post in background tab (fallback: new tab)
- `S`: save/bookmark
- `X`: not interested

## Manual Test Checklist

- Feed is locked when no session is active.
- Start-session popover appears on X feed routes.
- Enabling `Hide distracting elements` removes non-essential X/Twitter chrome while keeping Search accessible.
- Enabling `Bypass FocusDeck on Following` lets the `Following` tab scroll freely without consuming session or daily-limit progress.
- Switching back from `Following` to `For you` restores paused sessions and daily-limit UI correctly.
- Promoted/ad units stay hidden across X/Twitter routes, including when no session is running.
- Only one focused post is visible during active session.
- Right sidebar modules are hidden on feed routes while feed focus UI is active.
- Start-session and daily-limit modals block wheel/touch/key scrolling until dismissed.
- Post counter increments only for feed progression (not detail/reply scrolling).
- Opening details pauses session and returning to feed resumes automatically.
- `Open` action pill button and `O` shortcut open the focused post in a background/new tab.
- Posts-limit completion keeps feed-side UI visible while only previously viewed posts remain explorable; blocked posts remain non-clickable.
- Daily limit modal shows expected actions and `Close Feed` closes the active tab.
- Extension icon opens Settings page directly.
- Chrome and Firefox unpacked builds load successfully.

## Documentation

- Architecture: `/docs/architecture.md`
- Privacy policy: `/docs/privacy-policy.md`

## Verification Commands

- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run release && npm run pack` (writes versioned ZIPs to `release/`)

Release scope since `v0.2.2` (`2026-02-28`):
- `cef7681` Fix X article post permalink resolution
- `77d7c39` Add X distraction hiding setting
- `b716219` Add Following feed bypass support

## Firefox Reviewer Build Instructions

Use this section for AMO source-code submission.

### Operating System / Build Environment

- macOS or Linux
- Node.js `22.x`
- npm `10+` (or npm bundled with Node 22)

### Install Requirements

```bash
node -v
npm -v
```

If needed, install Node.js from `https://nodejs.org/`.

### Reproducible Firefox Build Steps

```bash
npm ci
npm run release:firefox
```

### Build Script Used

- `release:firefox` -> `RELEASE=1 npm run build:firefox`
- `build:firefox` -> `tsx scripts/build.ts firefox`

### Expected Outputs

- `dist/firefox/manifest.json`
- `dist/firefox/content.js`
- `release/focusdeck-firefox-v0.3.0.zip` (if `npm run pack:firefox` is executed)

### Source Integrity

- Source files in this repository are human-readable (`.ts`, `.html`, `.css`).
- Generated/minified files are produced only during the build step into `dist/`.
