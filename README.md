# Compress PDF

A local Figma Design plugin for exporting selected frames into one smaller PDF. Its panel follows Figma's native controls, typography, and light/dark theme colors.

## Try it in Figma

Use one checkout of this repository for both development and running the plugin in Figma. A GitHub checkout contains the source and dependency lockfile; `dist/` is generated locally and excluded from Git. Before importing the plugin, run these commands from the repository root:

```sh
npm ci
npm run build
```

1. Open **Figma Desktop** and a Design file.
2. Open **Plugins → Development → Import plugin from manifest** and select this repository's `manifest.json`.
3. Run **Compress PDF** from the Development menu.
4. Select frames in Figma, arrange their names, and export.

Import only the `manifest.json` at the repository root. It points to the compiled files in `dist/`. After changing source code, run `npm run build` in this repository and reopen the plugin; no copying or separate installation folder is needed.

This development manifest does not invent a plugin ID. Without a Figma-assigned ID, the plugin skips relaunch button registration and keeps settings for the current session. Adding a genuine ID enables the relaunch button and persistent preferences; publishing also requires a Figma-assigned ID.

## Workflow

**Figma frames:** select frames on the current page to see their names. Drag the names or use the arrows to set their order, choose compression, and export one PDF containing one tall page. Frames are stacked vertically, top to bottom, aligned at the left edge with no added gaps. Their size and aspect ratio are preserved. Automatic selection updates retain your manual order for frames still selected and append new frames. The list contains frame names only and updates when selection changes, including during export and compression. The active export uses the order captured when Export is clicked; new selections apply to the next export. Up to 300 frames can be exported. The plugin does not modify frames in Figma.

Drag the bottom-right corner of the plugin panel to resize its width and height. The frame list expands with the window. The handle also supports arrow keys (hold Shift for larger steps).

The result reports original and final sizes, percentage saved, image optimizations, and repeated resources. Sizes are measured against the single native Figma export of the same arranged stack. If optimization does not reduce that file, its exact native bytes are returned instead; a larger recompressed file is never delivered.

## Compression settings

| Preset | Image resolution ceiling | JPEG quality | Use |
|---|---:|---:|---|
| Balanced | 144 DPI | 82% | Screen viewing |
| Smallest | 96 DPI | 65% | Email and sharing |
| High quality | 300 DPI | 94% | Printing |
| Lossless | Original | No lossy encoding | Preserve image pixels |

Images are not upscaled. Placement analysis considers the largest image use, including nested Form XObjects. Uncertain placements retain their resolution. Images can retain more resolution than the ceiling when shared placements or different horizontal/vertical scales require it.

Advanced controls override image DPI and quality. Compression runs with the selected preset or custom settings. The panel has no target-size control.

## What stays sharp

The optimizer never renders a whole PDF page to a bitmap. It leaves text, paths, and other vector drawing instructions intact. Text that was already an outline stays outlined; text inside an image remains image content.

For multiple frames, the plugin clones the selected artwork into a temporary transparent frame, stacks the copies in the listed order, and exports the whole stack once with Figma's native PDF renderer. Shared fonts, photos and masks are therefore exported together rather than repeated in separate PDFs. Temporary copies are removed before compression, and also after cancellation or export errors. Original frames and their selection are preserved. A single selected frame is exported directly. The optimizer then compresses supported image XObjects, recompresses streams, shares identical resources, removes unreachable objects, and writes compressed object streams. Frame text remains native vector artwork; searchability is inherited from Figma's export.

Supported image optimization includes 8-bit RGB, grayscale, RGB ICC profiles, JPEG, unfiltered and Flate image streams, PNG/TIFF predictors, and supported grayscale soft masks. Flat artwork uses lossless image compression; photographic content can use JPEG. CMYK, spot/indexed color spaces, custom decode arrays, color-key masks, JPEG2000, CCITT, JBIG2, and other unsupported representations stay intact. No fonts are unembedded and no intentional document content is discarded.

This is an RGB-oriented compressor, not a PDF/X prepress converter or an OCR tool. The print preset retains more image resolution without creating print certifications.

