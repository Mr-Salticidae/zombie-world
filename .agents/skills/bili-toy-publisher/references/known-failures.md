# Known TOY Publishing Failures

Use this reference when debugging publish failures, wrong ownership, broken links, covers, or update confusion.

## Wrong UID / Wrong Owner

Local RCA: `/Users/never/Documents/bilibili toy/toy-wrong-uid-rca.md`.

The incident:

- Cookie user was `DedeUserID=254450574`.
- Request used `uid=21704`.
- The project was created under the wrong owner because the legacy API accepted query `uid`.
- The bad UID came from an old ordinary cookie field named `uid`, not the Bilibili account UID.

Hard rules:

- Use only `DedeUserID` as the publish UID.
- Never infer UID from a cookie key named `uid`.
- If `--uid` and `DedeUserID` differ, stop before network request.
- Do not save historical UID as a trusted default in `toy.yaml`.

## Intranet API Drift Or Network Failure

Symptoms:

- `sunflower.bilibili.co` times out, returns TLS errors, or is only reachable from a different network.
- The old intranet endpoint returns a different schema from the current publishing UI.
- The local system proxy can reach `api.bilibili.com` but not the intranet TOY API.

Fix:

- Use the public cookie API first: `https://api.bilibili.com/x/sunflower/artifex/toy/...`.
- Include the full `Cookie` header, `csrf` from cookie key `bili_jct`, `Origin: https://www.bilibili.com`, and `Referer: https://www.bilibili.com/toy/publish`.
- For create, send `title`, `sub_dir`, `file`, `poster`, and `csrf`.
- For update, send `id`, optional `title`, optional `file`, optional `poster`, and `csrf`.
- Never print Cookie or CSRF values.

The bundled `publish.sh` defaults to this public cookie path. Use `TOY_API_MODE=internal` only when intentionally targeting the legacy intranet endpoint.

## Absolute Resource Paths

Symptoms:

- White page after publish.
- CSS or JS 404.
- Images missing only on the TOY URL.

Cause:

- The page lives under `/toy/<slug>/`, so `/assets/app.js` resolves to the Bilibili site root, not the TOY package.

Fix:

- Use `./assets/app.js`, `assets/app.js`, or a bundler relative base.
- Vite: `base: "./"`.
- Webpack: `output.publicPath = "./"`.
- Vue CLI: `publicPath: "./"`.
- CRA: `"homepage": "."`.

## Hash Navigation

Symptoms:

- `#section` links do not navigate correctly.
- Directory or object-storage keys return `NoSuchKey`.

Fix:

- Replace `<a href="#section">` with buttons or links carrying `data-target`.
- Use `document.getElementById(id).scrollIntoView({ behavior: "smooth", block: "start" })`.
- Avoid `location.hash`, `history.pushState`, and `history.replaceState` for in-page TOY navigation.

## External Link Rewriting

Observed issue:

- Direct external `href="https://..."` in some published TOY pages opened as `https://www.bilibili.com/toy/<slug>/https://...`.

Conservative fix for reports/source cards:

```html
<a href="javascript:void(0)" data-web-url="https://www.bilibili.com/opus/...">source</a>
```

```js
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-web-url]");
  if (!link) return;
  event.preventDefault();
  window.open(link.dataset.webUrl, "_blank", "noopener,noreferrer");
});
```

After publish, click-test at least one external link.

## Directory URL

Share `https://www.bilibili.com/toy/<slug>/index.html`, not only `https://www.bilibili.com/toy/<slug>/`. Directory fallback is not guaranteed.

## Cover Problems

Known issues:

- Portrait covers can look overly tall or cropped in list cards and report heroes.
- Remote cover hotlinks can fail or look generic.

Preferred report cover:

- Local `assets/cover.png`.
- 4:3 landscape, ideally `1200x900`.
- Use the same local cover in page metadata and upload poster.

Official UI cover formats: `.png`, `.jpg`, `.jpeg`.

## toy.yaml Drift

Issues:

- `toy.yaml` missing causes accidental create instead of update.
- `toy.yaml` in the wrong directory causes the skill to miss project identity.
- Uploading `toy.yaml` with static files leaks internal project metadata into the package.

Rules:

- Framework project: keep `toy.yaml` in project root.
- Direct static project: keep `toy.yaml` in the static directory, but exclude it from upload ZIPs.
- On create success, write `id`, `slug`, `url`, `title`, and informational `owner_mid`.
- On update, preserve existing `id` and `slug`.

## Script/Doc Drift

Older notes referenced paths such as `scripts/check-toy-static.py` that did not exist in the publishing plugin. This skill bundles its own checked scripts:

- `scripts/toy_doctor.py`
- `scripts/publish.sh`

Use scripts relative to this skill directory, not a marketplace cache path.
