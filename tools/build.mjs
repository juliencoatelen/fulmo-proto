// Construit les bundles de la landing (Three.js tree-shaké, minifié).
// Le résultat est commité : le site reste 100 % statique (GitHub Pages).
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const options = {
  entryPoints: { landing: "src/landing/main.js" },
  outdir: "assets/js",
  entryNames: "[name].bundle",
  bundle: true,
  minify: true,
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
