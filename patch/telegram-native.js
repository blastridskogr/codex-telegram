"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const net = require("node:net");
const crypto = require("node:crypto");

const DEFAULT_PIPE = "\\\\.\\pipe\\codex-ipc";
const DEFAULT_POLL_TIMEOUT_SEC = 30;
const DEFAULT_MAX_REPLY_CHARS = 3500;
const DEFAULT_RECENT_SESSION_LIMIT = 10;
const DEFAULT_SESSION_HISTORY_REPLAY_PAIR_LIMIT = 5;
const DEFAULT_SESSION_REPLAY_SEND_DELAY_MS = 250;
const DEFAULT_CHAT_SETTINGS_FILE = "chat_settings.json";
const DEFAULT_PENDING_NEW_THREAD_FILE = "pending_new_thread.json";
const DEFAULT_IPC_CONNECT_TIMEOUT_MS = 30000;
const DEFAULT_IPC_RETRY_DELAY_MS = 500;
const DEFAULT_TURN_INJECT_RETRY_COUNT = 3;
const DEFAULT_TURN_INJECT_RETRY_DELAY_MS = 900;
const DEFAULT_TURN_DELIVERY_ACK_TIMEOUT_MS = 17000;
const DEFAULT_APPROVAL_SYNC_DELAY_MS = 400;
const DEFAULT_LABEL = "Default";
const DEFAULT_PERMISSION_LABEL = "Basic permission";
const FAST_OPTIONS = [
    { id: "standard", label: "Standard", value: null },
    { id: "fast", label: "Fast", value: "fast" },
];
const PERMISSION_MODE_OPTIONS = [
    { id: "default", label: "Default permissions", value: null },
    { id: "full-access", label: "Full access", value: "full-access" },
    { id: "custom", label: "Custom (config.toml)", value: "custom" },
];
const CODEX_COMMANDS = [
    { command: "codex_help", description: "Show Codex Telegram commands." },
    { command: "codex_controls", description: "Open the Codex control panel." },
    { command: "codex_current", description: "Show the current Codex app state." },
    { command: "codex_new", description: "Open a real Codex New Thread draft in the app." },
    { command: "codex_session", description: "Pick the active Codex session." },
    { command: "codex_bind", description: "Bind this chat to a Codex session." },
    { command: "codex_bindindex", description: "Bind this chat using a recent session index." },
    { command: "codex_model", description: "Pick the Codex model." },
    { command: "codex_fast", description: "Pick the Codex Fast mode." },
    { command: "codex_reasoning", description: "Pick the Codex reasoning effort." },
    { command: "codex_permission", description: "Pick the Codex permission mode." },
    { command: "codex_unbind", description: "Unbind this chat from the current Codex session." },
];
const SANDBOX_OPTIONS = [
    { id: "default", label: DEFAULT_PERMISSION_LABEL, value: null },
    { id: "danger-full-access", label: "Full access", value: "danger-full-access" },
    { id: "workspace-write", label: "Workspace write", value: "workspace-write" },
    { id: "read-only", label: "Read only", value: "read-only" },
];
const REASONING_LABELS = {
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
};
const START_MESSAGE = "Codex Portable Telegram is online. Use /help for general commands and /codex_help for Codex controls.";
const HELP_MESSAGE = [
    "General commands:",
    "/start - show the startup message",
    "/help - show general commands",
    "/status - show runtime status",
    "/codex_help - show Codex control commands",
    "",
    "Codex controls are exposed only through /codex_* commands.",
].join("\n");
const UNAUTHORIZED_MESSAGE = "This Telegram chat is not allowed to control the Codex Portable Telegram runtime.";
const NO_SESSION_MESSAGE = "This chat is not bound to a Codex session. Use /codex_session or /codex_bind <session_id>.";
const NO_SESSION_PICKER_MESSAGE = "This chat is not bound to a Codex session. Pick a recent session below or use /codex_bind <session_id>.";

function formatError(error) {
    if (error instanceof Error) {
        if (error.codexIpcError != null) {
            const payload = safeJsonStringify(error.codexIpcError);
            return `${error.stack || error.message}\nIPC payload: ${payload}`;
        }
        return error.stack || error.message;
    }
    if (error && typeof error === "object") {
        return safeJsonStringify(error);
    }
    return String(error);
}

function safeJsonStringify(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function normalizeIpcErrorPayload(payload) {
    if (payload == null) {
        return { message: "IPC request failed.", code: null, payload: null };
    }
    if (payload instanceof Error) {
        return {
            message: payload.message || "IPC request failed.",
            code: typeof payload.code === "string" ? payload.code : null,
            payload,
        };
    }
    if (typeof payload === "string") {
        return { message: payload, code: null, payload };
    }
    if (typeof payload === "object") {
        const code = typeof payload.code === "string"
            ? payload.code
            : typeof payload.errorCode === "string"
                ? payload.errorCode
                : typeof payload.type === "string"
                    ? payload.type
                    : null;
        const message = typeof payload.message === "string"
            ? payload.message
            : typeof payload.error === "string"
                ? payload.error
                : typeof payload.description === "string"
                    ? payload.description
                    : null;
        const summary = [code, message].filter(Boolean).join(": ");
        return {
            message: summary || safeJsonStringify(payload),
            code,
            payload,
        };
    }
    return { message: String(payload), code: null, payload };
}

function isRetryableTurnInjectError(error) {
    const code = String(error?.code || "").toLowerCase();
    const message = String(error?.message || error || "").toLowerCase();
    return code.includes("no-client-found")
        || code.includes("no_client_found")
        || message.includes("no-client-found")
        || message.includes("no client found")
        || message.includes("client not found")
        || message.includes("unavailable in the renderer")
        || (message.includes("timed out") && message.includes("bound turn"));
}

function appendBootstrapLog(message) {
    const bootstrapLogPath = path.join(process.env.TEMP || os.tmpdir(), "codex-telegram-bootstrap.log");
    try {
        fs.appendFileSync(bootstrapLogPath, `${new Date().toISOString()} ${message}\n`, "utf8");
    } catch {}
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function readUtf8Text(filePath) {
    return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

function readJsonObject(filePath, fallback = {}) {
    try {
        return JSON.parse(readUtf8Text(filePath));
    } catch {
        return { ...fallback };
    }
}

function writeJsonObject(filePath, value) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function updateCodexPersistedAtomState(filePath, key, value) {
    const payload = readJsonObject(filePath, {});
    const atomState = payload["electron-persisted-atom-state"] && typeof payload["electron-persisted-atom-state"] === "object"
        ? { ...payload["electron-persisted-atom-state"] }
        : {};
    if (value == null) {
        delete atomState[key];
    } else {
        atomState[key] = value;
    }
    payload["electron-persisted-atom-state"] = atomState;
    writeJsonObject(filePath, payload);
    return value == null ? null : atomState[key] ?? null;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
    const args = { configPath: null, dryRun: false };
    for (let i = 2; i < argv.length; i += 1) {
        const part = argv[i];
        if (part === "--config") {
            args.configPath = argv[i + 1] || null;
            i += 1;
            continue;
        }
        if (part === "--dry-run") {
            args.dryRun = true;
        }
    }
    return args;
}

function resolvePath(baseDir, candidate, fallbackRelative = null) {
    const value = candidate || fallbackRelative;
    if (!value) {
        return null;
    }
    if (path.isAbsolute(value)) {
        return path.normalize(value);
    }
    return path.resolve(baseDir, value);
}

function loadConfig(configPath) {
    if (!configPath) {
        throw new Error("Missing --config <path>.");
    }
    const absoluteConfigPath = path.resolve(configPath);
    const baseDir = path.dirname(absoluteConfigPath);
    const raw = readUtf8Text(absoluteConfigPath);
    const parsed = JSON.parse(raw);

    const stateDir = resolvePath(baseDir, parsed.stateDir, "./state");
    const bindingsPath = resolvePath(baseDir, parsed.bindingsPath, "./state/chat_bindings.json");
    const telegramInboxDir = resolvePath(baseDir, parsed.telegramInboxDir, "./telegram-inbox");
    const logPath = resolvePath(baseDir, parsed.logPath, "./logs/app.log");
    const workspaceRoots = Array.isArray(parsed.workspaceRoots)
        ? parsed.workspaceRoots.map((item) => resolvePath(baseDir, item)).filter(Boolean)
        : [];
    const codexHome = process.env.CODEX_HOME
        ? path.resolve(process.env.CODEX_HOME)
        : path.join(os.homedir(), ".codex");

    return {
        configPath: absoluteConfigPath,
        baseDir,
        telegramBotToken: String(parsed.telegramBotToken || "").trim(),
        allowedChatIds: new Set((parsed.allowedChatIds || []).map((item) => String(item).trim()).filter(Boolean)),
        stateDir,
        bindingsPath,
        telegramInboxDir,
        logPath,
        pollTimeoutSec: Number(parsed.pollTimeoutSec || DEFAULT_POLL_TIMEOUT_SEC),
        maxReplyChars: Number(parsed.maxReplyChars || DEFAULT_MAX_REPLY_CHARS),
        defaultLanguage: String(parsed.defaultLanguage || "ko").trim().toLowerCase(),
        codexIpcPipe: String(parsed.codexIpcPipe || DEFAULT_PIPE),
        workspaceRoots,
        codexHome,
        codexGlobalStatePath: path.join(codexHome, ".codex-global-state.json"),
        defaultSettings: {
            model: parsed.defaultSettings?.model ?? null,
            serviceTier: parsed.defaultSettings?.serviceTier ?? null,
            effort: parsed.defaultSettings?.effort ?? null,
            permissionMode: normalizePermissionMode(parsed.defaultSettings?.permissionMode ?? inferPermissionModeFromSandboxValue(parsed.defaultSettings?.sandbox)),
            sandbox: parsed.defaultSettings?.sandbox ?? null,
        },
    };
}

function splitReplyChunks(text, limit) {
    const trimmed = String(text || "").trim();
    if (!trimmed) {
        return ["(empty response)"];
    }
    if (trimmed.length <= limit) {
        return [trimmed];
    }

    const chunks = [];
    let remaining = trimmed;
    while (remaining.length > limit) {
        let splitAt = remaining.lastIndexOf("\n\n", limit);
        if (splitAt < Math.max(200, Math.floor(limit / 3))) {
            splitAt = remaining.lastIndexOf("\n", limit);
        }
        if (splitAt < Math.max(200, Math.floor(limit / 3))) {
            splitAt = remaining.lastIndexOf(" ", limit);
        }
        if (splitAt < Math.max(100, Math.floor(limit / 4))) {
            splitAt = limit;
        }
        const chunk = remaining.slice(0, splitAt).trim();
        if (chunk) {
            chunks.push(chunk);
        }
        remaining = remaining.slice(splitAt).trim();
    }
    if (remaining) {
        chunks.push(remaining);
    }
    return chunks;
}

function escapeTelegramHtml(text) {
    return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function escapeTelegramHtmlAttribute(text) {
    return escapeTelegramHtml(text).replace(/"/g, "&quot;");
}

function splitMarkdownBlocks(text) {
    const blocks = [];
    const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
    if (!normalized) {
        return blocks;
    }

    const codeFencePattern = /```[\s\S]*?```/g;
    let lastIndex = 0;
    let match;
    while ((match = codeFencePattern.exec(normalized)) !== null) {
        const before = normalized.slice(lastIndex, match.index);
        for (const part of before.split(/\n{2,}/)) {
            const trimmed = part.trim();
            if (trimmed) {
                blocks.push(trimmed);
            }
        }
        const fenced = match[0].trim();
        if (fenced) {
            blocks.push(fenced);
        }
        lastIndex = match.index + match[0].length;
    }

    const tail = normalized.slice(lastIndex);
    for (const part of tail.split(/\n{2,}/)) {
        const trimmed = part.trim();
        if (trimmed) {
            blocks.push(trimmed);
        }
    }
    return blocks;
}

function splitOversizedMarkdownBlock(block, limit) {
    const trimmed = String(block || "").trim();
    if (!trimmed) {
        return [];
    }
    if (!trimmed.startsWith("```") || trimmed.length <= limit) {
        return splitReplyChunks(trimmed, limit);
    }

    const lines = trimmed.split("\n");
    const openingFence = lines[0];
    const closingFence = lines[lines.length - 1] === "```" ? "```" : openingFence.startsWith("```") ? "```" : "";
    const bodyLines = closingFence ? lines.slice(1, -1) : lines.slice(1);
    const chunks = [];
    let current = [];

    const flush = () => {
        const candidate = [openingFence, ...current, closingFence].filter(Boolean).join("\n");
        if (candidate.trim()) {
            chunks.push(candidate);
        }
        current = [];
    };

    for (const line of bodyLines) {
        const next = [...current, line];
        const candidate = [openingFence, ...next, closingFence].filter(Boolean).join("\n");
        if (candidate.length > limit && current.length > 0) {
            flush();
        }
        current.push(line);
    }
    if (current.length > 0) {
        flush();
    }
    return chunks.length > 0 ? chunks : splitReplyChunks(trimmed, limit);
}

function splitMarkdownForTelegram(text, limit) {
    const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
    if (!normalized) {
        return [];
    }
    if (normalized.length <= limit) {
        return [normalized];
    }

    const blocks = splitMarkdownBlocks(normalized);
    const chunks = [];
    let current = "";

    const flush = () => {
        const trimmed = current.trim();
        if (trimmed) {
            chunks.push(trimmed);
        }
        current = "";
    };

    for (const block of blocks) {
        const candidate = current ? `${current}\n\n${block}` : block;
        if (candidate.length <= limit) {
            current = candidate;
            continue;
        }
        if (current) {
            flush();
        }
        if (block.length <= limit) {
            current = block;
            continue;
        }
        const oversized = splitOversizedMarkdownBlock(block, limit);
        for (const part of oversized) {
            if (part.length <= limit) {
                chunks.push(part);
            } else {
                chunks.push(...splitReplyChunks(part, limit));
            }
        }
    }
    if (current) {
        flush();
    }
    return chunks.length > 0 ? chunks : splitReplyChunks(normalized, limit);
}

function renderMarkdownChunkToTelegramHtml(markdown) {
    const placeholders = [];
    const pushPlaceholder = (html) => {
        const token = `@@TGHTML${placeholders.length}@@`;
        placeholders.push(html);
        return token;
    };

    let text = String(markdown || "").replace(/\r\n/g, "\n");

    text = text.replace(/```([A-Za-z0-9_+-]*)\n?([\s\S]*?)```/g, (_, language, code) => {
        const safeCode = escapeTelegramHtml(String(code || "").replace(/^\n/, "").replace(/\n$/, ""));
        const classAttr = language ? ` class="language-${escapeTelegramHtmlAttribute(language)}"` : "";
        return pushPlaceholder(`<pre><code${classAttr}>${safeCode}</code></pre>`);
    });

    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
        return pushPlaceholder(`<code>${escapeTelegramHtml(code)}</code>`);
    });

    text = escapeTelegramHtml(text);

    text = text.replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, (_, content) => `<b>${String(content || "").trim()}</b>`);
    text = text.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>");
    text = text.replace(/__([^_\n]+?)__/g, "<b>$1</b>");
    text = text.replace(/\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
        return `<a href="${escapeTelegramHtmlAttribute(url)}">${label}</a>`;
    });
    text = text.replace(/^&gt;\s?(.*)$/gm, (_, quote) => `<blockquote>${quote}</blockquote>`);

    return text.replace(/@@TGHTML(\d+)@@/g, (_, index) => placeholders[Number(index)] || "");
}

function buildAssistantTelegramMessages(text, limit) {
    const body = String(text || "").trim();
    if (!body) {
        return [{ text: "[Codex Response]", parseMode: null }];
    }
    const safeLimit = Math.max(500, Number(limit || DEFAULT_MAX_REPLY_CHARS) - 400);
    return splitMarkdownForTelegram(body, safeLimit).map((chunk) => ({
        text: renderMarkdownChunkToTelegramHtml(chunk),
        parseMode: "HTML",
    }));
}

function labelForOption(options, value) {
    const match = (options || []).find((option) => option.value === value);
    return match ? match.label : (value == null ? DEFAULT_LABEL : String(value));
}

function normalizePermissionMode(value) {
    if (value == null) {
        return null;
    }
    const normalized = String(value).trim().toLowerCase();
    if (!normalized || normalized === "default" || normalized === "auto") {
        return null;
    }
    if (normalized === "danger-full-access" || normalized === "full-access") {
        return "full-access";
    }
    if (normalized === "custom") {
        return "custom";
    }
    return normalized;
}

function permissionModeToSandboxValue(permissionMode) {
    const normalized = normalizePermissionMode(permissionMode);
    if (normalized === "full-access") {
        return "danger-full-access";
    }
    return null;
}

function inferPermissionModeFromSandboxValue(sandbox) {
    if (sandbox === "danger-full-access") {
        return "full-access";
    }
    return null;
}

function formatPermissionLabel(settings) {
    const permissionMode = normalizePermissionMode(settings?.permissionMode ?? inferPermissionModeFromSandboxValue(settings?.sandbox));
    if (permissionMode != null || settings?.sandbox == null) {
        return labelForOption(PERMISSION_MODE_OPTIONS, permissionMode);
    }
    return `${labelForOption(SANDBOX_OPTIONS, settings.sandbox)} (legacy)`;
}

function normalizeChatSettings(raw) {
    const permissionMode = normalizePermissionMode(raw?.permissionMode ?? inferPermissionModeFromSandboxValue(raw?.sandbox));
    return {
        model: raw?.model ?? null,
        serviceTier: raw?.serviceTier ?? null,
        effort: raw?.effort ?? null,
        permissionMode,
        sandbox: raw?.sandbox ?? permissionModeToSandboxValue(permissionMode),
    };
}

function extractTextParts(content) {
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .filter((part) => part && part.type === "text")
        .map((part) => part.text || "")
        .join("")
        .trim();
}

function extractImageUrls(content) {
    if (!Array.isArray(content)) {
        return [];
    }
    return content
        .map((part) => {
            if (!part) {
                return null;
            }
            if (part.type === "image" && part.url) {
                return String(part.url).trim();
            }
            if (part.type === "localImage" && part.path) {
                return String(part.path).trim();
            }
            return null;
        })
        .filter(Boolean);
}

function normalizeFilePathFromUrl(urlValue) {
    const value = String(urlValue || "").trim();
    if (!value) {
        return null;
    }
    if (value.startsWith("file://")) {
        try {
            const parsed = new URL(value);
            let pathname = decodeURIComponent(parsed.pathname || "");
            if (/^\/[A-Za-z]:/.test(pathname)) {
                pathname = pathname.slice(1);
            }
            return path.normalize(pathname);
        } catch {
            return null;
        }
    }
    if (path.isAbsolute(value)) {
        return path.normalize(value);
    }
    return null;
}

function extractInputImageRefs(input) {
    if (!Array.isArray(input)) {
        return [];
    }
    return input
        .map((item) => {
            if (!item) {
                return null;
            }
            if (item.type === "image" && item.url) {
                return String(item.url).trim();
            }
            if (item.type === "localImage" && item.path) {
                return String(item.path).trim();
            }
            return null;
        })
        .filter(Boolean);
}

function buildNativeImageTurnPayload(staged, caption) {
    const prompt = String(caption || "").trim();
    const input = [];
    if (prompt) {
        input.push({ type: "text", text: prompt, text_elements: [] });
    }
    input.push({ type: "localImage", path: staged.filePath });
    return {
        prompt,
        input,
        attachments: [],
    };
}

function truncatePlainText(text, limit = 500) {
    const normalized = String(text || "").trim().replace(/\s+/g, " ");
    if (normalized.length <= limit) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function summarizeApprovalField(value, limit = 500) {
    if (value == null) {
        return "";
    }
    if (typeof value === "string") {
        return truncatePlainText(value, limit);
    }
    return truncatePlainText(safeJsonStringify(value), limit);
}

function normalizePendingApproval(raw, conversationId = null) {
    if (!raw || typeof raw !== "object") {
        return null;
    }
    const approvalRequestId = String(raw.approvalRequestId || "").trim();
    if (!approvalRequestId) {
        return null;
    }
    const type = String(raw.type || "").trim().toLowerCase() === "patch" ? "patch" : "exec";
    const networkApprovalContext = raw.networkApprovalContext && typeof raw.networkApprovalContext === "object"
        ? {
            host: raw.networkApprovalContext.host != null ? String(raw.networkApprovalContext.host) : null,
        }
        : null;
    const proposedNetworkPolicyAmendments = Array.isArray(raw.proposedNetworkPolicyAmendments)
        ? raw.proposedNetworkPolicyAmendments
            .filter((entry) => entry && typeof entry === "object")
            .map((entry) => ({
                action: entry.action != null ? String(entry.action) : null,
                host: entry.host != null ? String(entry.host) : null,
                hostPattern: entry.hostPattern != null ? String(entry.hostPattern) : null,
            }))
        : [];
    const changes = raw.changes && typeof raw.changes === "object"
        ? { ...raw.changes }
        : null;
    return {
        conversationId: raw.conversationId != null ? String(raw.conversationId) : (conversationId != null ? String(conversationId) : null),
        approvalRequestId,
        callId: raw.callId != null ? String(raw.callId) : null,
        type,
        approvalReason: raw.approvalReason != null ? String(raw.approvalReason) : null,
        command: raw.command != null ? String(raw.command) : null,
        networkApprovalContext,
        proposedExecpolicyAmendment: raw.proposedExecpolicyAmendment ?? null,
        proposedNetworkPolicyAmendments,
        changes,
        grantRoot: raw.grantRoot != null ? String(raw.grantRoot) : null,
        allowForSession: type === "exec"
            && proposedNetworkPolicyAmendments.some((entry) => String(entry?.action || "").trim().toLowerCase() === "allow"),
    };
}

function parseApprovalCallbackData(data) {
    const match = /^approval:(acceptForSession|accept|decline):(.+)$/.exec(String(data || "").trim());
    if (!match) {
        return null;
    }
    return {
        decision: match[1],
        approvalRequestId: match[2],
    };
}

function sanitizeFileName(name, fallback = "attachment") {
    const normalized = String(name || "").trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
    return normalized || fallback;
}

function getTelegramPhotoVariant(photoSizes) {
    if (!Array.isArray(photoSizes) || photoSizes.length === 0) {
        return null;
    }
    return [...photoSizes].sort((a, b) => {
        const aArea = Number(a?.width || 0) * Number(a?.height || 0);
        const bArea = Number(b?.width || 0) * Number(b?.height || 0);
        return bArea - aArea;
    })[0] || null;
}

function isImageDocument(document) {
    const mimeType = String(document?.mime_type || "");
    return mimeType.startsWith("image/");
}

function guessMimeType(filePath) {
    switch (path.extname(String(filePath || "")).toLowerCase()) {
        case ".png":
            return "image/png";
        case ".webp":
            return "image/webp";
        case ".gif":
            return "image/gif";
        case ".bmp":
            return "image/bmp";
        case ".svg":
            return "image/svg+xml";
        case ".jpg":
        case ".jpeg":
        default:
            return "image/jpeg";
    }
}

function truncatePreview(text, limit = 72) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (!normalized) {
        return "(no preview)";
    }
    if (normalized.length <= limit) {
        return normalized;
    }
    return `${normalized.slice(0, limit - 3)}...`;
}

function truncateButtonLabel(text, limit = 32) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (!normalized) {
        return "session";
    }
    if (normalized.length <= limit) {
        return normalized;
    }
    return `${normalized.slice(0, limit - 3)}...`;
}

