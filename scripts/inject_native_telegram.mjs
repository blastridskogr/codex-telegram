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

function injectTelegramReadyPingCase(source, rendererFileName) {
  const caseSource =
    "case`telegram-ready-ping`:{try{Tr.dispatchMessage(`telegram-ready-ping-result`,{requestId:e.requestId,ok:!0})}catch(n){Er.error(`telegram_ready_ping_failed`,{safe:{requestId:e.requestId??null},sensitive:{error:n}}),Tr.dispatchMessage(`telegram-ready-ping-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}";
  return upsertRendererCase(source, "telegram-ready-ping", caseSource, rendererFileName);
}

function injectTelegramGetCurrentStateCase(source, rendererFileName) {
  const caseSource =
    "case`telegram-get-current-state`:{try{let n=globalThis.__codexTelegramModelController??null,r=globalThis.__codexTelegramServiceTierController??null,o=globalThis.__codexTelegramPermissionController??null,s=globalThis.__codexTelegramApprovalController??null,c=e.conversationId??n?.conversationId??r?.conversationId??o?.conversationId??s?.conversationId??null;if(e.conversationId&&c&&(c??null)!==(e.conversationId??null))throw Error(`Current controller state is bound to ${c??`unknown`} instead of ${e.conversationId}`);Tr.dispatchMessage(`telegram-get-current-state-result`,{requestId:e.requestId,ok:!0,state:{path:window.location?.pathname??null,conversationId:c,model:n?.modelSettings?.model??null,reasoningEffort:n?.modelSettings?.reasoningEffort??null,serviceTier:r?.serviceTierSettings?.serviceTier??null,permissionMode:o?.permissionMode??null,pendingApproval:s&&(s.conversationId??null)===(c??null)?s.snapshot??null:null}})}catch(n){Er.error(`telegram_get_current_state_failed`,{safe:{requestId:e.requestId??null,conversationId:e.conversationId??null},sensitive:{error:n}}),Tr.dispatchMessage(`telegram-get-current-state-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}";
  return upsertRendererCase(source, "telegram-get-current-state", caseSource, rendererFileName);
}

function injectTelegramSubmitBoundTurnCase(source, rendererFileName) {
  const caseSource =
    "case`telegram-submit-bound-turn`:{try{let n=i.getForHostIdOrThrowWhenDefaultHost(e.hostId??null);if(n==null)throw Error(`Conversation manager unavailable for host ${e.hostId??`local`}`);let r=e.conversationId??null,o=Array.isArray(e.input)?e.input:[],s=Array.isArray(e.attachments)?e.attachments:[];if(!r)throw Error(`Missing conversationId for telegram-submit-bound-turn`);if(o.length===0)throw Error(`Missing input for telegram-submit-bound-turn`);let c=null;for(let l=0;l<16;l++){if(c=n.getConversation(r),c)break;await new Promise(e=>setTimeout(e,250))}if(!c)throw Error(`Conversation ${r} is unavailable in the renderer`);let l=c.turns[c.turns.length-1]??null,u=typeof e.cwd==`string`&&e.cwd.trim().length>0?e.cwd:c.cwd??null,d=e.settings??null,f={conversationId:r,turnStartParams:{input:o,cwd:u,approvalPolicy:e.approvalPolicy??l?.params?.approvalPolicy??null,sandboxPolicy:e.sandboxPolicy??l?.params?.sandboxPolicy??null,model:e.model??d?.model??l?.params?.model??null,serviceTier:e.serviceTier??d?.serviceTier??l?.params?.serviceTier??null,effort:e.effort??d?.effort??l?.params?.effort??null,outputSchema:null,collaborationMode:e.collaborationMode??l?.params?.collaborationMode??c.latestCollaborationMode??null,attachments:s},isSteering:!1};await n.handleThreadFollowerStartTurn(f),Tr.dispatchMessage(`telegram-submit-bound-turn-result`,{requestId:e.requestId,ok:!0,conversationId:r})}catch(n){Er.error(`telegram_submit_bound_turn_failed`,{safe:{requestId:e.requestId??null,conversationId:e.conversationId??null},sensitive:{error:n}}),Tr.dispatchMessage(`telegram-submit-bound-turn-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}";
  return upsertRendererCase(source, "telegram-submit-bound-turn", caseSource, rendererFileName);
}

