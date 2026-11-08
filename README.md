# Codewarp

A custom desktop app for making Scratch projects, with two ways to code that you can switch between at any time: a text-based syntax and classic blocks.

> **Status: in development.** Everything below describes the goals of the project, not finished features. More features are coming.

## Features

### Two interchangeable coding modes
- A custom **text-based syntax** and the classic **block-based** editor.
- Switch between text and blocks at any time without losing or breaking your code.
- Export to **.sb3** and use your project on the Scratch website.

### Scratch account linking
- Link your Scratch account to share and edit your projects from inside the app.
- Your Scratch username is available to other features (for example, real-time collaboration).

### Open source, with GitHub project storage
- The app's code is public on GitHub.
- Sign in with GitHub to store your projects in a git repository that **you own**.

### Real-time collaboration (RTC)
- Work on a project together with others, live.
- See other people's mouse cursors, with everything kept in sync.
- Usernames come from each person's linked Scratch account.

## Getting started

Download the latest build from the [Releases](../../releases) page:

| File | For |
|---|---|
| `Codewarp-<version>-x86_64.AppImage` | Any Linux distribution. Make it executable (`chmod +x`) and run it. |
| `Codewarp-<version>-amd64.deb` | Debian, Ubuntu and relatives (`sudo apt install ./file.deb`). |
| `Codewarp-<version>-x86_64.rpm` | Fedora, openSUSE and relatives (`sudo dnf install ./file.rpm`). |
| `Codewarp-Setup-<version>-x64.exe` | Windows installer (choose the install folder, adds a Start menu entry). |
| `Codewarp-<version>-x64-portable.exe` | Windows portable version: no install, just run it. |
| `codewarp-server-<version>.tar.gz` | The collaboration server, only needed if you host your own (see below). |
| `SHA256SUMS.txt` | Checksums to verify the downloads. |

Numbered releases (`v1.2.3`) are the stable ones. The `dev` pre-release is rebuilt from the latest commit on every push to `main` and can be broken.

**Windows:** the `.exe` files are not code-signed, so Windows SmartScreen may say "Windows protected your PC". Choose **More info > Run anyway**. You can compare the file with `SHA256SUMS.txt` first (`certutil -hashfile <file> SHA256`).

### Settings

Open the **Settings** tab (top right of the editor) to:

- **Change the colours.** Pick a preset or set the accent, background, panel and text colours yourself.
- **Change the collaboration server.** The project server is the default. Enter another `ws://` or `wss://` address and press Save, use **Test connection** to check it, or press **Use default server** to go back. The change applies the next time you join a room.
- **Rooms.** Room names ignore capitals. The join window lists open rooms with a Join button. When you create a room you can give it a password (joiners get a popup asking for it) and hide it from the list.
- **Updates.** Check for updates now, or turn off automatic checks.
- **Frame rate.** Projects run at 60 fps by default; set 10 to 250 fps.
- **Scratch-style sprite area.** A lighter, Scratch-like sprite panel.
- **Diagnostics.** Errors and sync problems are recorded; copy them when reporting a bug.

The **backpack** (bottom of the Code tab) keeps scripts, costumes and sounds between projects. Drag a block stack onto it, or press the backpack button on a costume or sound; click an item to add it to the current sprite.

### Updates

Installed copies update themselves (AppImage, `.deb`, `.rpm` and the Windows installer; the portable `.exe` does not). A **dev** build follows the rolling `dev` release and a **production** build follows the latest numbered release, so what you download decides which one you start on. You can switch in **Settings > Updates > Update from**; the app then installs the newest build from that branch (this can mean going to a lower version number). The app checks a few seconds after it starts and every four hours, downloads the new version in the background and installs it when you close the app (or when you press Restart now). Packages need `pkexec` (polkit) to install, which every desktop Linux has.

## Contributing

Issues and pull requests are welcome. By contributing, you agree that your contributions are released under the same license as the project (see below).

## License

