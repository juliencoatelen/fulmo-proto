// Construit les bundles de la landing (Three.js tree-shaké, minifié).
// Le résultat est commité : le site reste 100 % statique (GitHub Pages).
import * as esbuild from "esbuild";
import { rmSync } from "node:fs";

// Les chunks portent un hash : on vide le dossier pour ne pas accumuler d'anciennes versions.
rmSync("assets/js/chunks", { recursive: true, force: true });

const watch = process.argv.includes("--watch");
const options = {
  entryPoints: { landing: "src/landing/main.js" },
  outdir: "assets/js",
  entryNames: "[name].bundle",
  bundle: true,
  splitting: true,          // la 3D part dans un chunk chargé après le texte
  chunkNames: "chunks/[name]-[hash]",
  minify: !process.argv.includes("--dev"),
  format: "esm",
  target: ["es2020", "safari15"],
  sourcemap: false,
  legalComments: "eof",
  logLevel: "info"
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