function truncateTitle(text, limit = 56) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (!normalized) {
        return "(untitled session)";
    }
    if (normalized.length <= limit) {
        return normalized;
    }
    return `${normalized.slice(0, limit - 3)}...`;
}

function extractSessionIdFromName(fileName) {
    const match = String(fileName || "").match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return match ? match[1] : null;
}

const SESSION_CATALOG_HEAD_BYTES = 256 * 1024;
const SESSION_CATALOG_TAIL_BYTES = 256 * 1024;

function readFileTailUtf8(filePath, maxBytes = SESSION_CATALOG_TAIL_BYTES) {
    const stats = fs.statSync(filePath);
    const length = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, "r");
    try {
        fs.readSync(fd, buffer, 0, length, stats.size - length);
    } finally {
        fs.closeSync(fd);
    }
    return buffer.toString("utf8");
}

function readFileHeadUtf8(filePath, maxBytes = SESSION_CATALOG_HEAD_BYTES) {
    const stats = fs.statSync(filePath);
    const length = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, "r");
    try {
        fs.readSync(fd, buffer, 0, length, 0);
    } finally {
        fs.closeSync(fd);
    }
    return buffer.toString("utf8");
}

function extractSessionText(parsed) {
    if (parsed?.type === "event_msg" && parsed?.payload?.type === "user_message") {
        return String(parsed.payload.message || "").trim();
    }
    if (parsed?.type === "response_item" && parsed?.payload?.type === "message" && parsed?.payload?.role === "user") {
        const content = Array.isArray(parsed.payload.content) ? parsed.payload.content : [];
        return content
            .filter((part) => part?.type === "input_text")
            .map((part) => part.text || "")
            .join("")
            .trim();
    }
    return "";
}

function shouldIgnoreSessionText(text) {
    return /AGENTS\.md instructions|<permissions instructions>|<app-context>|<INSTRUCTIONS>|<environment_context>|<collaboration_mode>|<personality_spec>/i.test(String(text || ""));
}

function buildSessionHistoryText(parsed) {
    const payload = parsed?.payload || {};
    const baseText = String(payload.message || "").trim();
    const markers = [];
    if (Array.isArray(payload.images) && payload.images.length) {
        markers.push(`[images: ${payload.images.length}]`);
    }
    if (Array.isArray(payload.attachments) && payload.attachments.length) {
        markers.push(`[attachments: ${payload.attachments.length}]`);
    }
    return [baseText, ...markers].filter(Boolean).join("\n").trim();
}

function extractHistoryEntry(parsed) {
    if (parsed?.type !== "event_msg") {
        return null;
    }
    const payload = parsed?.payload || {};
    const kind = payload.type;
    let role = null;
    let text = "";
    let phase = null;
    let isFinalSummary = false;
    if (kind === "user_message" || kind === "agent_message") {
        text = buildSessionHistoryText(parsed);
        role = kind === "agent_message" ? "assistant" : "user";
        phase = typeof payload.phase === "string" ? payload.phase : null;
    } else if (kind === "task_complete" && payload.last_agent_message) {
        text = String(payload.last_agent_message || "").trim();
        role = "assistant";
        phase = "task_complete";
        isFinalSummary = true;
    } else {
        return null;
    }
    if (!text || shouldIgnoreSessionText(text)) {
        return null;
    }
    const timestamp = parsed?.timestamp ? new Date(parsed.timestamp) : null;
    return {
        role,
        text,
        timestamp: timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp : null,
        phase,
        isFinalSummary,
    };
}

function extractTitleFromSessionHead(head) {
    const lines = head.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
        try {
            const text = extractSessionText(JSON.parse(line));
            if (text) {
                if (shouldIgnoreSessionText(text)) {
                    continue;
                }
                return truncateTitle(text);
            }
        } catch {}
    }
    return "(untitled session)";
}

function formatSessionTimestamp(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function shouldTreatAsReplayResult(entry, preferTaskComplete = false) {
    if (entry?.role !== "assistant") {
        return false;
    }
    if (preferTaskComplete) {
        return !!entry?.isFinalSummary;
    }
    return !!entry?.isFinalSummary || entry?.phase === "final_answer";
}

function buildReplayFallbackResultEntry(entries) {
    const assistantEntries = Array.isArray(entries)
        ? entries.filter((entry) => entry?.role === "assistant" && entry?.text)
        : [];
    if (!assistantEntries.length) {
        return null;
    }
    if (assistantEntries.length === 1) {
        return assistantEntries[0];
    }
    const lastEntry = assistantEntries[assistantEntries.length - 1];
    return {
        ...lastEntry,
        text: assistantEntries
            .map((entry) => String(entry?.text || "").trim())
            .filter(Boolean)
            .join("\n\n")
            .trim(),
        phase: "commentary_block",
    };
}

function buildSessionReplaySelection(history) {
    const groups = [];
    const pendingUserEntries = [];
    const pendingAssistantEntries = [];
    const preferTaskComplete = (history || []).some((entry) => entry?.isFinalSummary);
    const flushPartialGroup = () => {
        const resultEntry = buildReplayFallbackResultEntry(pendingAssistantEntries);
        if (!pendingUserEntries.length || !resultEntry) {
            return false;
        }
        groups.push({
            userEntries: pendingUserEntries.splice(0, pendingUserEntries.length),
            resultEntry,
            isPartial: true,
        });
        pendingAssistantEntries.splice(0, pendingAssistantEntries.length);
        return true;
    };
    for (const entry of history || []) {
        if (entry?.role === "user") {
            if (pendingUserEntries.length && pendingAssistantEntries.length) {
                flushPartialGroup();
            }
            pendingUserEntries.push(entry);
            continue;
        }
        if (entry?.role !== "assistant" || !pendingUserEntries.length) {
            continue;
        }
        if (!shouldTreatAsReplayResult(entry, preferTaskComplete)) {
            pendingAssistantEntries.push(entry);
            continue;
        }
        groups.push({
            userEntries: pendingUserEntries.splice(0, pendingUserEntries.length),
            resultEntry: entry,
            isPartial: false,
        });
        pendingAssistantEntries.splice(0, pendingAssistantEntries.length);
    }
    flushPartialGroup();
    return {
        groups: groups
            .filter((group) => Array.isArray(group?.userEntries) && group.userEntries.length && group?.resultEntry)
            .slice(-DEFAULT_SESSION_HISTORY_REPLAY_PAIR_LIMIT),
    };
}

function extractPreviewFromSessionTail(tail) {
    const lines = tail.split(/\r?\n/).filter(Boolean).reverse();
    let fallback = "";
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line);
            const text = extractSessionText(parsed);
            if (text) {
                return truncatePreview(text);
            }
            if (!fallback) {
                const entry = extractHistoryEntry(parsed);
                if (entry?.text) {
                    fallback = entry.text;
                }
            }
        } catch {}
    }
    return truncatePreview(fallback);
}

function buildSandboxPolicy(kind, workspaceRoots) {
    if (!kind) {
        return null;
    }
    if (kind === "full-access") {
        kind = "danger-full-access";
    }
    if (kind === "danger-full-access") {
        return { type: "danger-full-access" };
    }
    if (kind === "read-only") {
        return {
            type: "read-only",
            access: { type: "full-access" },
            network_access: true,
        };
    }
    if (kind === "workspace-write") {
        return {
            type: "workspace-write",
            writable_roots: workspaceRoots,
            read_only_access: { type: "full-access" },
            network_access: true,
            exclude_tmpdir_env_var: false,
            exclude_slash_tmp: false,
        };
    }
    return null;
}

function flattenConversationMessages(conversationState) {
    const messages = [];
    for (const turn of conversationState.turns || []) {
        const turnId = turn.turnId || null;
        const turnStatus = turn.status || null;
        for (const item of turn.items || []) {
            if (!item || !item.id) {
                continue;
            }
            if (item.type === "userMessage" || item.type === "steeringUserMessage") {
                const text = extractTextParts(item.content);
                const images = extractImageUrls(item.content);
                const attachments = Array.isArray(item.attachments) ? item.attachments : [];
                if (text || images.length || attachments.length) {
                    messages.push({ id: item.id, role: "user", text, images, attachments, turnId, turnStatus });
                }
            } else if (item.type === "agentMessage") {
                const text = String(item.text || "").trim();
                if (text) {
                    messages.push({ id: item.id, role: "assistant", text, images: [], attachments: [], turnId, turnStatus });
                }
            }
        }
    }
    return messages;
}

