// The site operator's hide switch for uploaded art. A hidden folder's pieces answer a plain grey
// image and the words "Hidden by the site operator." on this site, with nothing changed on chain.
// The files stay on permanent storage (nobody can delete them there); the site only stops
// showing them. The list is a text file, one folder id per line, "#" starts a note. The site
// reads it again within seconds of a change: no restart.
//   node scripts/art-hide.mjs add <folder id> [note]
//   node scripts/art-hide.mjs remove <folder id>
//   node scripts/art-hide.mjs list
// The file is ART_HIDDEN_FILE, else <UPLOADS_DIR>/art-hidden.txt, else web/uploads/art-hidden.txt,
// the same rule web/serve.js uses. --file <path> picks another one. Run it with the same
// environment as the site (on a server: the site's environment file). It works from the
// repository's scripts/ folder and from a folder next to the site's api/ folder (a server that
// holds only the contents of web/, with this file in tools/, for example).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = [path.join(here, "..", "web", "api"), path.join(here, "..", "api"), path.join(here, "api")].find((d) => fs.existsSync(path.join(d, "_art.js")));
if (!apiDir) { console.error("The site's api/_art.js was not found next to this script."); process.exit(1); }
const { artSettings, parseHiddenList } = await import(pathToFileURL(path.join(apiDir, "_art.js")).href);
const { isFolderId, parseArtUriBase } = await import(pathToFileURL(path.join(apiDir, "_artpack.js")).href);

const args = process.argv.slice(2);
const at = args.indexOf("--file");
const file = at >= 0 ? path.resolve(args.splice(at, 2)[1] || "") : artSettings(process.env).hiddenFile;
const [cmd, rawId, ...note] = args;
const usage = () => { console.error("usage: node scripts/art-hide.mjs add <folder id> [note] | remove <folder id> | list   [--file <path>]"); process.exit(1); };

/// A folder id, or the id inside a piece or collection address the operator pasted.
function idOf(s) {
  const t = String(s || "").trim();
  if (isFolderId(t)) return t;
  const m = /\/art\/u\/([A-Za-z0-9_-]{32,44})(?:\/|$)/.exec(t);
  if (m) return m[1];
  const p = parseArtUriBase(t);
  return p ? p.folderId : "";
}
const read = () => { try { return fs.readFileSync(file, "utf8"); } catch (_) { return ""; } };
function write(text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
const clean = (s) => String(s).replace(/[\r\n#]+/g, " ").replace(/[^\x20-\x7e]/g, "?").trim().slice(0, 200);

if (cmd === "list") {
  const ids = [...parseHiddenList(read())];
  console.log(ids.length ? ids.length + " hidden folder(s) in " + file + ":\n" + read().split(/\r?\n/).filter((l) => isFolderId(l.replace(/#.*$/, "").trim().split(/\s+/)[0])).join("\n") : "Nothing is hidden (" + file + ").");
} else if (cmd === "add" || cmd === "remove") {
  const id = idOf(rawId);
  if (!id) { console.error("That is not a folder id, or an address with /art/u/<folder id> in it."); usage(); }
  const text = read();
  const has = parseHiddenList(text).has(id);
  if (cmd === "add") {
    if (has) console.log("Already hidden: " + id + " (" + file + ").");
    else {
      const line = id + "  # hidden " + new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC" + (note.length ? ": " + clean(note.join(" ")) : "");
      write((text && !text.endsWith("\n") ? text + "\n" : text) + line + "\n");
      console.log("Hidden: " + id + ". The site shows a plain image for its pieces within a few seconds (" + file + ").");
    }
  } else {
    if (!has) console.log("Not in the list: " + id + " (" + file + ").");
    else {
      const kept = text.split(/\r?\n/).filter((l) => l.replace(/#.*$/, "").trim().split(/\s+/)[0] !== id);
      write(kept.join("\n").replace(/\n*$/, "\n"));
      console.log("Shown again: " + id + " (" + file + ").");
    }
  }
} else usage();
