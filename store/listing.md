# FocusDeck — Store Listing Reference

> Use this file when filling out the Chrome Web Store and Firefox AMO submission forms.

---

## Extension Name

FocusDeck: Intentional Feed

## Short Description (≤132 characters)

Keep native feed UI while adding subtle focus sessions and user-initiated actions.

## Detailed Description

FocusDeck turns your X / Twitter feed into a deliberate, one-post-at-a-time experience — no infinite scroll, no distractions.

**How it works**

• Feed access is gated behind an explicit session start — no surprise changes when you load the page.
• During a session, only the focused post is visible. Navigate with J/K or arrow keys.
• After your post limit (10 / 20 / 30 / custom), the session ends and only previously viewed posts remain accessible. Non-viewed posts are blocked.
• A total daily post limit (optional) enforces a hard cap, resetting at midnight local time.
• Actions like Save and Not Interested are triggered only by explicit user gestures and are rate-limited.

**What FocusDeck does NOT do**

• No custom post cards — the native X post UI is preserved exactly as-is.
• No background automation or bulk actions.
• No remote code loading.
• No cloud sync or server-side analytics. All data stays in your browser's local storage.

**Settings**

Click the extension icon to open Settings directly. Choose theme (System / Light / Dark), manage session data, and configure the total daily post limit.

**Keyboard shortcuts**

• J / ↓ — next post
• K / ↑ — previous post
• S — save / bookmark
• X — not interested
• Esc — toggle overlay controls
• Ctrl+Shift+. (Cmd+Shift+. on Mac) — start session from any X page

---

## Category

**Chrome Web Store:** Productivity
**Firefox AMO:** Privacy & Security (or Productivity if available)

## Tags

focus, productivity, digital wellbeing, screen time, feed control, intentional browsing

---

## Single Purpose Description

> Required by Chrome Web Store. This justifies the extension's access patterns.

FocusDeck has a single purpose: to gate X / Twitter feed access behind explicit focus sessions so users view posts intentionally rather than through infinite scrolling.

The extension does not use a browser-action popup because clicking the toolbar icon opens the full Settings page — the same experience Chrome provides via the context-menu "Options" entry. This avoids duplicating UI and gives users a richer settings surface (theme control, daily limit configuration, session data management) that would not fit in a small popup frame.

---

## Permission Justifications

### `storage`
Stores session configuration, theme preference, daily usage counters, and session snapshots locally. No data leaves the browser.

### `activeTab`
Required to inject the content script that manages focus sessions on the active X / Twitter tab.

### `tabs`
Used for two purposes only:
1. When the user clicks the toolbar icon, FocusDeck queries open tabs to check if the Settings page is already open (to re-focus it rather than opening a duplicate).
2. The "Close Feed" action in the daily-limit modal removes the current tab via `tabs.remove`.

No browsing history, tab URLs, or other tab metadata is collected or stored.

### Host permissions (`*://*.x.com/*`, `*://*.twitter.com/*`)
Content scripts run only on X / Twitter pages to apply the focus layer, manage session state, and execute user-initiated Save / Not Interested actions through native UI interaction.

---

## Privacy Practices

### Data Use Disclosures (Chrome Web Store)

| Question | Answer |
|----------|--------|
| Does the extension collect personally identifiable information? | No |
| Does the extension collect health information? | No |
| Does the extension collect financial and payment information? | No |
| Does the extension collect authentication information? | No |
| Does the extension collect personal communications? | No |
| Does the extension collect location data? | No |
| Does the extension collect web history? | No |
| Does the extension collect user activity? | No* |
| Does the extension collect website content? | No |

\* FocusDeck counts posts viewed and active minutes locally to enforce session and daily limits. These counters never leave the browser.

### Firefox Data Collection Permissions
`data_collection_permissions.required: ["none"]`

---

## Privacy Policy URL

> Host the file at `docs/privacy-policy.md` as a public URL before submission.
> Options:
> - GitHub raw URL: `https://raw.githubusercontent.com/makeavish/FocusDeck/main/docs/privacy-policy.md`
> - GitHub Pages or personal site: `https://vishal.wtf/focusdeck/privacy`

---

## Screenshots

Located in `store/screenshots/`:

| # | File | Shows |
|---|------|-------|
| 1 | `1-settings.png` | Settings page — General tab with theme selector and session data controls |
| 2 | `2-blocked-posts.png` | Post-limit explore mode — viewed post visible, non-viewed posts blocked |
| 3 | `3-daily-limit.png` | Daily limit modal — usage summary with Close Feed and Settings actions |

All screenshots use demo / placeholder content with no real user data.

### Recommended resolution
Chrome Web Store: 1280×800 or 640×400
Firefox AMO: 1280×800

> You may need to resize the generated screenshots to match these exact dimensions before uploading.

---

## Support URL

GitHub Issues: `https://github.com/makeavish/FocusDeck/issues`

## Homepage URL

`https://github.com/makeavish/FocusDeck`
