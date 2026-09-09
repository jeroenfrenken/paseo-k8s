/**
 * v0.8 compiles the two entries separately and enforces the runtime boundary:
 * the client bundle may not reach `server/` or any node: builtin, and the
 * server bundle may not reach `client/`. Those failures only surface when the
 * plugin loads, so check both here.
 */
import { build } from "esbuild";

const SHARED_EXTERNAL = [
  "@getpaseo/plugin",
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/react-native",
  "@getpaseo/plugin/client/ui",
  "@getpaseo/plugin/server",
  "zod",
];

function forbid(rules) {
  return {
    name: "paseo-plugin-boundary",
    setup(context) {
      for (const [filter, message] of rules) {
        context.onResolve({ filter }, (args) => ({ errors: [{ text: `${message}: ${args.path}` }] }));
      }
    },
  };
}

async function check({ entry, platform, external, rules }) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform,
    target: platform === "node" ? "node20" : "es2020",
    external,
    plugins: [forbid(rules)],
    treeShaking: true,
    write: false,
    logLevel: "silent",
  });
  const size = (result.outputFiles[0].text.length / 1024).toFixed(1);
  console.log(`${entry} builds clean (${size} KB)`);
}

await check({
  entry: "index.client.tsx",
  platform: "neutral",
  external: [...SHARED_EXTERNAL, "@tanstack/react-query", "react", "react/jsx-runtime", "react-native"],
  rules: [
    [/(^|\/)server\//, "server-only module reached the client bundle"],
    [/^node:/, "node builtin reached the client bundle"],
  ],
});

await check({
  entry: "index.server.ts",
  platform: "node",
  external: SHARED_EXTERNAL,
  rules: [[/(^|\/)client\//, "client-only module reached the server bundle"]],
});
