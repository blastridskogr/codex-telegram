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
const DEFAULT_SESSION_HISTORY_REPLAY_HOURS = 2;
const DEFAULT_SESSION_REPLAY_SEND_DELAY_MS = 250;
const DEFAULT_CHAT_SETTINGS_FILE = "chat_settings.json";
const DEFAULT_PENDING_NEW_THREAD_FILE = "pending_new_thread.json";
const DEFAULT_IPC_CONNECT_TIMEOUT_MS = 30000;
const DEFAULT_IPC_RETRY_DELAY_MS = 500;
const DEFAULT_TURN_INJECT_RETRY_COUNT = 3;
const DEFAULT_TURN_INJECT_RETRY_DELAY_MS = 900;
const DEFAULT_LABEL = "Default";
const DEFAULT_PERMISSION_LABEL = "Basic permission";
const CODEX_COMMANDS = [
    { command: "codex_help", description: "Show Codex Telegram commands." },
    { command: "codex_controls", description: "Open the Codex control panel." },
    { command: "codex_current", description: "Show the current Codex chat settings." },
    { command: "codex_new", description: "Open a real Codex New Thread draft in the app." },
    { command: "codex_session", description: "Pick the active Codex session." },
    { command: "codex_model", description: "Pick the Codex model." },
    { command: "codex_speed", description: "Pick the Codex speed." },
    { command: "codex_reasoning", description: "Pick the Codex reasoning effort." },
    { command: "codex_permission", description: "Pick the Codex permission mode." },
    { command: "codex_sandbox", description: "Pick the Codex sandbox mode." },
    { command: "codex_unbind", description: "Unbind this chat from the current Codex session." },
    { command: "codex_status", description: "Show Codex Telegram runtime status." },
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
const SPEED_OPTIONS = [
    { id: "standard", label: "Standard", value: null },
    { id: "fast", label: "Fast", value: "fast" },
];
const START_MESSAGE = "Codex Portable Telegram is online. Use /help for commands.";
const HELP_MESSAGE = [
    "Commands:",
    "/help - show commands",
    "/status - show runtime status",
    "/current - show current chat binding",
    "/new [prompt] - open a real Codex new-thread draft in the app",
    "/session or /sessions - list recent Codex app sessions",
    "/bind <session_id> - bind this chat to a specific session",
    "/unbind - remove the current chat binding",
    "",
    "Controls:",
    "/speed - pick speed",
    "/model - pick model",
    "/reasoning - pick reasoning",
    "/permission - pick permission",
    "/sandbox - pick sandbox",
    "",
    "After binding, send text, images, or documents and they will be injected into the bound Codex app session.",
].join("\n");
const UNAUTHORIZED_MESSAGE = "This Telegram chat is not allowed to control the Codex Portable Telegram runtime.";
const NO_SESSION_MESSAGE = "This chat is not bound to a Codex session. Use /session or /bind <session_id>.";
const NO_SESSION_PICKER_MESSAGE = "This chat is not bound to a Codex session. Pick a recent session below or use /bind <session_id>.";

function formatError(error) {
    if (error instanceof Error) {
        return error.stack || error.message;
    }
    return String(error);
}

function appendBootstrapLog(message) {
    const bootstrapLogPath = path.join(process.env.TEMP || os.tmpdir(), "codex-portable-telegram-bootstrap.log");
    try {
        fs.appendFileSync(bootstrapLogPath, `${new Date().toISOString()} ${message}\n`, "utf8");
    } catch {}
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
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
    const raw = fs.readFileSync(absoluteConfigPath, "utf8");
    const parsed = JSON.parse(raw);

    const stateDir = resolvePath(baseDir, parsed.stateDir, "./state");
    const bindingsPath = resolvePath(baseDir, parsed.bindingsPath, "./state/chat_bindings.json");
    const telegramInboxDir = resolvePath(baseDir, parsed.telegramInboxDir, "./telegram-inbox");
    const logPath = resolvePath(baseDir, parsed.logPath, "./logs/app.log");
    const workspaceRoots = Array.isArray(parsed.workspaceRoots)
        ? parsed.workspaceRoots.map((item) => resolvePath(baseDir, item)).filter(Boolean)
        : [];

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
        defaultSettings: {
            model: parsed.defaultSettings?.model ?? null,
            serviceTier: parsed.defaultSettings?.serviceTier ?? null,
            effort: parsed.defaultSettings?.effort ?? null,
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

function normalizeChatSettings(raw) {
    return {
        model: raw?.model ?? null,
        serviceTier: raw?.serviceTier ?? null,
        effort: raw?.effort ?? null,
        sandbox: raw?.sandbox ?? null,
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
        .filter((part) => part && part.type === "image" && part.url)
        .map((part) => String(part.url).trim())
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

function buildSafeImageTurnPayload(staged, caption) {
    const prompt = caption
        ? `${caption}\n\n[Telegram image file: ${staged.filePath}]`
        : `Analyze the Telegram image file saved at ${staged.filePath}.`;
    return {
        prompt,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        attachments: [{ label: staged.fileName, path: staged.filePath, fsPath: staged.filePath }],
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

function readFileTailUtf8(filePath, maxBytes = 64 * 1024) {
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

function readFileHeadUtf8(filePath, maxBytes = 64 * 1024) {
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

function findReplayAnchorTimestamp(history, replayedAt = new Date()) {
    const timestamps = (history || []).map((entry) => {
        const timestamp = entry?.timestamp;
        if (!timestamp || typeof timestamp.getTime !== "function") {
            return null;
        }
        const value = timestamp.getTime();
        return Number.isNaN(value) ? null : value;
    }).filter((value) => typeof value === "number");
    if (timestamps.length === 0) {
        return replayedAt.getTime();
    }
    return Math.max(...timestamps);
}

function filterHistoryForReplayWindow(history, replayedAt, windowHours = DEFAULT_SESSION_HISTORY_REPLAY_HOURS) {
    const anchorMs = findReplayAnchorTimestamp(history, replayedAt);
    const cutoffMs = anchorMs - (windowHours * 60 * 60 * 1000);
    return (history || []).filter((entry) => {
        const timestamp = entry?.timestamp;
        if (!timestamp || typeof timestamp.getTime !== "function") {
            return false;
        }
        const value = timestamp.getTime();
        if (Number.isNaN(value)) {
            return false;
        }
        return value >= cutoffMs && value <= anchorMs;
    });
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

function buildSessionReplaySelection(history, replayedAt = new Date()) {
    const sourceHistory = filterHistoryForReplayWindow(history, replayedAt);
    const groups = [];
    const pendingUserEntries = [];
    const preferTaskComplete = sourceHistory.some((entry) => entry?.isFinalSummary);
    for (const entry of sourceHistory) {
        if (entry?.role === "user") {
            pendingUserEntries.push(entry);
            continue;
        }
        if (!shouldTreatAsReplayResult(entry, preferTaskComplete)) {
            continue;
        }
        if (!pendingUserEntries.length) {
            continue;
        }
        groups.push({
            userEntries: pendingUserEntries.splice(0, pendingUserEntries.length),
            resultEntry: entry,
        });
    }
    if (pendingUserEntries.length) {
        groups.push({
            userEntries: pendingUserEntries.splice(0, pendingUserEntries.length),
            resultEntry: null,
        });
    }
    return { groups };
}

function extractPreviewFromSessionTail(tail) {
    const lines = tail.split(/\r?\n/).filter(Boolean).reverse();
    for (const line of lines) {
        try {
            const text = extractSessionText(JSON.parse(line));
            if (text) {
                return truncatePreview(text);
            }
        } catch {}
    }
    return "(no preview)";
}

function buildSandboxPolicy(kind, workspaceRoots) {
    if (!kind) {
        return null;
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
        const legacy = JSON.parse(fs.readFileSync(legacyConfigPath, "utf8"));
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
            const payload = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
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
            const payload = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
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
            const payload = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
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
    constructor(logger) {
        this.logger = logger;
        this.modelsPath = path.join(os.homedir(), ".codex", "models_cache.json");
        this.configPath = path.join(os.homedir(), ".codex", "config.toml");
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
}

class SessionCatalog {
    constructor(logger) {
        this.logger = logger;
        this.sessionsRoot = path.join(os.homedir(), ".codex", "sessions");
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
                pending.reject(new Error(frame.error || "IPC request failed."));
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
        this.pendingSuppressions = new Map();
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
        let lastError = null;
        for (let attempt = 1; attempt <= DEFAULT_TURN_INJECT_RETRY_COUNT; attempt += 1) {
            if (typeof this.config.ensureSessionOpen === "function") {
                await this.config.ensureSessionOpen(sessionId);
            }
            if (!this.socketReady()) {
                await this.connectWithRetry();
            }
            this.logger.info(`inject session=${sessionId} attempt=${attempt} inputs=${turnPayload.input.length} attachments=${turnPayload.attachments.length}`);
            try {
                await this.ipc.startTurnWithContent(sessionId, turnPayload.input, turnPayload.attachments, settings);
                return;
            } catch (error) {
                lastError = error;
                const message = String(error?.message || error);
                if (!message.includes("no-client-found") || attempt === DEFAULT_TURN_INJECT_RETRY_COUNT) {
                    throw error;
                }
                this.logger.warn(`inject retry after no-client-found session=${sessionId} attempt=${attempt}`);
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
        if (change.type !== "snapshot") {
            return;
        }
        this.processSnapshot(String(chatId), conversationId, change.conversationState || {}).catch((error) => {
            this.logger.error(`snapshot processing failed: ${error.message}`);
        });
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
        const messages = flattenConversationMessages(conversationState);
        let delivered = this.knownItemIds.get(conversationId);
        if (!delivered) {
            delivered = new Set(messages.map((message) => message.id).filter(Boolean));
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
        this.modelCatalog = new ModelCatalog(logger);
        this.catalog = new SessionCatalog(logger);
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
            { command: "help", description: "Show Codex app direct commands." },
            { command: "status", description: "Show runtime status." },
            { command: "current", description: "Show current chat settings." },
            { command: "new", description: "Open a real Codex New Thread draft in the app." },
            { command: "session", description: "Pick a recent Codex session." },
            { command: "sessions", description: "Pick a recent Codex session." },
            { command: "controls", description: "Open the Codex control panel." },
            { command: "model", description: "Pick the Codex model." },
            { command: "speed", description: "Pick the Codex speed." },
            { command: "reasoning", description: "Pick the Codex reasoning effort." },
            { command: "permission", description: "Pick the Codex permission mode." },
            { command: "sandbox", description: "Pick the Codex sandbox mode." },
            { command: "unbind", description: "Unbind this chat from the current session." },
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
    }

    formatSettingsSummary(chatId) {
        const settings = this.chatSettings.get(chatId);
        const sessionId = this.bindings.getSession(chatId) || "(not bound)";
        const sessionInfo = sessionId !== "(not bound)" ? this.catalog.findSessionEntry(sessionId) : null;
        const modelOptions = this.modelCatalog.getModelOptions();
        const effortOptions = this.modelCatalog.getEffortOptions(settings.model);
        const modelSummary = settings.model == null
            ? `${DEFAULT_LABEL} (${this.modelCatalog.getCurrentModel(settings.model) || "-"})`
            : labelForOption(modelOptions, settings.model);
        const speedSummary = labelForOption(SPEED_OPTIONS, settings.serviceTier);
        const effortSummary = settings.effort == null
            ? `${DEFAULT_LABEL} (${this.modelCatalog.getCurrentEffort(settings.effort, settings.model) || "-"})`
            : labelForOption(effortOptions, settings.effort);
        return [
            `Current session: ${sessionInfo?.title || sessionId}`,
            `Session ID: ${sessionInfo?.sessionId || "-"}`,
            `Model: ${modelSummary}`,
            `Speed: ${speedSummary}`,
            `Reasoning: ${effortSummary}`,
            `Permission: ${labelForOption(SANDBOX_OPTIONS, settings.sandbox)}`,
        ].join("\n");
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

    buildMainControlsMessage(chatId) {
        return {
            text: `Codex controls\n\n${this.formatSettingsSummary(chatId)}`,
            replyMarkup: {
                inline_keyboard: [
                    [{ text: "New Thread", callback_data: "action:new-thread" }],
                    [{ text: "Session", callback_data: "menu:session" }],
                    [{ text: "Model", callback_data: "menu:model" }],
                    [{ text: "Speed", callback_data: "menu:speed" }],
                    [{ text: "Reasoning", callback_data: "menu:effort" }],
                    [{ text: "Permission", callback_data: "menu:permission" }],
                ],
            },
        };
    }

    async openNewThread(chatId, prompt = "", callbackId = null) {
        if (callbackId) {
            await this.api.answerCallbackQuery(callbackId, "Opening new thread");
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
            "Send the first message in Codex, then use /session or /codex_session to bind the new thread.",
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

        const suppressionMessage = {
            text: String(turnPayload?.prompt || "").trim(),
            images: input.filter((item) => item?.type === "image").map((item) => item.url),
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
            "After that, use /session or /codex_session to bind the new thread.",
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
        const modelOptions = this.modelCatalog.getModelOptions();
        const effortOptions = this.modelCatalog.getEffortOptions(settings.model);
        const configMap = {
            model: {
                title: "Model selection",
                current: settings.model == null
                    ? `${DEFAULT_LABEL} (${this.modelCatalog.getCurrentModel(settings.model) || "-"})`
                    : labelForOption(modelOptions, settings.model),
                options: modelOptions,
            },
            speed: {
                title: "Speed selection",
                current: labelForOption(SPEED_OPTIONS, settings.serviceTier),
                options: SPEED_OPTIONS,
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
                current: labelForOption(SANDBOX_OPTIONS, settings.sandbox),
                options: SANDBOX_OPTIONS,
                patchKey: "sandbox",
            },
            sandbox: {
                title: "Sandbox selection",
                current: labelForOption(SANDBOX_OPTIONS, settings.sandbox),
                options: SANDBOX_OPTIONS,
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
        const replayAnchorMs = findReplayAnchorTimestamp(history, replayedAt);
        const replayAnchor = Number.isFinite(replayAnchorMs) ? formatSessionTimestamp(new Date(replayAnchorMs)) : "-";
        const userEntryCount = (replay.groups || []).reduce((sum, group) => sum + ((group?.userEntries || []).length), 0);
        const completedGroupCount = (replay.groups || []).filter((group) => group?.resultEntry).length;
        const hasPendingOnlyGroup = (replay.groups || []).some((group) => Array.isArray(group?.userEntries) && group.userEntries.length > 0 && !group.resultEntry);
        const lines = [
            `# ${sessionInfo?.title || "(untitled session)"}`,
            `Session ID: ${sessionInfo?.sessionId || "-"}`,
            `Last activity: ${sessionInfo?.modifiedAt ? formatSessionTimestamp(sessionInfo.modifiedAt) : "-"}`,
            `Messages: ${history.length}`,
            `Replay anchor: ${replayAnchor}`,
            `Replay window: ${DEFAULT_SESSION_HISTORY_REPLAY_HOURS} hours before the latest session message`,
            "Replay mode: completed instruction/result pairs from the replay window",
        ];
        lines.push(`Replaying ${userEntryCount} user messages across ${completedGroupCount} completed instruction/result groups.`);
        if (hasPendingOnlyGroup) {
            lines.push("Including the latest pending user-only group with no completed result yet.");
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

    async bindChatToSession(chatId, sessionId, callbackId = null) {
        const result = this.bindings.bind(chatId, sessionId);
        if (callbackId) {
            await this.api.answerCallbackQuery(callbackId, result.ok ? "Session updated" : result.message);
        }
        if (result.ok) {
            this.pendingNewThread.clear(chatId);
            await this.sendSessionHistory(chatId, sessionId);
            return result;
        }
        await this.api.sendMessage(chatId, result.message);
        return result;
    }

    async showOptionPicker(chatId, kind) {
        if (kind === "session") {
            await this.showSessionPicker(chatId);
            return;
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
            this.logger.warn(`downgrading telegram photo to text+attachment file=${staged.filePath}`);
            return buildSafeImageTurnPayload(staged, caption);
        }

        const document = message?.document;
        if (document?.file_id) {
            const staged = await this.stageTelegramFile(document.file_id, document.file_name || `telegram-document-${document.file_unique_id || document.file_id}`);
            if (isImageDocument(document)) {
                this.logger.warn(`downgrading telegram image document to text+attachment file=${staged.filePath}`);
                return buildSafeImageTurnPayload(staged, caption);
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

    async handleCallbackQuery(update) {
        const callback = update.callback_query;
        const callbackId = callback?.id;
        const data = String(callback?.data || "").trim();
        const chatId = String(callback?.message?.chat?.id || "");
        if (!callbackId || !chatId) {
            return;
        }
        if (!this.isAuthorized(chatId)) {
            await this.api.answerCallbackQuery(callbackId, "Unauthorized chat.");
            return;
        }
        if (data === "action:new-thread") {
            await this.openNewThread(chatId, "", callbackId);
            return;
        }
        if (data.startsWith("menu:")) {
            const kind = data.slice("menu:".length).trim();
            await this.api.answerCallbackQuery(callbackId, "Opening menu");
            if (kind === "main") {
                await this.showMainControls(chatId);
                return;
            }
            await this.showOptionPicker(chatId, kind);
            return;
        }
        if (data.startsWith("session:")) {
            const sessionId = data.slice("session:".length).trim();
            await this.bindChatToSession(chatId, sessionId, callbackId);
            return;
        }
        if (!data.startsWith("set:")) {
            await this.api.answerCallbackQuery(callbackId, "Unknown action.");
            return;
        }

        const [, kind, rawValue] = data.split(":");
        if (kind === "session") {
            const sessionId = String(rawValue || "").trim();
            await this.bindChatToSession(chatId, sessionId, callbackId);
            return;
        }

        const settings = this.chatSettings.get(chatId);
        const optionMap = {
            model: this.modelCatalog.getModelOptions(),
            speed: SPEED_OPTIONS,
            effort: this.modelCatalog.getEffortOptions(settings.model),
            sandbox: SANDBOX_OPTIONS,
        };
        const options = optionMap[kind];
        const selected = options?.find((option) => option.id === rawValue);
        if (!selected) {
            await this.api.answerCallbackQuery(callbackId, "Unsupported value");
            return;
        }

        const patchKey = kind === "speed" ? "serviceTier" : kind;
        const patch = { [patchKey]: selected.value };
        if (kind === "model") {
            const nextEffortOptions = this.modelCatalog.getEffortOptions(selected.value);
            if (settings.effort && !nextEffortOptions.some((option) => option.value === settings.effort)) {
                patch.effort = null;
            }
        }
        this.chatSettings.update(chatId, patch);
        await this.api.answerCallbackQuery(callbackId, `${kind} updated`);
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
        if (text === "/start") {
            await this.api.sendMessage(chatId, START_MESSAGE);
            if (!this.bindings.getSession(chatId)) {
                await this.promptForBinding(chatId);
            }
            return true;
        }
        if (text === "/help") {
            await this.api.sendMessage(chatId, `${HELP_MESSAGE}\n/controls - open controls\n/model - pick model\n/reasoning - pick reasoning\n/permission - pick permission\n/sandbox - pick sandbox\n/codex_help - show codex-prefixed commands`);
            return true;
        }
        if (text === "/codex_help") {
            await this.api.sendMessage(chatId, [
                "Codex commands:",
                "/codex_controls",
                "/codex_current",
                "/codex_new [prompt]",
                "/codex_session",
                "/codex_model",
                "/codex_speed",
                "/codex_reasoning",
                "/codex_permission",
                "/codex_sandbox",
                "/codex_status",
                "/codex_unbind",
            ].join("\n"));
            return true;
        }
        if (text === "/status" || text === "/codex_status") {
            await this.api.sendMessage(chatId, this.formatStatus(chatId));
            return true;
        }
        if (text === "/controls" || text === "/codex_controls") {
            await this.showMainControls(chatId);
            return true;
        }
        if (text === "/new" || text.startsWith("/new ")) {
            const prompt = text === "/new" ? "" : text.slice("/new".length).trim();
            await this.openNewThread(chatId, prompt);
            return true;
        }
        if (text === "/codex_new" || text.startsWith("/codex_new ")) {
            const prompt = text === "/codex_new" ? "" : text.slice("/codex_new".length).trim();
            await this.openNewThread(chatId, prompt);
            return true;
        }
        if (text === "/current" || text === "/codex_current") {
            await this.api.sendMessage(chatId, this.formatSettingsSummary(chatId));
            return true;
        }
        if (text === "/session" || text === "/sessions" || text === "/codex_session") {
            await this.showSessionPicker(chatId);
            return true;
        }
        if (text === "/model" || text === "/codex_model") {
            await this.showOptionPicker(chatId, "model");
            return true;
        }
        if (text === "/speed" || text === "/codex_speed") {
            await this.showOptionPicker(chatId, "speed");
            return true;
        }
        if (text === "/reasoning" || text === "/codex_reasoning") {
            await this.showOptionPicker(chatId, "effort");
            return true;
        }
        if (text === "/permission" || text === "/codex_permission") {
            await this.showOptionPicker(chatId, "permission");
            return true;
        }
        if (text === "/sandbox" || text === "/codex_sandbox") {
            await this.showOptionPicker(chatId, "sandbox");
            return true;
        }
        if (text.startsWith("/bindindex ")) {
            const rawIndex = text.split(/\s+/, 2)[1]?.trim();
            const index = Number(rawIndex);
            const sessions = this.catalog.listRecentSessions();
            if (!Number.isInteger(index) || index < 1 || index > sessions.length) {
                await this.api.sendMessage(chatId, `Invalid index. Use /sessions first. Available range: 1-${sessions.length}.`);
                return true;
            }
            await this.bindChatToSession(chatId, sessions[index - 1].sessionId);
            return true;
        }
        if (text.startsWith("/bind ")) {
            const sessionId = text.split(/\s+/, 2)[1]?.trim();
            if (!sessionId) {
                await this.api.sendMessage(chatId, "Usage: /bind <session_id>");
                return true;
            }
            await this.bindChatToSession(chatId, sessionId);
            return true;
        }
        if (text === "/unbind" || text === "/codex_unbind") {
            const result = this.bindings.unbind(chatId);
            this.pendingNewThread.clear(chatId);
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
            images: turnPayload.input.filter((item) => item?.type === "image").map((item) => item.url),
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
    loadConfig,
    CodexAppDirectCompanion,
};