function buildMirrorFingerprint(message) {
    const text = String(message?.text || "").trim();
    const images = Array.isArray(message?.images) ? message.images.map((value) => path.basename(normalizeFilePathFromUrl(value) || String(value))).sort() : [];
    const attachments = Array.isArray(message?.attachments)
        ? message.attachments.map((item) => path.basename(item?.fsPath || item?.path || item?.label || "")).filter(Boolean).sort()
        : [];
    return JSON.stringify({ text, images, attachments });
}

function clonePatchValue(value) {
    if (!value || typeof value !== "object") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => clonePatchValue(entry));
    }
    const cloned = {};
    for (const [key, entry] of Object.entries(value)) {
        cloned[key] = clonePatchValue(entry);
    }
    return cloned;
}

function createPatchContainer(nextSegment) {
    return typeof nextSegment === "number" || nextSegment === "-" ? [] : {};
}

function applyConversationPatch(baseState, patch) {
    const op = String(patch?.op || "");
    const pathSegments = Array.isArray(patch?.path) ? patch.path : [];
    if (!pathSegments.length) {
        if (op === "remove") {
            return {};
        }
        if (op === "add" || op === "replace") {
            return clonePatchValue(patch?.value);
        }
        return baseState;
    }

    let state = baseState;
    if (!state || typeof state !== "object") {
        state = {};
    }

    let target = state;
    for (let index = 0; index < pathSegments.length - 1; index += 1) {
        const rawKey = pathSegments[index];
        const nextSegment = pathSegments[index + 1];
        if (Array.isArray(target)) {
            const key = rawKey === "-" ? target.length : Number(rawKey);
            if (!Number.isInteger(key) || key < 0) {
                return state;
            }
            if (!target[key] || typeof target[key] !== "object") {
                target[key] = createPatchContainer(nextSegment);
            }
            target = target[key];
            continue;
        }

        const key = String(rawKey);
        if (!target[key] || typeof target[key] !== "object") {
            target[key] = createPatchContainer(nextSegment);
        }
        target = target[key];
    }

    const leafSegment = pathSegments[pathSegments.length - 1];
    if (Array.isArray(target)) {
        const key = leafSegment === "-" ? target.length : Number(leafSegment);
        if (!Number.isInteger(key) || key < 0) {
            return state;
        }
        if (op === "remove") {
            if (key < target.length) {
                target.splice(key, 1);
            }
            return state;
        }
        const nextValue = clonePatchValue(patch?.value);
        if (op === "add") {
            if (key <= target.length) {
                target.splice(key, 0, nextValue);
            } else {
                target[key] = nextValue;
            }
            return state;
        }
        if (op === "replace") {
            target[key] = nextValue;
        }
        return state;
    }

    const key = String(leafSegment);
    if (op === "remove") {
        delete target[key];
        return state;
    }
    if (op === "add" || op === "replace") {
        target[key] = clonePatchValue(patch?.value);
    }
    return state;
}

function applyConversationPatches(baseState, patches) {
    let nextState = baseState && typeof baseState === "object" ? baseState : {};
    for (const patch of Array.isArray(patches) ? patches : []) {
        nextState = applyConversationPatch(nextState, patch);
    }
    return nextState;
}

class OutputLogger {
    constructor(filePath) {
        this.filePath = filePath;
        ensureDir(path.dirname(filePath));
    }

    write(level, message) {
        const line = `${new Date().toISOString()} [${level}] ${message}`;
        fs.appendFileSync(this.filePath, `${line}\n`, "utf8");
        if (level === "error") {
            console.error(line);
        } else {
            console.log(line);
        }
    }

    info(message) { this.write("info", message); }
    warn(message) { this.write("warn", message); }
    error(message) { this.write("error", message); }
}

function migrateLegacyConfigToPortable(userDataPath) {
    const portableConfigPath = path.join(userDataPath, "telegram-native.json");
    appendBootstrapLog(`[migrate] userDataPath=${userDataPath} portableConfigPath=${portableConfigPath}`);
    if (fs.existsSync(portableConfigPath)) {
        appendBootstrapLog(`[migrate] portable config exists path=${portableConfigPath}`);
        return portableConfigPath;
    }

    const legacyBaseDir = path.join(os.homedir(), "AppData", "Roaming", "Codex");
    const legacyConfigPath = process.env.CODEX_TELEGRAM_NATIVE_LEGACY_CONFIG || path.join(legacyBaseDir, "telegram-native.json");
    if (!fs.existsSync(legacyConfigPath)) {
        appendBootstrapLog(`[migrate] legacy config missing path=${legacyConfigPath}`);
        return portableConfigPath;
    }

    try {
        const legacy = JSON.parse(readUtf8Text(legacyConfigPath));
        const stateDir = path.join(userDataPath, "telegram-native-state");
        const bindingsPath = path.join(stateDir, "chat_bindings.json");
        const telegramInboxDir = path.join(userDataPath, "telegram-native-inbox");
        const logPath = path.join(userDataPath, "telegram-native.log");

        ensureDir(userDataPath);
        ensureDir(stateDir);
        ensureDir(telegramInboxDir);

        const migrated = {
            telegramBotToken: legacy.telegramBotToken || "",
            allowedChatIds: Array.isArray(legacy.allowedChatIds) ? legacy.allowedChatIds : [],
            stateDir,
            bindingsPath,
            telegramInboxDir,
            logPath,
            pollTimeoutSec: Number(legacy.pollTimeoutSec || DEFAULT_POLL_TIMEOUT_SEC),
            maxReplyChars: Number(legacy.maxReplyChars || DEFAULT_MAX_REPLY_CHARS),
            defaultLanguage: String(legacy.defaultLanguage || "ko").trim().toLowerCase(),
            codexIpcPipe: String(legacy.codexIpcPipe || DEFAULT_PIPE),
            workspaceRoots: Array.isArray(legacy.workspaceRoots) ? legacy.workspaceRoots : [],
            defaultSettings: {
                model: legacy.defaultSettings?.model ?? null,
                serviceTier: legacy.defaultSettings?.serviceTier ?? null,
                effort: legacy.defaultSettings?.effort ?? null,
                permissionMode: normalizePermissionMode(legacy.defaultSettings?.permissionMode ?? inferPermissionModeFromSandboxValue(legacy.defaultSettings?.sandbox)),
                sandbox: legacy.defaultSettings?.sandbox ?? null,
            },
        };

        const legacyBindingsPath = typeof legacy.bindingsPath === "string" && legacy.bindingsPath.trim()
            ? legacy.bindingsPath
            : path.join(legacyBaseDir, "telegram-native-state", "chat_bindings.json");

        if (fs.existsSync(legacyBindingsPath) && !fs.existsSync(bindingsPath)) {
            fs.copyFileSync(legacyBindingsPath, bindingsPath);
        }

        fs.writeFileSync(portableConfigPath, JSON.stringify(migrated, null, 2), "utf8");
        appendBootstrapLog(`[migrate] wrote portable config path=${portableConfigPath}`);
    } catch (error) {
        appendBootstrapLog(`[migrate-error] ${formatError(error)}`);
        console.error("[telegram-native-migrate]", formatError(error));
    }

    return portableConfigPath;
}

class SessionBindings {
    constructor(filePath) {
        this.filePath = filePath;
        this.chatToSession = {};
        this.load();
    }

    load() {
        if (!fs.existsSync(this.filePath)) {
            this.chatToSession = {};
            return;
        }
        try {
            const payload = JSON.parse(readUtf8Text(this.filePath));
            const mapping = payload.chat_to_session || {};
            this.chatToSession = Object.fromEntries(Object.entries(mapping).map(([chatId, sessionId]) => [String(chatId), String(sessionId)]));
        } catch {
            this.chatToSession = {};
        }
    }

    save() {
        ensureDir(path.dirname(this.filePath));
        fs.writeFileSync(this.filePath, JSON.stringify({ chat_to_session: this.chatToSession }, null, 2), "utf8");
    }

    getSession(chatId) {
        return this.chatToSession[String(chatId)] || null;
    }

    getChatIdForSession(sessionId) {
        for (const [chatId, existingSessionId] of Object.entries(this.chatToSession)) {
            if (existingSessionId === sessionId) {
                return chatId;
            }
        }
        return null;
    }

    bind(chatId, sessionId) {
        const normalizedChatId = String(chatId);
        const normalizedSessionId = String(sessionId).trim();
        for (const [existingChatId, existingSessionId] of Object.entries(this.chatToSession)) {
            if (existingSessionId === normalizedSessionId && existingChatId !== normalizedChatId) {
                return { ok: false, message: `Session ${normalizedSessionId} is already bound to chat ${existingChatId}.` };
            }
        }
        this.chatToSession[normalizedChatId] = normalizedSessionId;
        this.save();
        return { ok: true, message: `Bound this chat to session ${normalizedSessionId}.` };
    }

    unbind(chatId) {
        const normalizedChatId = String(chatId);
        const removed = this.chatToSession[normalizedChatId];
        if (!removed) {
            return { ok: false, message: "This chat is not bound to any Codex session." };
        }
        delete this.chatToSession[normalizedChatId];
        this.save();
        return { ok: true, message: `Unbound this chat from session ${removed}.` };
    }
}

class ChatSettingsStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.chatSettings = {};
        this.load();
    }

    load() {
        if (!fs.existsSync(this.filePath)) {
            this.chatSettings = {};
            return;
        }
        try {
            const payload = JSON.parse(readUtf8Text(this.filePath));
            this.chatSettings = payload.chat_settings || {};
        } catch {
            this.chatSettings = {};
        }
    }

    save() {
        ensureDir(path.dirname(this.filePath));
        fs.writeFileSync(this.filePath, JSON.stringify({ chat_settings: this.chatSettings }, null, 2), "utf8");
    }

    get(chatId) {
        return normalizeChatSettings(this.chatSettings[String(chatId)] || {});
    }

    update(chatId, patch) {
        const normalizedChatId = String(chatId);
        this.chatSettings[normalizedChatId] = {
            ...this.get(normalizedChatId),
            ...patch,
        };
        this.save();
        return this.get(normalizedChatId);
    }
}

class PendingNewThreadStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.pendingByChat = {};
        this.load();
    }

    load() {
        if (!fs.existsSync(this.filePath)) {
            this.pendingByChat = {};
            return;
        }
        try {
            const payload = JSON.parse(readUtf8Text(this.filePath));
            this.pendingByChat = payload.pending_new_thread || {};
        } catch {
            this.pendingByChat = {};
        }
    }

    save() {
        ensureDir(path.dirname(this.filePath));
        fs.writeFileSync(this.filePath, JSON.stringify({ pending_new_thread: this.pendingByChat }, null, 2), "utf8");
    }

    get(chatId) {
        return this.pendingByChat[String(chatId)] || null;
    }

    set(chatId, patch = {}) {
        const normalizedChatId = String(chatId);
        this.pendingByChat[normalizedChatId] = {
            active: true,
            updatedAt: new Date().toISOString(),
            ...this.pendingByChat[normalizedChatId],
            ...patch,
        };
        this.save();
        return this.pendingByChat[normalizedChatId];
    }

    clear(chatId) {
        const normalizedChatId = String(chatId);
        if (!(normalizedChatId in this.pendingByChat)) {
            return false;
        }
        delete this.pendingByChat[normalizedChatId];
        this.save();
        return true;
    }
}

class ModelCatalog {
    constructor(codexHome, logger) {
        this.codexHome = codexHome;
        this.logger = logger;
        this.modelsPath = path.join(this.codexHome, "models_cache.json");
        this.configPath = path.join(this.codexHome, "config.toml");
        this.cachedAtMs = 0;
        this.modelOptions = [{ id: "default", label: DEFAULT_LABEL, value: null }];
        this.modelMap = new Map();
        this.defaultModel = null;
        this.defaultEffort = null;
        this.refresh();
    }

    refresh() {
        const now = Date.now();
        if (now - this.cachedAtMs < 5000) {
            return;
        }
        this.cachedAtMs = now;
        this.defaultModel = this.readConfiguredValue("model");
        this.defaultEffort = this.readConfiguredValue("model_reasoning_effort");
        this.modelOptions = [{ id: "default", label: DEFAULT_LABEL, value: null }];
        this.modelMap = new Map();
        const models = this.readModels();
        for (const model of models) {
            this.modelMap.set(model.slug, model);
            this.modelOptions.push({
                id: model.slug,
                label: model.display_name || model.slug,
                value: model.slug,
            });
        }
        if (this.defaultModel && !this.modelMap.has(this.defaultModel)) {
            this.modelOptions.splice(1, 0, {
                id: this.defaultModel,
                label: this.defaultModel,
                value: this.defaultModel,
            });
            this.modelMap.set(this.defaultModel, {
                slug: this.defaultModel,
                display_name: this.defaultModel,
                default_reasoning_level: this.defaultEffort || "medium",
                supported_reasoning_levels: [],
            });
        }
    }

    readModels() {
        try {
            const raw = fs.readFileSync(this.modelsPath, "utf8");
            const parsed = JSON.parse(raw);
            return (parsed.models || [])
                .filter((model) => model && (model.visibility === "list" || model.slug === this.defaultModel))
                .sort((a, b) => Number(a.priority ?? 9999) - Number(b.priority ?? 9999));
        } catch (error) {
            this.logger.warn(`model catalog load failed: ${formatError(error)}`);
            return [];
        }
    }

    readConfiguredValue(key) {
        try {
            const raw = fs.readFileSync(this.configPath, "utf8");
            const match = raw.match(new RegExp(`^${key}\\s*=\\s*\"([^\"]+)\"`, "m"));
            return match ? match[1] : null;
        } catch {
            return null;
        }
    }

    getCurrentModel(selectedModel) {
        this.refresh();
        return selectedModel || this.defaultModel || null;
    }

    getCurrentEffort(selectedEffort, selectedModel) {
        this.refresh();
        if (selectedEffort) {
            return selectedEffort;
        }
        const model = this.modelMap.get(this.getCurrentModel(selectedModel));
        return model?.default_reasoning_level || this.defaultEffort || null;
    }

    getModelOptions() {
        this.refresh();
        return this.modelOptions.slice();
    }

    getSelectableModelOptions() {
        return this.getModelOptions().filter((option) => option.value != null);
    }

    getEffortOptions(selectedModel) {
        this.refresh();
        const model = this.modelMap.get(this.getCurrentModel(selectedModel));
        const levels = (model?.supported_reasoning_levels || []).map((level) => level.effort);
        const uniqueLevels = [...new Set(levels)];
        const options = [{ id: "default", label: DEFAULT_LABEL, value: null }];
        for (const effort of uniqueLevels) {
            options.push({
                id: effort,
                label: REASONING_LABELS[effort] || effort,
                value: effort,
            });
        }
        if (options.length === 1) {
            for (const effort of ["low", "medium", "high", "xhigh"]) {
                options.push({
                    id: effort,
                    label: REASONING_LABELS[effort] || effort,
                    value: effort,
                });
            }
        }
        return options;
    }

    getSelectableEffortOptions(selectedModel) {
        return this.getEffortOptions(selectedModel).filter((option) => option.value != null);
    }
}

class SessionCatalog {
    constructor(codexHome, logger) {
        this.codexHome = codexHome;
        this.logger = logger;
        this.sessionsRoot = path.join(this.codexHome, "sessions");
    }

