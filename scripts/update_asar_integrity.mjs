import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { getRawHeader } from "@electron/asar";
import { NtExecutable, NtExecutableResource, Resource } from "resedit";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function parseArgs(argv) {
  let exePath = null;
  let asarPath = null;
  let relativeAsarPath = "resources\\app.asar";

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--exe-path") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --exe-path");
      }
      exePath = path.resolve(repoRoot, value);
      index += 1;
      continue;
    }
    if (token === "--asar-path") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --asar-path");
      }
      asarPath = path.resolve(repoRoot, value);
      index += 1;
      continue;
    }
    if (token === "--relative-asar-path") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --relative-asar-path");
      }
      relativeAsarPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!exePath || !asarPath) {
    throw new Error("Pass both --exe-path and --asar-path");
  }

  return { exePath, asarPath, relativeAsarPath };
}

function normalizeRelativeAsarPath(value) {
  return String(value)
    .trim()
    .replace(/^[.][\\/]+/, "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .join("\\");
}

const options = parseArgs(process.argv.slice(2));
const exePath = options.exePath;
const asarPath = options.asarPath;
const relativeAsarPath = normalizeRelativeAsarPath(options.relativeAsarPath);

if (!fs.existsSync(exePath)) {
  throw new Error(`Executable not found: ${exePath}`);
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

for (let index = res.entries.length - 1; index >= 0; index -= 1) {
  const entry = res.entries[index];
  if (String(entry.type) === "INTEGRITY" || String(entry.id) === "ELECTRONASAR") {
    res.entries.splice(index, 1);
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
