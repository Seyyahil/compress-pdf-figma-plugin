# Compress PDF

Figma plugin for exporting selected frames to a smaller size PDF while preserving vector text and artwork.

https://github.com/user-attachments/assets/ad06c311-1dfe-4fe4-932e-f706a923de3a

## Install

Requires **Figma Desktop** and **Node.js 20.19+**.

```sh
git clone https://github.com/Seyyahil/compress-pdf-figma-plugin.git
cd compress-pdf-figma-plugin
npm ci
npm run build
```

In a Figma Design file, choose **Plugins → Development → Import plugin from manifest** and select the root `manifest.json`.

## Use

Run **Compress PDF**, select frames, set their order, choose compression, and export.

- **Output:** one PDF page with frames stacked vertically.
- **Presets:** Balanced, Smallest, High quality, or Lossless. Custom DPI and quality are available.
- **Local processing:** original frames stay unchanged. If compression does not reduce size, the native export is returned.
- **Limits:** 300 frames, 200 MiB native PDF, and 100,000 px per stack dimension. Already optimized PDFs may shrink only slightly.

## Development

`npm run verify` runs checks, build, and tests (requires Google Chrome). Rebuild with `npm run build` after code changes.

[Third-party notices](THIRD_PARTY_NOTICES.md).
