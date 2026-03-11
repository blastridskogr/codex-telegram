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

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function upsertRendererCase(source, caseName, caseSource, rendererFileName) {
  const existingCasePattern = new RegExp(`case\\\`${escapeRegex(caseName)}\\\`:[\\s\\S]*?break bb3}`);
  if (existingCasePattern.test(source)) {
    return source.replace(existingCasePattern, caseSource);
  }

  const exactAnchor = "case`implement-todo`:break bb3;";
  if (source.includes(exactAnchor)) {
    return source.replace(exactAnchor, `${caseSource}${exactAnchor}`);
  }

  return replaceRegexOnce(
    source,
    /case`implement-todo`:[\s\S]*?break bb3;/,
    (match) => `${caseSource}${match}`,
    `renderer ${caseName} case in ${rendererFileName}`
  );
}

function injectTelegramStartConversationCase(source, rendererFileName) {
  const caseSource =
    "case`telegram-start-conversation`:{try{let n=Array.isArray(e.input)?e.input:[],r=Array.isArray(e.attachments)?e.attachments:[],o=Array.isArray(e.workspaceRoots)?e.workspaceRoots.filter(e=>typeof e==`string`&&e.trim().length>0):[];o.length===0&&(o=(await kt(`active-workspace-roots`)).roots??[]);let s=typeof e.cwd==`string`&&e.cwd.trim().length>0?e.cwd:o[0]??null,c=e.collaborationMode??null;if(n.length===0)throw Error(`Missing input for telegram-start-conversation`);let l=null;for(let u=0;u<16;u++){if(l=globalThis.__codexTelegramConversationStarter,l&&typeof l.startConversation==`function`)break;await new Promise(e=>setTimeout(e,250))}if(!l||typeof l.startConversation!=`function`)throw Error(`Conversation starter unavailable`);let d=await l.startConversation({input:n,attachments:r,cwd:s,workspaceRoots:o,collaborationMode:c});a(`/local/${d}`),Tr.dispatchMessage(`telegram-start-conversation-result`,{requestId:e.requestId,ok:!0,conversationId:d})}catch(n){Er.error(`telegram_start_conversation_failed`,{safe:{requestId:e.requestId??null},sensitive:{error:n}}),Tr.dispatchMessage(`telegram-start-conversation-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}";
  return upsertRendererCase(source, "telegram-start-conversation", caseSource, rendererFileName);
}

function injectTelegramSetServiceTierCase(source, rendererFileName) {
  const caseSource =
    "case`telegram-set-service-tier`:{try{let n=null;for(let r=0;r<12;r++){if(n=globalThis.__codexTelegramServiceTierController,n&&typeof n.setServiceTier==`function`&&(!e.conversationId||n.conversationId===e.conversationId))break;await new Promise(t=>setTimeout(t,250))}if(!n||typeof n.setServiceTier!=`function`)throw Error(`Service tier controller unavailable`);if(e.conversationId&&n.conversationId!==e.conversationId)throw Error(`Service tier controller is bound to ${n.conversationId??`unknown`} instead of ${e.conversationId}`);await n.setServiceTier(e.serviceTier??null,e.source??`telegram`),Tr.dispatchMessage(`telegram-set-service-tier-result`,{requestId:e.requestId,ok:!0,conversationId:e.conversationId??n.conversationId??null,serviceTier:e.serviceTier??null})}catch(n){Er.error(`telegram_set_service_tier_failed`,{safe:{requestId:e.requestId??null,conversationId:e.conversationId??null},sensitive:{error:n}}),Tr.dispatchMessage(`telegram-set-service-tier-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}";
  return upsertRendererCase(source, "telegram-set-service-tier", caseSource, rendererFileName);
}

function injectTelegramSetModelAndReasoningCase(source, rendererFileName) {
  const caseSource =
    "case`telegram-set-model-and-reasoning`:{try{let n=null;for(let r=0;r<16;r++){if(n=globalThis.__codexTelegramModelController,n&&typeof n.setModelAndReasoningEffort==`function`&&(!e.conversationId||(n.conversationId??null)===(e.conversationId??null)))break;await new Promise(t=>setTimeout(t,250))}if(!n||typeof n.setModelAndReasoningEffort!=`function`)throw Error(`Model controller unavailable`);if(e.conversationId&&(n.conversationId??null)!==(e.conversationId??null))throw Error(`Model controller is bound to ${n.conversationId??`unknown`} instead of ${e.conversationId}`);let r=e.model??n.modelSettings?.model??null,o=e.reasoningEffort??n.modelSettings?.reasoningEffort??null;await n.setModelAndReasoningEffort(r,o),Tr.dispatchMessage(`telegram-set-model-and-reasoning-result`,{requestId:e.requestId,ok:!0,conversationId:n.conversationId??e.conversationId??null,model:r,reasoningEffort:o})}catch(n){Er.error(`telegram_set_model_and_reasoning_failed`,{safe:{requestId:e.requestId??null,conversationId:e.conversationId??null},sensitive:{error:n}}),Tr.dispatchMessage(`telegram-set-model-and-reasoning-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}";
  return upsertRendererCase(source, "telegram-set-model-and-reasoning", caseSource, rendererFileName);
}