    collectSessionFiles() {
        if (!fs.existsSync(this.sessionsRoot)) {
            return [];
        }
        const files = [];
        const walk = (dir, depth = 0) => {
            if (depth > 4) {
                return;
            }
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath, depth + 1);
                    continue;
                }
                if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
                    continue;
                }
                const sessionId = extractSessionIdFromName(entry.name);
                if (!sessionId) {
                    continue;
                }
                files.push({ filePath: fullPath, sessionId, mtimeMs: fs.statSync(fullPath).mtimeMs });
            }
        };

        try {
            walk(this.sessionsRoot);
        } catch (error) {
            this.logger.warn(`session catalog walk failed: ${formatError(error)}`);
            return [];
        }
        return files;
    }

    describeSessionEntry(entry) {
        try {
            const head = readFileHeadUtf8(entry.filePath);
            const tail = readFileTailUtf8(entry.filePath);
            return {
                sessionId: entry.sessionId,
                filePath: entry.filePath,
                modifiedAt: new Date(entry.mtimeMs),
                title: extractTitleFromSessionHead(head),
                preview: extractPreviewFromSessionTail(tail),
            };
        } catch (error) {
            this.logger.warn(`session catalog parse failed for ${entry.filePath}: ${formatError(error)}`);
            return {
                sessionId: entry.sessionId,
                filePath: entry.filePath,
                modifiedAt: new Date(entry.mtimeMs),
                title: "(untitled session)",
                preview: "(preview unavailable)",
            };
        }
    }

    listRecentSessions(limit = DEFAULT_RECENT_SESSION_LIMIT) {
        const files = this.collectSessionFiles();
        const uniqueFiles = [];
        const seenSessionIds = new Set();
        for (const entry of files.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
            if (seenSessionIds.has(entry.sessionId)) {
                continue;
            }
            seenSessionIds.add(entry.sessionId);
            uniqueFiles.push(entry);
        }

        return uniqueFiles
            .slice(0, limit)
            .map((entry) => this.describeSessionEntry(entry));
    }

    findSessionEntry(sessionId) {
        if (!sessionId) {
            return null;
        }
        const files = this.collectSessionFiles()
            .filter((entry) => entry.sessionId === sessionId)
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
        if (!files.length) {
            return null;
        }
        return this.describeSessionEntry(files[0]);
    }

    readSessionHistory(sessionId) {
        const entry = this.findSessionEntry(sessionId);
        if (!entry) {
            return { session: null, history: [] };
        }
        const history = [];
        try {
            const raw = fs.readFileSync(entry.filePath, "utf8");
            for (const line of raw.split(/\r?\n/)) {
                if (!line.trim()) {
                    continue;
                }
                try {
                    const item = extractHistoryEntry(JSON.parse(line));
                    if (item) {
                        history.push(item);
                    }
                } catch {}
            }
        } catch (error) {
            this.logger.warn(`session history read failed for ${entry.filePath}: ${formatError(error)}`);
        }
        return { session: entry, history };
    }
}

class TelegramApi {
    constructor(token) {
        this.token = token;
        this.basePath = `/bot${token}/`;
        this.fileBasePath = `/file/bot${token}/`;
    }

    call(method, payload = {}) {
        const body = new URLSearchParams();
        for (const [key, value] of Object.entries(payload)) {
            if (value == null) {
                continue;
            }
            body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
        }
        const encoded = body.toString();
        return new Promise((resolve, reject) => {
            const request = https.request({
                hostname: "api.telegram.org",
                path: `${this.basePath}${method}`,
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Content-Length": Buffer.byteLength(encoded),
                },
            }, (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("end", () => {
                    const raw = Buffer.concat(chunks).toString("utf8");
                    try {
                        const parsed = JSON.parse(raw);
                        if (!parsed.ok) {
                            reject(new Error(`Telegram API error: ${raw}`));
                            return;
                        }
                        resolve(parsed.result);
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            request.on("error", reject);
            request.write(encoded);
            request.end();
        });
    }

    callMultipart(method, fields, fileFieldName, filePath, fileName, contentType = "application/octet-stream") {
        const boundary = `----CodexAppDirect${crypto.randomUUID().replace(/-/g, "")}`;
        const chunks = [];
        const push = (value) => chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8"));

        for (const [key, value] of Object.entries(fields || {})) {
            if (value == null) {
                continue;
            }
            push(`--${boundary}\r\n`);
            push(`Content-Disposition: form-data; name="${key}"\r\n\r\n`);
            push(typeof value === "object" ? JSON.stringify(value) : String(value));
            push("\r\n");
        }

        if (fileFieldName && filePath) {
            push(`--${boundary}\r\n`);
            push(`Content-Disposition: form-data; name="${fileFieldName}"; filename="${sanitizeFileName(fileName || path.basename(filePath))}"\r\n`);
            push(`Content-Type: ${contentType}\r\n\r\n`);
            push(fs.readFileSync(filePath));
            push("\r\n");
        }

        push(`--${boundary}--\r\n`);
        const body = Buffer.concat(chunks);

        return new Promise((resolve, reject) => {
            const request = https.request({
                hostname: "api.telegram.org",
                path: `${this.basePath}${method}`,
                method: "POST",
                headers: {
                    "Content-Type": `multipart/form-data; boundary=${boundary}`,
                    "Content-Length": body.length,
                },
            }, (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("end", () => {
                    const raw = Buffer.concat(chunks).toString("utf8");
                    try {
                        const parsed = JSON.parse(raw);
                        if (!parsed.ok) {
                            reject(new Error(`Telegram API error: ${raw}`));
                            return;
                        }
                        resolve(parsed.result);
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            request.on("error", reject);
            request.write(body);
            request.end();
        });
    }

    getUpdates(offset, timeoutSec) {
        const payload = { timeout: timeoutSec };
        if (offset != null) {
            payload.offset = offset;
        }
        return this.call("getUpdates", payload);
    }

    getFile(fileId) {
        return this.call("getFile", { file_id: fileId });
    }

    setMyCommands(commands, scope = null) {
        const payload = { commands };
        if (scope) {
            payload.scope = scope;
        }
        return this.call("setMyCommands", payload);
    }

    setChatMenuButton(chatId = null, menuButton = { type: "commands" }) {
        const payload = { menu_button: menuButton };
        if (chatId != null) {
            payload.chat_id = chatId;
        }
        return this.call("setChatMenuButton", payload);
    }

    sendMessage(chatId, text, options = null) {
        const payload = { chat_id: chatId, text };
        if (options?.parseMode) {
            payload.parse_mode = options.parseMode;
        }
        return this.call("sendMessage", payload);
    }

    sendMessageWithMarkup(chatId, text, replyMarkup, options = null) {
        const payload = { chat_id: chatId, text, reply_markup: replyMarkup };
        if (options?.parseMode) {
            payload.parse_mode = options.parseMode;
        }
        return this.call("sendMessage", payload);
    }

    editMessageReplyMarkup(chatId, messageId, replyMarkup = null) {
        const payload = { chat_id: chatId, message_id: messageId };
        if (replyMarkup != null) {
            payload.reply_markup = replyMarkup;
        }
        return this.call("editMessageReplyMarkup", payload);
    }

    sendTyping(chatId) {
        return this.call("sendChatAction", { chat_id: chatId, action: "typing" });
    }

    sendPhoto(chatId, photoPath, caption = "", options = null) {
        const fields = { chat_id: chatId, caption };
        if (options?.parseMode) {
            fields.parse_mode = options.parseMode;
        }
        return this.callMultipart("sendPhoto", fields, "photo", photoPath, path.basename(photoPath), guessMimeType(photoPath));
    }

    sendDocument(chatId, documentPath, caption = "", options = null) {
        const fields = { chat_id: chatId, caption };
        if (options?.parseMode) {
            fields.parse_mode = options.parseMode;
        }
        return this.callMultipart("sendDocument", fields, "document", documentPath, path.basename(documentPath), "application/octet-stream");
    }

    answerCallbackQuery(callbackQueryId, text = "") {
        return this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
    }

    async downloadFile(filePath) {
        return new Promise((resolve, reject) => {
            const request = https.request({
                hostname: "api.telegram.org",
                path: `${this.fileBasePath}${filePath}`,
                method: "GET",
            }, (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("end", () => {
                    if ((response.statusCode || 500) >= 400) {
                        reject(new Error(`Telegram file download failed: ${response.statusCode}`));
                        return;
                    }
                    resolve(Buffer.concat(chunks));
                });
            });
            request.on("error", reject);
            request.end();
        });
    }
}

class CodexIpcClient {
    constructor(pipePath, logger) {
        this.pipePath = pipePath;
        this.logger = logger;
        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.pendingRequests = new Map();
        this.clientId = null;
        this.broadcastHandler = null;
        this.closed = false;
    }

    async connect() {
        if (this.socket) {
            return;
        }
        this.closed = false;
        const socket = net.createConnection(this.pipePath);
        this.socket = socket;
        socket.on("data", (chunk) => this.handleData(chunk));
        socket.on("error", (error) => this.handleError(error));
        socket.on("close", () => this.handleClose());

        await new Promise((resolve, reject) => {
            const onError = (error) => { cleanup(); reject(error); };
            const onConnect = () => { cleanup(); resolve(); };
            const cleanup = () => {
                socket.off("error", onError);
                socket.off("connect", onConnect);
            };
            socket.once("error", onError);
            socket.once("connect", onConnect);
        });

        const result = await this.request("initialize", { clientType: "telegram-app-direct" });
        this.clientId = result.clientId;
    }

    async close() {
        this.closed = true;
        if (!this.socket) {
            return;
        }
        await new Promise((resolve) => {
            this.socket.once("close", resolve);
            this.socket.end();
        }).catch(() => {});
        this.socket.destroy();
        this.socket = null;
    }

    setBroadcastHandler(handler) {
        this.broadcastHandler = handler;
    }

    handleError(error) {
        if (!this.closed) {
            this.logger.error(`IPC error: ${error.message}`);
        }
        this.clientId = null;
        this.socket = null;
        for (const pending of this.pendingRequests.values()) {
            pending.reject(error);
        }
        this.pendingRequests.clear();
    }

    handleClose() {
        if (this.closed) {
            return;
        }
        this.clientId = null;
        this.socket = null;
        const error = new Error("Codex IPC connection closed.");
        for (const pending of this.pendingRequests.values()) {
            pending.reject(error);
        }
        this.pendingRequests.clear();
    }

    handleData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
            const length = this.buffer.readInt32LE(0);
            if (this.buffer.length < 4 + length) {
                return;
            }
            const payload = this.buffer.slice(4, 4 + length);
            this.buffer = this.buffer.slice(4 + length);
            try {
                this.handleFrame(JSON.parse(payload.toString("utf8")));
            } catch (error) {
                this.logger.error(`Failed to parse IPC frame: ${error.message}`);
            }
        }
    }

    handleFrame(frame) {
        if (frame.type === "response" && frame.requestId) {
            const pending = this.pendingRequests.get(frame.requestId);
            if (!pending) {
                return;
            }
            this.pendingRequests.delete(frame.requestId);
            if (frame.resultType === "error" || frame.error) {
                const normalizedError = normalizeIpcErrorPayload(frame.error || null);
                const error = new Error(normalizedError.message || "IPC request failed.");
                if (normalizedError.code) {
                    error.code = normalizedError.code;
                }
                if (normalizedError.payload != null) {
                    error.codexIpcError = normalizedError.payload;
                }
                pending.reject(error);
                return;
            }
            pending.resolve(frame.result || {});
            return;
        }
        if (frame.type === "broadcast" && this.broadcastHandler) {
            this.broadcastHandler(frame);
        }
    }

    sendFrame(payload) {
        if (!this.socket) {
            throw new Error("IPC socket is not connected.");
        }
        const encoded = Buffer.from(JSON.stringify(payload), "utf8");
        const length = Buffer.alloc(4);
        length.writeInt32LE(encoded.length, 0);
        this.socket.write(Buffer.concat([length, encoded]));
    }

    request(method, params, version = null) {
        const requestId = crypto.randomUUID();
        const payload = { type: "request", requestId, method, params };
        if (version != null) {
            payload.version = version;
        }
        if (this.clientId) {
            payload.sourceClientId = this.clientId;
        }
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(requestId, { resolve, reject });
            try {
                this.sendFrame(payload);
            } catch (error) {
                this.pendingRequests.delete(requestId);
                reject(error);
            }
        });
    }

    startTurnWithContent(conversationId, input, attachments = [], settings = {}) {
        return this.request("thread-follower-start-turn", {
            conversationId,
            turnStartParams: {
                input,
                cwd: null,
                approvalPolicy: null,
                sandboxPolicy: buildSandboxPolicy(settings.sandbox ?? null, settings.workspaceRoots || []),
                model: settings.model ?? null,
                serviceTier: settings.serviceTier ?? null,
                effort: settings.effort ?? null,
                outputSchema: null,
                collaborationMode: null,
                attachments,
            },
            isSteering: false,
        }, 1);
    }
}

class AppBroadcastMonitor {
    constructor(api, bindings, config, logger) {
        this.api = api;
        this.bindings = bindings;
        this.config = config;
        this.logger = logger;
        this.ipc = new CodexIpcClient(config.codexIpcPipe, logger);
        this.started = false;
        this.knownItemIds = new Map();
        this.conversationStates = new Map();
        this.pendingSuppressions = new Map();
        this.pendingDeliveryWaiters = new Map();
    }

    async start() {
        if (this.started) {
            return;
        }
        this.ipc.setBroadcastHandler((frame) => this.handleBroadcast(frame));
        await this.connectWithRetry();
        this.started = true;
        this.logger.info(`broadcast monitor connected pipe=${this.config.codexIpcPipe}`);
    }

    async dispose() {
        await this.ipc.close();
        this.started = false;
    }

    suppressNextUserMessage(sessionId, fingerprint) {
        const queue = this.pendingSuppressions.get(sessionId) || [];
        queue.push(fingerprint);
        if (queue.length > 20) {
            queue.shift();
        }
        this.pendingSuppressions.set(sessionId, queue);
    }

    removePendingDeliveryWaiter(sessionId, waiter) {
        const queue = this.pendingDeliveryWaiters.get(sessionId) || [];
        const index = queue.indexOf(waiter);
        if (index === -1) {
            return;
        }
        queue.splice(index, 1);
        if (queue.length) {
            this.pendingDeliveryWaiters.set(sessionId, queue);
        } else {
            this.pendingDeliveryWaiters.delete(sessionId);
        }
    }

    waitForUserMessageDelivery(sessionId, fingerprint, timeoutMs = DEFAULT_TURN_DELIVERY_ACK_TIMEOUT_MS) {
        let settled = false;
        let resolvePromise = null;
        let rejectPromise = null;
        const waiter = {
            fingerprint,
            resolve: (payload) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeoutHandle);
                this.removePendingDeliveryWaiter(sessionId, waiter);
                resolvePromise(payload);
            },
            reject: (error) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeoutHandle);
                this.removePendingDeliveryWaiter(sessionId, waiter);
                rejectPromise(error);
            },
        };
        const promise = new Promise((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        });
        const timeoutHandle = setTimeout(() => {
            waiter.reject(new Error(`Timed out waiting for delivered user message echo for ${sessionId}`));
        }, timeoutMs);
        const queue = this.pendingDeliveryWaiters.get(sessionId) || [];
        queue.push(waiter);
        this.pendingDeliveryWaiters.set(sessionId, queue);
        return {
            promise,
            cancel: () => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeoutHandle);
                this.removePendingDeliveryWaiter(sessionId, waiter);
            },
        };
    }

    resolvePendingUserMessageDelivery(sessionId, fingerprint, payload = null) {
        const queue = this.pendingDeliveryWaiters.get(sessionId) || [];
        const index = queue.findIndex((waiter) => waiter.fingerprint === fingerprint);
        if (index === -1) {
            return false;
        }
        const [waiter] = queue.splice(index, 1);
        if (queue.length) {
            this.pendingDeliveryWaiters.set(sessionId, queue);
        } else {
            this.pendingDeliveryWaiters.delete(sessionId);
        }
        waiter.resolve(payload);
        return true;
    }

    async connectWithRetry(timeoutMs = DEFAULT_IPC_CONNECT_TIMEOUT_MS) {
        const startedAt = Date.now();
        let lastError = null;
        while (Date.now() - startedAt < timeoutMs) {
            try {
                await this.ipc.connect();
                return;
            } catch (error) {
                lastError = error;
                const code = String(error?.code || "");
                const message = String(error?.message || error);
                if (code !== "ENOENT" && !message.includes("ENOENT")) {
                    throw error;
                }
                this.logger.warn(`IPC pipe not ready yet, retrying: ${message}`);
                await delay(DEFAULT_IPC_RETRY_DELAY_MS);
            }
        }
        throw lastError || new Error(`Timed out waiting for IPC pipe ${this.config.codexIpcPipe}`);
    }

    async injectTurn(sessionId, turnPayload, settingsOverride = null) {
        const settings = {
            ...this.config.defaultSettings,
            workspaceRoots: this.config.workspaceRoots,
            ...(settingsOverride || {}),
        };
        const useBoundTurnBridge = typeof this.config.submitBoundThreadTurn === "function";
        const suppressionMessage = {
            text: String(turnPayload?.prompt || "").trim(),
            images: extractInputImageRefs(turnPayload?.input),
            attachments: Array.isArray(turnPayload?.attachments) ? turnPayload.attachments : [],
        };
        const deliveryFingerprint = buildMirrorFingerprint(suppressionMessage);
        let lastError = null;
        for (let attempt = 1; attempt <= DEFAULT_TURN_INJECT_RETRY_COUNT; attempt += 1) {
            if (typeof this.config.ensureSessionOpen === "function") {
                await this.config.ensureSessionOpen(sessionId);
            }
            if (!useBoundTurnBridge && !this.socketReady()) {
                await this.connectWithRetry();
            }
            this.logger.info(`inject session=${sessionId} attempt=${attempt} inputs=${turnPayload.input.length} attachments=${turnPayload.attachments.length}`);
            try {
                if (useBoundTurnBridge) {
                    const deliveryWaiter = this.waitForUserMessageDelivery(sessionId, deliveryFingerprint);
                    const submitOutcomePromise = this.config.submitBoundThreadTurn({
                        conversationId: sessionId,
                        input: turnPayload.input,
                        attachments: turnPayload.attachments,
                        cwd: settings.cwd ?? null,
                        workspaceRoots: settings.workspaceRoots || this.config.workspaceRoots,
                        settings,
                    }).then(
                        (conversationId) => ({ kind: "submit", ok: true, conversationId }),
                        (error) => ({ kind: "submit", ok: false, error }),
                    );
                    let deliveryAcknowledged = false;
                    submitOutcomePromise.then((outcome) => {
                        if (deliveryAcknowledged && !outcome.ok) {
                            this.logger.warn(`bound turn submit completion failed after delivery ack session=${sessionId} error=${String(outcome.error?.message || outcome.error)}`);
                        }
                    });
                    const deliveryOutcomePromise = deliveryWaiter.promise.then(
                        (payload) => ({ kind: "delivery", payload }),
                    );
                    const firstOutcome = await Promise.race([submitOutcomePromise, deliveryOutcomePromise]);
                    if (firstOutcome.kind === "submit") {
                        deliveryWaiter.cancel();
                        if (!firstOutcome.ok) {
                            throw firstOutcome.error;
                        }
                    } else {
                        deliveryAcknowledged = true;
                        this.logger.info(`bound turn delivery acknowledged from conversation state session=${sessionId} item=${firstOutcome.payload?.messageId || "-"}`);
                    }
                } else {
                    await this.ipc.startTurnWithContent(sessionId, turnPayload.input, turnPayload.attachments, settings);
                }
                return;
            } catch (error) {
                lastError = error;
                if (!isRetryableTurnInjectError(error) || attempt === DEFAULT_TURN_INJECT_RETRY_COUNT) {
                    throw error;
                }
                this.logger.warn(`inject retry after transient client miss session=${sessionId} attempt=${attempt} error=${String(error?.message || error)}`);
                await delay(DEFAULT_TURN_INJECT_RETRY_DELAY_MS);
            }
        }
        throw lastError || new Error(`Failed to inject turn for session ${sessionId}`);
    }

    socketReady() {
        return !!(this.ipc.socket && this.ipc.clientId);
    }

    handleBroadcast(frame) {
        if (frame.method !== "thread-stream-state-changed") {
            return;
        }
        const params = frame.params || {};
        const conversationId = params.conversationId;
        if (!conversationId) {
            return;
        }
        const chatId = this.bindings.getChatIdForSession(conversationId);
        if (!chatId) {
            return;
        }
        const change = params.change || {};
        if (change.type === "snapshot") {
            const conversationState = change.conversationState && typeof change.conversationState === "object"
                ? change.conversationState
                : {};
            this.conversationStates.set(conversationId, conversationState);
            this.processSnapshot(String(chatId), conversationId, conversationState).catch((error) => {
                this.logger.error(`snapshot processing failed: ${error.message}`);
            });
            return;
        }
        if (change.type === "patches") {
            const baseline = this.conversationStates.get(conversationId);
            if (!baseline) {
                this.logger.warn(`patch mirror skipped without baseline session=${conversationId} patches=${Array.isArray(change.patches) ? change.patches.length : 0}`);
                return;
            }
            try {
                const conversationState = applyConversationPatches(baseline, change.patches);
                this.conversationStates.set(conversationId, conversationState);
                this.processSnapshot(String(chatId), conversationId, conversationState).catch((error) => {
                    this.logger.error(`patch processing failed: ${error.message}`);
                });
            } catch (error) {
                this.logger.error(`patch apply failed session=${conversationId}: ${error.message}`);
            }
        }
    }

    shouldSuppressUserEcho(sessionId, message) {
        const queue = this.pendingSuppressions.get(sessionId) || [];
        const fingerprint = buildMirrorFingerprint(message);
        const index = queue.findIndex((candidate) => candidate === fingerprint);
        if (index === -1) {
            return false;
        }
        queue.splice(index, 1);
        this.pendingSuppressions.set(sessionId, queue);
        this.resolvePendingUserMessageDelivery(sessionId, fingerprint, {
            messageId: message?.id || null,
            fingerprint,
        });
        return true;
    }

    formatMirrorMessage(role, text) {
        const body = String(text || "").trim();
        if (!body) {
            return role === "user" ? "[App Input]" : "[Codex Response]";
        }
        if (role === "user") {
            return `[App Input]\n${body}`;
        }
        return `[Codex Response]\n${body}`;
    }

    async sendText(chatId, text, options = null) {
        const chunks = options?.parseMode
            ? [{ text, parseMode: options.parseMode }]
            : splitReplyChunks(text, this.config.maxReplyChars).map((chunk) => ({ text: chunk, parseMode: null }));
        for (const chunk of chunks) {
            await this.api.sendMessage(chatId, chunk.text, chunk.parseMode ? { parseMode: chunk.parseMode } : null);
        }
    }

    async sendAssistantText(chatId, text) {
        const messages = buildAssistantTelegramMessages(text, this.config.maxReplyChars);
        for (const message of messages) {
            await this.sendText(chatId, message.text, message.parseMode ? { parseMode: message.parseMode } : null);
        }
    }

    async sendMedia(chatId, message) {
        let sent = 0;
        for (const imageUrl of message.images || []) {
            const imagePath = normalizeFilePathFromUrl(imageUrl);
            if (!imagePath || !fs.existsSync(imagePath)) {
                this.logger.warn(`skip mirror image missing path=${imageUrl}`);
                continue;
            }
            const caption = sent === 0 ? this.formatMirrorMessage(message.role, message.text) : "";
            await this.api.sendPhoto(chatId, imagePath, caption);
            sent += 1;
        }
        for (const attachment of message.attachments || []) {
            const attachmentPath = attachment?.fsPath || attachment?.path;
            if (!attachmentPath || !fs.existsSync(attachmentPath)) {
                this.logger.warn(`skip mirror attachment missing path=${attachmentPath}`);
                continue;
            }
            const caption = sent === 0 ? this.formatMirrorMessage(message.role, message.text) : "";
            await this.api.sendDocument(chatId, attachmentPath, caption);
            sent += 1;
        }
        return sent > 0;
    }

    async processSnapshot(chatId, conversationId, conversationState) {
        if (typeof this.config.onConversationActivity === "function") {
            Promise.resolve(this.config.onConversationActivity({
                chatId: String(chatId),
                conversationId,
                conversationState,
            })).catch((error) => {
                this.logger.warn(`approval sync scheduling failed session=${conversationId} error=${String(error?.message || error)}`);
            });
        }
        const messages = flattenConversationMessages(conversationState);
        let delivered = this.knownItemIds.get(conversationId);
        if (!delivered) {
            delivered = new Set(
                messages
                    .filter((message) => !(message.role === "assistant" && message.turnStatus === "inProgress"))
                    .map((message) => message.id)
                    .filter(Boolean),
            );
            this.knownItemIds.set(conversationId, delivered);
            this.logger.info(`prime snapshot session=${conversationId} items=${delivered.size}`);
            return;
        }

        for (const message of messages) {
            if (!message.id) {
                continue;
            }
            if (delivered.has(message.id)) {
                continue;
            }
            if (message.role === "assistant" && message.turnStatus === "inProgress") {
                continue;
            }
            delivered.add(message.id);

            if (message.role === "user") {
                if (this.shouldSuppressUserEcho(conversationId, message)) {
                    this.logger.info(`suppressed telegram echo session=${conversationId} item=${message.id}`);
                    continue;
                }
                const mediaSent = await this.sendMedia(chatId, message);
                if (!mediaSent || message.text) {
                    await this.sendText(chatId, this.formatMirrorMessage("user", message.text));
                }
                continue;
            }

            await this.sendAssistantText(chatId, message.text);
        }
    }
}

