// Builds a folder and .tar.gz you can copy to the VPS and run there: node dist/codewarp-server/server.ts
// Usage: npm run server:export
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..');
const out = join(pkgDir, 'dist');
const name = 'codewarp-server';
const folder = join(out, name);

rmSync(out, { recursive: true, force: true });
mkdirSync(folder, { recursive: true });

// The server imports the shared protocol from the monorepo. In the export both files sit side by side.
let server = readFileSync(join(pkgDir, 'src', 'server.ts'), 'utf8');
server = server.replaceAll("'../../core/src/rtc.ts'", "'./rtc.ts'");
if (server.includes('core/src')) throw new Error('Export left a monorepo import in server.ts');
writeFileSync(join(folder, 'server.ts'), server);
cpSync(join(pkgDir, '..', 'core', 'src', 'rtc.ts'), join(folder, 'rtc.ts'));

const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
writeFileSync(
  join(folder, 'package.json'),
  JSON.stringify(
    {
      name,
      version,
      private: true,
      type: 'module',
      scripts: { start: 'node server.ts' },
      dependencies: { ws: '^8.18.0' },
      engines: { node: '>=22.18' },
    },
    null,
    2,
  ) + '\n',
);

writeFileSync(
  join(folder, 'codewarp-collab.service'),
  `[Unit]
Description=Codewarp collaboration server
After=network.target

[Service]
WorkingDirectory=/opt/codewarp-server
Environment=PORT=8787 HOST=127.0.0.1
ExecStart=/usr/bin/node server.ts
Restart=always
RestartSec=2
User=codewarp
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`,
);

writeFileSync(
  join(folder, 'Caddyfile.example'),
  `# Replace with your own domain. Caddy gets the certificate for you; the app then uses wss://collab.example.com
collab.example.com {
    reverse_proxy 127.0.0.1:8787
}
`,
);

writeFileSync(
  join(folder, 'README.md'),
  `# Codewarp collaboration server

Needs Node 22.18 or newer.

\`\`\`bash
# on the VPS (as root or with sudo)
useradd --system --home /opt/codewarp-server codewarp
mkdir -p /opt/codewarp-server && cd /opt/codewarp-server
# copy this folder's files here (scp -r codewarp-server/* you@vps:/opt/codewarp-server/), then:
npm install --omit=dev
chown -R codewarp: /opt/codewarp-server
cp codewarp-collab.service /etc/systemd/system/
systemctl enable --now codewarp-collab
curl http://127.0.0.1:8787/health      # {"ok":true,...}
\`\`\`

Put a TLS proxy in front (see Caddyfile.example) and set that address in the app (packages/core/src/config.ts).
Open only ports 80 and 443 in the firewall; the server itself listens on 127.0.0.1.
`,
);

const tarball = join(out, `${name}-${version}.tar.gz`);
execFileSync('tar', ['-czf', tarball, '-C', out, name]);
console.log(`Server exported to ${folder}\nArchive: ${tarball}`);
