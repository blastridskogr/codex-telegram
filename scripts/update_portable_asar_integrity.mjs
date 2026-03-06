import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { getRawHeader } from "@electron/asar";
import { NtExecutable, NtExecutableResource, Resource } from "resedit";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exePath = path.join(repoRoot, "work", "portable_package_root_v2", "app", "Codex.exe");
const asarPath = path.join(repoRoot, "work", "portable_package_root_v2", "app", "resources", "app.asar");
const relativeAsarPath = "resources\\app.asar";

if (!fs.existsSync(exePath)) {
  throw new Error(`Portable executable not found: ${exePath}`);
}
if (!fs.existsSync(asarPath)) {
  throw new Error(`Patched app.asar not found: ${asarPath}`);
}

const { headerString } = getRawHeader(asarPath);
const hash = crypto.createHash("SHA256").update(headerString).digest("hex");

const exe = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = NtExecutableResource.from(exe);
const versionInfo = Resource.VersionInfo.fromEntries(res.entries);

if (versionInfo.length !== 1) {
  throw new Error("Failed to locate version info resource");
}

const languages = versionInfo[0].getAllLanguagesForStringValues();
if (languages.length !== 1) {
  throw new Error("Failed to locate language metadata for integrity resource");
}

for (let i = res.entries.length - 1; i >= 0; i -= 1) {
  const entry = res.entries[i];
  if (String(entry.type) === "INTEGRITY" || String(entry.id) === "ELECTRONASAR") {
    res.entries.splice(i, 1);
  }
}

const integrityBuffer = Buffer.from(JSON.stringify([
  {
    file: relativeAsarPath,
    alg: "SHA256",
    value: hash,
  },
]), "utf8");

res.entries.push({
  type: "INTEGRITY",
  id: "ELECTRONASAR",
  bin: integrityBuffer.buffer.slice(
    integrityBuffer.byteOffset,
    integrityBuffer.byteOffset + integrityBuffer.length
  ),
  lang: languages[0].lang,
  codepage: languages[0].codepage,
});

res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));

console.log(JSON.stringify({ exePath, asarPath, relativeAsarPath, hash }, null, 2));

