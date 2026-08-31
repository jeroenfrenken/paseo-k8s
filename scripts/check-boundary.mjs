/**
 * The daemon compiles index.ts twice — once for the app, once for itself — and
 * refuses to pull a `.server` module into the app bundle. That failure only
 * surfaces when the plugin loads, so check it here instead.
 */
import { build } from "esbuild";

const boundary = {
  name: "paseo-plugin-boundary",
  setup(context) {
    context.onResolve({ filter: /\.server(?:\.[cm]?[jt]sx?)?$/ }, (args) => ({
      errors: [{ text: `server-only module reached the app bundle: ${args.path}` }],
    }));
    context.onResolve({ filter: /^node:/ }, (args) => ({
      errors: [{ text: `node builtin reached the app bundle: ${args.path}` }],
    }));
  },
};

const result = await build({
  entryPoints: ["main.client.tsx"],
  bundle: true,
  format: "cjs",
  platform: "neutral",
  target: "es2020",
  external: [
    "@getpaseo/plugin",
    "@getpaseo/plugin/server",
    "@tanstack/react-query",
    "react",
    "react/jsx-runtime",
    "react-native",
    "zod",
  ],
  plugins: [boundary],
  treeShaking: true,
  write: false,
  logLevel: "silent",
});

const size = (result.outputFiles[0].text.length / 1024).toFixed(1);
console.log(`app bundle builds clean (${size} KB), no server or node code leaked in`);
