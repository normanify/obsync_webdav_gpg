import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  format: "cjs",
  target: "es2018",
  platform: "browser",
  external: [
    "obsidian",
    "electron",
    ...builtins,
  ],
  minify: prod,
  sourcemap: prod ? false : "inline",
  treeShaking: true,
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
