import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPackageWithOptions } from "@electron/asar";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function normalizeForAsar(value) {
  return String(value).replace(/\\/g, "/");
}

function parseArgs(argv) {
  let sourceDir = path.join(repoRoot, "work", "full_extract");
  let outputAsar = path.join(repoRoot, "work", "app.patched.asar");

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--source-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --source-dir");
      }
      sourceDir = path.resolve(repoRoot, value);
      index += 1;
      continue;
    }
    if (token === "--output-asar") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --output-asar");
      }
      outputAsar = path.resolve(repoRoot, value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return { sourceDir, outputAsar };
}

const options = parseArgs(process.argv.slice(2));
const sourceDir = normalizeForAsar(options.sourceDir);
const outputAsar = normalizeForAsar(options.outputAsar);
await createPackageWithOptions(sourceDir, outputAsar, { dot: true });
console.log(`ASAR_REBUILT source=${sourceDir} output=${outputAsar}`);
