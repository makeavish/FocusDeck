# FocusDeck: Intentional Feed

FocusDeck is a WebExtensions MV3 extension for X.com that makes feed browsing intentional.

## Extension Behavior

- Native X post UI is preserved (no custom post cards/decks).
- Feed access is session-gated; if no session is active, feed posts are hidden and a start-session popover is shown.
- During a session, only the focused post is visible; all other feed items are hidden.
- Right sidebar modules and promoted/ad feed units are hidden while on feed routes.
- Focused post is selected as the item nearest viewport center.
- Floating action pill includes `Save` and `Not interested`.
- After a posts-limit session ends, only previously viewed posts remain explorable; non-viewed posts are blocked, blurred, and non-clickable.

## Session and Route Handling

- Session start supports by-post limits (`10 / 20 / 30 / custom`).
- A legacy by-time mode (`5 / 10 / 15 / custom`) is still available in the start prompt for compatibility.
- When total daily post limit is enabled, session post limit selection is capped by remaining posts for the day.
- Opening post details/thread/media pauses session automatically.
- Returning to feed resumes automatically and restores focus when possible.
- Leaving feed routes pauses session quietly.
- Time-limit completion shows a non-blocking completion modal.
- Posts-limit completion switches to viewed-only explore mode on the current feed.
- Daily limit reached shows a dedicated modal with `Close Feed` and `Settings` (`Close Feed` closes the active tab).

## Settings (Current)

Clicking the extension icon opens Settings directly (no popup).

Available settings:
- Theme: `System`, `Light mode`, `Dark mode`
- Total daily post limit (global, local-only, resets at local browser midnight)
- Session maintenance actions: clear unfinished session, reset today's usage

## Safety and Policy Guardrails

- `Not interested` and `Save` only run from explicit user gestures.
- Actions are rate-limited (minimum 1 second between actions).
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
- `S`: save/bookmark
- `X`: not interested
- `Esc`: temporarily hide FocusDeck overlay controls

## Manual Test Checklist

- Feed is locked when no session is active.
- Start-session popover appears on X feed routes.
- Only one focused post is visible during active session.
- Right sidebar and promoted/ad units are hidden on feed routes.
- Post counter increments only for feed progression (not detail/reply scrolling).
- Opening details pauses session and returning to feed resumes automatically.
- Posts-limit completion only allows previously viewed posts; blocked posts remain non-clickable.
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