function injectTelegramRespondApprovalCase(source, rendererFileName) {
  const caseSource =
    "case`telegram-respond-approval`:{try{let n=null;for(let r=0;r<16;r++){if(n=globalThis.__codexTelegramApprovalController,n&&typeof n.decide==`function`&&(!e.conversationId||(n.conversationId??null)===(e.conversationId??null))&&(!e.approvalRequestId||(n.approvalRequestId??null)===(e.approvalRequestId??null)))break;await new Promise(t=>setTimeout(t,250))}if(!n||typeof n.decide!=`function`)throw Error(`Approval controller unavailable`);if(e.conversationId&&(n.conversationId??null)!==(e.conversationId??null))throw Error(`Approval controller is bound to ${n.conversationId??`unknown`} instead of ${e.conversationId}`);if(e.approvalRequestId&&(n.approvalRequestId??null)!==(e.approvalRequestId??null))throw Error(`Approval controller is bound to ${n.approvalRequestId??`unknown`} instead of ${e.approvalRequestId}`);let r=typeof e.decision==`string`?e.decision.trim():``;if(!r)throw Error(`Missing approval decision`);await n.decide(r),Tr.dispatchMessage(`telegram-respond-approval-result`,{requestId:e.requestId,ok:!0,conversationId:n.conversationId??e.conversationId??null,approvalRequestId:n.approvalRequestId??e.approvalRequestId??null,decision:r})}catch(n){Er.error(`telegram_respond_approval_failed`,{safe:{requestId:e.requestId??null,conversationId:e.conversationId??null,approvalRequestId:e.approvalRequestId??null},sensitive:{error:n}}),Tr.dispatchMessage(`telegram-respond-approval-result`,{requestId:e.requestId,ok:!1,error:n instanceof Error?n.message:String(n)})}break bb3}";
  return upsertRendererCase(source, "telegram-respond-approval", caseSource, rendererFileName);
}

