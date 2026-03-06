import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extractDir = path.join(repoRoot, "work", "full_extract");
const buildDir = path.join(extractDir, ".vite", "build");
const mainPath = path.join(buildDir, "main.js");
const telegramSource = path.join(repoRoot, "patch", "telegram-native.js");
const telegramDest = path.join(buildDir, "telegram-native.js");

if (!fs.existsSync(mainPath)) {
  throw new Error(`Extracted main.js not found: ${mainPath}`);
}
if (!fs.existsSync(telegramSource)) {
  throw new Error(`Patch source not found: ${telegramSource}`);
}

let main = fs.readFileSync(mainPath, "utf8");
const marker = "[telegram-native-load]";

if (!main.includes(marker)) {
  const setNamePattern = /m\.app\.setName\([^;]+?\),XA\(\);|m\.app\.setName\(`Codex`\);|m\.app\.setName\("Codex"\);/;
  if (!setNamePattern.test(main)) {
    throw new Error("Could not find the Codex app name assignment in main.js");
  }

  const portablePathsSnippet = "m.app.setName(`Codex Portable`);try{let e=(process.env.LOCALAPPDATA||m.app.getPath(`appData`)),t=(0,p.join)(e,`CodexPortableData`);m.app.setPath(`userData`,t),m.app.setPath(`sessionData`,(0,p.join)(t,`session`)),m.app.setPath(`crashDumps`,(0,p.join)(t,`Crashpad`)),typeof m.app.setAppLogsPath==`function`&&m.app.setAppLogsPath((0,p.join)(t,`logs`));}catch(e){}XA();";
  main = main.replace(setNamePattern, portablePathsSnippet);

  const appIdPattern = /m\.app\.setAppUserModelId\(`[^`]+`\)|m\.app\.setAppUserModelId\(\"[^\"]+\"\)/;
  if (appIdPattern.test(main)) {
    main = main.replace(appIdPattern, "m.app.setAppUserModelId(`com.openai.codexportable`)");
  }

  const bootstrapSnippet = `
try{let e=(process.env.LOCALAPPDATA||m.app.getPath('appData')),t=(0,p.join)(e,'CodexPortableData'),n=async r=>{if(!r)return;let i=await Y9(Kk);i&&(i.isMinimized()&&i.restore(),i.show(),i.focus(),$9(i,\`/local/\${r}\`),await new Promise(e=>setTimeout(e,750)));};require('./telegram-native.js').startNativeTelegramBridge({userDataPath:t,ensureSessionOpen:n}).catch(e=>console.error('[telegram-native]',e));}catch(e){console.error('[telegram-native-load]',e);}
`;
  main += bootstrapSnippet;
}

fs.copyFileSync(telegramSource, telegramDest);
fs.writeFileSync(mainPath, main, "utf8");
console.log("INJECTED_NATIVE_TELEGRAM");