Codewarp is licensed under the
[Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License (CC BY-NC-SA 4.0)](https://creativecommons.org/licenses/by-nc-sa/4.0/).

In plain terms, you are free to **share** and **adapt** (edit, modify, build on) Codewarp, under these conditions:

- **Attribution**: you must give appropriate credit, link to the license, and indicate if you made changes.
- **NonCommercial**: you may **not** use Codewarp, or anything derived from it, for commercial purposes.
- **ShareAlike**: if you modify or build on Codewarp, you must distribute your version under this same license.

This summary is not a substitute for the license. See [LICENSE](LICENSE) for details.

## Disclaimer

Codewarp is an independent project. It is not affiliated with, endorsed by, or sponsored by the Scratch Foundation, the Scratch Team, or MIT. "Scratch" is a project of the Scratch Foundation, in collaboration with the Lifelong Kindergarten Group at the MIT Media Lab. It is available for free at <https://scratch.mit.edu>.

---

# Collaboration server setup

Real-time collaboration needs a small relay server. The app uses the project's server by default, so you only need this to **host your own**. The server only relays edits between people in the same room; it never stores projects.

**Requirements:** a Linux server with Node.js **22.18 or newer**, and a domain name pointing at it (for `wss://`, the encrypted connection the app needs on the internet).

## 1. Get the server

Download `codewarp-server-<version>.tar.gz` from the [Releases](../../releases) page and unpack it:

```bash
tar xzf codewarp-server-*.tar.gz
cd codewarp-server
```

(To build it yourself instead, run `npm run server:export` in a clone of the repository. The archive appears in `packages/server/dist/`.)

## 2. Run it on a VPS with systemd

```bash
# as root, or with sudo
useradd --system --home /opt/codewarp-server codewarp
mkdir -p /opt/codewarp-server
cp -r ./* /opt/codewarp-server/
cd /opt/codewarp-server
npm install --omit=dev
chown -R codewarp: /opt/codewarp-server
cp codewarp-collab.service /etc/systemd/system/
systemctl enable --now codewarp-collab
curl http://127.0.0.1:8787/health      # {"ok":true,"rooms":0}
```

The server listens on `127.0.0.1:8787`. Change `PORT` and `HOST` in the service file if you need to.

## 3. Add HTTPS with a reverse proxy

The app connects with `wss://`, so put a proxy with a certificate in front of the server.

**Caddy** (gets the certificate for you):

```
collab.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

**nginx**, on a domain you already serve (for example next to another site). Add this inside the existing `server { ... }` block that has `listen 443 ssl`:

```nginx
location = /collab {
    proxy_pass http://127.0.0.1:8787/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
location /collab/ {
    proxy_pass http://127.0.0.1:8787/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
```

Then run `nginx -t && systemctl reload nginx`. Check it with `curl https://your-domain/collab/health`. The address for the app is then `wss://your-domain/collab`.

Open only ports 80 and 443 in the firewall. The server itself does not need to be reachable from outside.

## 4. Point the app at it

In Codewarp, open **Settings > Collaboration server**, enter your address (for example `wss://collab.example.com`), press **Test connection**, then **Save**. Everyone who should join your rooms needs to set the same address.

To make your server the default in your own builds, change `COLLAB_SERVER_URL` in `packages/core/src/config.ts`.

## Hosting it in Pterodactyl

**Easiest: the egg.** Every release includes `egg-codewarp-collab.json`.

1. In the admin area go to Nests, pick a nest (or create one), choose Import Egg and upload the file.
2. Create a server from the egg and give it a port allocation. The `RELEASE` variable is `latest` (newest stable release) by default; set it to `dev` for the newest dev build, or a tag such as `v0.1.0` to pin a version. Reinstall the server to update it.
3. Start it. The console says "listening on". Then proxy your domain to the allocated port as in step 3 above (containers are usually reached on the Docker gateway address, for example `172.18.0.1:PORT`, rather than `127.0.0.1`).

**Without the egg:** use a generic Node.js egg (Node 22 image). Upload `server.ts`, `rtc.ts`, `index.js` and `package.json` from the archive, set *Main file* to `index.js` and *Additional Node packages* to `ws`. To update, upload the newer `server.ts` and `rtc.ts` over the old ones and restart.

## Limits

12 people per room, 500 rooms, 64 MB per message (a project snapshot), 600 messages per second per person. Anyone who knows a room name can join it, so use hard-to-guess room names until accounts are linked.

---

# Development

## Layout

```
codewarp/
  packages/core/        shared TypeScript: project model, sync protocol (rtc.ts), server address
  packages/server/      the collaboration server (plain Node, TypeScript run directly)
  packages/scratch-vm/  vendored scratch-vm, built with webpack
  apps/desktop/         Electron + Vite + TypeScript app
    electron/           main + preload (plain .cjs, no build step)
    src/vmHost.ts       scratch-vm + renderer + audio + storage
    src/blocksEditor.ts scratch-blocks workspace wired to the VM
    src/toolbox.ts      the block palettes (sprite and stage)
    src/menus.ts        dropdowns that list costumes, sounds and sprites
    src/spritePanel.ts  the sprite and stage selector
    src/collab.ts       real-time collaboration client
    src/settings*.ts    the Settings tab: colours and server address
    src/main.ts         UI wiring
```

The project JSON (`project.json` inside an `.sb3`) is the single source of truth. The blocks editor and the future text syntaxes are views of it.

## Requirements

- Node.js **22.18 or newer** and npm
- Git
- To build the rpm: `rpm-build` (`sudo dnf install rpm-build`; on Debian/Ubuntu `sudo apt install rpm`)

## Set up

```bash
git clone https://github.com/Orrin-Dev/codewarp.git
cd codewarp
HUSKY=0 npm install
(cd packages/scratch-vm && npx webpack)     # builds the vendored scratch-vm once
```

The webpack step may print warnings about `scratch-storage` and `scratch-render` for its demo page. They are harmless as long as `scratch-vm.js` is produced.

## Run

```bash
npm run dev          # Vite + Electron
```

`npm run dev` also works in a plain browser at http://localhost:5173 (Open and Save fall back to a file picker and a download), which is handy for debugging.

If port 5173 is already in use, a previous dev server is still running: `pkill -f vite`.

### Testing collaboration locally

```bash
npm run server       # the collaboration server on ws://localhost:8787
npm run dev          # in a second terminal
```

In the app open **Settings > Collaboration server** and press **Use this computer**. To try it with two people, start a second Electron window and join the same room name in both.

## Useful commands

| Command | What it does |
|---|---|
| `npm run dev` | Run the app with hot reload |
| `npm run build` | Production build of the app (`apps/desktop/dist`) |
| `npm run typecheck` | Typecheck core, desktop and server |
| `npm run dist` | Build the AppImage, deb and rpm into `apps/desktop/release/` |
| `npm run dist:win` | Build the Windows installer and portable `.exe` (run this on Windows) |
| `npm run server` | Run the collaboration server locally |
| `npm run server:export` | Build `packages/server/dist/codewarp-server-<version>.tar.gz` |

## Releases (GitHub Actions)

- **Production:** push a version tag, for example `git tag v0.2.0 && git push origin v0.2.0`. A tag with a dash (`v0.2.0-beta.1`) becomes a pre-release.
- **Dev:** every push to `main` replaces the pre-release called `dev` with a fresh build, numbered `<version>-dev.<run>`.
- Each release contains the AppImage, deb, rpm, the Windows installer and portable `.exe`, the collaboration server archive and `SHA256SUMS.txt`.
- The Linux and Windows builds run as separate jobs (`linux`, `windows`) and a final `publish` job uploads everything, so a release only appears when both succeeded.
- Pull requests and other branches only run a typecheck and build (`ci.yml`).
- Keep `version` in `apps/desktop/package.json` in step with your tags, and commit `package-lock.json` so installs in CI match yours.

Package names and the deb/rpm metadata (homepage, maintainer, icon) are in the `build` section of `apps/desktop/package.json`.

## Notes

- The Scratch packages must be compatible with each other. `scratch-vm` is vendored in `packages/scratch-vm`; `scratch-blocks` is pinned to 1.3.0 and loaded as classic `<script>` tags (Vite warns about this, harmlessly).
- `scratch-vm` and `scratch-render` are AGPL-3.0 and `scratch-blocks` is Apache-2.0. Check their licenses before redistributing. Don't use the Scratch name, logo or cat.
- Scratch's cloud, login and project-hosting hooks are not included. Account linking will replace them.

## Roadmap

1. Text syntaxes (C#-flavoured and Python-flavoured) with a shared block table.
2. Scratch account linking (replaces the typed name in collaboration).
3. GitHub project storage.
4. More palette work: extensions, and the remaining editor polish.