class CodexAppDirectCompanion {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.api = new TelegramApi(config.telegramBotToken);
        this.bindings = new SessionBindings(config.bindingsPath);
        this.chatSettings = new ChatSettingsStore(path.join(config.stateDir, DEFAULT_CHAT_SETTINGS_FILE));
        this.pendingNewThread = new PendingNewThreadStore(path.join(config.stateDir, DEFAULT_PENDING_NEW_THREAD_FILE));
        this.modelCatalog = new ModelCatalog(config.codexHome, logger);
        this.catalog = new SessionCatalog(config.codexHome, logger);
        this.pendingApprovals = new Map();
        this.pendingApprovalSyncTimers = new Map();
        this.pendingApprovalSyncs = new Map();
        this.monitor = new AppBroadcastMonitor(this.api, this.bindings, config, logger);
        this.offset = null;
        this.disposed = false;
    }

    isAuthorized(chatId) {
        if (!this.config.allowedChatIds.size) {
            return true;
        }
        return this.config.allowedChatIds.has(String(chatId));
    }

    async syncCommands() {
        const commands = [
            { command: "start", description: "Show the Codex Portable Telegram startup message." },
            { command: "help", description: "Show general Telegram commands." },
            { command: "status", description: "Show runtime status." },
            ...CODEX_COMMANDS,
        ];
        const merged = new Map();
        for (const command of commands) {
            merged.set(command.command, command);
        }
        const scopes = [{ type: "default" }, { type: "all_private_chats" }];
        for (const chatId of this.config.allowedChatIds) {
            scopes.push({ type: "chat", chat_id: Number(chatId) });
        }
        for (const scope of scopes) {
            try {
                await this.api.setMyCommands([...merged.values()], scope);
            } catch (error) {
                this.logger.warn(`command sync failed scope=${JSON.stringify(scope)} error=${error.message}`);
            }
        }
        try {
            await this.api.setChatMenuButton(null, { type: "commands" });
        } catch (error) {
            this.logger.warn(`menu button sync failed scope=default error=${error.message}`);
        }
        for (const chatId of this.config.allowedChatIds) {
            try {
                await this.api.setChatMenuButton(Number(chatId), { type: "commands" });
            } catch (error) {
                this.logger.warn(`menu button sync failed scope=chat chatId=${chatId} error=${error.message}`);
            }
        }
    }

    getNativeConversationTarget(chatId) {
        const sessionId = this.bindings.getSession(chatId) || null;
        if (sessionId) {
            return { conversationId: sessionId, isBoundSession: true, isPendingDraft: false };
        }
        const pending = this.pendingNewThread.get(chatId);
        if (pending?.active) {
            return { conversationId: null, isBoundSession: false, isPendingDraft: true };
        }
        return null;
    }

    buildChatSettingsPatchFromAppState(state) {
        if (!state || typeof state !== "object") {
            return {};
        }
        const patch = {};
        if (Object.prototype.hasOwnProperty.call(state, "model")) {
            patch.model = state.model ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(state, "reasoningEffort")) {
            patch.effort = state.reasoningEffort ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(state, "serviceTier")) {
            patch.serviceTier = state.serviceTier ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(state, "permissionMode")) {
            const permissionMode = normalizePermissionMode(state.permissionMode);
            patch.permissionMode = permissionMode;
            patch.sandbox = permissionModeToSandboxValue(permissionMode);
        }
        return patch;
    }

    async refreshChatSettingsFromApp(chatId, reason = "telegram_refresh") {
        if (typeof this.config.getCurrentAppState !== "function") {
            return null;
        }
        const target = this.getNativeConversationTarget(chatId);
        if (!target) {
            return null;
        }
        try {
            const state = await this.config.getCurrentAppState({
                conversationId: target.conversationId,
                reason,
            });
            const patch = this.buildChatSettingsPatchFromAppState(state);
            if (Object.keys(patch).length) {
                this.chatSettings.update(chatId, patch);
            }
            return state || null;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`getCurrentAppState failed chat=${chatId} reason=${reason} error=${message}`);
            return null;
        }
    }

    buildSettingsSummaryLines(chatId, settings, appState = null) {
        const boundSessionId = this.bindings.getSession(chatId) || null;
        const sessionInfo = boundSessionId ? this.catalog.findSessionEntry(boundSessionId) : null;
        const pending = this.pendingNewThread.get(chatId);
        const modelOptions = this.modelCatalog.getModelOptions();
        const effortOptions = this.modelCatalog.getEffortOptions(settings.model);
        const modelSummary = settings.model == null
            ? `${DEFAULT_LABEL} (${this.modelCatalog.getCurrentModel(settings.model) || "-"})`
            : labelForOption(modelOptions, settings.model);
        const fastSummary = labelForOption(FAST_OPTIONS, settings.serviceTier);
        const effortSummary = settings.effort == null
            ? `${DEFAULT_LABEL} (${this.modelCatalog.getCurrentEffort(settings.effort, settings.model) || "-"})`
            : labelForOption(effortOptions, settings.effort);
        const lines = [
            `Current session: ${sessionInfo?.title || boundSessionId || (pending?.active ? "(new thread draft)" : "(not bound)")}`,
            `Session ID: ${sessionInfo?.sessionId || boundSessionId || "-"}`,
        ];
        if (appState) {
            lines.push(`App route: ${appState.path || "-"}`);
            lines.push(`App conversation: ${appState.conversationId || (pending?.active ? "(new thread draft)" : "-")}`);
            if (boundSessionId && appState.conversationId && appState.conversationId !== boundSessionId) {
                lines.push(`App conversation mismatch: ${appState.conversationId}`);
            }
        }
        lines.push(
            `Model: ${modelSummary}`,
            `Fast: ${fastSummary}`,
            `Reasoning: ${effortSummary}`,
            `Permission: ${formatPermissionLabel(settings)}`,
        );
        return lines;
    }

    formatSettingsSummary(chatId) {
        return this.buildSettingsSummaryLines(chatId, this.chatSettings.get(chatId)).join("\n");
    }

    async formatCurrentStateSummary(chatId) {
        const target = this.getNativeConversationTarget(chatId);
        const appState = await this.refreshChatSettingsFromApp(chatId, "telegram_current");
        const settings = this.chatSettings.get(chatId);
        const lines = this.buildSettingsSummaryLines(chatId, settings, appState);
        if (!target) {
            lines.splice(2, 0, "App target: bind a session or open /codex_new first.");
        } else if (typeof this.config.getCurrentAppState !== "function") {
            lines.splice(2, 0, "App state: unavailable in this build.");
        } else if (!appState) {
            lines.splice(2, 0, "App state: unavailable.");
        }
        return lines.join("\n");
    }

    formatStatus(chatId = null) {
        const sessionId = chatId != null ? (this.bindings.getSession(chatId) || "(not bound)") : "(n/a)";
        const pending = chatId != null && this.pendingNewThread.get(chatId)?.active ? "yes" : "no";
        const lines = [
            "Codex Portable Telegram is online.",
            `Pipe: ${this.config.codexIpcPipe}`,
            `Bindings: ${this.config.bindingsPath}`,
            `Inbox: ${this.config.telegramInboxDir}`,
            `Workspace roots: ${this.config.workspaceRoots.join(", ") || "(none)"}`,
            `Current session: ${sessionId}`,
            `Pending new thread: ${pending}`,
        ];
        if (chatId != null) {
            lines.push("");
            lines.push(this.formatSettingsSummary(chatId));
        }
        return lines.join("\n");
    }

    async safeAnswerCallbackQuery(callbackId, text = "", context = "callback") {
        if (!callbackId) {
            return false;
        }
        try {
            await this.api.answerCallbackQuery(callbackId, text);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const isExpired = message.includes("query is too old")
                || message.includes("response timeout expired")
                || message.includes("query ID is invalid");
            const logMethod = isExpired ? "warn" : "error";
            this.logger[logMethod](`answerCallbackQuery failed context=${context} error=${message}`);
            return false;
        }
    }

    async safeClearCallbackMarkup(chatId, messageId, context = "callback_markup_clear") {
        if (!chatId || messageId == null) {
            return false;
        }
        try {
            await this.api.editMessageReplyMarkup(chatId, messageId);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`editMessageReplyMarkup failed context=${context} error=${message}`);
            return false;
        }
    }

    buildApprovalPrompt(chatId, approval) {
        const lines = ["Codex approval requested."];
        if (approval.type === "patch") {
            lines.push("Type: File changes");
        } else if (approval.networkApprovalContext?.host) {
            lines.push(`Type: Network access`);
            lines.push(`Host: ${approval.networkApprovalContext.host}`);
        } else {
            lines.push("Type: Command execution");
        }
        if (approval.approvalReason) {
            lines.push(`Reason: ${truncatePlainText(approval.approvalReason, 500)}`);
        }
        const commandSummary = summarizeApprovalField(approval.command || approval.proposedExecpolicyAmendment, 700);
        if (commandSummary) {
            lines.push(`Command: ${commandSummary}`);
        }
        if (approval.type === "patch" && approval.changes) {
            const fileNames = Object.keys(approval.changes).filter(Boolean);
            if (fileNames.length) {
                lines.push(`Files: ${fileNames.slice(0, 6).join(", ")}${fileNames.length > 6 ? ` (+${fileNames.length - 6} more)` : ""}`);
            }
        }
        if (approval.grantRoot) {
            lines.push(`Root: ${approval.grantRoot}`);
        }
        lines.push("");
        lines.push("Choose Approve or Reject below.");
        return lines.join("\n\n");
    }

    buildApprovalReplyMarkup(approval) {
        const buttons = [];
        if (approval.type === "exec" && approval.allowForSession) {
            buttons.push(
                [
                    { text: "Approve once", callback_data: `approval:accept:${approval.approvalRequestId}` },
                    { text: "Allow session", callback_data: `approval:acceptForSession:${approval.approvalRequestId}` },
                ],
                [
                    { text: "Reject", callback_data: `approval:decline:${approval.approvalRequestId}` },
                ],
            );
        } else {
            buttons.push([
                { text: "Approve", callback_data: `approval:accept:${approval.approvalRequestId}` },
                { text: "Reject", callback_data: `approval:decline:${approval.approvalRequestId}` },
            ]);
        }
        return { inline_keyboard: buttons };
    }

    async clearPendingApproval(chatId, context = "approval_clear") {
        const current = this.pendingApprovals.get(chatId) || null;
        if (!current) {
            return false;
        }
        this.pendingApprovals.delete(chatId);
        if (current.messageId != null) {
            await this.safeClearCallbackMarkup(chatId, current.messageId, context);
        }
        return true;
    }

    async applyPendingApprovalState(chatId, conversationId, approval, context = "approval_state") {
        const current = this.pendingApprovals.get(chatId) || null;
        if (!approval) {
            if (current && (!conversationId || current.conversationId === conversationId)) {
                await this.clearPendingApproval(chatId, `${context}_resolved:${conversationId || current.conversationId || "unknown"}`);
            }
            return null;
        }
        if (current && current.approvalRequestId === approval.approvalRequestId && current.conversationId === conversationId) {
            return current;
        }
        if (current) {
            await this.clearPendingApproval(chatId, `${context}_replace:${conversationId}`);
        }
        const sent = await this.api.sendMessageWithMarkup(
            chatId,
            this.buildApprovalPrompt(chatId, approval),
            this.buildApprovalReplyMarkup(approval),
        );
        const pending = {
            ...approval,
            messageId: Number(sent?.message_id || 0) || null,
        };
        this.pendingApprovals.set(chatId, pending);
        this.logger.info(`approval relayed chat=${chatId} session=${conversationId} approval=${approval.approvalRequestId} type=${approval.type} source=${context}`);
        return pending;
    }

    async handleApprovalStatePush(payload) {
        const raw = payload && typeof payload === "object" ? payload : null;
        const conversationId = raw?.conversationId != null ? String(raw.conversationId) : null;
        if (!conversationId) {
            return false;
        }
        const chatId = this.bindings.getChatIdForSession(conversationId);
        if (!chatId) {
            return false;
        }
        const activeTarget = this.getNativeConversationTarget(chatId);
        if (!activeTarget?.conversationId || activeTarget.conversationId !== conversationId) {
            return false;
        }
        const approval = normalizePendingApproval(raw?.approval ?? null, conversationId);
        await this.applyPendingApprovalState(chatId, conversationId, approval, "approval_push");
        return true;
    }

    scheduleApprovalSync(chatId, conversationId, reason = "activity") {
        if (!chatId || !conversationId || typeof this.config.getCurrentAppState !== "function") {
            return;
        }
        const key = String(chatId);
        const existing = this.pendingApprovalSyncTimers.get(key);
        if (existing) {
            clearTimeout(existing);
        }
        const timeoutHandle = setTimeout(() => {
            this.pendingApprovalSyncTimers.delete(key);
            this.syncPendingApproval(chatId, conversationId, reason).catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(`syncPendingApproval failed chat=${chatId} session=${conversationId} reason=${reason} error=${message}`);
            });
        }, DEFAULT_APPROVAL_SYNC_DELAY_MS);
        this.pendingApprovalSyncTimers.set(key, timeoutHandle);
    }

    async syncPendingApproval(chatId, conversationId, reason = "activity") {
        if (!chatId || !conversationId || typeof this.config.getCurrentAppState !== "function") {
            return null;
        }
        const key = String(chatId);
        const previous = this.pendingApprovalSyncs.get(key) || Promise.resolve();
        const run = previous.catch(() => {}).then(async () => {
            const activeTarget = this.getNativeConversationTarget(chatId);
            if (!activeTarget?.conversationId || activeTarget.conversationId !== conversationId) {
                return null;
            }
            if (reason === "activity") {
                const current = this.pendingApprovals.get(chatId) || null;
                if (current?.conversationId === conversationId) {
                    return current;
                }
            }
            const readState = async ({ skipNavigation, timeoutMs, stage }) => this.config.getCurrentAppState({
                conversationId,
                reason: `approval_${reason}_${stage}`,
                skipNavigation,
                timeoutMs,
            }).catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(`approval current-state failed chat=${chatId} session=${conversationId} reason=${reason} stage=${stage} error=${message}`);
                return null;
            });
            let state = null;
            if (reason === "activity") {
                state = await readState({
                    skipNavigation: true,
                    timeoutMs: 1500,
                    stage: "passive",
                });
                if (!state) {
                    state = await readState({
                        skipNavigation: false,
                        timeoutMs: 5000,
                        stage: "route_open",
                    });
                }
            } else {
                state = await readState({
                    skipNavigation: false,
                    timeoutMs: 10000,
                    stage: "direct",
                });
            }
            const approval = normalizePendingApproval(state?.pendingApproval ?? null, conversationId);
            return await this.applyPendingApprovalState(chatId, conversationId, approval, `approval_${reason}`);
        });
        this.pendingApprovalSyncs.set(key, run);
        try {
            return await run;
        } finally {
            if (this.pendingApprovalSyncs.get(key) === run) {
                this.pendingApprovalSyncs.delete(key);
            }
        }
    }

    async handleApprovalCallback(chatId, callbackId, callbackMessageId, data) {
        const parsed = parseApprovalCallbackData(data);
        if (!parsed) {
            await this.safeAnswerCallbackQuery(callbackId, "Unknown approval action.", "approval_unknown");
            return;
        }
        const current = this.pendingApprovals.get(chatId) || null;
        if (!current) {
            await this.safeAnswerCallbackQuery(callbackId, "Approval already resolved.", "approval_missing");
            await this.safeClearCallbackMarkup(chatId, callbackMessageId, "approval_missing");
            return;
        }
        if (current.approvalRequestId !== parsed.approvalRequestId) {
            await this.safeAnswerCallbackQuery(callbackId, "Approval is stale.", "approval_stale");
            await this.safeClearCallbackMarkup(chatId, callbackMessageId, "approval_stale");
            return;
        }
        if (typeof this.config.respondToApproval !== "function") {
            await this.safeAnswerCallbackQuery(callbackId, "Approval relay unavailable.", "approval_unavailable");
            await this.api.sendMessage(chatId, "This build cannot respond to Codex approvals yet.");
            return;
        }
        await this.safeAnswerCallbackQuery(callbackId, "Applying approval", `approval_apply:${parsed.decision}`);
        try {
            await this.config.respondToApproval({
                conversationId: current.conversationId,
                approvalRequestId: current.approvalRequestId,
                decision: parsed.decision,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`respondToApproval failed chat=${chatId} session=${current.conversationId} approval=${current.approvalRequestId} error=${message}`);
            await this.api.sendMessage(chatId, `Failed to apply approval.\n\n${message}`);
            return;
        }
        await this.clearPendingApproval(chatId, `approval_applied:${current.approvalRequestId}`);
        const resultLabel = parsed.decision === "decline"
            ? "Rejected."
            : parsed.decision === "acceptForSession"
                ? "Allowed for this conversation."
                : "Approved.";
        await this.api.sendMessage(chatId, resultLabel);
        this.scheduleApprovalSync(chatId, current.conversationId, "post_decision");
    }

    buildMainControlsMessage(chatId) {
        return {
            text: `Codex controls\n\n${this.formatSettingsSummary(chatId)}`,
            replyMarkup: {
                inline_keyboard: [
                    [{ text: "New Thread", callback_data: "action:new-thread" }],
                    [{ text: "Session", callback_data: "menu:session" }],
                    [{ text: "Model", callback_data: "menu:model" }],
                    [{ text: "Fast", callback_data: "menu:fast" }],
                    [{ text: "Reasoning", callback_data: "menu:effort" }],
                    [{ text: "Permission", callback_data: "menu:permission" }],
                ],
            },
        };
    }

    async openNewThread(chatId, prompt = "", callbackId = null) {
        if (callbackId) {
            await this.safeAnswerCallbackQuery(callbackId, "Opening new thread", "open_new_thread");
        }
        if (typeof this.config.openNewThread !== "function") {
            await this.api.sendMessage(chatId, "The native Codex New Thread command is unavailable in this build.");
            return false;
        }

        const currentSessionId = this.bindings.getSession(chatId);
        const normalizedPrompt = String(prompt || "").trim();
        const preferredCwd = this.config.workspaceRoots[0] || null;

        await this.config.openNewThread({
            ...(normalizedPrompt ? { prompt: normalizedPrompt } : {}),
            ...(preferredCwd ? { cwd: preferredCwd } : {}),
        });

        if (currentSessionId) {
            this.bindings.unbind(chatId);
        }
        await this.clearPendingApproval(chatId, "open_new_thread");
        this.pendingNewThread.set(chatId, {
            prompt: normalizedPrompt,
            cwd: preferredCwd,
        });

        const lines = [
            normalizedPrompt
                ? "Opened a real Codex New Thread draft in the app with the prompt prefilled."
                : "Opened a real Codex New Thread draft in the app.",
            currentSessionId
                ? "This Telegram chat was unbound from the previous session so messages do not go to the wrong thread."
                : "This Telegram chat is currently unbound.",
            "Codex creates the new session id when the first turn is sent.",
            "Send the first message in Codex, then use /codex_session to bind the new thread.",
        ];
        await this.api.sendMessage(chatId, lines.join("\n\n"));
        return true;
    }

    async startPendingNewThread(chatId, turnPayload) {
        if (typeof this.config.startNewThreadTurn !== "function") {
            await this.prefillPendingNewThread(chatId, turnPayload);
            return false;
        }

        const pending = this.pendingNewThread.get(chatId) || {};
        const preferredCwd = pending.cwd || this.config.workspaceRoots[0] || null;
        const settings = this.chatSettings.get(chatId);
        const input = Array.isArray(turnPayload?.input) ? turnPayload.input : [];
        const attachments = Array.isArray(turnPayload?.attachments) ? turnPayload.attachments : [];

        await this.api.sendTyping(chatId);
        const conversationId = await this.config.startNewThreadTurn({
            prompt: String(turnPayload?.prompt || "").trim(),
            input,
            attachments,
            cwd: preferredCwd,
            workspaceRoots: this.config.workspaceRoots,
            settings,
        });
        if (!conversationId) {
            throw new Error("Codex did not return a real conversation id.");
        }

        this.pendingNewThread.clear(chatId);
        this.bindings.bind(chatId, conversationId);
        await this.clearPendingApproval(chatId, "start_pending_new_thread");
        await this.refreshChatSettingsFromApp(chatId, "start_pending_new_thread");
        this.scheduleApprovalSync(chatId, conversationId, "start_pending_new_thread");

        const suppressionMessage = {
            text: String(turnPayload?.prompt || "").trim(),
            images: extractInputImageRefs(input),
            attachments,
        };
        this.monitor.suppressNextUserMessage(conversationId, buildMirrorFingerprint(suppressionMessage));

        await this.api.sendMessage(chatId, `Created and bound a real Codex thread.\n\nSession: ${conversationId}`);
        return true;
    }

    async prefillPendingNewThread(chatId, turnPayload) {
        if (typeof this.config.openNewThread !== "function") {
            await this.promptForBinding(chatId);
            return false;
        }
        const pending = this.pendingNewThread.get(chatId) || {};
        const prompt = String(turnPayload?.prompt || "").trim();
        if (!prompt) {
            await this.promptForBinding(chatId);
            return false;
        }
        const preferredCwd = pending.cwd || this.config.workspaceRoots[0] || null;
        await this.config.openNewThread({
            prompt,
            ...(preferredCwd ? { cwd: preferredCwd } : {}),
        });
        this.pendingNewThread.set(chatId, {
            prompt,
            cwd: preferredCwd,
        });
        const lines = [
            "Updated the real Codex New Thread draft in the app with your latest Telegram message.",
            "This is still a native draft. Codex creates the session id only when you press Send in Codex.",
            "After that, use /codex_session to bind the new thread.",
        ];
        await this.api.sendMessage(chatId, lines.join("\n\n"));
        return true;
    }

    buildSessionPicker(chatId) {
        const sessions = this.catalog.listRecentSessions();
        const currentSession = this.bindings.getSession(chatId);
        if (!sessions.length) {
            return { text: "No recent Codex sessions were found.", replyMarkup: null };
        }
        const lines = ["Recent sessions:"];
        const keyboard = [];
        for (const [index, session] of sessions.entries()) {
            const current = session.sessionId === currentSession ? " [current]" : "";
            const title = session.title || session.preview;
            lines.push(`${index + 1}. ${title}${current}`);
            lines.push(`   ${session.sessionId}`);
            lines.push(`   ${formatSessionTimestamp(session.modifiedAt)} | ${session.preview}`);
            keyboard.push([{ text: `${index + 1}. ${truncateButtonLabel(title)}`, callback_data: `set:session:${session.sessionId}` }]);
        }
        lines.push("");
        lines.push("Choose a button to switch the current chat session.");
        return { text: lines.join("\n"), replyMarkup: { inline_keyboard: keyboard } };
    }

    buildOptionPickerMessage(chatId, kind) {
        const settings = this.chatSettings.get(chatId);
        const modelOptions = this.modelCatalog.getSelectableModelOptions();
        const effortOptions = this.modelCatalog.getSelectableEffortOptions(settings.model);
        const configMap = {
            model: {
                title: "Model selection",
                current: settings.model == null
                    ? `${DEFAULT_LABEL} (${this.modelCatalog.getCurrentModel(settings.model) || "-"})`
                    : labelForOption(modelOptions, settings.model),
                options: modelOptions,
            },
            fast: {
                title: "Fast selection",
                current: labelForOption(FAST_OPTIONS, settings.serviceTier),
                options: FAST_OPTIONS,
            },
            effort: {
                title: "Reasoning selection",
                current: settings.effort == null
                    ? `${DEFAULT_LABEL} (${this.modelCatalog.getCurrentEffort(settings.effort, settings.model) || "-"})`
                    : labelForOption(effortOptions, settings.effort),
                options: effortOptions,
            },
            permission: {
                title: "Permission selection",
                current: formatPermissionLabel(settings),
                options: PERMISSION_MODE_OPTIONS,
            },
            sandbox: {
                title: "Permission selection",
                current: formatPermissionLabel(settings),
                options: PERMISSION_MODE_OPTIONS,
                patchKey: "permission",
            },
        };
        const config = configMap[kind];
        if (!config) {
            return null;
        }
        return {
            text: `${config.title}\nCurrent: ${config.current}`,
            replyMarkup: {
                inline_keyboard: [
                    ...config.options.map((option) => [{
                        text: option.label,
                        callback_data: `set:${config.patchKey || kind}:${option.id}`,
                    }]),
                    [{ text: "Back", callback_data: "menu:main" }],
                ],
            },
        };
    }

    async showSessionPicker(chatId) {
        const picker = this.buildSessionPicker(chatId);
        if (picker.replyMarkup) {
            await this.api.sendMessageWithMarkup(chatId, picker.text, picker.replyMarkup);
            return;
        }
        await this.api.sendMessage(chatId, picker.text);
    }

    async promptForBinding(chatId, prefixText = NO_SESSION_PICKER_MESSAGE) {
        const picker = this.buildSessionPicker(chatId);
        if (picker.replyMarkup) {
            const text = `${prefixText}\n\n${picker.text}`;
            await this.api.sendMessageWithMarkup(chatId, text, picker.replyMarkup);
            return;
        }
        await this.api.sendMessage(chatId, `${prefixText}\n\n${picker.text}`);
    }

    async showMainControls(chatId) {
        await this.refreshChatSettingsFromApp(chatId, "show_main_controls");
        const panel = this.buildMainControlsMessage(chatId);
        await this.api.sendMessageWithMarkup(chatId, panel.text, panel.replyMarkup);
    }

    formatHistoryTimestamp(timestamp) {
        if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
            return "";
        }
        return formatSessionTimestamp(timestamp);
    }

    formatTranscriptLine(entry) {
        const roleLabel = entry.role === "assistant" ? "Codex" : "You";
        const timestamp = this.formatHistoryTimestamp(entry.timestamp);
        const prefix = timestamp ? `[${timestamp}] ${roleLabel}` : roleLabel;
        return `${prefix}\n${entry.text}`.trim();
    }

    buildSessionReplayHeader(sessionInfo, history, { replayedAt = new Date() } = {}) {
        const replay = buildSessionReplaySelection(history, replayedAt);
        const userEntryCount = (replay.groups || []).reduce((sum, group) => sum + ((group?.userEntries || []).length), 0);
        const completedGroupCount = (replay.groups || []).filter((group) => group?.resultEntry && !group?.isPartial).length;
        const partialGroupCount = (replay.groups || []).filter((group) => group?.isPartial).length;
        const lines = [
            `# ${sessionInfo?.title || "(untitled session)"}`,
            `Session ID: ${sessionInfo?.sessionId || "-"}`,
            `Last activity: ${sessionInfo?.modifiedAt ? formatSessionTimestamp(sessionInfo.modifiedAt) : "-"}`,
            `Messages: ${history.length}`,
            `Replay count: latest ${DEFAULT_SESSION_HISTORY_REPLAY_PAIR_LIMIT} instruction/result groups`,
            "Replay order: chronological (oldest to newest within the selected latest groups)",
        ];
        lines.push(`Replaying ${userEntryCount} user messages across ${completedGroupCount} completed and ${partialGroupCount} partial instruction/result groups.`);
        if (partialGroupCount) {
            lines.push("Partial groups use the newest assistant progress/commentary block when no completed result was stored yet.");
        }
        return {
            header: lines.join("\n"),
            groups: replay.groups,
        };
    }

    async sendPlainChunkedText(chatId, text) {
        const chunks = splitReplyChunks(text, this.config.maxReplyChars);
        for (let index = 0; index < chunks.length; index += 1) {
            await this.api.sendMessage(chatId, chunks[index]);
            if (index < chunks.length - 1) {
                await delay(DEFAULT_SESSION_REPLAY_SEND_DELAY_MS);
            }
        }
    }

    async sendReplayHistoryEntry(chatId, entry) {
        if (entry.role === "user-group") {
            const groupedText = (entry.userEntries || []).map((item) => this.formatTranscriptLine(item)).filter(Boolean).join("\n\n").trim();
            if (groupedText) {
                await this.sendPlainChunkedText(chatId, groupedText);
            }
            return;
        }
        if (entry.role !== "assistant") {
            await this.sendPlainChunkedText(chatId, this.formatTranscriptLine(entry));
            return;
        }

        const timestamp = this.formatHistoryTimestamp(entry.timestamp);
        const prefix = timestamp ? `[${timestamp}] Codex` : "Codex";
        const messages = buildAssistantTelegramMessages(entry.text, this.config.maxReplyChars);
        for (let index = 0; index < messages.length; index += 1) {
            const message = messages[index];
            const text = index === 0
                ? `<b>${escapeTelegramHtml(prefix)}</b>\n${message.text}`
                : message.text;
            await this.api.sendMessage(chatId, text, message.parseMode ? { parseMode: message.parseMode } : null);
            if (index < messages.length - 1) {
                await delay(DEFAULT_SESSION_REPLAY_SEND_DELAY_MS);
            }
        }
    }

    async sendSessionHistory(chatId, sessionId) {
        const { session, history } = this.catalog.readSessionHistory(sessionId);
        if (!session) {
            await this.api.sendMessage(chatId, `Unable to load session history for ${sessionId}.`);
            return;
        }
        const replay = this.buildSessionReplayHeader(session, history, { replayedAt: new Date() });
        for (const group of replay.groups || []) {
            if (Array.isArray(group?.userEntries) && group.userEntries.length) {
                await delay(DEFAULT_SESSION_REPLAY_SEND_DELAY_MS);
                await this.sendReplayHistoryEntry(chatId, { role: "user-group", userEntries: group.userEntries });
            }
            if (group?.resultEntry) {
                await delay(DEFAULT_SESSION_REPLAY_SEND_DELAY_MS);
                await this.sendReplayHistoryEntry(chatId, group.resultEntry);
            }
        }
    }

    async bindChatToSession(chatId, sessionId, callbackId = null, callbackMessageId = null) {
        await this.safeAnswerCallbackQuery(callbackId, "Opening session", `bind_session:${sessionId}`);
        const previousSessionId = this.bindings.getSession(chatId) || null;
        const result = this.bindings.bind(chatId, sessionId);
        if (!result.ok) {
            await this.api.sendMessage(chatId, result.message);
            return result;
        }

        if (typeof this.config.ensureSessionOpen === "function") {
            try {
                await this.config.ensureSessionOpen(sessionId);
            } catch (error) {
                if (previousSessionId && previousSessionId !== sessionId) {
                    this.bindings.bind(chatId, previousSessionId);
                } else {
                    this.bindings.unbind(chatId);
                }
                const message = error instanceof Error ? error.message : String(error);
                await this.api.sendMessage(chatId, `Failed to open session ${sessionId} in the Codex app.\n\n${message}`);
                return { ok: false, message };
            }
        }

        this.pendingNewThread.clear(chatId);
        await this.clearPendingApproval(chatId, `bind_session:${sessionId}`);
        await this.safeClearCallbackMarkup(chatId, callbackMessageId, `bind_session:${sessionId}`);
        await this.sendSessionHistory(chatId, sessionId);
        void this.refreshChatSettingsFromApp(chatId, "bind_session");
        this.scheduleApprovalSync(chatId, sessionId, "bind_session");
        return result;
    }

    async showOptionPicker(chatId, kind) {
        if (kind === "session") {
            await this.showSessionPicker(chatId);
            return;
        }
        const target = this.getNativeConversationTarget(chatId);
        if (kind === "fast" && (!target || !target.isBoundSession)) {
            await this.api.sendMessage(chatId, "Fast applies only to a real Codex session. Bind a session first.");
            if (!target) {
                await this.promptForBinding(chatId, "Bind a session first.");
            }
            return;
        }
        if (["model", "effort", "permission", "sandbox", "fast"].includes(kind)) {
            if (!target) {
                await this.promptForBinding(chatId, "Bind a session or open /codex_new first.");
                return;
            }
            await this.refreshChatSettingsFromApp(chatId, `show_option_${kind}`);
        }
        const picker = this.buildOptionPickerMessage(chatId, kind);
        if (!picker) {
            await this.api.sendMessage(chatId, "Unsupported picker.");
            return;
        }
        await this.api.sendMessageWithMarkup(chatId, picker.text, picker.replyMarkup);
    }

    async stageTelegramFile(fileId, preferredName) {
        const fileInfo = await this.api.getFile(fileId);
        const remotePath = fileInfo.file_path;
        const fileName = sanitizeFileName(preferredName || path.basename(remotePath));
        const absolutePath = path.join(this.config.telegramInboxDir, fileName);
        ensureDir(path.dirname(absolutePath));
        const content = await this.api.downloadFile(remotePath);
        fs.writeFileSync(absolutePath, content);
        return { filePath: absolutePath, fileName };
    }

    async buildTurnPayloadFromMessage(message) {
        const caption = String(message?.caption || "").trim();
        const text = String(message?.text || "").trim();
        if (text) {
            return { prompt: text, input: [{ type: "text", text, text_elements: [] }], attachments: [] };
        }

        const photo = getTelegramPhotoVariant(message?.photo);
        if (photo?.file_id) {
            const staged = await this.stageTelegramFile(photo.file_id, `telegram-photo-${photo.file_unique_id || photo.file_id}.jpg`);
            this.logger.info(`mapping telegram photo to app-native localImage input file=${staged.filePath}`);
            return buildNativeImageTurnPayload(staged, caption);
        }

        const document = message?.document;
        if (document?.file_id) {
            const staged = await this.stageTelegramFile(document.file_id, document.file_name || `telegram-document-${document.file_unique_id || document.file_id}`);
            if (isImageDocument(document)) {
                this.logger.info(`mapping telegram image document to app-native localImage input file=${staged.filePath}`);
                return buildNativeImageTurnPayload(staged, caption);
            }
            const prompt = caption || "Check the attached file.";
            return {
                prompt,
                input: [{ type: "text", text: prompt, text_elements: [] }],
                attachments: [{ label: staged.fileName, path: staged.filePath, fsPath: staged.filePath }],
            };
        }

        if (caption) {
            return { prompt: caption, input: [{ type: "text", text: caption, text_elements: [] }], attachments: [] };
        }
        return null;
    }

    async applyNativeOptionSelection(chatId, kind, selected, settings) {
        const target = this.getNativeConversationTarget(chatId);
        if (!target) {
            throw new Error("Bind a session or open /codex_new first.");
        }

        if (kind === "fast") {
            if (!target.isBoundSession) {
                throw new Error("Fast applies only after the draft becomes a real Codex session.");
            }
            if (typeof this.config.setThreadServiceTier !== "function") {
                throw new Error("Fast is unavailable in this portable build.");
            }
            await this.config.setThreadServiceTier({
                conversationId: target.conversationId,
                serviceTier: selected.value,
                source: "telegram_fast_picker",
            });
            try {
                updateCodexPersistedAtomState(this.config.codexGlobalStatePath, "default-service-tier", selected.value);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(`updateCodexPersistedAtomState failed after thread Fast update: ${message}`);
            }
            if (typeof this.config.setDefaultServiceTier === "function") {
                try {
                    await this.config.setDefaultServiceTier(selected.value);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this.logger.warn(`setDefaultServiceTier callback failed after thread Fast update: ${message}`);
                }
            }
            return { serviceTier: selected.value };
        }

        if (kind === "model" || kind === "effort") {
            if (typeof this.config.setModelAndReasoning !== "function") {
                throw new Error("Model and reasoning controls are unavailable in this portable build.");
            }
            const model = kind === "model" ? selected.value : (settings.model ?? null);
            const nextEffortOptions = this.modelCatalog.getEffortOptions(model);
            const reasoningEffort = kind === "effort"
                ? selected.value
                : (settings.effort && nextEffortOptions.some((option) => option.value === settings.effort) ? settings.effort : null);
            const result = await this.config.setModelAndReasoning({
                conversationId: target.conversationId,
                model,
                reasoningEffort,
            });
            return {
                model: result?.model ?? model ?? null,
                effort: result?.reasoningEffort ?? reasoningEffort ?? null,
            };
        }

        if (kind === "permission" || kind === "sandbox") {
            if (typeof this.config.setPermissionMode !== "function") {
                throw new Error("Permission control is unavailable in this portable build.");
            }
            const permissionMode = normalizePermissionMode(selected.value);
            const result = await this.config.setPermissionMode({
                conversationId: target.conversationId,
                permissionMode,
            });
            const nextPermissionMode = normalizePermissionMode(result?.permissionMode ?? permissionMode);
            return {
                permissionMode: nextPermissionMode,
                sandbox: permissionModeToSandboxValue(nextPermissionMode),
            };
        }

        return { [kind]: selected.value };
    }

    async handleCallbackQuery(update) {
        const callback = update.callback_query;
        const callbackId = callback?.id;
        const data = String(callback?.data || "").trim();
        const chatId = String(callback?.message?.chat?.id || "");
        const callbackMessageId = Number(callback?.message?.message_id || 0) || null;
        if (!callbackId || !chatId) {
            return;
        }
        if (!this.isAuthorized(chatId)) {
            await this.safeAnswerCallbackQuery(callbackId, "Unauthorized chat.", "unauthorized_callback");
            return;
        }
        if (data === "action:new-thread") {
            await this.openNewThread(chatId, "", callbackId);
            return;
        }
        if (data.startsWith("menu:")) {
            const kind = data.slice("menu:".length).trim();
            await this.safeAnswerCallbackQuery(callbackId, "Opening menu", `open_menu:${kind}`);
            if (kind === "main") {
                await this.showMainControls(chatId);
                return;
            }
            await this.showOptionPicker(chatId, kind);
            return;
        }
        if (data.startsWith("session:")) {
            const sessionId = data.slice("session:".length).trim();
            await this.bindChatToSession(chatId, sessionId, callbackId, callbackMessageId);
            return;
        }
        if (data.startsWith("approval:")) {
            await this.handleApprovalCallback(chatId, callbackId, callbackMessageId, data);
            return;
        }
        if (!data.startsWith("set:")) {
            await this.safeAnswerCallbackQuery(callbackId, "Unknown action.", `unknown_callback:${data}`);
            return;
        }

        const [, kind, rawValue] = data.split(":");
        if (kind === "session") {
            const sessionId = String(rawValue || "").trim();
            await this.bindChatToSession(chatId, sessionId, callbackId, callbackMessageId);
            return;
        }

        await this.refreshChatSettingsFromApp(chatId, `callback_${kind}`);
        const settings = this.chatSettings.get(chatId);
        const optionMap = {
            model: this.modelCatalog.getSelectableModelOptions(),
            fast: FAST_OPTIONS,
            effort: this.modelCatalog.getSelectableEffortOptions(settings.model),
            sandbox: PERMISSION_MODE_OPTIONS,
            permission: PERMISSION_MODE_OPTIONS,
        };
        const options = optionMap[kind];
        const selected = options?.find((option) => option.id === rawValue);
        if (!selected) {
            await this.safeAnswerCallbackQuery(callbackId, "Unsupported value", `unsupported_value:${kind}`);
            return;
        }

        let patch;
        try {
            patch = await this.applyNativeOptionSelection(chatId, kind, selected, settings);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`applyNativeOptionSelection failed kind=${kind} error=${message}`);
            await this.safeAnswerCallbackQuery(callbackId, "Failed to apply", `apply_failed:${kind}`);
            await this.api.sendMessage(chatId, `Failed to apply ${selected.label} in the Codex app.\n\n${message}`);
            return;
        }
        this.chatSettings.update(chatId, patch);
        await this.refreshChatSettingsFromApp(chatId, `post_${kind}`);
        await this.safeAnswerCallbackQuery(callbackId, `${kind} updated`, `apply_success:${kind}`);
        if (kind === "model") {
            const effortPicker = this.buildOptionPickerMessage(chatId, "effort");
            await this.api.sendMessageWithMarkup(
                chatId,
                `${selected.label} selected.\n\n${this.formatSettingsSummary(chatId)}\n\nChoose reasoning next.`,
                effortPicker.replyMarkup,
            );
            return;
        }
        await this.api.sendMessage(chatId, `${selected.label} selected.\n\n${this.formatSettingsSummary(chatId)}`);
    }

    async handleCommand(chatId, text) {
        const redirect = async (target) => {
            await this.api.sendMessage(chatId, `Use ${target}.`);
            return true;
        };
        if (text === "/start") {
            await this.api.sendMessage(chatId, START_MESSAGE);
            if (!this.bindings.getSession(chatId)) {
                await this.promptForBinding(chatId);
            }
            return true;
        }
        if (text === "/help") {
            await this.api.sendMessage(chatId, HELP_MESSAGE);
            return true;
        }
        if (text === "/codex_help") {
            await this.api.sendMessage(chatId, [
                "Codex commands:",
                "/codex_controls",
                "/codex_current",
                "/codex_new [prompt]",
                "/codex_session",
                "/codex_bind <session_id>",
                "/codex_bindindex <n>",
                "/codex_model",
                "/codex_fast",
                "/codex_reasoning",
                "/codex_permission",
                "/codex_unbind",
            ].join("\n"));
            return true;
        }
        if (text === "/status") {
            await this.api.sendMessage(chatId, this.formatStatus(chatId));
            return true;
        }
        if (text === "/codex_status") {
            return redirect("/status");
        }
        if (text === "/controls") {
            return redirect("/codex_controls");
        }
        if (text === "/codex_controls") {
            await this.showMainControls(chatId);
            return true;
        }
        if (text === "/new" || text.startsWith("/new ")) {
            return redirect("/codex_new");
        }
        if (text === "/codex_new" || text.startsWith("/codex_new ")) {
            const prompt = text === "/codex_new" ? "" : text.slice("/codex_new".length).trim();
            await this.openNewThread(chatId, prompt);
            return true;
        }
        if (text === "/current") {
            return redirect("/codex_current");
        }
        if (text === "/codex_current") {
            await this.api.sendMessage(chatId, await this.formatCurrentStateSummary(chatId));
            return true;
        }
        if (text === "/codex_session") {
            await this.showSessionPicker(chatId);
            return true;
        }
        if (text === "/session" || text === "/sessions" || text === "/codex_sessions") {
            await this.api.sendMessage(chatId, "Use /codex_session.");
            return true;
        }
        if (text === "/model") {
            return redirect("/codex_model");
        }
        if (text === "/codex_model") {
            await this.showOptionPicker(chatId, "model");
            return true;
        }
        if (text === "/speed" || text === "/fast" || text === "/codex_speed") {
            return redirect("/codex_fast");
        }
        if (text === "/codex_fast") {
            await this.showOptionPicker(chatId, "fast");
            return true;
        }
        if (text === "/reasoning") {
            return redirect("/codex_reasoning");
        }
        if (text === "/codex_reasoning") {
            await this.showOptionPicker(chatId, "effort");
            return true;
        }
        if (text === "/permission") {
            return redirect("/codex_permission");
        }
        if (text === "/codex_permission") {
            await this.showOptionPicker(chatId, "permission");
            return true;
        }
        if (text === "/sandbox") {
            return redirect("/codex_permission");
        }
        if (text === "/codex_sandbox") {
            return redirect("/codex_permission");
        }
        if (text === "/bindindex" || text.startsWith("/bindindex ")) {
            return redirect("/codex_bindindex");
        }
        if (text === "/codex_bindindex" || text.startsWith("/codex_bindindex ")) {
            const rawIndex = text.split(/\s+/, 2)[1]?.trim();
            if (!rawIndex) {
                await this.api.sendMessage(chatId, "Usage: /codex_bindindex <n>");
                return true;
            }
            const index = Number(rawIndex);
            const sessions = this.catalog.listRecentSessions();
            if (!Number.isInteger(index) || index < 1 || index > sessions.length) {
                await this.api.sendMessage(chatId, `Invalid index. Use /codex_session first. Available range: 1-${sessions.length}.`);
                return true;
            }
            await this.bindChatToSession(chatId, sessions[index - 1].sessionId);
            return true;
        }
        if (text === "/bind" || text.startsWith("/bind ")) {
            return redirect("/codex_bind");
        }
        if (text === "/codex_bind" || text.startsWith("/codex_bind ")) {
            const sessionId = text.split(/\s+/, 2)[1]?.trim();
            if (!sessionId) {
                await this.api.sendMessage(chatId, "Usage: /codex_bind <session_id>");
                return true;
            }
            await this.bindChatToSession(chatId, sessionId);
            return true;
        }
        if (text === "/unbind") {
            return redirect("/codex_unbind");
        }
        if (text === "/codex_unbind") {
            const result = this.bindings.unbind(chatId);
            this.pendingNewThread.clear(chatId);
            await this.clearPendingApproval(chatId, "unbind");
            await this.api.sendMessage(chatId, result.message);
            return true;
        }
        return false;
    }

    async handleMessage(update) {
        const message = update.message;
        const chatId = String(message?.chat?.id || "");
        if (!chatId) {
            return;
        }
        if (!this.isAuthorized(chatId)) {
            await this.api.sendMessage(chatId, UNAUTHORIZED_MESSAGE);
            return;
        }

        const plainText = String(message?.text || "").trim();
        if (plainText.startsWith("/")) {
            const handled = await this.handleCommand(chatId, plainText);
            if (handled) {
                return;
            }
        }

        const turnPayload = await this.buildTurnPayloadFromMessage(message);
        if (!turnPayload) {
            return;
        }
        const sessionId = this.bindings.getSession(chatId);
        if (!sessionId) {
            if (this.pendingNewThread.get(chatId)?.active) {
                await this.startPendingNewThread(chatId, turnPayload);
                return;
            }
            await this.promptForBinding(chatId);
            return;
        }
        this.pendingNewThread.clear(chatId);
        const suppressionMessage = {
            text: turnPayload.prompt,
            images: extractInputImageRefs(turnPayload.input),
            attachments: turnPayload.attachments,
        };
        this.monitor.suppressNextUserMessage(sessionId, buildMirrorFingerprint(suppressionMessage));
        await this.api.sendTyping(chatId);
        await this.monitor.injectTurn(sessionId, turnPayload, this.chatSettings.get(chatId));
    }

    async processUpdate(update) {
        if (update.callback_query) {
            await this.handleCallbackQuery(update);
            return;
        }
        if (update.message) {
            await this.handleMessage(update);
        }
    }

    async start({ dryRun = false } = {}) {
        ensureDir(this.config.stateDir);
        ensureDir(this.config.telegramInboxDir);
        ensureDir(path.dirname(this.config.logPath));
        this.logger.info(`starting config=${this.config.configPath}`);
        await this.monitor.start();
        if (dryRun) {
            this.logger.info("dry-run succeeded: Telegram runtime config loaded and Codex IPC connected.");
            await this.monitor.dispose();
            return;
        }
        await this.syncCommands();
        this.logger.info(`polling started allowlist=${[...this.config.allowedChatIds].join(",") || "all"}`);
        while (!this.disposed) {
            try {
                const updates = await this.api.getUpdates(this.offset, this.config.pollTimeoutSec);
                for (const update of updates) {
                    this.offset = Number(update.update_id) + 1;
                    try {
                        await this.processUpdate(update);
                    } catch (error) {
                        this.logger.error(`update processing failed: ${formatError(error)}`);
                        const chatId = String(update?.message?.chat?.id || update?.callback_query?.message?.chat?.id || "");
                        if (chatId) {
                            await this.api.sendMessage(chatId, `Codex app direct error:\n${String(error.message || error)}`).catch(() => {});
                        }
                    }
                }
            } catch (error) {
                this.logger.error(`poll loop failed: ${formatError(error)}`);
                await delay(2000);
            }
        }
    }

    async dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        for (const timeoutHandle of this.pendingApprovalSyncTimers.values()) {
            clearTimeout(timeoutHandle);
        }
        this.pendingApprovalSyncTimers.clear();
        this.pendingApprovalSyncs.clear();
        await this.monitor.dispose().catch((error) => {
            this.logger.warn(`monitor dispose failed: ${error.message}`);
        });
    }
}

