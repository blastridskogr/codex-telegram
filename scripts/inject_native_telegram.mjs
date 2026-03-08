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

function discoverImplementTodoRegistration(source, rendererFileName) {
  const needle = "Io(`implement-todo`";
  const needleIndex = source.indexOf(needle);
  if (needleIndex === -1) {
    throw new Error(`Could not find the implement-todo registration in ${rendererFileName}`);
  }

  const functionIndex = source.lastIndexOf("function ", needleIndex);
  if (functionIndex === -1) {
    throw new Error(`Could not locate the implement-todo function start in ${rendererFileName}`);
  }

  const functionHeader = source.slice(functionIndex, Math.min(needleIndex, functionIndex + 120));
  const functionMatch = functionHeader.match(/^function\s+(\w+)\(\)\{/);
  if (!functionMatch) {
    throw new Error(`Could not parse the implement-todo function name in ${rendererFileName}`);
  }

  const functionName = functionMatch[1];
  const functionTailAnchor = ",null}var ";
  const functionTailIndex = source.indexOf(functionTailAnchor, needleIndex);
  if (functionTailIndex === -1) {
    throw new Error(`Could not locate the implement-todo function tail in ${rendererFileName}`);
  }

  return {
    functionName,
    functionTailAnchor,
  };
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

const setNamePattern = /m\.app\.setName\([^;]+?\),XA\(\);|m\.app\.setName\(`Codex`\);|m\.app\.setName\("Codex"\);/;
if (!setNamePattern.test(main)) {
  throw new Error("Could not find the Codex app name assignment in main.js");
}
if (!main.includes("Codex Portable")) {
  const portablePathsSnippet = "m.app.setName(`Codex Portable`);try{let e=(process.env.LOCALAPPDATA||m.app.getPath(`appData`)),t=(0,p.join)(e,`CodexPortableData`);m.app.setPath(`userData`,t),m.app.setPath(`sessionData`,(0,p.join)(t,`session`)),m.app.setPath(`crashDumps`,(0,p.join)(t,`Crashpad`)),typeof m.app.setAppLogsPath==`function`&&m.app.setAppLogsPath((0,p.join)(t,`logs`));}catch(e){}XA();";
  main = main.replace(setNamePattern, portablePathsSnippet);
}

const appIdPattern = /m\.app\.setAppUserModelId\(`[^`]+`\)|m\.app\.setAppUserModelId\("[^"]+"\)/;
if (appIdPattern.test(main)) {
  main = main.replace(appIdPattern, "m.app.setAppUserModelId(`com.openai.codexportable`)");
}

if (!main.includes("telegram-start-conversation-result")) {
  main = replaceOnce(
    main,
    "m.ipcMain.handle(`codex_desktop:message-from-view`,async(e,t)=>{if(!w9(e))return;",
    "m.ipcMain.handle(`codex_desktop:message-from-view`,async(e,t)=>{if(!w9(e))return;if(t.type===`telegram-start-conversation-result`){let n=globalThis.__codexTelegramStartConversationRequests;if(n){let r=n.get(t.requestId);r&&(n.delete(t.requestId),t.ok?r.resolve(t.conversationId):r.reject(Error(t.error||`Failed to create conversation`)))}return}",
    "main ipc handler"
  );
}

if (!main.includes("startNewThreadTurn:")) {
  const bootstrapReplacement = "try{let e=(process.env.LOCALAPPDATA||m.app.getPath('appData')),t=(0,p.join)(e,'CodexPortableData'),n=async r=>{if(!r)return;let i=await Y9(Kk);i&&(i.isMinimized()&&i.restore(),i.show(),i.focus(),$9(i,`/local/${r}`),await new Promise(e=>setTimeout(e,750)));},o=async({prompt:r,cwd:i}={})=>{let a=await Y9(Kk);if(a){a.isMinimized()&&a.restore(),a.show(),a.focus();let e={focusComposerNonce:Date.now()};typeof r=='string'&&r.trim().length>0&&(e.prefillPrompt=r),typeof i=='string'&&i.trim().length>0&&(e.prefillCwd=i),$9(a,'/',e),await new Promise(e=>setTimeout(e,750));}},s=async({input:r,attachments:i=[],cwd:a=null,workspaceRoots:o=[],settings:s=null}={})=>{let c=await Y9(Kk);if(!c)throw Error('Failed to open the Codex window');c.isMinimized()&&c.restore(),c.show(),c.focus();let l=typeof O.randomUUID=='function'?O.randomUUID():`${Date.now()}-${Math.random().toString(16).slice(2)}`,u=globalThis.__codexTelegramStartConversationRequests||(globalThis.__codexTelegramStartConversationRequests=new Map),d=Array.isArray(o)?o.filter(e=>typeof e=='string'&&e.trim().length>0):[],f=typeof a=='string'&&a.trim().length>0?a:d[0]??null,p=null;if(s&&((typeof s.model=='string'&&s.model.trim().length>0)||(typeof s.effort=='string'&&s.effort.trim().length>0))){p={mode:`default`,settings:{model:typeof s.model=='string'&&s.model.trim().length>0?s.model.trim():null,reasoning_effort:typeof s.effort=='string'&&s.effort.trim().length>0?s.effort.trim():null,developer_instructions:null}}}let m=new Promise((e,t)=>{let n=setTimeout(()=>{u.delete(l),t(Error('Timed out waiting for Codex to create the new thread'))},3e4);u.set(l,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});L9.sendMessageToWindow(c,{type:`telegram-start-conversation`,requestId:l,input:Array.isArray(r)?r:[],attachments:Array.isArray(i)?i:[],cwd:f,workspaceRoots:d,collaborationMode:p});return await m},c=require('./telegram-native.js');typeof c.stopNativeTelegramBridge=='function'&&m.app.once('before-quit',()=>{c.stopNativeTelegramBridge().catch(e=>console.error('[telegram-native-stop]',e))}),c.startNativeTelegramBridge({userDataPath:t,ensureSessionOpen:n,openNewThread:o,startNewThreadTurn:s}).catch(e=>console.error('[telegram-native]',e));}catch(e){console.error('[telegram-native-load]',e);}";
  const existingBootstrapPattern = /try\{let e=\(process\.env\.LOCALAPPDATA\|\|m\.app\.getPath\('appData'\)\),t=\(0,p\.join\)\(e,'CodexPortableData'\),[\s\S]*?console\.error\('\[telegram-native-load\]',e\);\}/;
  if (existingBootstrapPattern.test(main)) {
    main = main.replace(existingBootstrapPattern, bootstrapReplacement);
  } else {
    main = replaceOnce(
      main,
      "var c9=process.env.CODEX_ELECTRON_AGENT_RUN_ID?.trim()||null;",
      `${bootstrapReplacement}var c9=process.env.CODEX_ELECTRON_AGENT_RUN_ID?.trim()||null;`,
      "portable telegram bootstrap anchor"
    );
  }
}

if (!renderer.includes("telegram-start-conversation")) {
  const rendererFileName = path.basename(rendererPath);
  const implementTodo = discoverImplementTodoRegistration(renderer, rendererFileName);
  const telegramHandlerSource = "async function SkTelegramStartConversationHandler({request:e,mcpManager:t,navigate:n}){let r=e?.requestId??null;try{let i=Array.isArray(e?.input)?e.input:[],a=Array.isArray(e?.attachments)?e.attachments:[],o=Array.isArray(e?.workspaceRoots)?e.workspaceRoots.filter(e=>typeof e=='string'&&e.trim().length>0):[];o.length===0&&(o=(await ut(`active-workspace-roots`)).roots??[]);let s=typeof e?.cwd=='string'&&e.cwd.trim().length>0?e.cwd:o[0]??null,c=e?.collaborationMode??null;if(i.length===0)throw Error(`Missing input for telegram-start-conversation`);let l=await t.startConversation({input:i,attachments:a,cwd:s,workspaceRoots:o,collaborationMode:c});n(`/local/${l}`),Ro.dispatchMessage(`telegram-start-conversation-result`,{requestId:r,ok:!0,conversationId:l})}catch(i){zo.error(`Failed to handle telegram-start-conversation`,{safe:{requestId:r},sensitive:{error:i}}),Ro.dispatchMessage(`telegram-start-conversation-result`,{requestId:r,ok:!1,error:i instanceof Error?i.message:String(i)})}}function SkTelegramStartConversationRegistration(){let e=(0,Q.c)(3),t=Xn(),n=I(),r;return e[0]!==t||e[1]!==n?(r=e=>{SkTelegramStartConversationHandler({request:e,mcpManager:t,navigate:n})},e[0]=t,e[1]=n,e[2]=r):r=e[2],Io(`telegram-start-conversation`,r),null}";
  renderer = insertOnceAtAnchor(
    renderer,
    implementTodo.functionTailAnchor,
    telegramHandlerSource,
    `renderer implement-todo block in ${rendererFileName}`
  );

  const registrationAnchor = `(0,$.jsx)(cc,{extension:!0,children:(0,$.jsx)(${implementTodo.functionName},{})})`;
  renderer = insertOnceAtAnchor(
    renderer,
    registrationAnchor,
    ",(0,$.jsx)(cc,{electron:!0,children:(0,$.jsx)(SkTelegramStartConversationRegistration,{})})",
    `renderer registration mount for ${implementTodo.functionName}`
  );
}

fs.writeFileSync(mainPath, main, "utf8");
fs.writeFileSync(rendererPath, renderer, "utf8");
fs.copyFileSync(telegramSource, telegramDest);

console.log(`INJECTED_NATIVE_TELEGRAM renderer=${path.relative(extractDir, rendererPath)}`);
