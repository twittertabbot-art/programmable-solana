// web3.js v1 expects a global Buffer in the browser.
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = Buffer;
export { Buffer };
