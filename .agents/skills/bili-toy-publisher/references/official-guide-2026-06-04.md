# Official TOY Guide Snapshot

Source: https://www.bilibili.com/toy/publish/guide

Snapshot method: the page shell loaded `//s1.hdslb.com/bfs/static/toy/app/publish/assets/index-Djdx81QJ.js`, last modified 2026-06-02. The guide content below was extracted from that bundle on 2026-06-04.

## Publish Flow

1. Fill the page address. The platform can generate a random path, or the publisher can customize it. Final form: `https://www.bilibili.com/toy/<path>`.
2. Upload a file. Supported UI modes: drag ZIP, drag HTML, or select a folder. A ZIP must contain `index.html` as the entry file.
3. Select a cover. After ZIP upload, the platform extracts images from the package as cover candidates; a separate cover upload is also allowed.
4. Fill the title. If HTML contains a `<title>` tag, the platform can use it as the default title.
5. Click publish. Submission enters audit and goes online after approval.

## File Structure

Recommended ZIP structure:

```text
my-project.zip
├── index.html
├── style.css
├── script.js
└── images/
    ├── logo.png
    └── banner.jpg
```

## FAQ Facts

- White screen after publish is usually caused by absolute CSS/JS paths such as `/assets/style.css`; pages run under `/toy/<path>/`, so use `./assets/style.css` or configure the bundler with a relative base such as Vite `base: "./"`.
- The platform rewrites relative `<a href>` paths to absolute paths, but dynamic links and JavaScript redirects may not be rewritten. For page-to-page navigation, use complete URLs; for JS redirects, construct complete paths.
- Published content is not always immediately live because publish and update require audit.
- Audit statuses include waiting/auditing, published, rejected with reason, and timeout.
- Update an existing project from publish records with the update button. Updates can upload new files, change cover, or modify title, and also enter audit.
- ZIP root or one first-level subdirectory must contain `index.html`.
- Upload supports `.zip`, `.html`, `.htm`, and folder selection. Cover supports `.png`, `.jpg`, `.jpeg`.
- A published page address/slug cannot be edited. Changing it requires deleting the project and publishing again.
- ZIP files are recommended under 20 MB.
- URL hash positioning such as `page.html#section` is unsupported. Use JavaScript such as `document.getElementById(...).scrollIntoView(...)` for in-page jumps.
- For Vue/React/framework projects, upload the build output such as `dist`; do not upload source. Build first and ensure the output contains `index.html`.

## How This Changes Skill Behavior

- Build projects must be exported to static output first.
- The skill should stop on root-relative resources before upload.
- The skill should not promise immediate public access after publish; audit may delay it.
- The skill should preserve slugs on update.
- The skill should use JavaScript in-page navigation instead of hash anchors.