function injectTelegramSetPermissionModeCase(source, rendererFileName) {
  const caseSource =
    "case`telegram-set-permission-mode`:{try{let n=null;for(let r=0;r<16;r++){if(n=globalThis.__codexTelegramPermissionController,n&&typeof n.applyPermissionMode==`function`&&(!e.conversationId||(n.conversationId??null)===(e.conversationId??null)))break;await new Promise(t=>setTimeout(t,250))}if(!n||typeof n.applyPermissionMode!=`function`)throw Error(`Permission controller unavailable`);if(e.conversationId&&(n.conversationId??null)!==(e.conversationId??null))throw Error(`Permission controller is bound to ${n.conversationId??`unknown`} instead of ${e.conversationId}`);let r=e.permissionMode??null;await n.applyPermissionMode(r),Tr.dispatchMessage(`telegram-set-permission-mode-result`,{requestId:e.requestId,ok:!0,conversationId:n.conversationId??e.conversationId??null,permissionMode:r})}catch(n){Er.error(`telegram_set_permission_mode_failed`,{safe:{requestId:e.requestId??null,conversationId:e.conversationId??null},sensitive:{error:n}}),Tr.dispatchMessage(`telegram-set-permission-mode-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}";
  return upsertRendererCase(source, "telegram-set-permission-mode", caseSource, rendererFileName);
}

