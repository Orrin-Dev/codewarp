// Regenerates egg-codewarp-collab.json:  node packages/server/pterodactyl/gen.mjs
import { writeFileSync } from 'node:fs';

const install = `#!/bin/bash
# Codewarp collaboration server installer
apt-get update -y && apt-get install -y curl tar ca-certificates
mkdir -p /mnt/server
cd /mnt/server

if [ "\${RELEASE}" = "latest" ] || [ -z "\${RELEASE}" ]; then
  URL=$(curl -fsSL https://api.github.com/repos/Orrin-Dev/codewarp/releases/latest | grep browser_download_url | grep 'codewarp-server-.*\\.tar\\.gz' | head -n 1 | cut -d '"' -f 4)
else
  URL="https://github.com/Orrin-Dev/codewarp/releases/download/\${RELEASE}/codewarp-server-\${RELEASE#v}.tar.gz"
fi

if [ -z "\${URL}" ]; then
  echo "Could not find a codewarp-server archive. Set RELEASE to a tag such as v0.1.0."
  exit 1
fi

echo "Downloading \${URL}"
curl -fsSL -o server.tar.gz "\${URL}"
tar -xzf server.tar.gz --strip-components=1
rm -f server.tar.gz
ls -la
echo "Install complete."
`;

const egg = {
  _comment: 'Codewarp collaboration server. Import under Admin > Nests > Import Egg.',
  meta: { version: 'PTDL_v2', update_url: null },
  exported_at: new Date().toISOString(),
  name: 'Codewarp Collab Server',
  author: 'voiddev3d@gmail.com',
  description: 'Real-time collaboration relay for the Codewarp Scratch editor.',
  features: null,
  docker_images: { 'Node.js 22': 'ghcr.io/parkervcp/yolks:nodejs_22' },
  file_denylist: [],
  startup: '[ -d node_modules/ws ] || npm install --omit=dev --no-audit --no-fund; node index.js',
  config: {
    files: '{}',
    startup: '{"done": "listening on"}',
    logs: '{}',
    stop: '^C',
  },
  scripts: {
    installation: {
      script: install,
      container: 'ghcr.io/parkervcp/installers:debian',
      entrypoint: 'bash',
    },
  },
  variables: [
    {
      name: 'Release',
      description: 'The release tag to install (for example v0.1.0), or "latest". Reinstall the server to update.',
      env_variable: 'RELEASE',
      default_value: 'latest',
      user_viewable: true,
      user_editable: true,
      rules: 'required|string|max:40',
      field_type: 'text',
    },
    {
      name: 'Max rooms',
      description: 'How many collaboration rooms can exist at once.',
      env_variable: 'MAX_ROOMS',
      default_value: '500',
      user_viewable: true,
      user_editable: true,
      rules: 'required|integer|min:1|max:10000',
      field_type: 'text',
    },
  ],
};
writeFileSync(new URL('./egg-codewarp-collab.json', import.meta.url), JSON.stringify(egg, null, 2) + '\n');
