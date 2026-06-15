# Claude Code handoff: AVT HEIC upload support

## TL;DR

Add HEIC image upload support to the AVT frontend so iPhone photos (saved as HEIC by default) can be uploaded without manual conversion. Fendi uploaded 39 HEIC images directly to his AVT FACE IMAGES folder and the current pipeline rejects them at the file picker stage.

**Currently in-flight.** This was dispatched to a Claude Code session (`local_8b3d1c76-7633-454d-a225-25c0aa647be1`) at 2026-06-12 03:00 UTC. This markdown is the spec for traceability — the executor is already running.

## Scope

- **Target repo:** `fendifrost-dot/ai-video-tool` (the AVT repo, not the CC repo this file lives in).
- **Auth:** `gh` CLI auth — the PAT in `~/fendi-control-center/.git/config` is EXPIRED. `gh` CLI is the working fallback (confirmed by prior commits today: `1bc72d4`, `210fef2`, `a13b84e`, `86c7a22`).
- **Branch:** `main` (push directly, single-dev repo).
- **No Lovable chat for code.** Only `redeploy frontend from latest main and publish` after the push.
- **No backend / edge function changes.** This is purely frontend.

## The change — two surfaces

### 1. Update MIME-type allowlist

Find every `<input type="file" accept="...">` and every `react-dropzone` `useDropzone({ accept: { ... } })` configuration in `src/`. Add HEIC/HEIF.

```tsx
<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" />
```

The `.heic` and `.heif` file-extension hints matter because some browsers (notably Safari pre-17) report empty `type` for HEIC files — only the extension survives.

### 2. Add client-side HEIC → JPEG conversion before upload

Install:

```bash
npm install heic2any
```

In the upload handler (likely `src/components/upload/*` or wherever Canonical Base Image / Style Reference / Identity uploads happen), wrap files in a preprocessing step before they go to Supabase Storage:

```ts
import heic2any from "heic2any";

async function preprocessImage(file: File): Promise<File> {
  const isHeic =
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    file.name.toLowerCase().endsWith(".heic") ||
    file.name.toLowerCase().endsWith(".heif");

  if (!isHeic) return file;

  const blob = await heic2any({
    blob: file,
    toType: "image/jpeg",
    quality: 0.92,
  }) as Blob;

  const newName = file.name.replace(/\.heic$|\.heif$/i, ".jpg");
  return new File([blob], newName, { type: "image/jpeg" });
}
```

Call `preprocessImage` on every file BEFORE it goes to Supabase Storage upload. The rest of the pipeline (bucket name, `canonical_base_image_url` field, etc.) is unchanged because we're now uploading JPEGs.

## What NOT to change

- Don't touch any edge function / backend code. Pure frontend change.
- Don't touch the Supabase Storage bucket configuration. Existing bucket logic continues to work.
- Don't touch `applyFilmTreatment` or VLONE paths.
- Don't reformat adjacent lines.

## Test plan after push

1. In AVT Lovable chat (project `bd21b544-c7b8-4780-bdde-391ac9d4bfa8`), send EXACTLY: `redeploy frontend from latest main and publish`.
2. Wait for publish confirmation (~1-3 min).
3. Hard-refresh `https://aivideotool.lovable.app/`.
4. Pick a HEIC file from the `AVT FACE IMAGES` folder (now at `~/fendi-control-center/AVT FACE IMAGES/`).
5. Verify: file picker accepts the file (no "Invalid file type" error), small UI delay (~1-2s) for client-side conversion, file lands in Supabase Storage as a `.jpg`.

## Commit message

```
feat(avt): accept HEIC uploads with client-side JPEG conversion

iPhones save photos as HEIC by default, but Supabase Storage and the
downstream Fal face-swap models expect JPEG. The previous upload UI
rejected HEIC at the file picker stage. This change:

- Adds .heic/.heif/image/heic/image/heif to the accept allowlist
- Converts HEIC -> JPEG in the browser via heic2any before upload
- Renames the file to .jpg so the rest of the pipeline is unchanged

Quality 0.92 to balance file size vs identity preservation for face-
swap inputs.
```

## Hard rules

- NO Lovable chat for code edits. Lovable chat is only for `redeploy frontend from latest main and publish` after the push.
- Push to `main` directly.
- Use `gh` CLI auth (PAT expired).
- Match existing code style.