async function bootWithConfigPath(configPath, options = {}) {
    const config = loadConfig(configPath);
    if (!config.telegramBotToken) {
        throw new Error(`telegramBotToken is missing in ${config.configPath}`);
    }
    if (typeof options.ensureSessionOpen === "function") {
        config.ensureSessionOpen = options.ensureSessionOpen;
    }
    if (typeof options.openNewThread === "function") {
        config.openNewThread = options.openNewThread;
    }
    if (typeof options.startNewThreadTurn === "function") {
        config.startNewThreadTurn = options.startNewThreadTurn;
    }
    if (typeof options.setDefaultServiceTier === "function") {
        config.setDefaultServiceTier = options.setDefaultServiceTier;
    }
    if (typeof options.setThreadServiceTier === "function") {
        config.setThreadServiceTier = options.setThreadServiceTier;
    }
    if (typeof options.setModelAndReasoning === "function") {
        config.setModelAndReasoning = options.setModelAndReasoning;
    }
    if (typeof options.setPermissionMode === "function") {
        config.setPermissionMode = options.setPermissionMode;
    }
    if (typeof options.getCurrentAppState === "function") {
        config.getCurrentAppState = options.getCurrentAppState;
    }
    if (typeof options.submitBoundThreadTurn === "function") {
        config.submitBoundThreadTurn = options.submitBoundThreadTurn;
    }
    if (typeof options.respondToApproval === "function") {
        config.respondToApproval = options.respondToApproval;
    }
    const logger = new OutputLogger(config.logPath);
    const app = new CodexAppDirectCompanion(config, logger);
    activeNativeApp = app;
    try {
        await app.start({ dryRun: options.dryRun === true });
        return app;
    } finally {
        if (activeNativeApp === app) {
            activeNativeApp = null;
        }
    }
}

