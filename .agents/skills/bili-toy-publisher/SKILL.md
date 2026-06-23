---
name: bili-toy-publisher
description: Safely prepare, preview, create, update, and troubleshoot Bilibili TOY static pages for UP creators. Use when the user asks to upload, publish, deploy, preview, update, "发到 toy", "上传 TOY", or package/check a local HTML, ZIP, folder, build output, report, or link-derived static page for Bilibili TOY; also use for toy.yaml maintenance, TOY slug/title/cover decisions, cookie or UID issues, preview links, audit status, final TOY URL verification, and TOY publish failures. Replaces older toy-link-report, toy-internal-kb, and bili-toy-publish workflows.
---

# Bilibili TOY Publisher

Use this as the single source of truth for TOY publishing. Do not use AppDeploy, Vercel, Netlify, Cloudflare, or generic web deploy tools when the target is TOY.

The skill has two jobs:

1. Prepare a TOY-safe static package.
2. Preview first, then create or update only after explicit user approval.

## Quick Decision

- If the user asks to publish, upload, deploy, preview, or update TOY: run the TOY workflow below.
- If the user provides a link and wants a TOY report: create the local static report first, then run this workflow.
- If the user only asks for a local page/package/check: stop after local validation and do not call publish APIs.
- If a project has `toy.yaml` with `id`: update that project and keep its URL.
- If no `toy.yaml` or no `id`: create a new TOY project.
- If an old intranet endpoint fails, differs from the current API, or is unreachable: use the public cookie API path in the bundled script before falling back to the browser UI.
- If the public script path fails because auth is browser-only or requires CAPTCHA state: use the official browser UI fallback, still preserving the preview-before-live gate.

## Non-Negotiable Safety Gates

Always:

- Generate or inspect a preview before create/update.
- Show the preview link and ask the user for explicit approval before create/update.
- Preserve `toy.yaml` so updates keep the same URL.
- Use the final URL with `/index.html`: `https://www.bilibili.com/toy/<slug>/index.html`.
- Verify the final URL or state clearly if it is still waiting for audit.
- Never print cookies or tokens.

Never:

- Trust a historical `uid` value from shell history, old cookie fields, or prior commands.
- Use a generic `uid=` cookie field as the Bilibili account UID.
- Change a published slug during update unless the user explicitly asks to delete/recreate.
- Upload source roots for framework projects when a static build output is required.
- Ship a page that obviously fails mobile layout, local asset loading, or hash navigation checks.

## Resolve Inputs

Resolve these from the user request, local files, `package.json`, `toy.yaml`, HTML metadata, or safe inference:

- `source`: local HTML file, ZIP file, static folder, or framework project root.
- `static_dir`: directory to upload; it must contain root `index.html` for script publishing.
- `title`: required for create; can default from `<title>`.
- `slug`: stable ASCII path segment, lowercase hyphen-case preferred. Official UI may generate one, but create flows should confirm it.
- `poster`: local cover image. Official guide supports `.png`, `.jpg`, `.jpeg`; prefer `assets/cover.png` at 4:3 for report/list-card quality.
- `id`: required for update, normally from `toy.yaml`.
- `owner_mid`: current Bilibili account UID from `DedeUserID`; informational in `toy.yaml`, not a trusted command default.

Use `toy.yaml`:

```yaml
id: 12345
slug: my-toy-slug
url: https://www.bilibili.com/toy/my-toy-slug/index.html
title: Human title
owner_mid: "254450574"
```

Place it in the framework project root for build projects, or in the static directory for direct HTML/CSS/JS projects. Exclude it from uploaded ZIPs.

## Package Rules

Official guide facts as of 2026-06-04:

- Upload accepts ZIP, HTML/HTM single files, or folders through the UI.
- ZIP root or a single first-level child directory must contain `index.html`.
- Vue/React/Vite/etc. projects should upload build output such as `dist`, not source.
- Static resources must work from `/toy/<slug>/`; prefer relative local paths such as `./assets/app.js`.
- Publishing and updating enter audit; live access may wait until approval.
- Published slug cannot be edited. Changing the path means deleting and recreating.
- ZIP size is recommended under 20 MB.
- URL hash positioning such as `page.html#section` is not supported; use JS `scrollIntoView`.

For details, read `references/official-guide-2026-06-04.md`.

## Local Checks

Before preview/create/update, run the bundled doctor:

```bash
# File/package check for preview or update.
python3 "$SKILL_DIR/scripts/toy_doctor.py" "$STATIC_DIR" --slug "$SLUG" --require-root-index

# Cover-required check for create or poster update.
python3 "$SKILL_DIR/scripts/toy_doctor.py" "$STATIC_DIR" --poster "$POSTER" --require-poster --slug "$SLUG" --require-root-index
```

