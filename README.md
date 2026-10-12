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
- **Long pages:** single frames and combined stacks use native PDF export without an arbitrary pixel-height limit. Frames retain their original size, vector artwork, and listed order.
- **Limits:** 300 frames and 200 MiB native PDF. Figma must be able to export the artwork; already optimized PDFs may shrink only slightly.

## Development

`npm run verify` runs checks, build, and tests (requires Google Chrome). Rebuild with `npm run build` after code changes.

Tests cover the Figma message flow, cancellation and retry, worker fallback, PDF drawing commands, transparency masks, image placement, and the output size guard.

[Third-party notices](THIRD_PARTY_NOTICES.md).
