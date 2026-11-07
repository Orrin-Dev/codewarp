# Codewarp collaboration server

A small relay for real-time collaboration: rooms, ordered block edits, host-to-newcomer project copy, and cursors.
It never reads project data, so it only needs `ws`.

## Run it

```bash
npm install            # from the repo root
npm run server         # listens on 0.0.0.0:8787 (override with PORT / HOST)
curl localhost:8787/health
```

Needs Node 22.18 or newer (it runs the TypeScript directly, no build step).

## Export for your VPS

```bash
npm run server:export    # creates packages/server/dist/codewarp-server-<version>.tar.gz
scp packages/server/dist/codewarp-server-*.tar.gz you@your-vps:~
```

The archive holds the server, a systemd unit, a Caddy example and install steps (see the README inside it).
After it is running, set its address once in `packages/core/src/config.ts` (`COLLAB_SERVER_URL`). The app uses
that address in release builds, and `ws://localhost:8787` during `npm run dev`.

## On your VPS (by hand)

Run it behind a TLS proxy so the app can use `wss://`. With Caddy this is the whole config:

```
collab.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Systemd unit (`/etc/systemd/system/codewarp-collab.service`), adjust the paths and user:

```
[Unit]
Description=Codewarp collaboration server
After=network.target

[Service]
WorkingDirectory=/opt/codewarp
Environment=PORT=8787 HOST=127.0.0.1
ExecStart=/usr/bin/node packages/server/src/server.ts
Restart=on-failure
User=codewarp

[Install]
WantedBy=multi-user.target
```

Then `sudo systemctl enable --now codewarp-collab`. In the app, join with `wss://collab.example.com`.

## Limits

12 people per room, 500 rooms, 64 MB per message (a project snapshot), 600 messages per second per person.
Anyone who knows a room name can join it, so use a hard-to-guess name until accounts are linked.
