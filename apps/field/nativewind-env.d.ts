/// <reference types="nativewind/types" />

// NativeWind's generated env file only declares the `className` prop on RN
// primitives; the side-effect `import "./global.css"` in the root layout still
// needs an ambient module declaration so `tsc` doesn't flag it.
declare module "*.css";

// NOTE: This file should be committed with your source code. It is generated
// (and amended) by NativeWind.
