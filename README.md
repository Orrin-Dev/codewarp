# Codewarp

A custom Scratch desktop app with two interchangeable coding modes (blocks and text), `.sb3` import/export, and, later, Scratch account linking, GitHub project storage, and real-time collaboration.

## Layout

```
codewarp/
  packages/core/      shared TypeScript: typed project model (sb3 JSON); later the text syntaxes
  apps/desktop/       Electron + Vite + TypeScript app
    electron/         main + preload (plain .cjs, no build step)
    src/vmHost.ts     scratch-vm + renderer + audio + storage
    src/blocksEditor.ts   scratch-blocks workspace wired to the VM
    src/toolbox.ts    the block palette
    src/main.ts       UI wiring: open/save, sprites, run, Blocks/Text toggle
```

The project JSON (`project.json` inside an `.sb3`) is the single source of truth. The blocks editor and the future C#-style and Python-style text syntaxes are all views of it.

## Run

```bash
npm install
npm run dev        # Vite + Electron
```

`npm run dev` also works in a plain browser at http://localhost:5173 (Open/Save fall back to a file picker and a download), which is handy for debugging in Firefox.

## Package (Linux)

```bash
npm run dist       # outputs AppImage, deb and rpm to apps/desktop/release/
```

Build the rpm on Fedora (`sudo dnf install rpm-build`). The deb and AppImage can come from the same machine or from GitHub Actions later.

## Known risks (this scaffold has not been run yet)

- **Package versions.** The Scratch packages are pinned to `latest` as placeholders. Pin real versions once `npm install` works. `scratch-vm` and `scratch-blocks` publish prerelease builds, and versions must be compatible with each other. Check which ones `scratch-gui` (or TurboWarp's forks) uses.
- **Vite + scratch-vm.** scratch-gui builds with webpack. If Vite chokes on `scratch-vm` or `scratch-render` (CommonJS, workers), first try the packages' prebuilt browser bundles, then fall back to webpack for the renderer.
- **Block labels.** If blocks render with missing or key-like labels, the scratch-blocks English messages aren't loaded; scratch-gui loads them through `scratch-l10n`.
- **Add sprite.** Creates a sprite with no costume; a real costume editor comes later.
- **Licensing.** `scratch-vm` and `scratch-render` are AGPL-3.0; `scratch-blocks` is Apache-2.0. Check the current license files before choosing your own license. Don't use the Scratch name, logo or cat.
- Scratch's cloud, login and project-hosting hooks are not included; Codewarp's account linking will replace them.

## Next

1. Get `npm run dev` running and fix whatever the first run turns up.
2. Fill out the palette and the stage/sprite targets (stage-specific blocks).
3. Costume and sound editing.
4. Text syntaxes (C#-flavored and Python-flavored) with a shared block table.
5. Account linking, GitHub storage, RTC (Yjs on your VPS).

## Releases

GitHub Actions builds the Linux packages (AppImage, deb, rpm) and puts them on the Releases page.

- **Production:** push a version tag. `git tag v0.2.0 && git push origin v0.2.0`. A tag with a dash (`v0.2.0-beta.1`) becomes a pre-release.
- **Dev:** every push to `main` replaces the pre-release called `dev` with a fresh build.
- Pull requests and other branches only run a typecheck and build (`ci.yml`).
- Commit `package-lock.json` so installs in CI match yours.