## Limits

- Up to **200 MiB** for the native PDF and **300 frames**, combined on one page. The complete stack must fit within Figma’s 100,000 px frame dimension limit.
- Images above **40 megapixels** retain their current encoding.
- Unsupported images may limit savings. Already optimized or vector-heavy PDFs may shrink only slightly.
- Figma's own rendering limitations are inherited by frame exports.

The manifest declares `networkAccess.allowedDomains: ["none"]`. PDF compression libraries are bundled. The plugin has no PDF viewer or preview dependencies. Compression normally runs in a dedicated local background worker; hosts blocking blob workers use a local main-thread fallback. Cancel terminates the worker and leaves the source intact.

## Development

Requires Node.js 20.19+ and npm. Dependencies are locked.

```sh
npm ci
npm run verify
```

`npm run check` checks the Figma TypeScript entrypoint. `npm run build` updates this repository's `dist/` files, which Figma loads through the root manifest. `npm test` runs browser and PDF integration tests; the default browser is an installed Google Chrome, or set `CRISP_TEST_BROWSER` to a Chromium executable. Tests create temporary fixtures under ignored `work/qa/`.

Files:

- `src/code.ts`: Live Figma frame names, a single native stack export, temporary-copy cleanup, progress and cancellation.
- `src/engine.js`: Image optimization, resource de-duplication and PDF validation.
- `src/worker.js`: background processing.
- `src/ui.html`, `src/ui.js`: Figma-styled panel with live frame names and PDF download.
- `scripts/build.mjs`: bundles all runtime dependencies and validates emitted JavaScript syntax.
- `test/`: image, text, single-page stacking, links, transparency, worker, download, drag ordering, selection relays and message-contract tests.

The integration harness models Figma's parent/iframe message contract. Live frame names, selection changes during compression, a single-page export, and PDF rendering have also been verified in Figma Desktop.

## License notices

See `THIRD_PARTY_NOTICES.md`. Full library licenses are included in `dist/licenses/`.

## Compression research and regression coverage

The optimizer was evaluated against the official guidance for [Ghostscript pdfwrite](https://ghostscript.readthedocs.io/en/latest/VectorDevices.html), [qpdf file-size optimization](https://qpdf.readthedocs.io/en/stable/cli.html#optimizing-file-size), and [MuPDF clean](https://mupdf.readthedocs.io/en/latest/tools/mutool-clean.html). Ghostscript provides mature downsampling and duplicate-image handling but rebuilds drawing commands and can alter non-visual document features. qpdf offers content-preserving stream/object compression and optional JPEG re-encoding; it does not resample images. MuPDF can combine stream de-duplication and image subsampling, and its [official JavaScript binding](https://mupdfjs.readthedocs.io/en/latest/faq/index.html) runs through WebAssembly under AGPL or a commercial license. Neither Artifex engine is bundled into this plugin.

A real six-page Figma native export of 22,774,425 bytes was used during the October 2026 fix. The corrected browser engine produced 8,232,315 bytes (63.9% smaller), compared with a Ghostscript 144 DPI reference run of 7,508,357 bytes. A subsequent Figma Desktop export of the same six frames on one stacked page produced 8,307,754 bytes (8.31 MB) on one page, versus the earlier broken 50,638,162-byte result. All six stacked sections were visually compared with the native pages, and the PDF rendered without image errors. This new export is 63.5% smaller than the six-page native file; its same-layout native stack baseline was 33.4 MB, yielding 75.1% savings within the plugin. Those are measurements for this document, not guaranteed savings. Private user PDFs are excluded from the repository.

The regression fixes preserve grayscale soft masks, optimize an image and its resized mask together, share duplicate masks and ICC profiles before comparing photos, and allow vector-only Type 3 fonts during image-placement analysis. Complex Figma vector streams receive a bounded 16-million-token placement scan. An incomplete scan retains image resolution. Tests cover these cases plus cleanup on native export errors/cancellation and the rule that compressed output cannot exceed its native input.
