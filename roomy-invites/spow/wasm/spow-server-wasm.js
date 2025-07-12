export * from "./spow-server-wasm_bg.js";
import * as bg from "./spow-server-wasm_bg.js"
const wasmBytes = await Deno.readFile("./spow/wasm/spow-server-wasm_bg.wasm");
const wasm = (await WebAssembly.instantiate(wasmBytes, {
  "./spow-server-wasm_bg.js": bg,
})).instance.exports;
bg.__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
