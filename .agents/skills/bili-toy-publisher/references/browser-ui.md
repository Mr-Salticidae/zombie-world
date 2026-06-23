# Browser UI Fallback

Use this when CLI publishing fails or when records, audit status, deletion, stats, or browser-only auth are needed.

## Official Pages

- Publish UI: https://www.bilibili.com/toy/publish
- Guide: https://www.bilibili.com/toy/publish/guide

## Current UI Behavior

Observed in the 2026-06-04 bundle:

- The app uses the public `api.bilibili.com` host with WBI middleware.
- Main API path family: `/x/sunflower/artifex`.
- Operations visible in the bundle:
  - `preview`
  - `create`
  - `update`
  - `mylist`
  - `delete`
  - `detail`
  - `stats`
  - `user/info`
- Chunk upload path family: `/x/sunflower/artifex/toy/upload`.
- The UI can ask for a "代理 C 端用户" UID and then fetch a user card. Select only after verifying the displayed UID/name.

The CLI publisher should use the public cookie endpoint first when the old intranet endpoint differs or is unreachable:

```text
https://api.bilibili.com/x/sunflower/artifex/toy/preview
https://api.bilibili.com/x/sunflower/artifex/toy/create
https://api.bilibili.com/x/sunflower/artifex/toy/update
```

Send `Cookie`, `csrf` from cookie key `bili_jct`, `Origin: https://www.bilibili.com`, and `Referer: https://www.bilibili.com/toy/publish`. Do not print the cookie or CSRF token. Do not hand-roll browser WBI signing unless the public cookie endpoint also fails and there is no viable script route. Browser UI already has the correct login, WBI, CSRF, and upload behavior.

## Create Flow

1. Open the publish UI.
2. Select or confirm the target user if prompted.
3. Fill slug/page address. Prefer stable lowercase hyphen-case.
4. Upload ZIP, HTML, or folder. For CLI-prepared packages, upload the static directory ZIP or folder containing `index.html`.
5. Select cover or upload local cover.
6. Confirm title.
7. Generate/check preview.
8. Show preview link to the user and wait for approval.
9. Click publish.
10. Record audit status and final URL.

## Update Flow

1. Open publish UI.
2. Switch to "发布记录".
3. Find the existing title/slug.
4. Click the update button for that record.
5. Do not delete/recreate unless changing slug is explicitly requested.
6. Upload new files, cover, or title as needed.
7. Preview and wait for user approval.
8. Submit update.
9. Record audit status and keep the same final URL.

## Troubleshooting

- If public URL is not live after publish/update, check audit state first.
- If the UI rejects ZIP structure, ensure `index.html` is at root or exactly one first-level folder.
- If preview is blank, run `toy_doctor.py` and inspect relative resource paths.
- If a slug conflict appears during create, ask for a new slug rather than overwriting.
- If update access is denied, verify the owner account and `toy.yaml` project ID.