Fix errors before upload. Treat warnings seriously when the TOY is a report or has outbound links.

Checks include:

- root `index.html`
- root-relative local resources such as `/assets/app.js`
- missing local assets
- native `href="#section"` and URL hash mutation
- risky direct external `href="https://..."`
- unsupported poster formats
- portrait or non-4:3 covers
- package size over 20 MB
- likely framework source roots

For link-derived reports, also ensure:

- a local `assets/cover.png` exists and is used by the page
- table-of-contents buttons use `data-target` and `scrollIntoView`
- outbound source links use `data-web-url` plus JS-mediated `window.open`
- mobile width around 390px has no horizontal overflow or cropped headline text

## Auth And UID

Use `~/.bilibili_cookie` by default, or `TOY_COOKIE_FILE` if set.

The UID rule is strict:

- Derive the publishing UID only from cookie key `DedeUserID`.
- If the user supplies a UID, compare it to `DedeUserID`; stop on mismatch.
- Ignore cookie key `uid`; it caused a real wrong-owner publish before.
- Show only safe identity confirmation such as `DedeUserID=254450574`; never show the full cookie.

If cookie is missing or expired, use the available local cookie connector or browser-login workflow to refresh it, then retry. If a UI asks for a "代理 C 端用户" UID, verify the returned user card before selecting it.

Read `references/known-failures.md` before debugging UID, cookie, or ownership issues.

## Script Publishing

Prefer the bundled script for repeatable CLI publishing:

```bash
SKILL_DIR="/Users/never/Documents/bilibili toy/.agents/skills/bili-toy-publisher"
"$SKILL_DIR/scripts/publish.sh" preview --dir "$STATIC_DIR" --uid auto
```

Create:

```bash
"$SKILL_DIR/scripts/publish.sh" create \
  --dir "$STATIC_DIR" \
  --title "$TITLE" \
  --slug "$SLUG" \
  --poster "$POSTER" \
  --uid auto
```

Update:

```bash
"$SKILL_DIR/scripts/publish.sh" update \
  --id "$ID" \
  --dir "$STATIC_DIR" \
  --title "$TITLE" \
  --poster "$POSTER" \
  --uid auto
```

Use `--uid auto` unless a user-supplied UID has been verified against `DedeUserID`. The script will infer and validate it.

The script defaults to the public cookie API:

```text
https://api.bilibili.com/x/sunflower/artifex/toy
```

Public API requests use `Cookie`, `bili_jct` as `csrf`, `Origin: https://www.bilibili.com`, and `Referer: https://www.bilibili.com/toy/publish`. This is the preferred path when the old intranet endpoint `https://sunflower.bilibili.co/api/toy` times out, returns a different schema, or is not reachable from the current network.

To force the legacy intranet endpoint only when needed:

```bash
TOY_API_MODE=internal "$SKILL_DIR/scripts/publish.sh" preview --dir "$STATIC_DIR" --uid auto
```

Script exit handling:

- `0`: success
- `1`: parameters, doctor checks, API business error, or UID mismatch
- `170`: cookie missing or empty
- `171`: cookie expired or API reports not logged in

For create success, parse project ID and URL from output, then update `toy.yaml`. For update success, preserve existing `id` and `slug`.

## Browser UI Fallback

Use the official UI when:

- the script endpoint fails because the API moved
- auth requires browser-only WBI or CAPTCHA state
- the user specifically wants the platform UI
- publish records, audit status, delete, or stats are needed

Open:

```text
https://www.bilibili.com/toy/publish
```

Follow the same gates: upload package, generate/inspect preview, show preview to user, wait for approval, then publish/update. For update, use "发布记录" and the update button for the existing record, not delete/recreate.

Read `references/browser-ui.md` before operating the UI or debugging API changes.

## Final Verification

After create/update:

- Record `id`, `slug`, `title`, `url`, `owner_mid`, and timestamp in `toy.yaml`.
- Share the explicit final URL: `https://www.bilibili.com/toy/<slug>/index.html`.
- Open and verify the final URL if audit has completed.
- If audit is pending, report the audit status and the preview link instead of claiming it is live.
- For pages with outbound links, click-test at least one published link and confirm it opens the real target, not `/toy/<slug>/https://...`.

## References

- `references/official-guide-2026-06-04.md`: official guide facts extracted from the current TOY publish guide.
- `references/known-failures.md`: local RCA and historical TOY publishing pitfalls.
- `references/browser-ui.md`: official publish UI/API behavior and fallback procedure.
