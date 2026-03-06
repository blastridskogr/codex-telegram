import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPackage } from "@electron/asar";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(repoRoot, "work", "full_extract");
const outputAsar = path.join(repoRoot, "work", "app.patched.asar");

await createPackage(sourceDir, outputAsar);
console.log(`ASAR_REBUILT ${outputAsar}`);

