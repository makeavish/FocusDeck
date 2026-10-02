# FocusDeck — Store Listing Reference

> Use this file when filling out the Chrome Web Store and Firefox AMO submission forms.

---

## Extension Name

FocusDeck: Intentional Feed

## Short Description (≤132 characters)

See your X feed one post at a time. Pick how many posts to read, and the feed locks when you're done. Optional daily limit.

## Detailed Description

FocusDeck turns your X feed into a deliberate, one-post-at-a-time read. No infinite scroll.

**How it works**

• On the home feed, FocusDeck asks how many posts you want: 10, 20, 30, or a custom number. The feed stays hidden until you start.
• Only the focused post is visible, in X's own post UI. Move with J/K or the arrow keys.
• When you reach your number, the session ends. Posts you've seen stay readable; the rest are locked.
• An optional daily limit caps posts across all sessions and resets at local midnight.
• Opening a post, thread, or media pauses the session, and coming back resumes it. Reading replies doesn't count.
• Ads are always hidden. You can also hide X's right sidebar (Search stays) and Explore, Follow, and Premium.
• Optionally, let the Following tab scroll freely without counting toward your limits.

**What FocusDeck doesn't do**

• Replace X's post UI. Posts look exactly as they do on X.
• Act on its own. Open, Save, and Hide run only when you press them, and Save and Hide are limited to one per second.
• Load remote code or send data anywhere. Settings and counts stay in your browser's local storage.

**Settings**

Click the toolbar icon to open Settings. Set the daily limit and see today's count, hide distractions, let Following scroll freely, pick a theme (System, Light, or Dark), and clear an unfinished session.

**Keyboard shortcuts**

• J or ↓: next post
• K or ↑: previous post
• O: open the post in a background tab
• S: bookmark
• X: not interested

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
Stores session configuration, theme preference, daily limits and usage counters, and session snapshots locally. No data leaves the browser.

### `tabs`
Used for four purposes only:
1. When the user clicks the toolbar icon, FocusDeck queries open tabs to check if the Settings page is already open (to re-focus it rather than opening a duplicate).
2. The "Close tab" action in the daily-limit modal removes the current tab via `tabs.remove`.
3. The `Open` action opens the focused post in an inactive background tab via `tabs.create` (same window when available).
4. To resume an unfinished session only after its original tab has closed, FocusDeck checks which tab IDs are still open via `tabs.query`. Only numeric tab IDs are compared.

No browsing history, tab URLs, or other tab metadata is collected or stored.

### Host permissions (`*://*.x.com/*`, `*://*.twitter.com/*`)
Content scripts run only on X / Twitter pages to apply the focus layer, manage session state, and support user-initiated feed actions (Open, Save, Hide) using native page context.

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

\* FocusDeck counts posts viewed locally to enforce session and daily limits. These counters never leave the browser.

### Firefox Data Collection Permissions
`data_collection_permissions.required: ["none"]`

---

## Privacy Policy URL

`https://github.com/makeavish/FocusDeck/blob/main/docs/privacy-policy.md`

---

## Screenshots

Located in `store/screenshots/`:

| # | File | Shows |
|---|------|-------|
| 1 | `1-settings.png` | Settings page: daily limit with today's count, feed options, theme, and session data |
| 2 | `2-blocked-posts.png` | Active session: one focused post with the session counter and Open / Save / Hide bar |
| 3 | `3-daily-limit.png` | Daily limit dialog: posts viewed today with Close tab and Open settings |
| 4 | `4-session-start.png` | Session prompt: choose 10, 20, 30, or a custom number of posts |

Screenshots show the X feed with names, handles, and profile photos masked.

### Uploaded resolution
All screenshots in `store/screenshots/` are 1280×800.

---

## Support URL

GitHub Issues: `https://github.com/makeavish/FocusDeck/issues`

## Homepage URL

`https://github.com/makeavish/FocusDeck`
