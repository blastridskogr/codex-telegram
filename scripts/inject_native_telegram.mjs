import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extractDir = path.join(repoRoot, "work", "full_extract");
const buildDir = path.join(extractDir, ".vite", "build");
const mainPath = path.join(buildDir, "main.js");
const rendererAssetsDir = path.join(extractDir, "webview", "assets");
const telegramSource = path.join(repoRoot, "patch", "telegram-native.js");
const telegramDest = path.join(buildDir, "telegram-native.js");

function replaceOnce(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`Could not find ${label}`);
  }
  return source.replace(search, replacement);
}

function replaceRegexOnce(source, pattern, replacement, label) {
  if (!pattern.test(source)) {
    throw new Error(`Could not find ${label}`);
  }
  return source.replace(pattern, replacement);
}

function insertOnceAtAnchor(source, anchor, insertion, label) {
  const index = source.indexOf(anchor);
  if (index === -1) {
    throw new Error(`Could not find ${label}`);
  }
  const offset = index + anchor.length;
  return `${source.slice(0, offset)}${insertion}${source.slice(offset)}`;
}

function listRendererAssets(directory) {
  if (!fs.existsSync(directory)) {
    throw new Error(`Renderer assets directory not found: ${directory}`);
  }
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(directory, entry.name));
}

function discoverRendererTarget() {
  const files = listRendererAssets(rendererAssetsDir);
  const scored = files.map((filePath) => {
    const source = fs.readFileSync(filePath, "utf8");
    let score = 0;
    if (source.includes("implement-todo")) {
      score += 3;
    }
    if (source.includes("startConversation(")) {
      score += 3;
    }
    if (source.includes("active-workspace-roots")) {
      score += 1;
    }
    return { filePath, source, score };
  });

  const candidates = scored
    .filter((entry) => entry.source.includes("implement-todo") && entry.source.includes("startConversation("))
    .sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath));

  if (candidates.length === 0) {
    const known = scored.map((entry) => path.basename(entry.filePath)).join(", ");
    throw new Error(`Could not locate the renderer bundle for Telegram injection. Searched: ${known}`);
  }

  if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
    const tied = candidates
      .filter((entry) => entry.score === candidates[0].score)
      .map((entry) => path.basename(entry.filePath))
      .join(", ");
    throw new Error(`Renderer bundle discovery was ambiguous. Matching files: ${tied}`);
  }

  return candidates[0];
}

function injectTelegramStartConversationCase(source, rendererFileName) {
  const caseSource =
    "case`telegram-start-conversation`:{try{let n=Array.isArray(e.input)?e.input:[],r=Array.isArray(e.attachments)?e.attachments:[],o=Array.isArray(e.workspaceRoots)?e.workspaceRoots.filter(e=>typeof e==`string`&&e.trim().length>0):[];o.length===0&&(o=(await kt(`active-workspace-roots`)).roots??[]);let s=typeof e.cwd==`string`&&e.cwd.trim().length>0?e.cwd:o[0]??null,c=e.collaborationMode??null;if(n.length===0)throw Error(`Missing input for telegram-start-conversation`);let l=await t.startConversation({input:n,attachments:r,cwd:s,workspaceRoots:o,collaborationMode:c});a(`/local/${l}`),Tr.dispatchMessage(`telegram-start-conversation-result`,{requestId:e.requestId,ok:!0,conversationId:l})}catch(n){Er.error(`telegram_start_conversation_failed`,{safe:{requestId:e.requestId??null},sensitive:{error:n}}),Tr.dispatchMessage(`telegram-start-conversation-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}";
  const exactAnchor = "case`implement-todo`:break bb3;";

  if (source.includes(exactAnchor)) {
    return source.replace(exactAnchor, `${caseSource}${exactAnchor}`);
  }

  return replaceRegexOnce(
    source,
    /case`implement-todo`:[\s\S]*?break bb3;/,
    (match) => `${caseSource}${match}`,
    `renderer implement-todo case in ${rendererFileName}`
  );
}

if (!fs.existsSync(mainPath)) {
  throw new Error(`Extracted main.js not found: ${mainPath}`);
}
if (!fs.existsSync(telegramSource)) {
  throw new Error(`Patch source not found: ${telegramSource}`);
}

let main = fs.readFileSync(mainPath, "utf8");
const rendererTarget = discoverRendererTarget();
const rendererPath = rendererTarget.filePath;
let renderer = rendererTarget.source;

const setNamePattern = /m\.app\.setName\([^;]+?\),\w+\(\);|m\.app\.setName\(`Codex`\);|m\.app\.setName\("Codex"\);/;
if (!setNamePattern.test(main)) {
  throw new Error("Could not find the Codex app name assignment in main.js");
}
if (!main.includes("Codex Portable")) {
  main = main.replace(setNamePattern, "m.app.setName(`Codex Portable`);ate();");
}

const appIdPattern = /m\.app\.setAppUserModelId\([^;]+?\)/;
if (appIdPattern.test(main)) {
  main = main.replace(appIdPattern, "(m.app.setAppUserModelId(`com.openai.codexportable`))");
  main = main.replace(
    /&&m\.app\.setAppUserModelId\(`com\.openai\.codexportable`\)\);/g,
    "&&(m.app.setAppUserModelId(`com.openai.codexportable`));"
  );
  main = main.replace(
    /&&\((m\.app\.setAppUserModelId\(`com\.openai\.codexportable`\))\)\);/g,
    "&&($1);"
  );
}

