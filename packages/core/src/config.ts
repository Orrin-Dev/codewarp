/**
 * The collaboration server every copy of Codewarp talks to.
 *
 * >>> Set this to your VPS address. Use wss:// (TLS) for anything on the internet. <<<
 * See packages/server/README.md for how to put the server on the VPS.
 */
export const COLLAB_SERVER_URL = 'wss://collab.example.com';

/** While developing (`npm run dev`) the app talks to a server on this computer instead. */
export const COLLAB_DEV_SERVER_URL = 'ws://localhost:8787';
