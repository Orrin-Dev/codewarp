import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// Relative base so the built app loads over file:// inside Electron.
export default defineConfig({
  base: './',
  define: {
    // Some Scratch packages expect a Node-style global.
    global: 'globalThis',
  },
  plugins: [
    // The Scratch packages were written for webpack 4, which auto-polyfilled Node
    // built-ins (events, buffer, stream, ...). Vite doesn't, so add them back.
    nodePolyfills({ globals: { global: true, process: true, Buffer: true } }),
    viteStaticCopy({
      targets: [
        // scratch-blocks loads block icons/sounds from a media folder at runtime.
        { src: '../../node_modules/scratch-blocks/media/*', dest: 'blocks-media' },
        // scratch-blocks is loaded as classic <script> tags (see index.html). Its npm "browser"
        // entry (shim/vertical.js) exports nothing under Vite, but the compressed files below
        // define the global `Blockly` when run as plain scripts.
        { src: '../../node_modules/scratch-blocks/blockly_compressed_vertical.js', dest: 'scratch-blocks' },
        { src: '../../node_modules/scratch-blocks/blocks_compressed.js', dest: 'scratch-blocks' },
        { src: '../../node_modules/scratch-blocks/blocks_compressed_vertical.js', dest: 'scratch-blocks' },
        { src: '../../node_modules/scratch-blocks/msg/*.js', dest: 'scratch-blocks/msg' },
      ],
    }),
  ],
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});