# Compress PDF

Figma plugin for exporting selected frames, components, and instances to a smaller PDF while preserving vector text and artwork.

https://github.com/user-attachments/assets/ad06c311-1dfe-4fe4-932e-f706a923de3a

## Install

Requires **Figma Desktop**. The repository includes the ready-to-run plugin in `dist/`; Node.js and a build step are not needed to install it.

1. Download and extract the repository, or clone it from GitHub.
2. In a Figma Design file, choose **Plugins → Development → Import plugin from manifest**.
3. Select the root `manifest.json`, then run **Compress PDF**.

Keep `manifest.json` and the `dist` folder together. If you move the folder, reimport its manifest from the new location.

## Use

Run **Compress PDF**, select frames, components, or component instances, set their order, choose compression, and export.

- **Output:** one PDF file with a separate page for each selected frame, component, or instance, in the listed order.
- **Presets:** Balanced, Smallest, High quality, or Lossless. Custom DPI and quality are available. Image resolution is measured at the largest use of each shared image.
- **Local processing:** original frames stay unchanged. If compression does not reduce size, the native export is returned.
- **Vector compression:** large drawing streams are processed in bounded chunks. Balanced, Smallest, and High quality compact path coordinates with maximum page-space errors of 0.01, 0.02, and 0.001 PDF points respectively; text strings, colors, and transforms stay intact. Lossless preserves decoded drawing bytes.
- **Long pages:** each selected item uses native PDF export without an arbitrary pixel-height limit. Frames retain their original size, vector artwork, and listed order.
- **Limits:** 300 frames and 200 MiB native PDF. Figma must be able to export the artwork; already optimized PDFs may shrink only slightly.

## Development

Requires **Node.js 20.19+** and Google Chrome for browser tests.

```sh
npm ci
npm run verify
npm run check:distribution
```

Rebuild with `npm run build` after code changes and commit the updated `dist` files with the source. CI checks the code and tests, confirms the manifest's runtime files are tracked, and rejects bundles that differ from a fresh build.

Tests cover components and instances, page order and dimensions, large vector streams, transform-aware coordinate precision, the Figma message flow, cancellation and retry, worker fallback, PDF drawing commands, transparency masks, image placement, and the output size guard.

[Third-party notices](THIRD_PARTY_NOTICES.md).