if (!main.includes("telegram-start-conversation-result")) {
  main = replaceRegexOnce(
    main,
    /m\.ipcMain\.handle\(`codex_desktop:message-from-view`,async\(e,t\)=>\{if\(!(\w+)\(e\)\)return;/,
    "m.ipcMain.handle(`codex_desktop:message-from-view`,async(e,t)=>{if(!$1(e))return;if(t.type===`telegram-start-conversation-result`){let n=globalThis.__codexTelegramStartConversationRequests;if(n){let r=n.get(t.requestId);r&&(n.delete(t.requestId),t.ok?r.resolve(t.conversationId):r.reject(Error(t.error||`Failed to create conversation`)))}return}",
    "main ipc handler"
  );
}

if (!main.includes("startNewThreadTurn:")) {
  const bootstrapReplacement = "try{let t=process.env.CODEX_PORTABLE_USER_DATA_DIR||m.app.getPath('userData')||(0,p.join)(process.env.LOCALAPPDATA||m.app.getPath('appData'),'CodexPortableData'),n=async r=>{if(!r)return;let i=await Y9(Kk);i&&(i.isMinimized()&&i.restore(),i.show(),i.focus(),$9(i,`/local/${r}`),await new Promise(e=>setTimeout(e,750)));},o=async({prompt:r,cwd:i}={})=>{let a=await Y9(Kk);if(a){a.isMinimized()&&a.restore(),a.show(),a.focus();let e={focusComposerNonce:Date.now()};typeof r=='string'&&r.trim().length>0&&(e.prefillPrompt=r),typeof i=='string'&&i.trim().length>0&&(e.prefillCwd=i),$9(a,'/',e),await new Promise(e=>setTimeout(e,750));}},s=async({input:r,attachments:i=[],cwd:a=null,workspaceRoots:o=[],settings:s=null}={})=>{let c=await Y9(Kk);if(!c)throw Error('Failed to open the Codex window');c.isMinimized()&&c.restore(),c.show(),c.focus();let l=typeof O.randomUUID=='function'?O.randomUUID():`${Date.now()}-${Math.random().toString(16).slice(2)}`,u=globalThis.__codexTelegramStartConversationRequests||(globalThis.__codexTelegramStartConversationRequests=new Map),d=Array.isArray(o)?o.filter(e=>typeof e=='string'&&e.trim().length>0):[],f=typeof a=='string'&&a.trim().length>0?a:d[0]??null,p=null;if(s&&((typeof s.model=='string'&&s.model.trim().length>0)||(typeof s.effort=='string'&&s.effort.trim().length>0))){p={mode:`default`,settings:{model:typeof s.model=='string'&&s.model.trim().length>0?s.model.trim():null,reasoning_effort:typeof s.effort=='string'&&s.effort.trim().length>0?s.effort.trim():null,developer_instructions:null}}}let m=new Promise((e,t)=>{let n=setTimeout(()=>{u.delete(l),t(Error('Timed out waiting for Codex to create the new thread'))},3e4);u.set(l,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});L9.sendMessageToWindow(c,{type:`telegram-start-conversation`,requestId:l,input:Array.isArray(r)?r:[],attachments:Array.isArray(i)?i:[],cwd:f,workspaceRoots:d,collaborationMode:p});return await m},c=require('./telegram-native.js');typeof c.stopNativeTelegramBridge=='function'&&m.app.once('before-quit',()=>{c.stopNativeTelegramBridge().catch(e=>console.error('[telegram-native-stop]',e))}),c.startNativeTelegramBridge({userDataPath:t,ensureSessionOpen:n,openNewThread:o,startNewThreadTurn:s}).catch(e=>console.error('[telegram-native]',e));}catch(e){console.error('[telegram-native-load]',e);}";
  const existingBootstrapPattern = /try\{let [^;]+?require\('\.\/telegram-native\.js'\)[\s\S]*?console\.error\('\[telegram-native-load\]',e\);\}/;
  if (existingBootstrapPattern.test(main)) {
    main = main.replace(existingBootstrapPattern, bootstrapReplacement);
  } else {
    main = replaceRegexOnce(
      main,
      /var\s+\w+=process\.env\.CODEX_ELECTRON_AGENT_RUN_ID\?\.trim\(\)\|\|null;/,
      match => `${bootstrapReplacement}${match}`,
      "portable telegram bootstrap anchor"
    );
  }
}

if (!renderer.includes("case`telegram-start-conversation`:")) {
  const rendererFileName = path.basename(rendererPath);
  renderer = injectTelegramStartConversationCase(renderer, rendererFileName);
}

fs.writeFileSync(mainPath, main, "utf8");
fs.writeFileSync(rendererPath, renderer, "utf8");
fs.copyFileSync(telegramSource, telegramDest);

console.log(`INJECTED_NATIVE_TELEGRAM renderer=${path.relative(extractDir, rendererPath)}`);
