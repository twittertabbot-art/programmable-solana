// Site config. Switch `cluster` to "devnet" or "mainnet" and the pages read
// deployments/<cluster>.json for the cluster name and rpc. `?cluster=` in the URL wins.
// `watcherUrl`: base URL of the watcher (its HTTP server, port 8790 by default), no trailing
// slash. With it the coin page shows the watcher's verdict (pools.json), takes its trades and its
// chart from trades/<pool>.json, and Explore and the liquidity page's list take every coin from
// market.json, all without a call to the RPC. Empty: the site reads everything from the RPC
// itself and hides the verdicts. It works the same, only with many more RPC calls (a coin page
// reads its last 50 transactions when it opens, and the pool every 10 seconds).
// On localnet a review tool can point a page at another RPC or watcher on this machine with
// ?rpc=<address> and ?watcher=<address> (web/review/rpc-count.mjs).
//
// `site` is the one place the site's name and mark are set. The shared header and footer
// (boot() in common.js) read it, and so do the page titles and the tab icon.
//   name: a short text name, at most 40 characters. Empty: the footer shows the mark alone
//         and the page titles carry no name.
//   mark: the path of an image, for example "brand/mark.svg". It is drawn 34 px high in the
//         header and the footer, and is the tab icon when `icon` is empty. Empty: a plain
//         ring is drawn.
//   icon: the path of the tab icon (.ico, .png or .svg). Empty: the mark is used.
// The mark and the icon in web/brand/ are Programmable's own, from programmable.market.
export default {
  cluster: "localnet",
  rpc: "http://127.0.0.1:8899",
  watcherUrl: "",
  site: { name: "Programmable", mark: "brand/programmable-mark.png", icon: "brand/programmable-icon.ico" },
};
