// Builds src/index.ts into a single ES module: dist/ha-cards.js (the file HACS installs).
// `yarn dev` serves the same bundle on the LAN so HA can load it as a dashboard resource.
import { defineConfig } from "@rspack/cli";
import { rspack } from "@rspack/core";
import os from "node:os";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const PORT = Number(process.env.PORT ?? 5173);
const lanIp =
  process.env.HOST ??
  Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address ??
  "localhost";

export default defineConfig({
  entry: { "ha-cards": "./src/index.ts" },
  output: {
    path: new URL("./dist", import.meta.url).pathname,
    filename: "[name].js",
    module: true,
    chunkFormat: "module",
    library: { type: "module" },
    clean: true,
  },
  experiments: { outputModule: true },
  resolve: { extensions: [".ts", ".js"] },
  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: "builtin:swc-loader",
        options: {
          jsc: {
            parser: { syntax: "typescript" },
            target: "es2022",
            // Lit: reactive props must not become define-semantics class fields
            transform: { useDefineForClassFields: false },
          },
        },
        type: "javascript/auto",
      },
    ],
  },
  optimization: { splitChunks: false, runtimeChunk: false },
  devtool: process.env.NODE_ENV === "production" ? false : "source-map",
  performance: { hints: false },
  plugins: [new rspack.DefinePlugin({ __VERSION__: JSON.stringify(version) })],
  devServer: {
    host: "0.0.0.0",
    port: PORT,
    allowedHosts: "all",
    headers: { "Access-Control-Allow-Origin": "*" },
    hot: false,
    liveReload: true,
    client: { webSocketURL: `ws://${lanIp}:${PORT}/ws`, overlay: false },
    devMiddleware: { writeToDisk: false },
    static: [{ directory: new URL("./.dev", import.meta.url).pathname, publicPath: "/preview" }],
    onListening: () =>
      console.log(`\n  Dashboard resource URL: http://${lanIp}:${PORT}/ha-cards.js  (type: JavaScript module)\n`),
  },
});