function injectTelegramGetCurrentStateCase(source, rendererFileName) {
  const caseSource =
    "case`telegram-get-current-state`:{try{let n=globalThis.__codexTelegramModelController??null,r=globalThis.__codexTelegramServiceTierController??null,o=globalThis.__codexTelegramPermissionController??null,s=e.conversationId??n?.conversationId??r?.conversationId??o?.conversationId??null;if(e.conversationId&&s&&(s??null)!==(e.conversationId??null))throw Error(`Current controller state is bound to ${s??`unknown`} instead of ${e.conversationId}`);Tr.dispatchMessage(`telegram-get-current-state-result`,{requestId:e.requestId,ok:!0,state:{path:window.location?.pathname??null,conversationId:s,model:n?.modelSettings?.model??null,reasoningEffort:n?.modelSettings?.reasoningEffort??null,serviceTier:r?.serviceTierSettings?.serviceTier??null,permissionMode:o?.permissionMode??null}})}catch(n){Er.error(`telegram_get_current_state_failed`,{safe:{requestId:e.requestId??null,conversationId:e.conversationId??null},sensitive:{error:n}}),Tr.dispatchMessage(`telegram-get-current-state-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}";
  return upsertRendererCase(source, "telegram-get-current-state", caseSource, rendererFileName);
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

if (!main.includes("telegram-set-service-tier-result")) {
  main = replaceRegexOnce(
    main,
    /if\(t\.type===`telegram-start-conversation-result`\)\{let n=globalThis\.__codexTelegramStartConversationRequests;if\(n\)\{let r=n\.get\(t\.requestId\);r&&\(n\.delete\(t\.requestId\),t\.ok\?r\.resolve\(t\.conversationId\):r\.reject\(Error\(t\.error\|\|`Failed to create conversation`\)\)\)\}return\}/,
    "$&if(t.type===`telegram-set-service-tier-result`){let n=globalThis.__codexTelegramSetServiceTierRequests;if(n){let r=n.get(t.requestId);r&&(n.delete(t.requestId),t.ok?r.resolve(t.conversationId??null):r.reject(Error(t.error||`Failed to set service tier`)))}return}",
    "main service tier ipc handler"
  );
}

if (!main.includes("telegram-set-model-and-reasoning-result")) {
  main = replaceRegexOnce(
    main,
    /if\(t\.type===`telegram-set-service-tier-result`\)\{let n=globalThis\.__codexTelegramSetServiceTierRequests;if\(n\)\{let r=n\.get\(t\.requestId\);r&&\(n\.delete\(t\.requestId\),t\.ok\?r\.resolve\(t\.conversationId\?\?null\):r\.reject\(Error\(t\.error\|\|`Failed to set service tier`\)\)\)\}return\}/,
    "$&if(t.type===`telegram-set-model-and-reasoning-result`){let n=globalThis.__codexTelegramSetModelAndReasoningRequests;if(n){let r=n.get(t.requestId);r&&(n.delete(t.requestId),t.ok?r.resolve({conversationId:t.conversationId??null,model:t.model??null,reasoningEffort:t.reasoningEffort??null}):r.reject(Error(t.error||`Failed to set model and reasoning`)))}return}",
    "main model/reasoning ipc handler"
  );
}

if (!main.includes("telegram-set-permission-mode-result")) {
  main = replaceRegexOnce(
    main,
    /if\(t\.type===`telegram-set-model-and-reasoning-result`\)\{let n=globalThis\.__codexTelegramSetModelAndReasoningRequests;if\(n\)\{let r=n\.get\(t\.requestId\);r&&\(n\.delete\(t\.requestId\),t\.ok\?r\.resolve\(\{conversationId:t\.conversationId\?\?null,model:t\.model\?\?null,reasoningEffort:t\.reasoningEffort\?\?null\}\):r\.reject\(Error\(t\.error\|\|`Failed to set model and reasoning`\)\)\)\}return\}/,
    "$&if(t.type===`telegram-set-permission-mode-result`){let n=globalThis.__codexTelegramSetPermissionModeRequests;if(n){let r=n.get(t.requestId);r&&(n.delete(t.requestId),t.ok?r.resolve({conversationId:t.conversationId??null,permissionMode:t.permissionMode??null}):r.reject(Error(t.error||`Failed to set permission mode`)))}return}",
    "main permission ipc handler"
  );
}

if (!main.includes("telegram-get-current-state-result")) {
  main = replaceRegexOnce(
    main,
    /if\(t\.type===`telegram-set-permission-mode-result`\)\{let n=globalThis\.__codexTelegramSetPermissionModeRequests;if\(n\)\{let r=n\.get\(t\.requestId\);r&&\(n\.delete\(t\.requestId\),t\.ok\?r\.resolve\(\{conversationId:t\.conversationId\?\?null,permissionMode:t\.permissionMode\?\?null\}\):r\.reject\(Error\(t\.error\|\|`Failed to set permission mode`\)\)\)\}return\}/,
    "$&if(t.type===`telegram-get-current-state-result`){let n=globalThis.__codexTelegramGetCurrentStateRequests;if(n){let r=n.get(t.requestId);r&&(n.delete(t.requestId),t.ok?r.resolve(t.state??null):r.reject(Error(t.error||`Failed to read current state`)))}return}",
    "main current-state ipc handler"
  );
}

const bootstrapReplacement = `try{
let t=process.env.CODEX_PORTABLE_USER_DATA_DIR||m.app.getPath('userData')||(0,p.join)(process.env.LOCALAPPDATA||m.app.getPath('appData'),'CodexPortableData'),
n=async r=>{if(!r)return;let i=await Y9('local');i&&(i.isMinimized()&&i.restore(),i.show(),i.focus(),$9(i,\`/local/\${r}\`),await new Promise(e=>setTimeout(e,750)));},
o=async({prompt:r,cwd:i}={})=>{let a=await Y9('local');if(a){a.isMinimized()&&a.restore(),a.show(),a.focus();let e={focusComposerNonce:Date.now()};typeof r=='string'&&r.trim().length>0&&(e.prefillPrompt=r),typeof i=='string'&&i.trim().length>0&&(e.prefillCwd=i),$9(a,'/',e),await new Promise(e=>setTimeout(e,750));}},
s=async({input:r,attachments:i=[],cwd:a=null,workspaceRoots:o=[],settings:s=null}={})=>{let c=await Y9('local');if(!c)throw Error('Failed to open the Codex window');c.isMinimized()&&c.restore(),c.show(),c.focus();let l=typeof O.randomUUID=='function'?O.randomUUID():\`\${Date.now()}-\${Math.random().toString(16).slice(2)}\`,u=globalThis.__codexTelegramStartConversationRequests||(globalThis.__codexTelegramStartConversationRequests=new Map),d=Array.isArray(o)?o.filter(e=>typeof e=='string'&&e.trim().length>0):[],f=typeof a=='string'&&a.trim().length>0?a:d[0]??null,p=null;if(s&&((typeof s.model=='string'&&s.model.trim().length>0)||(typeof s.effort=='string'&&s.effort.trim().length>0))){p={mode:\`default\`,settings:{model:typeof s.model=='string'&&s.model.trim().length>0?s.model.trim():null,reasoning_effort:typeof s.effort=='string'&&s.effort.trim().length>0?s.effort.trim():null,developer_instructions:null}}}let m=new Promise((e,t)=>{let n=setTimeout(()=>{u.delete(l),t(Error('Timed out waiting for Codex to create the new thread'))},3e4);u.set(l,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});L9.sendMessageToWindow(c,{type:\`telegram-start-conversation\`,requestId:l,input:Array.isArray(r)?r:[],attachments:Array.isArray(i)?i:[],cwd:f,workspaceRoots:d,collaborationMode:p});return await m},
c=async r=>{let i=N9(hA),a={...i.get(\`electron-persisted-atom-state\`)??{}};r==null?delete a[\`default-service-tier\`]:a[\`default-service-tier\`]=r,i.set(\`electron-persisted-atom-state\`,a),L9.sendMessageToAllWindows(hA,{type:\`persisted-atom-updated\`,key:\`default-service-tier\`,value:r==null?null:r,deleted:r==null})},
d=async({conversationId:r,serviceTier:i,source:a=\`telegram\`}={})=>{if(!r)throw Error('Missing conversationId for telegram service tier update');let o=await Y9('local');if(!o)throw Error('Failed to open the Codex window');o.isMinimized()&&o.restore(),o.show(),o.focus(),$9(o,\`/local/\${r}\`),await new Promise(e=>setTimeout(e,900));let s=typeof O.randomUUID=='function'?O.randomUUID():\`\${Date.now()}-\${Math.random().toString(16).slice(2)}\`,c=globalThis.__codexTelegramSetServiceTierRequests||(globalThis.__codexTelegramSetServiceTierRequests=new Map),l=new Promise((e,t)=>{let n=setTimeout(()=>{c.delete(s),t(Error('Timed out waiting for Codex to apply service tier'))},15e3);c.set(s,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});L9.sendMessageToWindow(o,{type:\`telegram-set-service-tier\`,requestId:s,conversationId:r,serviceTier:i??null,source:a});return await l},
f=async({conversationId:r=null,model:i=null,reasoningEffort:a=null}={})=>{let o=await Y9('local');if(!o)throw Error('Failed to open the Codex window');o.isMinimized()&&o.restore(),o.show(),o.focus(),r&&($9(o,\`/local/\${r}\`),await new Promise(e=>setTimeout(e,900)));let s=typeof O.randomUUID=='function'?O.randomUUID():\`\${Date.now()}-\${Math.random().toString(16).slice(2)}\`,c=globalThis.__codexTelegramSetModelAndReasoningRequests||(globalThis.__codexTelegramSetModelAndReasoningRequests=new Map),l=new Promise((e,t)=>{let n=setTimeout(()=>{c.delete(s),t(Error('Timed out waiting for Codex to apply model and reasoning'))},15e3);c.set(s,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});L9.sendMessageToWindow(o,{type:\`telegram-set-model-and-reasoning\`,requestId:s,conversationId:r??null,model:i,reasoningEffort:a});return await l},
g=async({conversationId:r=null,permissionMode:i=null}={})=>{let o=await Y9('local');if(!o)throw Error('Failed to open the Codex window');o.isMinimized()&&o.restore(),o.show(),o.focus(),r&&($9(o,\`/local/\${r}\`),await new Promise(e=>setTimeout(e,900)));let s=typeof O.randomUUID=='function'?O.randomUUID():\`\${Date.now()}-\${Math.random().toString(16).slice(2)}\`,c=globalThis.__codexTelegramSetPermissionModeRequests||(globalThis.__codexTelegramSetPermissionModeRequests=new Map),l=new Promise((e,t)=>{let n=setTimeout(()=>{c.delete(s),t(Error('Timed out waiting for Codex to apply permission mode'))},15e3);c.set(s,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});L9.sendMessageToWindow(o,{type:\`telegram-set-permission-mode\`,requestId:s,conversationId:r??null,permissionMode:i});return await l},
h=async({conversationId:r=null,reason:i=\`telegram_current\`}={})=>{let o=await Y9('local');if(!o)throw Error('Failed to open the Codex window');o.isMinimized()&&o.restore(),o.show(),o.focus(),r&&($9(o,\`/local/\${r}\`),await new Promise(e=>setTimeout(e,900)));let s=typeof O.randomUUID=='function'?O.randomUUID():\`\${Date.now()}-\${Math.random().toString(16).slice(2)}\`,c=globalThis.__codexTelegramGetCurrentStateRequests||(globalThis.__codexTelegramGetCurrentStateRequests=new Map),l=new Promise((e,t)=>{let n=setTimeout(()=>{c.delete(s),t(Error('Timed out waiting for Codex current state'))},15e3);c.set(s,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});L9.sendMessageToWindow(o,{type:\`telegram-get-current-state\`,requestId:s,conversationId:r??null,reason:i});return await l},
l=require('./telegram-native.js');
typeof l.stopNativeTelegramBridge=='function'&&m.app.once('before-quit',()=>{l.stopNativeTelegramBridge().catch(e=>console.error('[telegram-native-stop]',e))}),
l.startNativeTelegramBridge({userDataPath:t,ensureSessionOpen:n,openNewThread:o,startNewThreadTurn:s,setDefaultServiceTier:c,setThreadServiceTier:d,setModelAndReasoning:f,setPermissionMode:g,getCurrentAppState:h}).catch(e=>console.error('[telegram-native]',e));
}catch(e){console.error('[telegram-native-load]',e);}`;
const existingBootstrapPattern = /try\{let [^;]+?require\('\.\/telegram-native\.js'\)[\s\S]*?console\.error\('\[telegram-native-load\]',e\);\}/;
if (existingBootstrapPattern.test(main)) {
  main = main.replace(existingBootstrapPattern, bootstrapReplacement);
} else if (!main.includes("setModelAndReasoning:")) {
  main = replaceRegexOnce(
    main,
    /var\s+\w+=process\.env\.CODEX_ELECTRON_AGENT_RUN_ID\?\.trim\(\)\|\|null;/,
    match => `${bootstrapReplacement}${match}`,
    "portable telegram bootstrap anchor"
  );
}

const rendererFileName = path.basename(rendererPath);
renderer = injectTelegramStartConversationCase(renderer, rendererFileName);
renderer = injectTelegramSetServiceTierCase(renderer, rendererFileName);
renderer = injectTelegramSetModelAndReasoningCase(renderer, rendererFileName);
renderer = injectTelegramSetPermissionModeCase(renderer, rendererFileName);
renderer = injectTelegramGetCurrentStateCase(renderer, rendererFileName);

if (!renderer.includes("globalThis.__codexTelegramConversationStarter=")) {
  renderer = replaceRegexOnce(
    renderer,
    /\{children:n\}=e,r=Nn\(\),i=On\(\),a=I\(\),o=xhe\(\),s=xt\(\),c=v\(F9\),l;/,
    (match) => `${match}globalThis.__codexTelegramConversationStarter={startConversation:e=>r.startConversation(e)};`,
    "renderer conversation starter hook"
  );
}

if (!renderer.includes("globalThis.__codexTelegramServiceTierController=")) {
  renderer = replaceOnce(
    renderer,
    "R=A.mode===`plan`,z;",
    "R=A.mode===`plan`,z;globalThis.__codexTelegramServiceTierController={conversationId:c,setServiceTier:I,serviceTierSettings:F};",
    "renderer service tier controller hook"
  );
}

if (!renderer.includes("globalThis.__codexTelegramModelController=")) {
  renderer = replaceOnce(
    renderer,
    "v=Fn(n,VK),y;",
    "v=Fn(n,VK),y;globalThis.__codexTelegramModelController={conversationId:n,setModelAndReasoningEffort:g,modelSettings:h};",
    "renderer model controller hook"
  );
}

if (!renderer.includes("globalThis.__codexTelegramPermissionController=")) {
  renderer = replaceOnce(
    renderer,
    "t[113]=d,t[114]=We,t[115]=Ge):Ge=t[115];let Ke;",
    "t[113]=d,t[114]=We,t[115]=Ge):Ge=t[115];globalThis.__codexTelegramPermissionController={conversationId:n,permissionMode:s,selectDefault:K,selectCustom:te,confirmFullAccess:We,applyPermissionMode:e=>{if(e==null||e===`default`||e===`auto`||e===`read-only`||e===`workspace-write`){K();return}if(e===`full-access`||e===`danger-full-access`){We();return}if(e===`custom`){te();return}throw Error(`Unsupported permission mode: ${String(e)}`)}};let Ke;",
    "renderer permission controller hook"
  );
}

fs.writeFileSync(mainPath, main, "utf8");
fs.writeFileSync(rendererPath, renderer, "utf8");
fs.copyFileSync(telegramSource, telegramDest);

console.log(`INJECTED_NATIVE_TELEGRAM renderer=${path.relative(extractDir, rendererPath)}`);
