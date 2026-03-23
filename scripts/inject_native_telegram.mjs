import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const telegramSource = path.join(repoRoot, "patch", "telegram-native.js");

function parseArgs(argv) {
  let extractDir = path.join(repoRoot, "work", "full_extract");
  let mutateIdentity = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--extract-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --extract-dir");
      }
      extractDir = path.resolve(repoRoot, value);
      index += 1;
      continue;
    }
    if (token === "--mutate-identity") {
      mutateIdentity = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return { extractDir, mutateIdentity };
}

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

function discoverRendererTarget(rendererAssetsDir) {
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

function resolveMainBundlePaths(extractDir) {
  const packageJsonPath = path.join(extractDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`Extracted package.json not found: ${packageJsonPath}`);
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (typeof packageJson.main !== "string" || packageJson.main.trim().length === 0) {
    throw new Error(`package.json is missing a usable main field: ${packageJsonPath}`);
  }

  const bootstrapPath = path.resolve(extractDir, packageJson.main);
  if (!fs.existsSync(bootstrapPath)) {
    throw new Error(`Extracted bootstrap entry not found: ${bootstrapPath}`);
  }

  let mainPath = bootstrapPath;
  const visited = new Set();
  const nextBundlePatterns = [
    /require\(`\.\/(main-[^`]+\.js)`\)/,
    /require\('\.\/(main-[^']+\.js)'\)/,
    /require\("\.\/(main-[^"]+\.js)"\)/,
    /require\(`\.\/(bootstrap-[^`]+\.js)`\)/,
    /require\('\.\/(bootstrap-[^']+\.js)'\)/,
    /require\("\.\/(bootstrap-[^"]+\.js)"\)/,
  ];

  while (true) {
    const normalizedPath = path.normalize(mainPath);
    if (visited.has(normalizedPath)) {
      throw new Error(`Detected a cyclic bootstrap chain while resolving the main bundle: ${mainPath}`);
    }
    visited.add(normalizedPath);

    const currentSource = fs.readFileSync(mainPath, "utf8");
    if (
      currentSource.includes("exports.runMainAppStartup=")
      || currentSource.includes("codex_desktop:message-from-view")
    ) {
      break;
    }
    const nextMatch = nextBundlePatterns
      .map((pattern) => currentSource.match(pattern))
      .find(Boolean);

    if (!nextMatch) {
      break;
    }

    const nextPath = path.join(path.dirname(mainPath), nextMatch[1]);
    if (!fs.existsSync(nextPath)) {
      throw new Error(`Resolved hashed bundle not found: ${nextPath}`);
    }

    mainPath = nextPath;
  }

  return {
    packageJsonPath,
    bootstrapPath,
    mainPath,
    buildDir: path.dirname(bootstrapPath),
  };
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