let activeNativeStart = null;
let activeNativeApp = null;

async function startNativeTelegramBridge(options = {}) {
    if (activeNativeStart) {
        return activeNativeStart;
    }
    const userDataPath = options.userDataPath || path.join(os.homedir(), "AppData", "Roaming", "Codex");
    appendBootstrapLog(`[start] userDataPath=${userDataPath} optionsConfigPath=${options.configPath || ""}`);
    let configPath = options.configPath
        || process.env.CODEX_TELEGRAM_NATIVE_CONFIG
        || path.join(userDataPath, "telegram-native.json");
    if (!fs.existsSync(configPath)) {
        configPath = migrateLegacyConfigToPortable(userDataPath);
    }
    appendBootstrapLog(`[start] resolvedConfigPath=${configPath} exists=${fs.existsSync(configPath)}`);
    if (!fs.existsSync(configPath)) {
        appendBootstrapLog(`[start] config missing, skipping native telegram start`);
        return null;
    }
    activeNativeStart = bootWithConfigPath(configPath, {
        dryRun: false,
        ensureSessionOpen: options.ensureSessionOpen,
        openNewThread: options.openNewThread,
        startNewThreadTurn: options.startNewThreadTurn,
        setDefaultServiceTier: options.setDefaultServiceTier,
        setThreadServiceTier: options.setThreadServiceTier,
        setModelAndReasoning: options.setModelAndReasoning,
        setPermissionMode: options.setPermissionMode,
        getCurrentAppState: options.getCurrentAppState,
        submitBoundThreadTurn: options.submitBoundThreadTurn,
        respondToApproval: options.respondToApproval,
    }).catch((error) => {
        appendBootstrapLog(`[start-error] ${formatError(error)}`);
        activeNativeStart = null;
        throw error;
    });
    return activeNativeStart;
}

