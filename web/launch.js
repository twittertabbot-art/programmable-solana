// Launch a token: the chooser. Three cards, one per path, and nothing else.
//   Module Mode   launch-modules.html      launch-modules.js
//   Collectible   launch-collectible.html  launch-collectible.js
//   Custom hook   launch-hook.html         launch-hook.js
// What the three share (the coin's details, the review, the launch itself) is launch-core.js.
// A link made for the earlier single form (launch.html?template=...) is sent on by the small
// script in the head of launch.html.
import { boot } from "./common.js";

await boot("launch.html");
