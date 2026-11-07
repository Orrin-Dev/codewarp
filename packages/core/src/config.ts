/**
 * The collaboration server every copy of Codewarp talks to.
 *
 * This is the default. People can pick another server in the app under Settings > Collaboration server.
 * Use wss:// (TLS) for anything on the internet. See packages/server/README.md for hosting your own.
 */
export const COLLAB_SERVER_URL = 'wss://darknervps.duckdns.org/collab';

/** A server running on this computer (`npm run server`). Settings has a button that switches to it for testing. */
export const COLLAB_DEV_SERVER_URL = 'ws://localhost:8787';
