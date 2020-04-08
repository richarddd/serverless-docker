import commonjs from "@rollup/plugin-commonjs";
import resolve from "@rollup/plugin-node-resolve";
import json from "@rollup/plugin-json";
import replace from "@rollup/plugin-replace";
import babel from "rollup-plugin-babel";
import builtins from "builtin-modules";

const extensions = [".js", ".ts"];

const name = "RollupTypeScriptBabel";

export default {
  input: "./src/index.ts",

  // Specify here external modules which you don't want to include in your bundle (for instance: 'lodash', 'moment' etc.)
  // https://rollupjs.org/guide/en#external-e-external
  external: [...builtins],

  plugins: [
    json(),
    replace({
      "global.GENTLY": false
    }),
    resolve({ extensions, preferBuiltins: true }),
    commonjs(),
    babel({ extensions, include: ["src/**/*", "node_moduels/**/*"] })
    // Allow bundling cjs modules. Rollup doesn't understand cjs
  ],

  output: {
    dir: "lib",
    sourcemap: true,
    name,
    format: "cjs"
  }

  //   output: [
  //     {
  //       file: pkg.main,
  //       format: "cjs"
  //     },
  //     {
  //       file: pkg.module,
  //       format: "es"
  //     },
  //     {
  //       file: pkg.browser,
  //       format: "iife",
  //       name,

  //       // https://rollupjs.org/guide/en#output-globals-g-globals
  //       globals: {}
  //     }
  //   ]
};