function renderMainIpcTelegramResultHandlers(payloadVar) {
  return `if(${payloadVar}.type===\`telegram-start-conversation-result\`){let n=globalThis.__codexTelegramStartConversationRequests;if(n){let r=n.get(${payloadVar}.requestId);r&&(n.delete(${payloadVar}.requestId),${payloadVar}.ok?r.resolve(${payloadVar}.conversationId):r.reject(Error(${payloadVar}.error||\`Failed to create conversation\`)))}return}if(${payloadVar}.type===\`telegram-set-service-tier-result\`){let n=globalThis.__codexTelegramSetServiceTierRequests;if(n){let r=n.get(${payloadVar}.requestId);r&&(n.delete(${payloadVar}.requestId),${payloadVar}.ok?r.resolve(${payloadVar}.conversationId??null):r.reject(Error(${payloadVar}.error||\`Failed to set service tier\`)))}return}if(${payloadVar}.type===\`telegram-set-model-and-reasoning-result\`){let n=globalThis.__codexTelegramSetModelAndReasoningRequests;if(n){let r=n.get(${payloadVar}.requestId);r&&(n.delete(${payloadVar}.requestId),${payloadVar}.ok?r.resolve({conversationId:${payloadVar}.conversationId??null,model:${payloadVar}.model??null,reasoningEffort:${payloadVar}.reasoningEffort??null}):r.reject(Error(${payloadVar}.error||\`Failed to set model and reasoning\`)))}return}if(${payloadVar}.type===\`telegram-set-permission-mode-result\`){let n=globalThis.__codexTelegramSetPermissionModeRequests;if(n){let r=n.get(${payloadVar}.requestId);r&&(n.delete(${payloadVar}.requestId),${payloadVar}.ok?r.resolve({conversationId:${payloadVar}.conversationId??null,permissionMode:${payloadVar}.permissionMode??null}):r.reject(Error(${payloadVar}.error||\`Failed to set permission mode\`)))}return}if(${payloadVar}.type===\`telegram-ready-ping-result\`){let n=globalThis.__codexTelegramReadyPingRequests;if(n){let r=n.get(${payloadVar}.requestId);r&&(n.delete(${payloadVar}.requestId),${payloadVar}.ok?r.resolve(!0):r.reject(Error(${payloadVar}.error||\`Failed to confirm renderer readiness\`)))}return}if(${payloadVar}.type===\`telegram-get-current-state-result\`){let n=globalThis.__codexTelegramGetCurrentStateRequests;if(n){let r=n.get(${payloadVar}.requestId);r&&(n.delete(${payloadVar}.requestId),${payloadVar}.ok?r.resolve(${payloadVar}.state??null):r.reject(Error(${payloadVar}.error||\`Failed to read current state\`)))}return}if(${payloadVar}.type===\`telegram-submit-bound-turn-result\`){let n=globalThis.__codexTelegramSubmitBoundTurnRequests;if(n){let r=n.get(${payloadVar}.requestId);r&&(n.delete(${payloadVar}.requestId),${payloadVar}.ok?r.resolve(${payloadVar}.conversationId??null):r.reject(Error(${payloadVar}.error||\`Failed to submit the bound turn\`)))}return}if(${payloadVar}.type===\`telegram-respond-approval-result\`){let n=globalThis.__codexTelegramRespondApprovalRequests;if(n){let r=n.get(${payloadVar}.requestId);r&&(n.delete(${payloadVar}.requestId),${payloadVar}.ok?r.resolve({conversationId:${payloadVar}.conversationId??null,approvalRequestId:${payloadVar}.approvalRequestId??null,decision:${payloadVar}.decision??null}):r.reject(Error(${payloadVar}.error||\`Failed to respond to approval\`)))}return}if(${payloadVar}.type===\`telegram-approval-state-changed\`){let n=globalThis.__codexTelegramApprovalStateChangeHandler;typeof n==\`function\`&&Promise.resolve(n({conversationId:${payloadVar}.conversationId??null,approval:${payloadVar}.approval??null})).catch(e=>console.error('[telegram-native-approval-state]',e));return}`;
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

const bootstrapReplacement = `try{
let qe=require('electron'),
rt=require('node:crypto'),
pt=require('node:path'),
tt='codex_desktop:message-for-view',
t=process.env.CODEX_PORTABLE_USER_DATA_DIR||qe.app.getPath('userData')||pt.join(process.env.LOCALAPPDATA||qe.app.getPath('appData'),'CodexPortableData'),
nt=()=>qe.BrowserWindow.getAllWindows().filter(e=>e&&!e.isDestroyed()&&e.webContents&&!e.webContents.isDestroyed()),
it=()=>{let e=nt()[0]??null;if(!e)throw Error('Failed to find a Codex window');return e;},
at=e=>{if(e.isMinimized())e.restore();e.show();e.focus();return e;},
lt=(e,{restoreMinimized:n=!1,foreground:r=!1}={})=>{n&&e.isMinimized()&&e.restore();return r?at(e):e;},
ot=(e,n)=>{e.webContents.send(tt,n);},
st=async(e,n=null,r=750,{foreground:i=!1,restoreMinimized:a=!1}={})=>{let o=lt(it(),{restoreMinimized:a,foreground:i});ot(o,{type:\`navigate-to-route\`,path:e,state:n});await new Promise(e=>setTimeout(e,r));return o;},
n=async r=>{if(!r)return;await st(\`/local/\${r}\`,null,750);},
o=async({prompt:r,cwd:i}={})=>{let a={focusComposerNonce:Date.now()};typeof r=='string'&&r.trim().length>0&&(a.prefillPrompt=r),typeof i=='string'&&i.trim().length>0&&(a.prefillCwd=i),await st('/',a,750,{foreground:!0,restoreMinimized:!0});},
ct=()=>typeof rt.randomUUID=='function'?rt.randomUUID():\`\${Date.now()}-\${Math.random().toString(16).slice(2)}\`,
vt=async({windowRef:r=null,timeoutMs:i=1500}={})=>{let a=r??lt(it()),o=ct(),s=globalThis.__codexTelegramReadyPingRequests||(globalThis.__codexTelegramReadyPingRequests=new Map),c=new Promise((e,t)=>{let n=setTimeout(()=>{s.delete(o),t(Error('Timed out waiting for Codex view readiness'))},i);s.set(o,{resolve:()=>{clearTimeout(n),e(!0)},reject:e=>{clearTimeout(n),t(e)}})});ot(a,{type:\`telegram-ready-ping\`,requestId:o});return await c},
ut=async({windowRef:r=null,maxAttempts:i=6,timeoutMs:a=1500,delayMs:o=250}={})=>{let s=null,c=r??lt(it());for(let l=0;l<i;l++)try{return await vt({windowRef:c,timeoutMs:a})}catch(e){if(s=e,l===i-1)break;await new Promise(e=>setTimeout(e,o))}throw s??Error('Timed out waiting for Codex view readiness')},
s=async({input:r,attachments:i=[],cwd:a=null,workspaceRoots:o=[],settings:s=null}={})=>{let c=lt(it()),l=ct(),u=globalThis.__codexTelegramStartConversationRequests||(globalThis.__codexTelegramStartConversationRequests=new Map),d=Array.isArray(o)?o.filter(e=>typeof e=='string'&&e.trim().length>0):[],f=typeof a=='string'&&a.trim().length>0?a:d[0]??null,p=null;if(s&&((typeof s.model=='string'&&s.model.trim().length>0)||(typeof s.effort=='string'&&s.effort.trim().length>0))){p={mode:\`default\`,settings:{model:typeof s.model=='string'&&s.model.trim().length>0?s.model.trim():null,reasoning_effort:typeof s.effort=='string'&&s.effort.trim().length>0?s.effort.trim():null,developer_instructions:null}}}let m=new Promise((e,t)=>{let n=setTimeout(()=>{u.delete(l),t(Error('Timed out waiting for Codex to create the new thread'))},3e4);u.set(l,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});ot(c,{type:\`telegram-start-conversation\`,requestId:l,input:Array.isArray(r)?r:[],attachments:Array.isArray(i)?i:[],cwd:f,workspaceRoots:d,collaborationMode:p});return await m},
c=async r=>{for(let e of nt())ot(e,{type:\`persisted-atom-updated\`,key:\`default-service-tier\`,value:r==null?null:r,deleted:r==null});return r??null;},
d=async({conversationId:r,serviceTier:i,source:a=\`telegram\`}={})=>{if(!r)throw Error('Missing conversationId for telegram service tier update');let o=await st(\`/local/\${r}\`,null,900),s=ct(),c=globalThis.__codexTelegramSetServiceTierRequests||(globalThis.__codexTelegramSetServiceTierRequests=new Map),l=new Promise((e,t)=>{let n=setTimeout(()=>{c.delete(s),t(Error('Timed out waiting for Codex to apply service tier'))},15e3);c.set(s,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});ot(o,{type:\`telegram-set-service-tier\`,requestId:s,conversationId:r,serviceTier:i??null,source:a});return await l},
f=async({conversationId:r=null,model:i=null,reasoningEffort:a=null}={})=>{let o=r?await st(\`/local/\${r}\`,null,900):lt(it()),s=ct(),c=globalThis.__codexTelegramSetModelAndReasoningRequests||(globalThis.__codexTelegramSetModelAndReasoningRequests=new Map),l=new Promise((e,t)=>{let n=setTimeout(()=>{c.delete(s),t(Error('Timed out waiting for Codex to apply model and reasoning'))},15e3);c.set(s,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});ot(o,{type:\`telegram-set-model-and-reasoning\`,requestId:s,conversationId:r??null,model:i,reasoningEffort:a});return await l},
g=async({conversationId:r=null,permissionMode:i=null}={})=>{let o=r?await st(\`/local/\${r}\`,null,900):lt(it()),s=ct(),c=globalThis.__codexTelegramSetPermissionModeRequests||(globalThis.__codexTelegramSetPermissionModeRequests=new Map),l=new Promise((e,t)=>{let n=setTimeout(()=>{c.delete(s),t(Error('Timed out waiting for Codex to apply permission mode'))},15e3);c.set(s,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});ot(o,{type:\`telegram-set-permission-mode\`,requestId:s,conversationId:r??null,permissionMode:i});return await l},
h=async({conversationId:r=null,reason:i=\`telegram_current\`,windowRef:a=null,skipNavigation:o=!1,timeoutMs:s=15e3}={})=>{let c=a??(o?lt(it()):r?await st(\`/local/\${r}\`,null,900):lt(it())),l=ct(),u=globalThis.__codexTelegramGetCurrentStateRequests||(globalThis.__codexTelegramGetCurrentStateRequests=new Map),d=new Promise((e,t)=>{let n=setTimeout(()=>{u.delete(l),t(Error('Timed out waiting for Codex current state'))},s);u.set(l,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});ot(c,{type:\`telegram-get-current-state\`,requestId:l,conversationId:r??null,reason:i});return await d},
i=async({conversationId:r,input:i=[],attachments:a=[],cwd:o=null,workspaceRoots:s=[],settings:c=null}={})=>{if(!r)throw Error('Missing conversationId for telegram bound turn');let l=await st(\`/local/\${r}\`,null,900),u=ct(),d=globalThis.__codexTelegramSubmitBoundTurnRequests||(globalThis.__codexTelegramSubmitBoundTurnRequests=new Map),f=new Promise((e,t)=>{let n=setTimeout(()=>{d.delete(u),t(Error('Timed out waiting for Codex to submit the bound turn'))},15e3);d.set(u,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});ot(l,{type:\`telegram-submit-bound-turn\`,requestId:u,hostId:\`local\`,conversationId:r,input:Array.isArray(i)?i:[],attachments:Array.isArray(a)?a:[],cwd:typeof o=='string'&&o.trim().length>0?o:null,workspaceRoots:Array.isArray(s)?s.filter(e=>typeof e=='string'&&e.trim().length>0):[],settings:c});return await f},
m=async({conversationId:r=null,approvalRequestId:i=null,decision:a=null,windowRef:o=null,timeoutMs:s=15e3}={})=>{if(!r)throw Error('Missing conversationId for telegram approval response');if(!i)throw Error('Missing approvalRequestId for telegram approval response');if(typeof a!='string'||a.trim().length===0)throw Error('Missing approval decision for telegram approval response');let c=o??await st(\`/local/\${r}\`,null,900),l=ct(),u=globalThis.__codexTelegramRespondApprovalRequests||(globalThis.__codexTelegramRespondApprovalRequests=new Map),d=new Promise((e,t)=>{let n=setTimeout(()=>{u.delete(l),t(Error('Timed out waiting for Codex approval response'))},s);u.set(l,{resolve:r=>{clearTimeout(n),e(r)},reject:e=>{clearTimeout(n),t(e)}})});ot(c,{type:\`telegram-respond-approval\`,requestId:l,conversationId:r,approvalRequestId:i,decision:a.trim()});return await d},
l=require('./telegram-native.js');
globalThis.__codexTelegramApprovalStateChangeHandler=e=>{try{return typeof l.notifyNativeTelegramApprovalStateChange=='function'?l.notifyNativeTelegramApprovalStateChange(e):null}catch(t){console.error('[telegram-native-approval-state]',t)}};
typeof l.stopNativeTelegramBridge=='function'&&qe.app.once('before-quit',()=>{l.stopNativeTelegramBridge().catch(e=>console.error('[telegram-native-stop]',e))}),
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
  renderer = injectTelegramStartConversationCase(renderer, rendererFileName);
  renderer = injectTelegramSetServiceTierCase(renderer, rendererFileName);
  renderer = injectTelegramSetModelAndReasoningCase(renderer, rendererFileName);
  renderer = injectTelegramSetPermissionModeCase(renderer, rendererFileName);
  renderer = injectTelegramReadyPingCase(renderer, rendererFileName);
  renderer = injectTelegramGetCurrentStateCase(renderer, rendererFileName);
  renderer = injectTelegramSubmitBoundTurnCase(renderer, rendererFileName);
  renderer = injectTelegramRespondApprovalCase(renderer, rendererFileName);

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