function resolveRendererMessageBridgeSymbols(source, rendererFileName) {
  const bridgeMatch = source.match(
    /case`thread-role-request`:\{let \w+=(\w+)\.getForHostIdOrThrow\(e\.hostId\);try\{let \w+=\w+\.getThreadRole\(e\.conversationId\);(\w+)\.dispatchMessage\(`thread-role-response`/
  );
  if (!bridgeMatch) {
    throw new Error(`Could not resolve renderer manager/dispatch symbols in ${rendererFileName}`);
  }
  const loggerMatch = source.match(/catch\(e\)\{let t=e;(\w+)\.error\(`Invalid message received`/);
  if (!loggerMatch) {
    throw new Error(`Could not resolve renderer logger symbol in ${rendererFileName}`);
  }
  return {
    managerSymbol: bridgeMatch[1],
    dispatchSymbol: bridgeMatch[2],
    loggerSymbol: loggerMatch[1],
  };
}

function applyRendererBridgeSymbols(caseSource, bridgeSymbols) {
  return caseSource
    .replaceAll("__MANAGER__", bridgeSymbols.managerSymbol)
    .replaceAll("__DISPATCH__", bridgeSymbols.dispatchSymbol)
    .replaceAll("__LOGGER__", bridgeSymbols.loggerSymbol);
}

function injectTelegramStartConversationCase(source, rendererFileName, bridgeSymbols) {
  const caseSource = applyRendererBridgeSymbols(
    "case`telegram-start-conversation`:{try{let n=Array.isArray(e.input)?e.input:[],r=Array.isArray(e.attachments)?e.attachments:[],o=Array.isArray(e.workspaceRoots)?e.workspaceRoots.filter(e=>typeof e==`string`&&e.trim().length>0):[];o.length===0&&(o=(await kt(`active-workspace-roots`)).roots??[]);let s=typeof e.cwd==`string`&&e.cwd.trim().length>0?e.cwd:o[0]??null,c=e.collaborationMode??null;if(n.length===0)throw Error(`Missing input for telegram-start-conversation`);let l=__MANAGER__.getForHostIdOrThrowWhenDefaultHost(e.hostId??null);if(l==null||typeof l.startConversation!=`function`)throw Error(`Conversation starter unavailable`);let d=await l.startConversation({input:n,attachments:r,cwd:s,workspaceRoots:o,collaborationMode:c});a(`/local/${d}`),__DISPATCH__.dispatchMessage(`telegram-start-conversation-result`,{requestId:e.requestId,ok:!0,conversationId:d})}catch(n){__LOGGER__.error(`telegram_start_conversation_failed`,{safe:{requestId:e.requestId??null},sensitive:{error:n}}),__DISPATCH__.dispatchMessage(`telegram-start-conversation-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}",
    bridgeSymbols
  );
  return upsertRendererCase(source, "telegram-start-conversation", caseSource, rendererFileName);
}

function injectTelegramStartCleanConversationCase(source, rendererFileName, bridgeSymbols) {
  const caseSource = applyRendererBridgeSymbols(
    "case`telegram-start-clean-conversation`:{try{let n=Array.isArray(e.input)?e.input:[],r=Array.isArray(e.attachments)?e.attachments:[],o=Array.isArray(e.workspaceRoots)?e.workspaceRoots.filter(e=>typeof e==`string`&&e.trim().length>0):[];o.length===0&&(o=(await kt(`active-workspace-roots`)).roots??[]);let s=typeof e.cwd==`string`&&e.cwd.trim().length>0?e.cwd:o[0]??null,c=e.collaborationMode??null;if(n.length===0)throw Error(`Missing input for telegram-start-clean-conversation`);let l=__MANAGER__.getForHostIdOrThrowWhenDefaultHost(e.hostId??null),u=null,d=null;if(l&&typeof l.startConversation==`function`)d=await l.startConversation({input:n,attachments:r,cwd:s,workspaceRoots:o,collaborationMode:c});else{for(let e=0;e<16;e++){if(u=globalThis.__codexTelegramConversationStarter,u&&typeof u.startConversation==`function`)break;await new Promise(e=>setTimeout(e,250))}if(!u||typeof u.startConversation!=`function`)throw Error(`Conversation starter unavailable`);d=await u.startConversation({input:n,attachments:r,cwd:s,workspaceRoots:o,collaborationMode:c})}__DISPATCH__.dispatchMessage(`telegram-start-clean-conversation-result`,{requestId:e.requestId,ok:!0,conversationId:d})}catch(n){__LOGGER__.error(`telegram_start_clean_conversation_failed`,{safe:{requestId:e.requestId??null},sensitive:{error:n}}),__DISPATCH__.dispatchMessage(`telegram-start-clean-conversation-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}",
    bridgeSymbols
  );
  return upsertRendererCase(source, "telegram-start-clean-conversation", caseSource, rendererFileName);
}

function injectTelegramSetServiceTierCase(source, rendererFileName, bridgeSymbols) {
  const caseSource = applyRendererBridgeSymbols(
    "case`telegram-set-service-tier`:{try{let n=null;for(let r=0;r<12;r++){if(n=globalThis.__codexTelegramServiceTierController,n&&typeof n.setServiceTier==`function`&&(!e.conversationId||n.conversationId===e.conversationId))break;await new Promise(t=>setTimeout(t,250))}if(!n||typeof n.setServiceTier!=`function`)throw Error(`Service tier controller unavailable`);if(e.conversationId&&n.conversationId!==e.conversationId)throw Error(`Service tier controller is bound to ${n.conversationId??`unknown`} instead of ${e.conversationId}`);await n.setServiceTier(e.serviceTier??null,e.source??`telegram`),__DISPATCH__.dispatchMessage(`telegram-set-service-tier-result`,{requestId:e.requestId,ok:!0,conversationId:e.conversationId??n.conversationId??null,serviceTier:e.serviceTier??null})}catch(n){__LOGGER__.error(`telegram_set_service_tier_failed`,{safe:{requestId:e.requestId??null,conversationId:e.conversationId??null},sensitive:{error:n}}),__DISPATCH__.dispatchMessage(`telegram-set-service-tier-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}",
    bridgeSymbols
  );
  return upsertRendererCase(source, "telegram-set-service-tier", caseSource, rendererFileName);
}

function injectTelegramSetModelAndReasoningCase(source, rendererFileName, bridgeSymbols) {
  const caseSource = applyRendererBridgeSymbols(
    "case`telegram-set-model-and-reasoning`:{try{let n=null;for(let r=0;r<16;r++){if(n=globalThis.__codexTelegramModelController,n&&typeof n.setModelAndReasoningEffort==`function`&&(!e.conversationId||(n.conversationId??null)===(e.conversationId??null)))break;await new Promise(t=>setTimeout(t,250))}if(!n||typeof n.setModelAndReasoningEffort!=`function`)throw Error(`Model controller unavailable`);if(e.conversationId&&(n.conversationId??null)!==(e.conversationId??null))throw Error(`Model controller is bound to ${n.conversationId??`unknown`} instead of ${e.conversationId}`);let r=e.model??n.modelSettings?.model??null,o=e.reasoningEffort??n.modelSettings?.reasoningEffort??null;await n.setModelAndReasoningEffort(r,o),__DISPATCH__.dispatchMessage(`telegram-set-model-and-reasoning-result`,{requestId:e.requestId,ok:!0,conversationId:n.conversationId??e.conversationId??null,model:r,reasoningEffort:o})}catch(n){__LOGGER__.error(`telegram_set_model_and_reasoning_failed`,{safe:{requestId:e.requestId??null,conversationId:e.conversationId??null},sensitive:{error:n}}),__DISPATCH__.dispatchMessage(`telegram-set-model-and-reasoning-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}",
    bridgeSymbols
  );
  return upsertRendererCase(source, "telegram-set-model-and-reasoning", caseSource, rendererFileName);
}

function injectTelegramSetPermissionModeCase(source, rendererFileName, bridgeSymbols) {
  const caseSource = applyRendererBridgeSymbols(
    "case`telegram-set-permission-mode`:{try{let n=null;for(let r=0;r<16;r++){if(n=globalThis.__codexTelegramPermissionController,n&&typeof n.applyPermissionMode==`function`&&(!e.conversationId||(n.conversationId??null)===(e.conversationId??null)))break;await new Promise(t=>setTimeout(t,250))}if(!n||typeof n.applyPermissionMode!=`function`)throw Error(`Permission controller unavailable`);if(e.conversationId&&(n.conversationId??null)!==(e.conversationId??null))throw Error(`Permission controller is bound to ${n.conversationId??`unknown`} instead of ${e.conversationId}`);let r=e.permissionMode??null;await n.applyPermissionMode(r),__DISPATCH__.dispatchMessage(`telegram-set-permission-mode-result`,{requestId:e.requestId,ok:!0,conversationId:n.conversationId??e.conversationId??null,permissionMode:r})}catch(n){__LOGGER__.error(`telegram_set_permission_mode_failed`,{safe:{requestId:e.requestId??null,conversationId:e.conversationId??null},sensitive:{error:n}}),__DISPATCH__.dispatchMessage(`telegram-set-permission-mode-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}",
    bridgeSymbols
  );
  return upsertRendererCase(source, "telegram-set-permission-mode", caseSource, rendererFileName);
}

function injectTelegramReadyPingCase(source, rendererFileName, bridgeSymbols) {
  const caseSource = applyRendererBridgeSymbols(
    "case`telegram-ready-ping`:{try{__DISPATCH__.dispatchMessage(`telegram-ready-ping-result`,{requestId:e.requestId,ok:!0})}catch(n){__LOGGER__.error(`telegram_ready_ping_failed`,{safe:{requestId:e.requestId??null},sensitive:{error:n}}),__DISPATCH__.dispatchMessage(`telegram-ready-ping-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}",
    bridgeSymbols
  );
  return upsertRendererCase(source, "telegram-ready-ping", caseSource, rendererFileName);
}

function injectTelegramGetCurrentStateCase(source, rendererFileName, bridgeSymbols) {
  const caseSource = applyRendererBridgeSymbols(
    "case`telegram-get-current-state`:{try{let n=globalThis.__codexTelegramModelController??null,r=globalThis.__codexTelegramServiceTierController??null,o=globalThis.__codexTelegramPermissionController??null,s=globalThis.__codexTelegramApprovalController??null,c=e.conversationId??n?.conversationId??r?.conversationId??o?.conversationId??s?.conversationId??null;if(e.conversationId&&c&&(c??null)!==(e.conversationId??null))throw Error(`Current controller state is bound to ${c??`unknown`} instead of ${e.conversationId}`);__DISPATCH__.dispatchMessage(`telegram-get-current-state-result`,{requestId:e.requestId,ok:!0,state:{path:window.location?.pathname??null,conversationId:c,model:n?.modelSettings?.model??null,reasoningEffort:n?.modelSettings?.reasoningEffort??null,serviceTier:r?.serviceTierSettings?.serviceTier??null,permissionMode:o?.permissionMode??null,pendingApproval:s&&(s.conversationId??null)===(c??null)?s.snapshot??null:null}})}catch(n){__LOGGER__.error(`telegram_get_current_state_failed`,{safe:{requestId:e.requestId??null,conversationId:e.conversationId??null},sensitive:{error:n}}),__DISPATCH__.dispatchMessage(`telegram-get-current-state-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}",
    bridgeSymbols
  );
  return upsertRendererCase(source, "telegram-get-current-state", caseSource, rendererFileName);
}

function injectTelegramDebugContextCase(source, rendererFileName, bridgeSymbols) {
  const caseSource = applyRendererBridgeSymbols(
    "case`telegram-debug-context`:{try{let n=__MANAGER__.getForHostIdOrThrowWhenDefaultHost(e.hostId??null);if(n==null)throw Error(`Conversation manager unavailable for host ${e.hostId??`local`}`);let r=e.conversationId??null,o=typeof n.getConversations==`function`?n.getConversations():[],s=r&&typeof n.getConversation==`function`?n.getConversation(r):null,c=(t=>{if(!t||typeof t!=`object`)return null;let e=t.parentThreadId??t.thread?.parentThreadId??t.subAgent?.thread_spawn?.parent_thread_id??t.subAgent?.threadSpawn?.parentThreadId??null;return typeof e==`string`&&e.trim().length>0?e.trim():null}),l=typeof n.collectAppStateMetrics==`function`?n.collectAppStateMetrics():null,u=0,d=0,f=0,p=0;for(let t of o){c(t?.source)&&u++;for(let e of t?.turns??[])for(let n of e?.items??[])n?.type===`collabAgentToolCall`&&(d++,f+=Array.isArray(n.receiverThreadIds)?n.receiverThreadIds.filter(e=>typeof e==`string`&&e.trim().length>0).length:0,n?.senderThreadId&&p++)}__DISPATCH__.dispatchMessage(`telegram-debug-context-result`,{requestId:e.requestId,ok:!0,context:{path:window.location?.pathname??null,requestedConversationId:r??null,requestedConversationExists:!!s,activeConversationId:s?.id??null,activeThreadId:s?.turns?.[s.turns.length-1]?.params?.threadId??null,conversationCount:o.length,hasManager:!!n,hasGetConversation:typeof n.getConversation==`function`,hasGetConversations:typeof n.getConversations==`function`,metrics:l,streamRole:r&&typeof n.getStreamRole==`function`?n.getStreamRole(r)??null:null,childSourceCount:u,collabActionCount:d,receiverThreadCount:f,senderThreadCount:p}})}catch(n){__LOGGER__.error(`telegram_debug_context_failed`,{safe:{requestId:e.requestId??null,conversationId:e.conversationId??null},sensitive:{error:n}}),__DISPATCH__.dispatchMessage(`telegram-debug-context-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}",
    bridgeSymbols
  );
  return upsertRendererCase(source, "telegram-debug-context", caseSource, rendererFileName);
}

function injectTelegramListChildContextsCase(source, rendererFileName, bridgeSymbols) {
  const caseSource = applyRendererBridgeSymbols(
    "case`telegram-list-child-contexts`:{try{let n=__MANAGER__.getForHostIdOrThrowWhenDefaultHost(e.hostId??null);if(n==null)throw Error(`Conversation manager unavailable for host ${e.hostId??`local`}`);let r=e.conversationId??null;if(!r)throw Error(`Missing conversationId for telegram-list-child-contexts`);let o=n.getConversation(r);if(!o)throw Error(`Conversation ${r} is unavailable in the renderer`);let s=e.hydrate!==!1,c=(t=>{if(!t||typeof t!=`object`)return null;let e=t.parentThreadId??t.thread?.parentThreadId??t.subAgent?.thread_spawn?.parent_thread_id??t.subAgent?.threadSpawn?.parentThreadId??null;return typeof e==`string`&&e.trim().length>0?e.trim():null}),l=(t=>{if(!Array.isArray(t))return null;for(let e=t.length-1;e>=0;e--){let n=t[e];if(!n||n.type!==`agentMessage`)continue;let r=typeof n.text==`string`?n.text.trim():``;if(r.length>0)return r.length>800?`${r.slice(0,800)}...`:r}return null}),u=new Map;for(let t of o.turns??[]){for(let e of t.items??[]){if(!e||e.type!==`collabAgentToolCall`)continue;let n=Array.isArray(e.receiverThreadIds)?e.receiverThreadIds.filter(t=>typeof t==`string`&&t.trim().length>0):[];for(let i of n){u.has(i)||u.set(i,{taskPrompt:typeof e.prompt==`string`&&e.prompt.trim().length>0?e.prompt.trim():null,taskTool:typeof e.tool==`string`&&e.tool.trim().length>0?e.tool.trim():null,taskModel:typeof e.model==`string`&&e.model.trim().length>0?e.model.trim():null,taskStatus:typeof e.status==`string`&&e.status.trim().length>0?e.status.trim():null,agentState:e.agentsStates&&typeof e.agentsStates==`object`?e.agentsStates[i]??null:null,senderThreadId:typeof e.senderThreadId==`string`&&e.senderThreadId.trim().length>0?e.senderThreadId.trim():null,parentTurnId:typeof t.turnId==`string`&&t.turnId.trim().length>0?t.turnId.trim():null,parentItemId:typeof e.id==`string`&&e.id.trim().length>0?e.id.trim():null})}}}let d=typeof n.getConversations==`function`?n.getConversations():[];for(let t of d){let e=t?.id??null;if(typeof e!=`string`||e.length===0||u.has(e))continue;c(t?.source)===r&&u.set(e,{taskPrompt:null,taskTool:null,taskModel:null,taskStatus:null,agentState:null,senderThreadId:null,parentTurnId:null,parentItemId:null})}let f=Array.from(u.keys());s&&typeof n.hydrateCollabThreads==`function`&&f.length>0&&await n.hydrateCollabThreads(f);let p=(typeof n.getConversations==`function`?n.getConversations():[]).filter(t=>u.has(t?.id??``)).map(t=>{let e=t?.id??null,i=u.get(e)??{},a=Array.isArray(t?.turns)&&t.turns.length>0?t.turns[t.turns.length-1]??null:null,o=Array.isArray(t?.requests)?t.requests:[],s=o.find(t=>t&&((t.method===`item/fileChange/requestApproval`||t.method===`item/commandExecution/requestApproval`)&&typeof t.id==`string`))??null;return{conversationId:e,parentConversationId:r,title:typeof t?.title==`string`&&t.title.trim().length>0?t.title.trim():null,cwd:typeof t?.cwd==`string`&&t.cwd.trim().length>0?t.cwd.trim():null,createdAt:t?.createdAt??null,updatedAt:t?.updatedAt??null,resumeState:t?.resumeState??null,threadRuntimeStatus:t?.threadRuntimeStatus??null,hasUnreadTurn:t?.hasUnreadTurn===!0,turnCount:Array.isArray(t?.turns)?t.turns.length:0,latestTurnId:typeof a?.turnId==`string`&&a.turnId.trim().length>0?a.turnId.trim():null,latestTurnStatus:typeof a?.status==`string`&&a.status.trim().length>0?a.status.trim():null,latestAssistantText:l(t?.turns??[]),latestModel:t?.latestModel??a?.params?.model??null,latestReasoningEffort:t?.latestReasoningEffort??a?.params?.effort??null,latestCollaborationMode:t?.latestCollaborationMode??a?.params?.collaborationMode??null,pendingRequestCount:o.length,pendingApprovalRequestId:s?.id??null,sourceParentThreadId:c(t?.source),taskPrompt:i.taskPrompt??null,taskTool:i.taskTool??null,taskModel:i.taskModel??null,taskStatus:i.taskStatus??null,agentState:i.agentState??null,senderThreadId:i.senderThreadId??null,parentTurnId:i.parentTurnId??null,parentItemId:i.parentItemId??null}}).sort((t,e)=>(Number(e.updatedAt??0)-Number(t.updatedAt??0))||String(t.conversationId??``).localeCompare(String(e.conversationId??``)));__DISPATCH__.dispatchMessage(`telegram-list-child-contexts-result`,{requestId:e.requestId,ok:!0,conversationId:r,children:p})}catch(n){__LOGGER__.error(`telegram_list_child_contexts_failed`,{safe:{requestId:e.requestId??null,conversationId:e.conversationId??null},sensitive:{error:n}}),__DISPATCH__.dispatchMessage(`telegram-list-child-contexts-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}",
    bridgeSymbols
  );
  return upsertRendererCase(source, "telegram-list-child-contexts", caseSource, rendererFileName);
}

function injectTelegramSubmitBoundTurnCase(source, rendererFileName, bridgeSymbols) {
  const caseSource = applyRendererBridgeSymbols(
    "case`telegram-submit-bound-turn`:{try{let n=__MANAGER__.getForHostIdOrThrowWhenDefaultHost(e.hostId??null);if(n==null)throw Error(`Conversation manager unavailable for host ${e.hostId??`local`}`);let r=e.conversationId??null,o=Array.isArray(e.input)?e.input:[],s=Array.isArray(e.attachments)?e.attachments:[];if(!r)throw Error(`Missing conversationId for telegram-submit-bound-turn`);if(o.length===0)throw Error(`Missing input for telegram-submit-bound-turn`);let c=null;for(let l=0;l<16;l++){if(c=n.getConversation(r),c)break;await new Promise(e=>setTimeout(e,250))}if(!c)throw Error(`Conversation ${r} is unavailable in the renderer`);let l=c.turns[c.turns.length-1]??null,u=typeof e.cwd==`string`&&e.cwd.trim().length>0?e.cwd:c.cwd??null,d=e.settings??null,f={conversationId:r,turnStartParams:{input:o,cwd:u,approvalPolicy:e.approvalPolicy??l?.params?.approvalPolicy??null,sandboxPolicy:e.sandboxPolicy??l?.params?.sandboxPolicy??null,model:e.model??d?.model??l?.params?.model??null,serviceTier:e.serviceTier??d?.serviceTier??l?.params?.serviceTier??null,effort:e.effort??d?.effort??l?.params?.effort??null,outputSchema:null,collaborationMode:e.collaborationMode??l?.params?.collaborationMode??c.latestCollaborationMode??null,attachments:s},isSteering:!1};await n.handleThreadFollowerStartTurn(f),__DISPATCH__.dispatchMessage(`telegram-submit-bound-turn-result`,{requestId:e.requestId,ok:!0,conversationId:r})}catch(n){__LOGGER__.error(`telegram_submit_bound_turn_failed`,{safe:{requestId:e.requestId??null,conversationId:e.conversationId??null},sensitive:{error:n}}),__DISPATCH__.dispatchMessage(`telegram-submit-bound-turn-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}",
    bridgeSymbols
  );
  return upsertRendererCase(source, "telegram-submit-bound-turn", caseSource, rendererFileName);
}

function injectTelegramRespondApprovalCase(source, rendererFileName, bridgeSymbols) {
  const caseSource = applyRendererBridgeSymbols(
    "case`telegram-respond-approval`:{try{let n=null;for(let r=0;r<16;r++){if(n=globalThis.__codexTelegramApprovalController,n&&typeof n.decide==`function`&&(!e.conversationId||(n.conversationId??null)===(e.conversationId??null))&&(!e.approvalRequestId||(n.approvalRequestId??null)===(e.approvalRequestId??null)))break;await new Promise(t=>setTimeout(t,250))}if(!n||typeof n.decide!=`function`)throw Error(`Approval controller unavailable`);if(e.conversationId&&(n.conversationId??null)!==(e.conversationId??null))throw Error(`Approval controller is bound to ${n.conversationId??`unknown`} instead of ${e.conversationId}`);if(e.approvalRequestId&&(n.approvalRequestId??null)!==(e.approvalRequestId??null))throw Error(`Approval controller is bound to ${n.approvalRequestId??`unknown`} instead of ${e.approvalRequestId}`);let r=typeof e.decision==`string`?e.decision.trim():``;if(!r)throw Error(`Missing approval decision`);await n.decide(r),__DISPATCH__.dispatchMessage(`telegram-respond-approval-result`,{requestId:e.requestId,ok:!0,conversationId:n.conversationId??e.conversationId??null,approvalRequestId:n.approvalRequestId??e.approvalRequestId??null,decision:r})}catch(n){__LOGGER__.error(`telegram_respond_approval_failed`,{safe:{requestId:e.requestId??null,conversationId:e.conversationId??null,approvalRequestId:e.approvalRequestId??null},sensitive:{error:n}}),__DISPATCH__.dispatchMessage(`telegram-respond-approval-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}",
    bridgeSymbols
  );
  return upsertRendererCase(source, "telegram-respond-approval", caseSource, rendererFileName);
}

function renderMainIpcTelegramResultHandlers(payloadVar) {
  return `if(${payloadVar}.type===\`telegram-start-conversation-result\`){let n=globalThis.__codexTelegramStartConversationRequests;if(n){let r=n.get(${payloadVar}.requestId);r&&(n.delete(${payloadVar}.requestId),${payloadVar}.ok?r.resolve(${payloadVar}.conversationId):r.reject(Error(${payloadVar}.error||\`Failed to create conversation\`)))}return}if(${payloadVar}.type===\`telegram-start-clean-conversation-result\`){let n=globalThis.__codexTelegramStartCleanConversationRequests;if(n){let r=n.get(${payloadVar}.requestId);r&&(n.delete(${payloadVar}.requestId),${payloadVar}.ok?r.resolve(${payloadVar}.conversationId):r.reject(Error(${payloadVar}.error||\`Failed to create clean conversation\`)))}return}if(${payloadVar}.type===\`telegram-set-service-tier-result\`){let n=globalThis.__codexTelegramSetServiceTierRequests;if(n){let r=n.get(${payloadVar}.requestId);r&&(n.delete(${payloadVar}.requestId),${payloadVar}.ok?r.resolve(${payloadVar}.conversationId??null):r.reject(Error(${payloadVar}.error||\`Failed to set service tier\`)))}return}if(${payloadVar}.type===\`telegram-set-model-and-reasoning-result\`){let n=globalThis.__codexTelegramSetModelAndReasoningRequests;if(n){let r=n.get(${payloadVar}.requestId);r&&(n.delete(${payloadVar}.requestId),${payloadVar}.ok?r.resolve({conversationId:${payloadVar}.conversationId??null,model:${payloadVar}.model??null,reasoningEffort:${payloadVar}.reasoningEffort??null}):r.reject(Error(${payloadVar}.error||\`Failed to set model and reasoning\`)))}return}if(${payloadVar}.type===\`telegram-set-permission-mode-result\`){let n=globalThis.__codexTelegramSetPermissionModeRequests;if(n){let r=n.get(${payloadVar}.requestId);r&&(n.delete(${payloadVar}.requestId),${payloadVar}.ok?r.resolve({conversationId:${payloadVar}.conversationId??null,permissionMode:${payloadVar}.permissionMode??null}):r.reject(Error(${payloadVar}.error||\`Failed to set permission mode\`)))}return}if(${payloadVar}.type===\`telegram-ready-ping-result\`){let n=globalThis.__codexTelegramReadyPingRequests;if(n){let r=n.get(${payloadVar}.requestId);r&&(n.delete(${payloadVar}.requestId),${payloadVar}.ok?r.resolve(!0):r.reject(Error(${payloadVar}.error||\`Failed to confirm renderer readiness\`)))}return}if(${payloadVar}.type===\`telegram-get-current-state-result\`){let n=globalThis.__codexTelegramGetCurrentStateRequests;if(n){let r=n.get(${payloadVar}.requestId);r&&(n.delete(${payloadVar}.requestId),${payloadVar}.ok?r.resolve(${payloadVar}.state??null):r.reject(Error(${payloadVar}.error||\`Failed to read current state\`)))}return}if(${payloadVar}.type===\`telegram-debug-context-result\`){let n=globalThis.__codexTelegramDebugContextRequests;if(n){let r=n.get(${payloadVar}.requestId);r&&(n.delete(${payloadVar}.requestId),${payloadVar}.ok?r.resolve(${payloadVar}.context??null):r.reject(Error(${payloadVar}.error||\`Failed to read debug context\`)))}return}if(${payloadVar}.type===\`telegram-list-child-contexts-result\`){let n=globalThis.__codexTelegramListChildContextsRequests;if(n){let r=n.get(${payloadVar}.requestId);r&&(n.delete(${payloadVar}.requestId),${payloadVar}.ok?r.resolve({conversationId:${payloadVar}.conversationId??null,children:Array.isArray(${payloadVar}.children)?${payloadVar}.children:[]}):r.reject(Error(${payloadVar}.error||\`Failed to list child contexts\`)))}return}if(${payloadVar}.type===\`telegram-submit-bound-turn-result\`){let n=globalThis.__codexTelegramSubmitBoundTurnRequests;if(n){let r=n.get(${payloadVar}.requestId);r&&(n.delete(${payloadVar}.requestId),${payloadVar}.ok?r.resolve(${payloadVar}.conversationId??null):r.reject(Error(${payloadVar}.error||\`Failed to submit the bound turn\`)))}return}if(${payloadVar}.type===\`telegram-respond-approval-result\`){let n=globalThis.__codexTelegramRespondApprovalRequests;if(n){let r=n.get(${payloadVar}.requestId);r&&(n.delete(${payloadVar}.requestId),${payloadVar}.ok?r.resolve({conversationId:${payloadVar}.conversationId??null,approvalRequestId:${payloadVar}.approvalRequestId??null,decision:${payloadVar}.decision??null}):r.reject(Error(${payloadVar}.error||\`Failed to respond to approval\`)))}return}if(${payloadVar}.type===\`telegram-approval-state-changed\`){let n=globalThis.__codexTelegramApprovalStateChangeHandler;typeof n==\`function\`&&Promise.resolve(n({conversationId:${payloadVar}.conversationId??null,approval:${payloadVar}.approval??null})).catch(e=>console.error('[telegram-native-approval-state]',e));return}`;
}

function upsertMainIpcTelegramResultHandlers(source) {
  const ipcHandlerPrefixPattern = /\w+\.ipcMain\.handle\((?:`codex_desktop:message-from-view`|'codex_desktop:message-from-view'|"codex_desktop:message-from-view"|\w+),async\((\w+),(\w+)\)=>\{if\(!(\w+)\(\1\)\)return;/;
  const ipcHandlerPrefixMatch = source.match(ipcHandlerPrefixPattern);
  if (!ipcHandlerPrefixMatch) {
    throw new Error("Could not find the main ipc handler");
  }

  const handlerPrefix = ipcHandlerPrefixMatch[0];
  const payloadVar = ipcHandlerPrefixMatch[2];
  const handlersSource = renderMainIpcTelegramResultHandlers(payloadVar);
  const existingHandlersPattern = new RegExp(
    `if\\(${escapeRegex(payloadVar)}\\.type===\\\`telegram-start-conversation-result\\\`\\)\\{[\\s\\S]*?if\\(${escapeRegex(payloadVar)}\\.type===\\\`telegram-approval-state-changed\\\`\\)\\{[\\s\\S]*?return\\}`
  );

  if (existingHandlersPattern.test(source)) {
    return source.replace(existingHandlersPattern, handlersSource);
  }

  return source.replace(handlerPrefix, `${handlerPrefix}${handlersSource}`);
}

function upsertMainAppServerContextHelpers(source) {
  const helperPrefix = "function DF({desktopSentry:n,hotkeyWindowLifecycleManager:e,codexHome:t,nativeContextMenuIconSearchRoots:i,getContextForWebContents:r,ensureHostWindow:o,navigateToRoute:s,isTrustedIpcEvent:c}){";
  if (source.includes("globalThis.__fm26TelegramGetAppServerConnectionForWebContents=")) {
    return source;
  }
  const helperBody = "globalThis.__fm26TelegramGetWindowContextForWebContents=e=>{try{return e?r(e)??null:null}catch(t){return null}};globalThis.__fm26TelegramGetAppServerConnectionForWebContents=e=>{try{let t=e?r(e)??null:null;return t?.appServerConnectionRegistry?.getConnection?.(t.hostId??`local`)??null}catch(n){return null}};";
  return replaceOnce(source, helperPrefix, `${helperPrefix}${helperBody}`, "main app-server context helpers");
}

function replaceInjectedBootstrap(source, bootstrapReplacement) {
  const bridgeMarker = "startNativeTelegramBridge({userDataPath:t";
  const electronMarker = "let qe=require('electron'),";
  const loadErrorMarker = "console.error('[telegram-native-load]',e);}";
  const bridgeIndex = source.indexOf(bridgeMarker);

  if (bridgeIndex === -1) {
    return null;
  }

  const electronIndex = source.lastIndexOf(electronMarker, bridgeIndex);
  const bootstrapStart = electronIndex === -1 ? -1 : source.lastIndexOf("try{", electronIndex);
  const bootstrapEnd = source.indexOf(loadErrorMarker, bridgeIndex);
  if (bootstrapStart === -1 || bootstrapEnd === -1) {
    return null;
  }

  return `${source.slice(0, bootstrapStart)}${bootstrapReplacement}${source.slice(bootstrapEnd + loadErrorMarker.length)}`;
}

function injectTelegramBridge(targetExtractDir, { mutateIdentity = false } = {}) {
  const extractDir = path.resolve(targetExtractDir);
  const { buildDir, mainPath } = resolveMainBundlePaths(extractDir);
  const rendererAssetsDir = path.join(extractDir, "webview", "assets");
  const telegramDest = path.join(buildDir, "telegram-native.js");

  if (!fs.existsSync(mainPath)) {
    throw new Error(`Extracted main bundle not found: ${mainPath}`);
  }
  if (!fs.existsSync(telegramSource)) {
    throw new Error(`Patch source not found: ${telegramSource}`);
  }

  let main = fs.readFileSync(mainPath, "utf8");
  const rendererTarget = discoverRendererTarget(rendererAssetsDir);
  const rendererPath = rendererTarget.filePath;
  let renderer = rendererTarget.source;

  if (!mutateIdentity && (main.includes("Codex Portable") || main.includes("com.openai.codexportable"))) {
    throw new Error(`Refusing to run official-style injection on a portable-identity bundle: ${extractDir}`);
  }

  if (mutateIdentity) {
    const setNamePattern = /m\.app\.setName\([^;]+?\),\w+\(\);|m\.app\.setName\(`Codex`\);|m\.app\.setName\("Codex"\);/;
    if (!setNamePattern.test(main) && !main.includes("Codex Portable")) {
      throw new Error("Could not find the Codex app name assignment in the resolved main bundle");
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
    } else if (!main.includes("com.openai.codexportable")) {
      throw new Error("Could not find the Codex app id assignment in the resolved main bundle");
    }
  }

  main = upsertMainIpcTelegramResultHandlers(main);
  main = upsertMainAppServerContextHelpers(main);

const bootstrapReplacement = `try{
 let qe=require('electron'),
 rt=require('node:crypto'),
 pt=require('node:path'),
 ht=require('node:http'),
 ft=require('node:fs'),
 tt='codex_desktop:message-for-view',
t=process.env.CODEX_PORTABLE_USER_DATA_DIR||qe.app.getPath('userData')||pt.join(process.env.LOCALAPPDATA||qe.app.getPath('appData'),'CodexPortableData'),
nt=()=>qe.BrowserWindow.getAllWindows().filter(e=>e&&!e.isDestroyed()&&e.webContents&&!e.webContents.isDestroyed()),
it=()=>{let e=qe.BrowserWindow.getFocusedWindow?.()??null;if(e&&!e.isDestroyed()&&e.webContents&&!e.webContents.isDestroyed())return e;let t=nt(),n=t.find(e=>typeof e.isVisible=='function'&&e.isVisible()&&!e.isMinimized())??t.find(e=>typeof e.isVisible=='function'&&e.isVisible())??t[0]??null;if(!n)throw Error('Failed to find a Codex window');return n;},
dt2=(e,t=null)=>{let n=nt();if(e!=null){let r=n.find(n=>String(n.id)===String(e)&&(!t||String(n.webContents?.id??'')===String(t)));if(r)return r;let i=n.find(n=>String(n.id)===String(e));if(i)return i}return null},
Ct3=(e=null,t=null,n=null)=>{let r=dt2(t,n)??e??lt(it()),i=globalThis.__fm26TelegramGetWindowContextForWebContents,a=globalThis.__fm26TelegramGetAppServerConnectionForWebContents;if(typeof i!='function'||typeof a!='function')throw Error('App server context helper unavailable');let o=r?.webContents??null,s=i(o),c=a(o);if(!s||!c)throw Error('App server connection unavailable');return{windowRef:r,context:s,connection:c};},
Dt3=(e,t=[])=>{let n=Array.isArray(t)?t.filter(e=>typeof e=='string'&&e.trim().length>0):[],r=typeof e?.permissionMode=='string'?e.permissionMode.trim().toLowerCase():null;if(r==='danger-full-access'||r==='full-access')return{approvalPolicy:'never',sandbox:'danger-full-access',sandboxPolicy:{type:'dangerFullAccess'}};if(r==='workspace-write')return{approvalPolicy:'never',sandbox:'workspace-write',sandboxPolicy:{type:'workspaceWrite',writableRoots:n,readOnlyAccess:{type:'fullAccess'},networkAccess:true,excludeTmpdirEnvVar:false,excludeSlashTmp:false}};if(r==='read-only')return{approvalPolicy:'never',sandbox:'read-only',sandboxPolicy:{type:'readOnly',access:{type:'fullAccess'},networkAccess:true}};return{approvalPolicy:'never',sandbox:'read-only',sandboxPolicy:{type:'readOnly',access:{type:'fullAccess'},networkAccess:true}};},
Et2=(e,n={})=>{try{let r=pt.join(t,'fm26-thread-controller.log'),a=(new Date).toISOString()+' '+e+(Object.keys(n).length?' '+JSON.stringify(n):'')+'\\n';ft.appendFileSync(r,a,'utf8')}catch{}},
Et3=e=>{if(!e||typeof e!='object')return null;let t=typeof e.model=='string'&&e.model.trim().length>0?e.model.trim():null,n=typeof e.effort=='string'&&e.effort.trim().length>0?e.effort.trim():null;return t||n?{mode:\`default\`,settings:{model:t,reasoning_effort:n,developer_instructions:null}}:null;},
Ft3=async({windowRef:e=null,targetWindowId:t=null,targetWebContentsId:n=null,cwd:r=null,workspaceRoots:i=[],settings:a=null,parentState:o=null,input:s=[],attachments:c=[]}={})=>{let{windowRef:l,connection:u}=Ct3(e,t,n),d=Array.isArray(i)?i.filter(e=>typeof e=='string'&&e.trim().length>0):[],f=typeof r=='string'&&r.trim().length>0?r:d[0]??null,p=Dt3(o,d),m=typeof a?.effort=='string'&&a.effort.trim().length>0?{model_reasoning_effort:a.effort.trim()}:null;Et2('spawn_child_direct_start',{cwd:f,targetWindowId:l?.id??null,targetWebContentsId:l?.webContents?.id??null,permissionMode:o?.permissionMode??null,model:a?.model??null,effort:a?.effort??null});let h=await u.startThread({model:a?.model??null,modelProvider:null,cwd:f,approvalPolicy:p.approvalPolicy,sandbox:p.sandbox,config:m,baseInstructions:null,developerInstructions:null,personality:null,ephemeral:!1,dynamicTools:null,experimentalRawEvents:!1,persistExtendedHistory:!1,serviceTier:o?.serviceTier??null}),g=typeof h?.thread?.id=='string'&&h.thread.id.trim().length>0?h.thread.id.trim():null;if(!g)throw Error('App server did not return child thread id');Et2('spawn_child_direct_thread_started',{childConversationId:g,cwd:f});let _=Et3(a),v=await u.startTurn({threadId:g,input:Array.isArray(s)?s:[],cwd:f??h?.cwd??null,approvalPolicy:p.approvalPolicy,sandboxPolicy:p.sandboxPolicy,model:null,serviceTier:o?.serviceTier??null,effort:null,summary:'none',personality:null,outputSchema:null,collaborationMode:_,attachments:Array.isArray(c)?c:[]});Et2('spawn_child_direct_turn_started',{childConversationId:g,turnId:v?.turn?.id??null});return{conversationId:g,thread:h?.thread??null,turn:v?.turn??null,windowRef:l};},
Gt3=async({conversationId:e,input:t=[],attachments:n=[],cwd:r=null,workspaceRoots:i=[],settings:a=null,parentConversationId:o=null,targetWindowId:s=null,targetWebContentsId:c=null,windowRef:l=null}={})=>{let{connection:u}=Ct3(l,s,c),d=Array.isArray(i)?i.filter(e=>typeof e=='string'&&e.trim().length>0):[],f=typeof r=='string'&&r.trim().length>0?r:d[0]??null,p=null;try{o&&(p=await h({conversationId:o,reason:'fm26_managed_child_parent_state',skipNavigation:!0,timeoutMs:5e3}))}catch{}let m=Dt3(p,d),g=await u.startTurn({threadId:e,input:Array.isArray(t)?t:[],cwd:f,approvalPolicy:m.approvalPolicy,sandboxPolicy:m.sandboxPolicy,model:null,serviceTier:p?.serviceTier??null,effort:null,summary:'none',personality:null,outputSchema:null,collaborationMode:Et3(a),attachments:Array.isArray(n)?n:[]});return{conversationId:e,turn:g?.turn??null};},
at=e=>{if(e.isMinimized())e.restore();e.show();e.focus();return e;},
lt=(e,{restoreMinimized:n=!1,foreground:r=!1}={})=>{n&&e.isMinimized()&&e.restore();return r?at(e):e;},
ot=(e,n)=>{e.webContents.send(tt,n);},
st=async(e,n=null,r=750,{foreground:i=!1,restoreMinimized:a=!1}={})=>{let o=lt(it(),{restoreMinimized:a,foreground:i});ot(o,{type:\`navigate-to-route\`,path:e,state:n});await new Promise(e=>setTimeout(e,r));return o;},
n=async r=>{if(!r)return;await st(\`/local/\${r}\`,null,750);},
 o=async({prompt:r,cwd:i}={})=>{let a={focusComposerNonce:Date.now()};typeof r=='string'&&r.trim().length>0&&(a.prefillPrompt=r),typeof i=='string'&&i.trim().length>0&&(a.prefillCwd=i);return await st('/',a,750,{foreground:!0,restoreMinimized:!0});},
 ct=()=>typeof rt.randomUUID=='function'?rt.randomUUID():\`\${Date.now()}-\${Math.random().toString(16).slice(2)}\`,
 et=e=>typeof e=='string'&&e.trim().length>0?e.trim():null,
 nt2=e=>Array.isArray(e)?e.filter(t=>typeof t=='string'&&t.trim().length>0).map(e=>e.trim()):[],
 ot2=e=>{let t=et(e);return t?[{type:\`text\`,text:t,text_elements:[]}]:[]},
 st2=(e,t=400,n='bad_request')=>{let r=Error(e);r.statusCode=t,r.errorCode=n;throw r},
 ct2=(e,t,n=200)=>{let r=Buffer.from(JSON.stringify(e));t.writeHead(n,{'Content-Type':'application/json; charset=utf-8','Content-Length':r.length}),t.end(r)},
 lt2=e=>new Promise((t,n)=>{let r=[];e.on('data',e=>r.push(Buffer.isBuffer(e)?e:Buffer.from(e))),e.on('end',()=>{if(!r.length){t({});return}try{let e=Buffer.concat(r).toString('utf8').trim();t(e?JSON.parse(e):{})}catch(e){n(Error('Invalid JSON body'))}}),e.on('error',n)}),
rt2=({windowRef:e=null,targetWindowId:t=null,targetWebContentsId:n=null}={})=>{let r=[],i=new Set,a=o=>{if(!o||o.isDestroyed()||!o.webContents||o.webContents.isDestroyed())return;let s=String(o.id??'');i.has(s)||(i.add(s),r.push(o))};a(e??null),a(dt2(t,n)),a(qe.BrowserWindow.getFocusedWindow?.()??null);for(let e of nt().filter(e=>typeof e.isVisible=='function'&&e.isVisible()&&!e.isMinimized()))a(e);for(let e of nt().filter(e=>typeof e.isVisible=='function'&&e.isVisible()))a(e);for(let e of nt())a(e);return r},
at2=(e,t=null)=>{let n=[],r=new Set,i=o=>{if(!o||typeof o.isDestroyed=='function'&&o.isDestroyed())return;let s=String(o.id??'');if(!s||r.has(s))return;let c=typeof qe.BrowserWindow.fromWebContents=='function'?qe.BrowserWindow.fromWebContents(o):null,l=typeof o.getURL=='function'?o.getURL()||null:null,u=typeof o.getType=='function'?o.getType()||null:null,d=o.hostWebContents?.id??null;r.add(s),n.push({webContents:o,windowId:t??c?.id??null,webContentsId:o.id??null,hostWebContentsId:d,url:l,type:u})},a=o=>{if(!o||typeof o!='object')return;if(o.webContents)i(o.webContents);let s=Array.isArray(o.children)?o.children:[];for(let e of s)a(e)};return{add:i,walkView:a,entries:n}},
wt2=({windowRef:e=null,targetWindowId:t=null,targetWebContentsId:n=null}={})=>{let r=rt2({windowRef:e,targetWindowId:t,targetWebContentsId:n}),i=at2(),a=new Set;for(let e of r){a.add(String(e.id??'')),i.add(e.webContents,e.id??null);if(typeof e.getBrowserViews=='function')for(let t of e.getBrowserViews()??[])t?.webContents&&i.add(t.webContents,e.id??null);e.contentView&&i.walkView(e.contentView)}let o=[];try{o=typeof qe.webContents?.getAllWebContents=='function'?qe.webContents.getAllWebContents():[]}catch{}for(let e of o){let t=typeof qe.BrowserWindow.fromWebContents=='function'?qe.BrowserWindow.fromWebContents(e):null,r=t?.id??null,o=e.hostWebContents?.id??null,s=(r!=null&&a.has(String(r)))||(o!=null&&i.entries.some(t=>t.webContentsId===o));s&&i.add(e,r)}return i.entries},
xt2=e=>e&&typeof e=='object'?{windowId:e.windowId??null,webContentsId:e.webContentsId??null,hostWebContentsId:e.hostWebContentsId??null,url:e.url??null,type:e.type??null}:null,
yt2=(e,t)=>{let n=e?.webContents??null;if(!n||typeof n.isDestroyed=='function'&&n.isDestroyed())throw Error('Renderer webContents unavailable');n.send(tt,t)},
it2=async({requestType:e,requestMap:t,requestPayload:n={},timeoutMs:r=15e3,windowRef:i=null,candidate:a=null}={})=>{if(typeof e!='string'||e.trim().length===0)throw Error('Missing request type');if(typeof t!='string'||t.trim().length===0)throw Error('Missing request map');let o=ct(),s=globalThis[t]||(globalThis[t]=new Map),c=new Promise((n,i)=>{let a=setTimeout(()=>{s.delete(o),i(Error('Timed out waiting for '+e))},r);s.set(o,{resolve:e=>{clearTimeout(a),n(e)},reject:e=>{clearTimeout(a),i(e)}})}),l=a??{webContents:(i??lt(it())).webContents};yt2(l,{type:e,requestId:o,...n});return await c},
 vt=async({windowRef:r=null,timeoutMs:i=1500}={})=>{let a=r??lt(it()),o=ct(),s=globalThis.__codexTelegramReadyPingRequests||(globalThis.__codexTelegramReadyPingRequests=new Map),c=new Promise((e,t)=>{let n=setTimeout(()=>{s.delete(o),t(Error('Timed out waiting for Codex view readiness'))},i);s.set(o,{resolve:()=>{clearTimeout(n),e(!0)},reject:e=>{clearTimeout(n),t(e)}})});ot(a,{type:\`telegram-ready-ping\`,requestId:o});return await c},
ut=async({windowRef:r=null,maxAttempts:i=6,timeoutMs:a=1500,delayMs:o=250}={})=>{let s=null,c=r??lt(it());for(let l=0;l<i;l++)try{return await vt({windowRef:c,timeoutMs:a})}catch(e){if(s=e,l===i-1)break;await new Promise(e=>setTimeout(e,o))}throw s??Error('Timed out waiting for Codex view readiness')},
s=async({input:r,attachments:i=[],cwd:a=null,workspaceRoots:o=[],settings:s=null,timeoutMs:y=12e4,windowRef:z=null}={})=>{let c=z??lt(it()),l=ct(),u=globalThis.__codexTelegramStartConversationRequests||(globalThis.__codexTelegramStartConversationRequests=new Map),d=Array.isArray(o)?o.filter(e=>typeof e=='string'&&e.trim().length>0):[],f=typeof a=='string'&&a.trim().length>0?a:d[0]??null,p=null;if(s&&((typeof s.model=='string'&&s.model.trim().length>0)||(typeof s.effort=='string'&&s.effort.trim().length>0))){p={mode:\`default\`,settings:{model:typeof s.model=='string'&&s.model.trim().length>0?s.model.trim():null,reasoning_effort:typeof s.effort=='string'&&s.effort.trim().length>0?s.effort.trim():null,developer_instructions:null}}}let m=new Promise((e,t)=>{let n=setTimeout(()=>{u.delete(l),t(Error('Timed out waiting for Codex to create the new thread'))},y);u.set(l,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});ot(c,{type:\`telegram-start-conversation\`,requestId:l,input:Array.isArray(r)?r:[],attachments:Array.isArray(i)?i:[],cwd:f,workspaceRoots:d,collaborationMode:p});return await m},
s2=async({input:r,attachments:i=[],cwd:a=null,workspaceRoots:o=[],settings:s=null,timeoutMs:y=12e4,windowRef:z=null}={})=>{let c=z??lt(it()),l=ct(),u=globalThis.__codexTelegramStartCleanConversationRequests||(globalThis.__codexTelegramStartCleanConversationRequests=new Map),d=Array.isArray(o)?o.filter(e=>typeof e=='string'&&e.trim().length>0):[],f=typeof a=='string'&&a.trim().length>0?a:d[0]??null,p=null;if(s&&((typeof s.model=='string'&&s.model.trim().length>0)||(typeof s.effort=='string'&&s.effort.trim().length>0))){p={mode:\`default\`,settings:{model:typeof s.model=='string'&&s.model.trim().length>0?s.model.trim():null,reasoning_effort:typeof s.effort=='string'&&s.effort.trim().length>0?s.effort.trim():null,developer_instructions:null}}}let m=new Promise((e,t)=>{let n=setTimeout(()=>{u.delete(l),t(Error('Timed out waiting for Codex to create the clean child'))},y);u.set(l,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});ot(c,{type:\`telegram-start-clean-conversation\`,requestId:l,input:Array.isArray(r)?r:[],attachments:Array.isArray(i)?i:[],cwd:f,workspaceRoots:d,collaborationMode:p});return await m},
w=async({input:r,attachments:i=[],cwd:a=null,workspaceRoots:q2=[],settings:p2=null,timeoutMs:w=12e4,windowRef:v2=null,targetWindowId:x2=null,targetWebContentsId:y2=null}={})=>{let c=Array.isArray(q2)?q2.filter(e=>typeof e=='string'&&e.trim().length>0):[],l=typeof a=='string'&&a.trim().length>0?a:c[0]??null,t=v2??dt2(x2,y2)??it(),n=null;try{await ut({windowRef:t,maxAttempts:12,timeoutMs:1500,delayMs:250})}catch(e){n=e}try{return await s({input:Array.isArray(r)?r:[],attachments:Array.isArray(i)?i:[],cwd:l,workspaceRoots:c,settings:p2,timeoutMs:15e3,windowRef:t})}catch(e){let a=null;if(p2&&((typeof p2.model=='string'&&p2.model.trim().length>0)||(typeof p2.effort=='string'&&p2.effort.trim().length>0))){a={mode:\`default\`,settings:{model:typeof p2.model=='string'&&p2.model.trim().length>0?p2.model.trim():null,reasoning_effort:typeof p2.effort=='string'&&p2.effort.trim().length>0?p2.effort.trim():null,developer_instructions:null}}}ot(t,{type:\`telegram-start-conversation\`,requestId:ct(),input:Array.isArray(r)?r:[],attachments:Array.isArray(i)?i:[],cwd:l,workspaceRoots:c,collaborationMode:a});let u=Date.now(),d=e??n;for(;Date.now()-u<w;){try{let e=await h({conversationId:null,reason:\`fm26_thread_create_probe\`,windowRef:t,skipNavigation:!0,timeoutMs:1500}),n=typeof e?.conversationId=='string'&&e.conversationId.trim().length>0?e.conversationId.trim():null;if(n)return n}catch(e){d=e}await new Promise(e=>setTimeout(e,500))}throw d??Error('Timed out waiting for Codex to create the new thread')}},
c=async r=>{for(let e of nt())ot(e,{type:\`persisted-atom-updated\`,key:\`default-service-tier\`,value:r==null?null:r,deleted:r==null});return r??null;},
d=async({conversationId:r,serviceTier:i,source:a=\`telegram\`}={})=>{if(!r)throw Error('Missing conversationId for telegram service tier update');let o=await st(\`/local/\${r}\`,null,900),s=ct(),c=globalThis.__codexTelegramSetServiceTierRequests||(globalThis.__codexTelegramSetServiceTierRequests=new Map),l=new Promise((e,t)=>{let n=setTimeout(()=>{c.delete(s),t(Error('Timed out waiting for Codex to apply service tier'))},15e3);c.set(s,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});ot(o,{type:\`telegram-set-service-tier\`,requestId:s,conversationId:r,serviceTier:i??null,source:a});return await l},
f=async({conversationId:r=null,model:i=null,reasoningEffort:a=null}={})=>{let o=r?await st(\`/local/\${r}\`,null,900):lt(it()),s=ct(),c=globalThis.__codexTelegramSetModelAndReasoningRequests||(globalThis.__codexTelegramSetModelAndReasoningRequests=new Map),l=new Promise((e,t)=>{let n=setTimeout(()=>{c.delete(s),t(Error('Timed out waiting for Codex to apply model and reasoning'))},15e3);c.set(s,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});ot(o,{type:\`telegram-set-model-and-reasoning\`,requestId:s,conversationId:r??null,model:i,reasoningEffort:a});return await l},
g=async({conversationId:r=null,permissionMode:i=null}={})=>{let o=r?await st(\`/local/\${r}\`,null,900):lt(it()),s=ct(),c=globalThis.__codexTelegramSetPermissionModeRequests||(globalThis.__codexTelegramSetPermissionModeRequests=new Map),l=new Promise((e,t)=>{let n=setTimeout(()=>{c.delete(s),t(Error('Timed out waiting for Codex to apply permission mode'))},15e3);c.set(s,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});ot(o,{type:\`telegram-set-permission-mode\`,requestId:s,conversationId:r??null,permissionMode:i});return await l},
 h=async({conversationId:r=null,reason:i=\`telegram_current\`,windowRef:a=null,skipNavigation:o=!1,timeoutMs:s=15e3}={})=>{let c=[],l=null,u=[];if(a)c=wt2({windowRef:a});else if(!o&&r)try{let e=await st(\`/local/\${r}\`,null,900);c=wt2({windowRef:e,targetWindowId:e?.id??null,targetWebContentsId:e?.webContents?.id??null})}catch(e){l=e}else c=wt2();c.length===0&&(c=wt2());for(let e of c)try{return await it2({requestType:\`telegram-get-current-state\`,requestMap:\`__codexTelegramGetCurrentStateRequests\`,requestPayload:{conversationId:r??null,reason:i},timeoutMs:s,candidate:e})}catch(t){l=t,u.push({...xt2(e),error:t instanceof Error?t.message:String(t)})}let d=l??Error('Timed out waiting for Codex current state');d.attempts=u;throw d},
i=async({conversationId:r,input:i=[],attachments:a=[],cwd:o=null,workspaceRoots:s=[],settings:c=null}={})=>{if(!r)throw Error('Missing conversationId for telegram bound turn');let l=await st(\`/local/\${r}\`,null,900),u=ct(),d=globalThis.__codexTelegramSubmitBoundTurnRequests||(globalThis.__codexTelegramSubmitBoundTurnRequests=new Map),f=new Promise((e,t)=>{let n=setTimeout(()=>{d.delete(u),t(Error('Timed out waiting for Codex to submit the bound turn'))},15e3);d.set(u,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});ot(l,{type:\`telegram-submit-bound-turn\`,requestId:u,hostId:\`local\`,conversationId:r,input:Array.isArray(i)?i:[],attachments:Array.isArray(a)?a:[],cwd:typeof o=='string'&&o.trim().length>0?o:null,workspaceRoots:Array.isArray(s)?s.filter(e=>typeof e=='string'&&e.trim().length>0):[],settings:c});return await f},
i2=async({conversationId:r,input:i=[],attachments:a=[],cwd:o=null,workspaceRoots:s=[],settings:c=null,timeoutMs:l=15e3,targetWindowId:u=null,targetWebContentsId:d=null,windowRef:f=null}={})=>{if(!r)throw Error('Missing conversationId for telegram direct bound turn');let p=wt2({windowRef:f,targetWindowId:u,targetWebContentsId:d}),m=[],h=null;for(let e of p)try{return await it2({requestType:\`telegram-submit-bound-turn\`,requestMap:\`__codexTelegramSubmitBoundTurnRequests\`,requestPayload:{hostId:\`local\`,conversationId:r,input:Array.isArray(i)?i:[],attachments:Array.isArray(a)?a:[],cwd:typeof o=='string'&&o.trim().length>0?o:null,workspaceRoots:Array.isArray(s)?s.filter(e=>typeof e=='string'&&e.trim().length>0):[],settings:c},timeoutMs:l,candidate:e})}catch(t){h=t,m.push({...xt2(e),error:t instanceof Error?t.message:String(t)})}let g=h??Error('Timed out waiting for Codex to submit the direct bound turn');g.attempts=m;throw g},
 m=async({conversationId:r=null,approvalRequestId:i=null,decision:a=null,windowRef:o=null,timeoutMs:s=15e3}={})=>{if(!r)throw Error('Missing conversationId for telegram approval response');if(!i)throw Error('Missing approvalRequestId for telegram approval response');if(typeof a!='string'||a.trim().length===0)throw Error('Missing approval decision for telegram approval response');let c=o??await st(\`/local/\${r}\`,null,900),l=ct(),u=globalThis.__codexTelegramRespondApprovalRequests||(globalThis.__codexTelegramRespondApprovalRequests=new Map),d=new Promise((e,t)=>{let n=setTimeout(()=>{u.delete(l),t(Error('Timed out waiting for Codex approval response'))},s);u.set(l,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});ot(c,{type:\`telegram-respond-approval\`,requestId:l,conversationId:r,approvalRequestId:i,decision:a.trim()});return await d},
 ft2=async({conversationId:r=null,hostId:i=null,windowRef:a=null,targetWindowId:o=null,targetWebContentsId:s=null,timeoutMs:c=5e3}={})=>{let l=wt2({windowRef:a,targetWindowId:o,targetWebContentsId:s}),u=[],d=null;for(let e of l)try{let t=await it2({requestType:\`telegram-debug-context\`,requestMap:\`__codexTelegramDebugContextRequests\`,requestPayload:{hostId:i??\`local\`,conversationId:r??null},timeoutMs:c,candidate:e});return{context:t,attempts:[...u,{...xt2(e),ok:!0}]}}catch(t){d=t,u.push({...xt2(e),ok:!1,error:t instanceof Error?t.message:String(t)})}let f=d??Error('Timed out waiting for Codex debug context');f.attempts=u;throw f},
bt2=async({conversationId:r=null,hostId:i=null,hydrate:a=!0,windowRef:o=null,targetWindowId:s=null,targetWebContentsId:c=null,timeoutMs:l=15e3}={})=>{if(!r)throw Error('Missing conversationId for telegram child-context listing');let u=wt2({windowRef:o,targetWindowId:s,targetWebContentsId:c}),d=[],f=null;for(let e of u)try{return await it2({requestType:\`telegram-list-child-contexts\`,requestMap:\`__codexTelegramListChildContextsRequests\`,requestPayload:{hostId:i??\`local\`,conversationId:r,hydrate:a!==!1},timeoutMs:l,candidate:e})}catch(t){f=t,d.push({...xt2(e),error:t instanceof Error?t.message:String(t)})}let p=f??Error('Timed out waiting for Codex child contexts');p.attempts=d;throw p},
mt2=()=>globalThis.__fm26ThreadControllerManagedChildren||(globalThis.__fm26ThreadControllerManagedChildren=new Map),
gt2=()=>globalThis.__fm26ThreadControllerChildParentIndex||(globalThis.__fm26ThreadControllerChildParentIndex=new Map),
kt2=(e,t)=>{let n=mt2(),r=gt2(),i=n.get(e);i||(i=new Map(),n.set(e,i));let a={...(i.get(t.conversationId)??{}),...t,parentConversationId:e,conversationId:t.conversationId};return i.set(t.conversationId,a),r.set(t.conversationId,e),a},
jt2=e=>{let t=gt2().get(e);if(!t)return null;let n=mt2().get(t);return n?.get(e)??null},
Mt2=e=>{let t=mt2().get(e);return t?Array.from(t.values()).map(e=>({...e})):[]},
Nt2=(e,t,n={})=>{let r=jt2(t);return r?kt2(e??r.parentConversationId,{...r,...n,conversationId:t,parentConversationId:e??r.parentConversationId}):null},
Pt2=e=>{if(!e||typeof e!='object')return null;let t=typeof e.taskPrompt=='string'&&e.taskPrompt.trim().length>0?e.taskPrompt.trim():null,n=Number(e.turnCount);return{conversationId:e.conversationId??null,parentConversationId:e.parentConversationId??null,title:e.title??null,cwd:e.cwd??null,createdAt:e.createdAt??null,updatedAt:e.updatedAt??null,taskPrompt:t,taskTool:e.taskTool??'thread-controller-spawn',taskStatus:e.taskStatus??null,turnCount:Number.isFinite(n)?n:null,latestTurnStatus:e.latestTurnStatus??null,latestAssistantText:e.latestAssistantText??null,latestModel:e.latestModel??null,latestReasoningEffort:e.latestReasoningEffort??null,sourceParentThreadId:e.sourceParentThreadId??e.parentConversationId??null,senderThreadId:e.senderThreadId??e.parentConversationId??null,targetWindowId:e.targetWindowId??null,targetWebContentsId:e.targetWebContentsId??null,relationshipOrigin:'controller',managedByThreadController:!0,nativeChild:!1}},
pt2=async(e,t)=>{let r=new URL(e.url||'/', 'http://127.0.0.1'),a=(e.method||'GET').toUpperCase();try{if(a==='GET'&&r.pathname==='/health'){ct2({ok:!0,service:'fm26-thread-controller',pendingDraftCount:(globalThis.__fm26ThreadControllerDrafts?.size)||0},t);return}if(a!=='POST'){ct2({ok:!1,error:'Method not allowed'},t,405);return}let b=await lt2(e),u=globalThis.__fm26ThreadControllerDrafts||(globalThis.__fm26ThreadControllerDrafts=new Map);if(r.pathname==='/thread/open'){let e=et(b.workspace_root)||et(b.cwd),r=nt2(b.workspace_roots);if(!e&&r.length)e=r[0];let i=await o({prompt:et(b.prompt)||'',cwd:e||null}),a=ct(),s=new Date().toISOString();u.set(a,{handle:a,prompt:et(b.prompt)||'',cwd:e||null,workspaceRoots:r,settings:b.settings&&typeof b.settings=='object'?b.settings:null,createdAt:s,targetWindowId:i?.id??null,targetWebContentsId:i?.webContents?.id??null});ct2({ok:!0,pending_thread_handle:a,cwd:e||null,workspace_roots:r,created_at:s,target_window_id:i?.id??null,target_webcontents_id:i?.webContents?.id??null},t);return}if(r.pathname==='/thread/webcontents'){let e=wt2({targetWindowId:et(b.target_window_id)||null,targetWebContentsId:et(b.target_webcontents_id)||null}).map(xt2);ct2({ok:!0,candidates:e},t);return}if(r.pathname==='/thread/submit-first'){let e=et(b.pending_thread_handle);if(!e)st2('Missing pending_thread_handle',400,'missing_handle');let r=u.get(e);if(!r)st2('Unknown pending_thread_handle',404,'draft_not_found');let a=et(b.prompt)||et(b.text)||r.prompt||'',c=Array.isArray(b.input)?b.input:ot2(a);if(!c.length)st2('Missing input for first turn',400,'missing_input');let l=Array.isArray(b.attachments)?b.attachments:[],d=et(b.cwd)||r.cwd||null,f=nt2(b.workspace_roots);f.length||(f=Array.isArray(r.workspaceRoots)?r.workspaceRoots:[]);let p=b.settings&&typeof b.settings=='object'?b.settings:r.settings,g=await w({input:c,attachments:l,cwd:d,workspaceRoots:f,settings:p,timeoutMs:Number(b.timeout_ms)||12e4,targetWindowId:r.targetWindowId??null,targetWebContentsId:r.targetWebContentsId??null});u.delete(e);ct2({ok:!0,conversation_id:g,pending_thread_handle:e,cwd:d,workspace_roots:f,target_window_id:r.targetWindowId??null,target_webcontents_id:r.targetWebContentsId??null},t);return}if(r.pathname==='/thread/spawn-child'){let e=et(b.parent_conversation_id)||et(b.conversation_id);if(!e)st2('Missing parent_conversation_id',400,'missing_parent_conversation_id');let r=et(b.prompt)||et(b.text)||'',a=Array.isArray(b.input)?b.input:ot2(r);if(!a.length)st2('Missing input for child spawn',400,'missing_input');let o=b.settings&&typeof b.settings=='object'?{...b.settings}:{},c=null;try{c=await h({conversationId:e,reason:'fm26_spawn_child_parent_state',skipNavigation:!0,timeoutMs:Math.min(Number(b.timeout_ms)||12e4,5e3)})}catch{};typeof o.model!='string'&&typeof c?.model=='string'&&c.model.trim().length>0&&(o.model=c.model.trim());typeof o.effort!='string'&&typeof c?.reasoningEffort=='string'&&c.reasoningEffort.trim().length>0&&(o.effort=c.reasoningEffort.trim());let l=et(b.cwd)||null,p=nt2(b.workspace_roots),m=dt2(et(b.target_window_id)||null,et(b.target_webcontents_id)||null)??lt(it()),g=await s2({input:a,attachments:Array.isArray(b.attachments)?b.attachments:[],cwd:l,workspaceRoots:p,settings:o,timeoutMs:Number(b.timeout_ms)||12e4,windowRef:m}),_=new Date().toISOString(),v=kt2(e,{conversationId:g,parentConversationId:e,title:null,cwd:l,workspaceRoots:p,settings:Object.keys(o).length>0?o:null,createdAt:_,updatedAt:_,taskPrompt:r||null,taskTool:'thread-controller-spawn',taskStatus:'spawned',turnCount:1,latestTurnStatus:'submitted',latestAssistantText:null,latestModel:typeof o.model=='string'&&o.model.trim().length>0?o.model.trim():null,latestReasoningEffort:typeof o.effort=='string'&&o.effort.trim().length>0?o.effort.trim():null,sourceParentThreadId:e,senderThreadId:e,targetWindowId:m?.id??null,targetWebContentsId:m?.webContents?.id??null});ct2({ok:!0,parent_conversation_id:e,child_conversation_id:g,child:Pt2(v)},t);return}if(r.pathname==='/thread/send'){let e=et(b.conversation_id);if(!e)st2('Missing conversation_id',400,'missing_conversation_id');let r=et(b.prompt)||et(b.text)||'',a=Array.isArray(b.input)?b.input:ot2(r);if(!a.length)st2('Missing input for send',400,'missing_input');let s=Array.isArray(b.attachments)?b.attachments:[],c=et(b.cwd)||null,l=nt2(b.workspace_roots),d=b.settings&&typeof b.settings=='object'?b.settings:null,f=jt2(e);if(f){let n=null;try{n=await i2({conversationId:e,input:a,attachments:s,cwd:c||f.cwd||null,workspaceRoots:l.length?l:Array.isArray(f.workspaceRoots)?f.workspaceRoots:[],settings:d??f.settings??null,timeoutMs:Number(b.timeout_ms)||15e3,targetWindowId:f.targetWindowId??null,targetWebContentsId:f.targetWebContentsId??null})}catch(t){n=await i({conversationId:e,input:a,attachments:s,cwd:c||f.cwd||null,workspaceRoots:l.length?l:Array.isArray(f.workspaceRoots)?f.workspaceRoots:[],settings:d??f.settings??null})}let r=Number.isFinite(Number(f.turnCount))?Number(f.turnCount)+1:f.turnCount;Nt2(f.parentConversationId,e,{updatedAt:new Date().toISOString(),turnCount:r,latestTurnStatus:'submitted',latestModel:d?.model??f.latestModel??null,latestReasoningEffort:d?.effort??f.latestReasoningEffort??null});ct2({ok:!0,conversation_id:n||e},t);return}let p=await i({conversationId:e,input:a,attachments:s,cwd:c,workspaceRoots:l,settings:d});ct2({ok:!0,conversation_id:p||e},t);return}if(r.pathname==='/thread/debug-context'){let e=et(b.conversation_id)||et(b.parent_conversation_id)||null,n=await ft2({conversationId:e,hostId:et(b.host_id)||null,targetWindowId:et(b.target_window_id)||null,targetWebContentsId:et(b.target_webcontents_id)||null,timeoutMs:Number(b.timeout_ms)||5e3});ct2({ok:!0,conversation_id:e,context:n?.context??null,attempts:Array.isArray(n?.attempts)?n.attempts:[]},t);return}if(r.pathname==='/thread/state'){let e=et(b.conversation_id);if(!e)st2('Missing conversation_id',400,'missing_conversation_id');let r=await h({conversationId:e,reason:et(b.reason)||'fm26_thread_controller',skipNavigation:b.skip_navigation===!0,timeoutMs:Number(b.timeout_ms)||15e3});ct2({ok:!0,state:r||null},t);return}if(r.pathname==='/thread/children'){let e=et(b.conversation_id)||et(b.parent_conversation_id);if(!e)st2('Missing conversation_id',400,'missing_conversation_id');let n=null,r=[];try{n=await bt2({conversationId:e,hostId:et(b.host_id)||null,hydrate:b.hydrate!==!1,targetWindowId:et(b.target_window_id)||null,targetWebContentsId:et(b.target_webcontents_id)||null,timeoutMs:Number(b.timeout_ms)||15e3}),r=Array.isArray(n?.children)?n.children:[]}catch(t){if(Mt2(e).length===0)throw t}let i=new Map;for(let t of Mt2(e)){let n=Pt2(t);n&&i.set(String(n.conversationId??''),n)}for(let t of r){let n=String(t?.conversationId??'');if(!n)continue;let r=i.get(n);i.set(n,r?{...r,...t,relationshipOrigin:'native',managedByThreadController:r.managedByThreadController===!0,nativeChild:!0}:{...t,relationshipOrigin:'native',managedByThreadController:!1,nativeChild:!0})}ct2({ok:!0,conversation_id:n?.conversationId??e,children:Array.from(i.values())},t);return}if(r.pathname==='/thread/approval'){let e=et(b.conversation_id),r=et(b.approval_request_id),a=et(b.decision);if(!e)st2('Missing conversation_id',400,'missing_conversation_id');if(!r)st2('Missing approval_request_id',400,'missing_approval_request_id');if(!a)st2('Missing decision',400,'missing_decision');let s=await m({conversationId:e,approvalRequestId:r,decision:a,timeoutMs:Number(b.timeout_ms)||15e3});ct2({ok:!0,result:s||null},t);return}if(r.pathname==='/thread/ensure-open'){let e=et(b.conversation_id);if(!e)st2('Missing conversation_id',400,'missing_conversation_id');await n(e);ct2({ok:!0,conversation_id:e},t);return}ct2({ok:!1,error:'Not found'},t,404)}catch(e){ct2({ok:!1,error:e instanceof Error?e.message:String(e),attempts:Array.isArray(e?.attempts)?e.attempts:void 0,code:e?.errorCode||e?.code||null},t,Number(e?.statusCode)||500)}},
Rt3=async(e,t)=>{let r=new URL(e.url||'/', 'http://127.0.0.1'),a=(e.method||'GET').toUpperCase();if(a!=='POST'||!(r.pathname==='/thread/spawn-child'||r.pathname==='/thread/send'||r.pathname==='/thread/children'))return await pt2(e,t);let b=await lt2(e);if(r.pathname==='/thread/spawn-child'){let e=et(b.parent_conversation_id)||et(b.conversation_id);if(!e)st2('Missing parent_conversation_id',400,'missing_parent_conversation_id');let r=et(b.prompt)||et(b.text)||'',a=Array.isArray(b.input)?b.input:ot2(r);if(!a.length)st2('Missing input for child spawn',400,'missing_input');let o=b.settings&&typeof b.settings=='object'?{...b.settings}:{},c=null;try{c=await h({conversationId:e,reason:'fm26_spawn_child_parent_state',skipNavigation:!0,timeoutMs:Math.min(Number(b.timeout_ms)||12e4,5e3)})}catch{};typeof o.model!='string'&&typeof c?.model=='string'&&c.model.trim().length>0&&(o.model=c.model.trim());typeof o.effort!='string'&&typeof c?.reasoningEffort=='string'&&c.reasoningEffort.trim().length>0&&(o.effort=c.reasoningEffort.trim());let l=et(b.cwd)||null,p=nt2(b.workspace_roots),m=dt2(et(b.target_window_id)||null,et(b.target_webcontents_id)||null)??lt(it()),g=null;Et2('spawn_child_route_begin',{parentConversationId:e,cwd:l,targetWindowId:m?.id??null,targetWebContentsId:m?.webContents?.id??null});try{let t=await Ft3({windowRef:m,cwd:l,workspaceRoots:p,settings:o,parentState:c,input:a,attachments:Array.isArray(b.attachments)?b.attachments:[]});g=t.conversationId;Et2('spawn_child_route_direct_success',{parentConversationId:e,childConversationId:g})}catch(t){Et2('spawn_child_route_direct_error',{parentConversationId:e,error:t instanceof Error?t.message:String(t)});throw t}let y=new Date().toISOString(),x=kt2(e,{conversationId:g,parentConversationId:e,title:null,cwd:l,workspaceRoots:p,settings:Object.keys(o).length>0?o:null,createdAt:y,updatedAt:y,taskPrompt:r||null,taskTool:'thread-controller-spawn',taskStatus:'spawned',turnCount:1,latestTurnStatus:'submitted',latestAssistantText:null,latestModel:typeof o.model=='string'&&o.model.trim().length>0?o.model.trim():null,latestReasoningEffort:typeof o.effort=='string'&&o.effort.trim().length>0?o.effort.trim():null,sourceParentThreadId:e,senderThreadId:e,targetWindowId:m?.id??null,targetWebContentsId:m?.webContents?.id??null});ct2({ok:!0,parent_conversation_id:e,child_conversation_id:g,child:Pt2(x)},t);return}if(r.pathname==='/thread/send'){let e=et(b.conversation_id);if(!e)st2('Missing conversation_id',400,'missing_conversation_id');let r=et(b.prompt)||et(b.text)||'',a=Array.isArray(b.input)?b.input:ot2(r);if(!a.length)st2('Missing input for send',400,'missing_input');let s=Array.isArray(b.attachments)?b.attachments:[],c=et(b.cwd)||null,l=nt2(b.workspace_roots),d=b.settings&&typeof b.settings=='object'?b.settings:null,f=jt2(e);if(!f){let p=await i({conversationId:e,input:a,attachments:s,cwd:c,workspaceRoots:l,settings:d});ct2({ok:!0,conversation_id:p||e},t);return}let n=null;try{n=(await Gt3({conversationId:e,input:a,attachments:s,cwd:c||f.cwd||null,workspaceRoots:l.length?l:Array.isArray(f.workspaceRoots)?f.workspaceRoots:[],settings:d??f.settings??null,parentConversationId:f.parentConversationId,targetWindowId:f.targetWindowId??null,targetWebContentsId:f.targetWebContentsId??null})).conversationId}catch(t){try{n=await i2({conversationId:e,input:a,attachments:s,cwd:c||f.cwd||null,workspaceRoots:l.length?l:Array.isArray(f.workspaceRoots)?f.workspaceRoots:[],settings:d??f.settings??null,timeoutMs:Number(b.timeout_ms)||15e3,targetWindowId:f.targetWindowId??null,targetWebContentsId:f.targetWebContentsId??null})}catch(t){n=await i({conversationId:e,input:a,attachments:s,cwd:c||f.cwd||null,workspaceRoots:l.length?l:Array.isArray(f.workspaceRoots)?f.workspaceRoots:[],settings:d??f.settings??null})}}let r2=Number.isFinite(Number(f.turnCount))?Number(f.turnCount)+1:f.turnCount;Nt2(f.parentConversationId,e,{updatedAt:new Date().toISOString(),turnCount:r2,latestTurnStatus:'submitted',latestModel:d?.model??f.latestModel??null,latestReasoningEffort:d?.effort??f.latestReasoningEffort??null});ct2({ok:!0,conversation_id:n||e},t);return}if(r.pathname==='/thread/children'){let e=et(b.conversation_id)||et(b.parent_conversation_id);if(!e)st2('Missing conversation_id',400,'missing_conversation_id');let n=null,r=[];try{n=await bt2({conversationId:e,hostId:et(b.host_id)||null,hydrate:b.hydrate!==!1,targetWindowId:et(b.target_window_id)||null,targetWebContentsId:et(b.target_webcontents_id)||null,timeoutMs:Number(b.timeout_ms)||15e3}),r=Array.isArray(n?.children)?n.children:[]}catch(t){if(Mt2(e).length===0)throw t}let i=new Map;for(let t of Mt2(e)){let n=Pt2(t);n&&i.set(String(n.conversationId??''),n)}for(let t of r){let n=String(t?.conversationId??'');if(!n)continue;let r=i.get(n);i.set(n,r?{...r,...t,relationshipOrigin:'native',managedByThreadController:r.managedByThreadController===!0,nativeChild:!0}:{...t,relationshipOrigin:'native',managedByThreadController:!1,nativeChild:!0})}ct2({ok:!0,conversation_id:n?.conversationId??e,children:Array.from(i.values())},t);return}},
qt=()=>{if(globalThis.__fm26ThreadControllerServer)return globalThis.__fm26ThreadControllerServer;let e=Number(process.env.FM26_THREAD_CONTROLLER_PORT||8765),t=process.env.FM26_THREAD_CONTROLLER_HOST||'127.0.0.1',n=ht.createServer((e,t)=>{Rt3(e,t).catch(n=>ct2({ok:!1,error:n instanceof Error?n.message:String(n)},t,500))});return n.listen(e,t),globalThis.__fm26ThreadControllerServer=n,n},
 l=require('./telegram-native.js');
globalThis.__codexTelegramApprovalStateChangeHandler=e=>{try{return typeof l.notifyNativeTelegramApprovalStateChange=='function'?l.notifyNativeTelegramApprovalStateChange(e):null}catch(t){console.error('[telegram-native-approval-state]',t)}};
qt();
typeof l.stopNativeTelegramBridge=='function'&&qe.app.once('before-quit',()=>{l.stopNativeTelegramBridge().catch(e=>console.error('[telegram-native-stop]',e));try{globalThis.__fm26ThreadControllerServer&&globalThis.__fm26ThreadControllerServer.close()}catch(e){console.error('[fm26-thread-controller-stop]',e)}}),
l.startNativeTelegramBridge({userDataPath:t,ensureSessionOpen:n,openNewThread:o,startNewThreadTurn:s,setDefaultServiceTier:c,setThreadServiceTier:d,setModelAndReasoning:f,setPermissionMode:g,getCurrentAppState:h,submitBoundThreadTurn:i,respondToApproval:m}).catch(e=>console.error('[telegram-native]',e));
}catch(e){console.error('[telegram-native-load]',e);}`;
  const replacedBootstrap = replaceInjectedBootstrap(main, bootstrapReplacement);
  if (replacedBootstrap !== null) {
    main = replacedBootstrap;
  } else if (!main.includes("setModelAndReasoning:")) {
    main = replaceRegexOnce(
      main,
      /exports\.runMainAppStartup=\w+;/,
      match => `${bootstrapReplacement}${match}`,
      "telegram bootstrap anchor"
    );
  }

  const rendererFileName = path.basename(rendererPath);
  const rendererBridgeSymbols = resolveRendererMessageBridgeSymbols(renderer, rendererFileName);
  renderer = injectTelegramStartConversationCase(renderer, rendererFileName, rendererBridgeSymbols);
  renderer = injectTelegramStartCleanConversationCase(renderer, rendererFileName, rendererBridgeSymbols);
  renderer = injectTelegramSetServiceTierCase(renderer, rendererFileName, rendererBridgeSymbols);
  renderer = injectTelegramSetModelAndReasoningCase(renderer, rendererFileName, rendererBridgeSymbols);
  renderer = injectTelegramSetPermissionModeCase(renderer, rendererFileName, rendererBridgeSymbols);
  renderer = injectTelegramReadyPingCase(renderer, rendererFileName, rendererBridgeSymbols);
  renderer = injectTelegramGetCurrentStateCase(renderer, rendererFileName, rendererBridgeSymbols);
  renderer = injectTelegramDebugContextCase(renderer, rendererFileName, rendererBridgeSymbols);
  renderer = injectTelegramListChildContextsCase(renderer, rendererFileName, rendererBridgeSymbols);
  renderer = injectTelegramSubmitBoundTurnCase(renderer, rendererFileName, rendererBridgeSymbols);
  renderer = injectTelegramRespondApprovalCase(renderer, rendererFileName, rendererBridgeSymbols);

  if (!renderer.includes("globalThis.__codexTelegramConversationStarter=")) {
    const newConversationStarterAnchor = "be(`implement-todo`,r),null}";
    if (renderer.includes(newConversationStarterAnchor)) {
      renderer = replaceOnce(
        renderer,
        newConversationStarterAnchor,
        `globalThis.__codexTelegramConversationStarter={startConversation:e=>t.startConversation(e)};${newConversationStarterAnchor}`,
        "renderer conversation starter hook"
      );
    } else {
      const currentConversationStarterAnchor = "function ZFe(){let e=(0,Q.c)(3),t=tt(),n=x(),r;";
      if (renderer.includes(currentConversationStarterAnchor)) {
        renderer = replaceOnce(
          renderer,
          currentConversationStarterAnchor,
          "function ZFe(){let e=(0,Q.c)(3),t=tt(),n=x(),r;globalThis.__codexTelegramConversationStarter={startConversation:async e=>await t.startConversation({input:Array.isArray(e?.input)?e.input:[],attachments:Array.isArray(e?.attachments)?e.attachments:[],cwd:typeof e?.cwd==`string`&&e.cwd.trim().length>0?e.cwd:null,workspaceRoots:Array.isArray(e?.workspaceRoots)?e.workspaceRoots.filter(t=>typeof t==`string`&&t.trim().length>0):[],collaborationMode:e?.collaborationMode??null})};",
          "renderer conversation starter hook"
        );
      } else {
        renderer = replaceRegexOnce(
          renderer,
          /\{children:n\}=e,r=Nn\(\),i=On\(\),a=I\(\),o=xhe\(\),s=xt\(\),c=v\(F9\),l;/,
          (match) => `${match}globalThis.__codexTelegramConversationStarter={startConversation:e=>r.startConversation(e)};`,
          "renderer conversation starter hook"
        );
      }
    }
  }

  if (!renderer.includes("globalThis.__codexTelegramServiceTierController=")) {
    const newServiceTierAnchor = "M=po(),{serviceTierSettings:N,setServiceTier:P}=fo(c),F=d===`connected`,I=O.mode===`plan`,L;";
    if (renderer.includes(newServiceTierAnchor)) {
      renderer = replaceOnce(
        renderer,
        newServiceTierAnchor,
        `${newServiceTierAnchor}globalThis.__codexTelegramServiceTierController={conversationId:c,setServiceTier:P,serviceTierSettings:N};`,
        "renderer service tier controller hook"
      );
    } else {
      const currentServiceTierAnchor = "M=Lr(),{serviceTierSettings:N,setServiceTier:P}=Fr(s),F=u===`connected`,I=O.mode===`plan`,L;";
      if (renderer.includes(currentServiceTierAnchor)) {
        renderer = replaceOnce(
          renderer,
          currentServiceTierAnchor,
          "M=Lr(),{serviceTierSettings:N,setServiceTier:P}=Fr(s),F=u===`connected`,I=O.mode===`plan`,L;globalThis.__codexTelegramServiceTierController={conversationId:s,setServiceTier:P,serviceTierSettings:N};",
          "renderer service tier controller hook"
        );
      } else {
        renderer = replaceOnce(
          renderer,
          "R=A.mode===`plan`,z;",
          "R=A.mode===`plan`,z;globalThis.__codexTelegramServiceTierController={conversationId:c,setServiceTier:I,serviceTierSettings:F};",
          "renderer service tier controller hook"
        );
      }
    }
  }

  if (!renderer.includes("globalThis.__codexTelegramModelController=")) {
    const newModelAnchor = "let w=C,T;return t[22]!==w||t[23]!==S?(T={setModelAndReasoningEffort:S,modelSettings:w},t[22]=w,t[23]=S,t[24]=T):T=t[24],T}";
    if (renderer.includes(newModelAnchor)) {
      renderer = replaceOnce(
        renderer,
        newModelAnchor,
        "let w=C,T;globalThis.__codexTelegramModelController={conversationId:n,setModelAndReasoningEffort:S,modelSettings:w};return t[22]!==w||t[23]!==S?(T={setModelAndReasoningEffort:S,modelSettings:w},t[22]=w,t[23]=S,t[24]=T):T=t[24],T}",
        "renderer model controller hook"
      );
    } else {
      renderer = replaceOnce(
        renderer,
        "v=Fn(n,VK),y;",
        "v=Fn(n,VK),y;globalThis.__codexTelegramModelController={conversationId:n,setModelAndReasoningEffort:g,modelSettings:h};",
        "renderer model controller hook"
      );
    }
  }

  if (!renderer.includes("globalThis.__codexTelegramPermissionController=")) {
    const currentPermissionAnchor = "let Ue;return t[116]!==ze||t[117]!==He?(Ue=(0,$.jsxs)($.Fragment,{children:[ze,He]}),t[116]=ze,t[117]=He,t[118]=Ue):Ue=t[118],Ue}";
    const newPermissionAnchor = "let Ge;return t[116]!==Ve||t[117]!==We?(Ge=(0,Z.jsxs)(Z.Fragment,{children:[Ve,We]}),t[116]=Ve,t[117]=We,t[118]=Ge):Ge=t[118],Ge}";
    if (renderer.includes(currentPermissionAnchor)) {
      renderer = replaceOnce(
        renderer,
        currentPermissionAnchor,
        "globalThis.__codexTelegramPermissionController={conversationId:n,permissionMode:s,selectDefault:G,selectCustom:te,selectFullAccess:q,confirmFullAccess:Ve,applyPermissionMode:e=>{if(e==null||e===`default`||e===`auto`||e===`read-only`||e===`workspace-write`){G();return}if(e===`full-access`||e===`danger-full-access`){q();return}if(e===`custom`){te();return}throw Error(`Unsupported permission mode: ${String(e)}`)}};let Ue;return t[116]!==ze||t[117]!==He?(Ue=(0,$.jsxs)($.Fragment,{children:[ze,He]}),t[116]=ze,t[117]=He,t[118]=Ue):Ue=t[118],Ue}",
        "renderer permission controller hook"
      );
    } else if (renderer.includes(newPermissionAnchor)) {
      renderer = replaceOnce(
        renderer,
        newPermissionAnchor,
        "let Ge;globalThis.__codexTelegramPermissionController={conversationId:n,permissionMode:s,selectDefault:q,selectCustom:re,confirmFullAccess:Ue,applyPermissionMode:e=>{if(e==null||e===`default`||e===`auto`||e===`read-only`||e===`workspace-write`){q();return}if(e===`full-access`||e===`danger-full-access`){Ue();return}if(e===`custom`){re();return}throw Error(`Unsupported permission mode: ${String(e)}`)}};return t[116]!==Ve||t[117]!==We?(Ge=(0,Z.jsxs)(Z.Fragment,{children:[Ve,We]}),t[116]=Ve,t[117]=We,t[118]=Ge):Ge=t[118],Ge}",
        "renderer permission controller hook"
      );
    } else {
      renderer = replaceOnce(
        renderer,
        "t[113]=d,t[114]=We,t[115]=Ge):Ge=t[115];let Ke;",
        "t[113]=d,t[114]=We,t[115]=Ge):Ge=t[115];globalThis.__codexTelegramPermissionController={conversationId:n,permissionMode:s,selectDefault:K,selectCustom:te,confirmFullAccess:We,applyPermissionMode:e=>{if(e==null||e===`default`||e===`auto`||e===`read-only`||e===`workspace-write`){K();return}if(e===`full-access`||e===`danger-full-access`){We();return}if(e===`custom`){te();return}throw Error(`Unsupported permission mode: ${String(e)}`)}};let Ke;",
        "renderer permission controller hook"
      );
    }
  }

  if (!renderer.includes("globalThis.__codexTelegramApprovalController=")) {
    const approvalPresenceAnchor = "let ce=gt(k),le=_?.trim()??``,ue=v?.trim()??``,de=ce?.pendingSteers??[],fe=od(),pe=SQ(ce,k!=null&&Et.getSessionForConversation(k)!=null),{memberships:he,rows:ge,mentionItems:ve,firstApproval:ye}=Xme({activeConversationId:k,conversation:ce,enabled:fe,manager:A}),be=ye!=null,Se=xt(ae),Ce=ae?.type===`approval`||be,we=k!=null&&(Se||be),[Te,Ee]=(0,Z.useState)(!1),De=q(pX),Oe=ge.length>0&&!Ce&&!De&&!Te,[Ae]=aq(),{isRequired:je}=rq(),{isPending:Ne}=pq(A),";
    if (renderer.includes(approvalPresenceAnchor)) {
      renderer = replaceOnce(
        renderer,
        approvalPresenceAnchor,
        "if(typeof globalThis.__codexTelegramEmitApprovalState!=`function`){globalThis.__codexTelegramEmitApprovalState=e=>{try{let t=e&&typeof e==`object`?e:null,n=t?.approval&&typeof t.approval==`object`?{conversationId:t.approval.conversationId??t.conversationId??null,approvalRequestId:t.approval.approvalRequestId??null,callId:t.approval.callId??null,type:t.approval.type??null,approvalReason:t.approval.approvalReason??null,command:t.approval.command??null,networkApprovalContext:t.approval.networkApprovalContext??null,proposedExecpolicyAmendment:t.approval.proposedExecpolicyAmendment??null,proposedNetworkPolicyAmendments:t.approval.proposedNetworkPolicyAmendments??null,changes:t.approval.changes??null,grantRoot:t.approval.grantRoot??null}:null,r=t?.conversationId??n?.conversationId??null,o=n?`${r??``}:${n.approvalRequestId??``}:${n.type??``}`:`clear:${r??``}`;if(globalThis.__codexTelegramApprovalStateSignature===o)return;globalThis.__codexTelegramApprovalStateSignature=o;I.dispatchMessage(`telegram-approval-state-changed`,{conversationId:r,approval:n})}catch{}}}if(ae?.type!==`approval`&&globalThis.__codexTelegramApprovalController){let e=globalThis.__codexTelegramApprovalController?.conversationId??k??null;globalThis.__codexTelegramApprovalController=null;globalThis.__codexTelegramEmitApprovalState({conversationId:e,approval:null})}let ce=gt(k),le=_?.trim()??``,ue=v?.trim()??``,de=ce?.pendingSteers??[],fe=od(),pe=SQ(ce,k!=null&&Et.getSessionForConversation(k)!=null),{memberships:he,rows:ge,mentionItems:ve,firstApproval:ye}=Xme({activeConversationId:k,conversation:ce,enabled:fe,manager:A}),be=ye!=null,Se=xt(ae),Ce=ae?.type===`approval`||be,we=k!=null&&(Se||be),[Te,Ee]=(0,Z.useState)(!1),De=q(pX),Oe=ge.length>0&&!Ce&&!De&&!Te,[Ae]=aq(),{isRequired:je}=rq(),{isPending:Ne}=pq(A),",
        "renderer approval presence hook"
      );
    }

    const approvalControllerAnchor = "let x=b,S=i.approvalRequestId,C;";
    if (renderer.includes(approvalControllerAnchor)) {
      renderer = replaceOnce(
        renderer,
        approvalControllerAnchor,
        "let x=b,S=i.approvalRequestId;globalThis.__codexTelegramApprovalController={conversationId:r,approvalRequestId:S,callId:i.callId??null,type:i.type??null,snapshot:{approvalRequestId:S,callId:i.callId??null,type:i.type??null,approvalReason:i.approvalReason??null,command:i.command??null,networkApprovalContext:i.networkApprovalContext??null,proposedExecpolicyAmendment:i.proposedExecpolicyAmendment??null,proposedNetworkPolicyAmendments:i.proposedNetworkPolicyAmendments??null,changes:i.changes??null,grantRoot:i.grantRoot??null},decide:e=>{if(i.type===`exec`){let t=e===`decline`?`decline`:_pe(e,_,p);a.replyWithCommandExecutionApprovalDecision(r,S,t);return}if(i.type===`patch`){let t=e===`decline`?`decline`:vpe(e);a.replyWithFileChangeApprovalDecision(r,S,t);return}throw Error(`Unsupported approval type: ${String(i.type)}`)}};globalThis.__codexTelegramEmitApprovalState?.({conversationId:r,approval:{approvalRequestId:S,callId:i.callId??null,type:i.type??null,approvalReason:i.approvalReason??null,command:i.command??null,networkApprovalContext:i.networkApprovalContext??null,proposedExecpolicyAmendment:i.proposedExecpolicyAmendment??null,proposedNetworkPolicyAmendments:i.proposedNetworkPolicyAmendments??null,changes:i.changes??null,grantRoot:i.grantRoot??null}});let C;",
        "renderer approval controller hook"
      );
    } else {
      throw new Error("Could not find the renderer approval controller anchor");
    }
  }

  fs.writeFileSync(mainPath, main, "utf8");
  fs.writeFileSync(rendererPath, renderer, "utf8");
  fs.copyFileSync(telegramSource, telegramDest);

  return {
    extractDir,
    rendererPath,
    mutateIdentity,
  };
}

const options = parseArgs(process.argv.slice(2));
const result = injectTelegramBridge(options.extractDir, { mutateIdentity: options.mutateIdentity });
console.log(
  `INJECTED_NATIVE_TELEGRAM extract=${result.extractDir} renderer=${path.relative(result.extractDir, result.rendererPath)} mutateIdentity=${result.mutateIdentity}`
);
