# Outlook 2.1.5 acceptance — 2026-10-19

Source commit: `964912570f3d9797d6f0fb3c26a1dcfc72d83fef`.
Release-format package: `/tmp/outlook-mail-2.1.5.cindy`, SHA-256
`721618c62b1d9dd1a68300a0bf4b6bf3a934159b395d287b1a9afc9a6e4782db`.

## Actual Cindy Beta

Cindy 0.1.111 Beta, macOS, existing desktop installation. Forge validated,
packaged and installed 2.1.5 from the source worktree. The installed plugin detail
page explicitly displays 2.1.5 with the new icon and React/Radix settings UI.
This is distinct from the catalog's 2.1.2 detail page; the installed list also
contains an older local copy. No catalog replacement or uninstall was performed.

Verified through actual desktop UI:

- Global service displays Add mailbox and keeps application setup optional.
- The service menu matches its trigger width and is not clipped by the settings
  card. Selection and saved Default badge are distinct.
- Selecting China reveals required Client ID, the `53688` callback and Azure
  China registration link; it retains the connected global mailbox.
- Switching back to global restores the direct connection path.
- More settings opens; Connection application opens; Cancel returns to the
  collapsed application section. The mailbox menu opens without reflowing its row.
- An existing mailbox remains connected. A read-only `outlook_accounts` profile
  lookup succeeded against Graph. No mail was sent, changed or deleted.
- Actual screenshots were cropped to the plugin detail area and the mailbox
  identity was redacted before being committed.

Actual screenshots:
[default](screenshots/outlook-cindy-beta-default.png),
[service menu](screenshots/outlook-cindy-beta-menu.png).

Limitations: only the current dark desktop theme was inspected in Cindy itself.
Light theme and narrow widths below were tested in desktop Chrome using simulated
Host APIs. A new Microsoft sign-in, China enterprise authorization and destructive
account actions were not performed on the real account. Forge repackages the
source; the separately generated release-format archive's exact SHA was not
installed through the file picker. The broad PR device checkbox remains unchecked.

## Reproducible browser verification

`settings-browser.mjs`, headed local desktop Chrome, synthetic `example.test`
accounts, same-origin CSP, and Cindy's actual auto-height/width constraints:

- 40 layouts: 280/320/360/460/720 px × zh-CN/en/ja/ko × light/dark.
- Visible control bounds, menu width, vertical clipping, long addresses,
  account-menu row stability, China setup and ordinary same-page links.
- Keyboard selection/Escape/focus return, transient service vs persisted default,
  failed saves preserving drafts, cancellation, duplicate-submit guard, clear-app
  fallback, four accounts across two services, per-service default/reconnect/
  disconnect isolation, failed disconnect, loading recovery, XSS and locale fallback.

All passed. Repository contract/localization/provisioning/publish-workflow and
Outlook tests: 73 passed, 0 failed. Manifest validation, bundle syntax and
release-format packaging passed. No new Host permissions or credential paths.