async function stopNativeTelegramBridge() {
    const runningPromise = activeNativeStart;
    const runningApp = activeNativeApp;
    if (!runningPromise && !runningApp) {
        return;
    }

    activeNativeStart = null;

    if (runningApp) {
        try {
            if (typeof runningApp.dispose === "function") {
                await runningApp.dispose();
            } else if (typeof runningApp.close === "function") {
                await runningApp.close();
            } else {
                runningApp.disposed = true;
            }
        } catch (error) {
            appendBootstrapLog(`[stop-error] ${formatError(error)}`);
        }
    }

    if (runningPromise) {
        try {
            await runningPromise.catch(() => {});
        } finally {
            if (activeNativeStart === runningPromise) {
                activeNativeStart = null;
            }
        }
    }
}

function notifyNativeTelegramApprovalStateChange(payload = null) {
    const app = activeNativeApp;
    if (!app || typeof app.handleApprovalStatePush !== "function") {
        return null;
    }
    return Promise.resolve(app.handleApprovalStatePush(payload)).catch((error) => {
        appendBootstrapLog(`[approval-state-error] ${formatError(error)}`);
        throw error;
    });
}

async function main() {
    const args = parseArgs(process.argv);
    await bootWithConfigPath(args.configPath, { dryRun: args.dryRun });
}

if (require.main === module) {
    main().catch((error) => {
        const message = formatError(error);
        console.error(message);
        process.exitCode = 1;
    });
}

module.exports = {
    startNativeTelegramBridge,
    stopNativeTelegramBridge,
    notifyNativeTelegramApprovalStateChange,
    loadConfig,
    CodexAppDirectCompanion,
};
