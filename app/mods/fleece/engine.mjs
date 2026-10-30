// src/config.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// src/export/opener.ts
import { spawn } from "node:child_process";
var SYSTEM = {
  darwin: "open",
  linux: "xdg-open"
};
function systemOpener(platform = process.platform) {
  return SYSTEM[platform];
}
function openArgs(target, options = {}) {
  if (!options.link && options.command && options.command.length > 0) {
    return [...options.command, target];
  }
  const opener = systemOpener(options.platform);
  return opener ? [opener, target] : null;
}
function parseCommand(text) {
  const parts = text?.trim().split(/\s+/).filter((part) => part !== "") ?? [];
  return parts.length > 0 ? parts : void 0;
}
function launch(argv) {
  const [bin, ...args] = argv;
  if (!bin) return Promise.reject(new Error("no command to open with"));
  return new Promise((resolve3, reject) => {
    const child = spawn(bin, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve3();
    });
  });
}

// src/keys.ts
var COMMANDS = [
  "close",
  "down",
  "up",
  "page-down",
  "top",
  "bottom",
  "reload",
  "send",
  "open",
  "older",
  "newer",
  "frame",
  "copy-answer",
  "save"
];
var DEFAULT_KEYS = {
  close: "q",
  down: "j",
  up: "k",
  "page-down": " ",
  top: "g",
  bottom: "G",
  reload: "r",
  send: "s",
  open: "e",
  older: "[",
  newer: "]",
  frame: "o",
  "copy-answer": "y",
  save: "m"
};
function resolveKeys(table) {
  const keys = { ...DEFAULT_KEYS };
  const problems = [];
  if (!table) return { keys, problems };
  const known = new Set(COMMANDS);
  for (const [name, value] of Object.entries(table)) {
    const command = name.replace(/_/g, "-");
    if (!known.has(command)) {
      problems.push(`unknown command "${name}"`);
      continue;
    }
    if (typeof value !== "string" || [...value].length !== 1) {
      problems.push(`${name}: a binding is one character, not ${JSON.stringify(value)}`);
      continue;
    }
    keys[command] = value;
  }
  const taken = /* @__PURE__ */ new Map();
  for (const command of COMMANDS) {
    const other = taken.get(keys[command]);
    if (other !== void 0) {
      problems.push(`"${keys[command]}" is bound to both ${other} and ${command}`);
      continue;
    }
    taken.set(keys[command], command);
  }
  return { keys, problems };
}
var POOL = "123456789abcdefghijklmnopqrstuvwxyz";
function pickKeys(keys = DEFAULT_KEYS) {
  const bound = new Set(Object.values(keys));
  return [...POOL].filter((char) => !bound.has(char));
}

// src/toml.ts
function parseToml(source) {
  const root = {};
  let table = root;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line === "") continue;
    const section2 = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (section2) {
      const name = section2[1];
      const nested = {};
      root[name] = nested;
      table = nested;
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const value = parseValue(pair[2].trim());
    if (value !== void 0) table[pair[1]] = value;
  }
  return root;
}
function stripComment(line) {
  let quote2 = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote2) {
      if (ch === quote2) quote2 = null;
    } else if (ch === '"' || ch === "'") {
      quote2 = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}
function parseValue(raw) {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((part) => part.trim()).filter((part) => part !== "").map(unquote);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d*\.\d+$/.test(raw)) return Number.parseFloat(raw);
  if (raw.startsWith('"') && raw.endsWith('"') || raw.startsWith("'") && raw.endsWith("'")) {
    return unquote(raw);
  }
  return void 0;
}
function unquote(raw) {
  if (raw.startsWith('"') && raw.endsWith('"') || raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return raw;
}

// src/config.ts
var DEFAULTS = {
  exportDir: join(homedir(), "Documents", "fleece"),
  includePrompt: true,
  includeThinking: false,
  frontMatter: true,
  journal: false,
  dockTurns: 3,
  dockWidth: 46,
  keys: DEFAULT_KEYS,
  keyProblems: []
};
function configPath(app = false) {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR ?? process.env.FLEECE_CONFIG_DIR ?? (app ? join(homedir(), ".config", "fleece") : void 0);
  return dir ? join(dir, "config.toml") : null;
}
function loadConfig(app = false) {
  const path = configPath(app);
  if (!path) return { ...DEFAULTS };
  let table;
  try {
    table = parseToml(readFileSync(path, "utf8"));
  } catch {
    return { ...DEFAULTS };
  }
  const bindings = resolveKeys(section(table, "keys"));
  return {
    keys: bindings.keys,
    keyProblems: bindings.problems,
    exportDir: expandHome(str(table, "export_dir") ?? DEFAULTS.exportDir),
    includePrompt: bool(table, "include_prompt") ?? DEFAULTS.includePrompt,
    includeThinking: bool(table, "include_thinking") ?? DEFAULTS.includeThinking,
    frontMatter: bool(table, "front_matter") ?? DEFAULTS.frontMatter,
    journal: bool(table, "journal") ?? DEFAULTS.journal,
    dockTurns: Math.max(1, int(table, "dock_turns") ?? DEFAULTS.dockTurns),
    dockWidth: Math.max(24, int(table, "dock_width") ?? DEFAULTS.dockWidth),
    openCommand: parseCommand(str(table, "open_command"))
  };
}
function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}
function section(table, key) {
  const value = table[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  return value;
}
function str(table, key) {
  const value = table[key];
  return typeof value === "string" ? value : void 0;
}
function bool(table, key) {
  const value = table[key];
  return typeof value === "boolean" ? value : void 0;
}
function int(table, key) {
  const value = table[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : void 0;
}

// src/core.ts
import { execFile as execFile2 } from "node:child_process";
import { readdirSync as readdirSync2, readFileSync as readFileSync2, statSync } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join3 } from "node:path";
import { promisify as promisify2 } from "node:util";

// src/resolve.ts
import { existsSync, readdirSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";

// src/herdr.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// src/render/text.ts
var ESC = String.fromCharCode(27);
var RESET = `${ESC}[0m`;
var COLOR = process.env.NO_COLOR === void 0;

// src/herdr.ts
var run = promisify(execFile);
var HERDR_BIN = process.env.HERDR_BIN_PATH ?? "herdr";
var ESC2 = String.fromCharCode(27);

// src/resolve.ts
function claudeProjectsDir() {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join2(homedir2(), ".claude");
  return join2(base, "projects");
}
function findClaudeTranscript(sessionId, cwd) {
  const projects = claudeProjectsDir();
  const file = `${sessionId}.jsonl`;
  if (cwd) {
    const direct = join2(projects, cwd.replace(/[/.]/g, "-"), file);
    if (existsSync(direct)) return direct;
  }
  let entries;
  try {
    entries = readdirSync(projects);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = join2(projects, entry, file);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// src/core.ts
var run2 = promisify2(execFile2);
var CoreError = class extends Error {
};
var HC_BIN = process.env.FLEECE_HC ?? "hc";
async function coreTerminal(address) {
  let stdout;
  try {
    ({ stdout } = await run2(HC_BIN, ["get", address, "--json"], { maxBuffer: 4 * 1024 * 1024 }));
  } catch (err) {
    const message2 = err instanceof Error ? err.message : String(err);
    throw new CoreError(`hc get ${address} failed: ${message2}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new CoreError(`hc get ${address} did not return JSON`);
  }
}
function agentApp(terminal) {
  return typeof terminal.status === "object" ? terminal.status?.app : void 0;
}
function isClaude(terminal) {
  if (agentApp(terminal) === "claude-code") return true;
  const head = terminal.foreground?.argv?.[0] ?? "";
  return /(^|\/)claude$/.test(head);
}
function claudeSessionsDir() {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join3(homedir3(), ".claude");
  return join3(base, "sessions");
}
function sessionIdForPid(pid, read = (path) => readFileSync2(path, "utf8")) {
  try {
    const record = JSON.parse(read(join3(claudeSessionsDir(), `${pid}.json`)));
    return typeof record?.sessionId === "string" && record.sessionId !== "" ? record.sessionId : void 0;
  } catch {
    return void 0;
  }
}
function newestTranscript(cwd) {
  const dir = join3(claudeProjectsDir(), cwd.replace(/[/.]/g, "-"));
  let best;
  let entries;
  try {
    entries = readdirSync2(dir);
  } catch {
    return void 0;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const path = join3(dir, entry);
    try {
      const mtime = statSync(path).mtimeMs;
      if (!best || mtime > best.mtime) best = { path, mtime };
    } catch {
    }
  }
  return best?.path;
}
async function resolveTerminal(address) {
  const terminal = await coreTerminal(address);
  const cwd = terminal.foreground?.cwd ?? terminal.cwd;
  const target = {
    paneId: terminal.address ?? address,
    agent: isClaude(terminal) ? "claude" : agentApp(terminal) ?? "unknown",
    cwd,
    title: terminal.title
  };
  if (target.agent !== "claude") return target;
  const pid = terminal.foreground?.pid;
  target.sessionId = pid ? sessionIdForPid(pid) : void 0;
  if (target.sessionId) {
    target.transcriptPath = findClaudeTranscript(target.sessionId, cwd) ?? void 0;
  }
  if (!target.transcriptPath && cwd) {
    target.transcriptPath = newestTranscript(cwd);
    const file = target.transcriptPath?.split("/").pop();
    if (file) target.sessionId ??= file.replace(/\.jsonl$/, "");
  }
  return target;
}

// src/export/clipboard.ts
import { execFile as execFile3 } from "node:child_process";
import { openSync, writeSync, closeSync } from "node:fs";
import { promisify as promisify3 } from "node:util";
var run3 = promisify3(execFile3);
var TOOLS = {
  darwin: [["pbcopy"]],
  linux: [
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"]
  ]
};
async function copyToClipboard(text) {
  const tool = await copyWithTool(text);
  const osc52 = writeOsc52(text);
  return { tool, osc52 };
}
async function copyWithTool(text) {
  for (const command of TOOLS[process.platform] ?? []) {
    const [bin, ...args] = command;
    if (!bin) continue;
    try {
      const child = run3(bin, args);
      child.child.stdin?.end(text);
      await child;
      return bin;
    } catch {
    }
  }
  return void 0;
}
function writeOsc52(text) {
  const payload = `\x1B]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
  let fd;
  try {
    fd = openSync("/dev/tty", "w");
  } catch {
    if (process.stdout.isTTY) {
      process.stdout.write(payload);
      return true;
    }
    return false;
  }
  try {
    writeSync(fd, payload);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

// src/export/code.ts
function extractCodeBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split("\n");
  let fence = null;
  let lang;
  let buffer = [];
  for (const line of lines) {
    const opening = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (fence === null) {
      if (opening) {
        fence = opening[1].charAt(0);
        lang = opening[2] === "" ? void 0 : opening[2];
        buffer = [];
      }
      continue;
    }
    if (opening && opening[1].charAt(0) === fence && opening[2] === "") {
      blocks.push({ lang, code: buffer.join("\n") });
      fence = null;
      lang = void 0;
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  if (fence !== null && buffer.length > 0) {
    blocks.push({ lang, code: buffer.join("\n") });
  }
  return blocks;
}
function codeOnly(markdown) {
  return extractCodeBlocks(markdown).map((block) => block.code.replace(/\s+$/, "")).filter((code) => code !== "").join("\n\n");
}

// src/export/markdown.ts
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join as join4 } from "node:path";
function buildMarkdown(turn, target, config) {
  const parts = [];
  if (config.frontMatter) parts.push(frontMatter(turn, target));
  if (config.includePrompt && turn.prompt !== "") {
    parts.push(`## Prompt

${quote(turn.prompt)}`);
  }
  if (config.includeThinking && turn.thinking !== "") {
    parts.push(`<details>
<summary>Thinking</summary>

${turn.thinking}

</details>`);
  }
  parts.push(turn.text === "" ? "_(no text in this answer)_" : turn.text);
  return `${parts.join("\n\n")}
`;
}
async function saveMarkdown(turn, target, config) {
  mkdirSync(config.exportDir, { recursive: true });
  const path = join4(config.exportDir, fileName(turn, target));
  writeAtomic(path, buildMarkdown(turn, target, config));
  return path;
}
function fileName(turn, target) {
  const project = slug(target.cwd ? basename(target.cwd) : "session");
  const session = slug(target.sessionId ?? target.paneId ?? "session").slice(0, 12);
  const index = String(turn.index).padStart(2, "0");
  return `${project}-${session}-turn${index}-${stamp(turn.endedAt)}.md`;
}
function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { encoding: "utf8", mode: 384 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw err;
  }
}
function frontMatter(turn, target) {
  const fields = [
    ["agent", target.agent],
    ["model", turn.model],
    ["session", target.sessionId],
    ["turn", turn.index],
    ["date", turn.endedAt ?? turn.promptAt],
    ["cwd", turn.cwd ?? target.cwd],
    ["branch", turn.gitBranch],
    ["input_tokens", turn.usage.input || void 0],
    ["output_tokens", turn.usage.output || void 0]
  ];
  const lines = fields.filter((entry) => entry[1] !== void 0).map(
    ([key, value]) => typeof value === "number" ? `${key}: ${value}` : `${key}: ${yaml(value)}`
  );
  return `---
${lines.join("\n")}
---`;
}
function yaml(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function quote(text) {
  return text.split("\n").map((line) => line === "" ? ">" : `> ${line}`).join("\n");
}
function slug(value) {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return cleaned === "" ? "session" : cleaned;
}
function stamp(iso) {
  const date = iso ? new Date(iso) : /* @__PURE__ */ new Date();
  const when = Number.isNaN(date.getTime()) ? /* @__PURE__ */ new Date() : date;
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${when.getFullYear()}${pad2(when.getMonth() + 1)}${pad2(when.getDate())}-${pad2(when.getHours())}${pad2(when.getMinutes())}${pad2(when.getSeconds())}`;
}

// src/extract.ts
import { existsSync as existsSync2 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join5, resolve as resolve2 } from "node:path";

// src/render/markdown.ts
function parseInline(text, base = {}) {
  const spans = [];
  let literal = "";
  let index = 0;
  const flush = () => {
    if (literal !== "") {
      spans.push({ text: literal, style: base });
      literal = "";
    }
  };
  while (index < text.length) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) {
      literal += text[index + 1];
      index += 2;
      continue;
    }
    if (char === "`") {
      const ticks = runLength(text, index, "`");
      const end = findTicks(text, index + ticks, ticks);
      if (end >= 0) {
        flush();
        spans.push({ text: text.slice(index + ticks, end).trim(), style: { ...base, code: true } });
        index = end + ticks;
        continue;
      }
    }
    if (char === "[") {
      const link = parseLink(text, index);
      if (link) {
        flush();
        spans.push(...parseInline(link.label, { ...base, underline: true }));
        if (link.url !== "") spans.push({ text: ` (${link.url})`, style: { ...base, dim: true } });
        index = link.end;
        continue;
      }
    }
    const opener = emphasisAt(text, index);
    if (opener) {
      const end = findEmphasisClose(text, index + opener.marker.length, opener.marker);
      if (end >= 0) {
        flush();
        const inner = text.slice(index + opener.marker.length, end);
        spans.push(...parseInline(inner, { ...base, ...opener.style }));
        index = end + opener.marker.length;
        continue;
      }
    }
    literal += char;
    index += 1;
  }
  flush();
  return spans;
}
function emphasisAt(text, index) {
  const two = text.slice(index, index + 2);
  const one = text[index];
  const before = index === 0 ? "" : text[index - 1];
  if (two === "~~") {
    return flanking(text, index, 2) ? { marker: "~~", style: { strike: true } } : null;
  }
  if (two === "**") {
    return flanking(text, index, 2) ? { marker: "**", style: { bold: true } } : null;
  }
  if (two === "__") {
    if (isWordChar(before)) return null;
    return flanking(text, index, 2) ? { marker: "__", style: { bold: true } } : null;
  }
  if (one === "*") {
    return flanking(text, index, 1) ? { marker: "*", style: { italic: true } } : null;
  }
  if (one === "_") {
    if (isWordChar(before)) return null;
    return flanking(text, index, 1) ? { marker: "_", style: { italic: true } } : null;
  }
  return null;
}
function flanking(text, index, length) {
  const next = text[index + length];
  return next !== void 0 && !/\s/.test(next);
}
function findEmphasisClose(text, from, marker) {
  for (let index = from; index <= text.length - marker.length; index++) {
    if (text[index - 1] === "\\") continue;
    if (text.slice(index, index + marker.length) !== marker) continue;
    if (index === from) continue;
    const before = text[index - 1];
    if (before === void 0 || /\s/.test(before)) continue;
    if (marker.startsWith("_") && isWordChar(text[index + marker.length] ?? "")) continue;
    return index;
  }
  return -1;
}
function isWordChar(char) {
  return /[A-Za-z0-9]/.test(char);
}
function runLength(text, index, char) {
  let length = 0;
  while (text[index + length] === char) length += 1;
  return length;
}
function findTicks(text, from, count) {
  for (let index = from; index <= text.length - count; index++) {
    if (text[index] !== "`") continue;
    if (runLength(text, index, "`") !== count) continue;
    return index;
  }
  return -1;
}
function parseLink(text, index) {
  let depth = 0;
  let close = -1;
  for (let scan = index; scan < text.length; scan++) {
    if (text[scan] === "[") depth += 1;
    else if (text[scan] === "]") {
      depth -= 1;
      if (depth === 0) {
        close = scan;
        break;
      }
    }
  }
  if (close < 0 || text[close + 1] !== "(") return null;
  const end = text.indexOf(")", close + 2);
  if (end < 0) return null;
  return {
    label: text.slice(index + 1, close),
    url: text.slice(close + 2, end).split(/\s+/)[0] ?? "",
    end: end + 1
  };
}

// src/extract.ts
var SHELL_LANGUAGES = /* @__PURE__ */ new Set(["sh", "bash", "zsh", "shell", "console", "terminal"]);
var MAX_COMMAND_LINES = 12;
var COMMAND_HEADS = /* @__PURE__ */ new Set([
  "herdr",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "node",
  "deno",
  "git",
  "gh",
  "docker",
  "kubectl",
  "terraform",
  "terragrunt",
  "aws",
  "php",
  "composer",
  "artisan",
  "python",
  "python3",
  "pip",
  "cargo",
  "go",
  "make",
  "curl",
  "wget",
  "ssh",
  "scp",
  "rsync",
  "sed",
  "awk",
  "jq",
  "cd",
  "ls",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "cat",
  "tail",
  "head",
  "grep",
  "find"
]);
var MAX_PER_KIND = 12;
var LONG_LINE = 800;
function resolvePath(text, cwd) {
  if (text.startsWith("~/")) return join5(homedir4(), text.slice(2));
  if (text.startsWith("/")) return text;
  if (!cwd) return null;
  return resolve2(cwd, text);
}
function extractItems(turns, options = {}) {
  const answered = turns.filter((turn) => turn.text !== "");
  const recent = answered.slice(-Math.max(1, options.turns ?? 3)).reverse();
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (item) => {
    const key = `${item.kind}:${item.text}`;
    if (seen.has(key)) return;
    if (items.filter((entry) => entry.kind === item.kind).length >= MAX_PER_KIND) return;
    seen.add(key);
    items.push(item);
  };
  const exists = options.exists ?? existsSync2;
  const edited = /* @__PURE__ */ new Set();
  const scopes = recent.map((turn) => {
    const base = turn.cwd ?? options.cwd;
    return { turn, base, exists, edited, resolve: (text) => resolvePath(text, base) };
  });
  for (const scope of scopes) collectFiles(scope, add);
  for (const scope of scopes) {
    collectBlocks(scope.turn, add);
    collectInline(scope, add);
    collectLinks(scope.turn, add);
  }
  const order = ["file", "code", "command", "path", "link"];
  return items.sort((left, right) => order.indexOf(left.kind) - order.indexOf(right.kind));
}
function collectFiles(scope, add) {
  for (const file of scope.turn.files ?? []) {
    const path = scope.resolve(file.path) ?? file.path;
    if (!scope.exists(path)) continue;
    scope.edited.add(path);
    add({
      kind: "file",
      label: relative(path, scope.base),
      text: path,
      detail: file.edits > 1 ? `\xD7${file.edits}` : void 0,
      open: path,
      turn: scope.turn.index
    });
  }
}
function relative(path, base) {
  if (base === void 0 || base === "") return path;
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
function collectBlocks(turn, add) {
  for (const block of extractCodeBlocks(turn.text)) {
    const lines = block.code.split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) continue;
    const shell = block.lang !== void 0 && SHELL_LANGUAGES.has(block.lang);
    if (shell && lines.length <= MAX_COMMAND_LINES) {
      for (const line of lines) {
        const command = line.replace(/^\s*\$\s+/, "").trim();
        if (command === "" || command.startsWith("#")) continue;
        add({ kind: "command", label: command, text: command, turn: turn.index });
      }
      continue;
    }
    if (block.lang === void 0 && !looksLikeCode(block.code)) continue;
    add({
      kind: "code",
      label: lines[0].trim(),
      text: block.code,
      tag: block.lang,
      detail: `${lines.length} ln`,
      turn: turn.index
    });
  }
}
function collectInline(scope, add) {
  const turn = scope.turn;
  for (const line of withoutFences(turn.text).split("\n")) {
    if (line.length > LONG_LINE) continue;
    for (const span of parseInline(line)) {
      if (!span.style.code) continue;
      const text = span.text.trim();
      if (text === "") continue;
      if (isPath(text)) {
        const path = scope.resolve(text);
        if (path === null || scope.edited.has(path) || !scope.exists(path)) continue;
        add({ kind: "path", label: text, text, open: path, turn: turn.index });
      } else if (isCommand(text)) {
        add({ kind: "command", label: text, text, turn: turn.index });
      }
    }
  }
}
function collectLinks(turn, add) {
  const matches = turn.text.match(/https?:\/\/[^\s)<>"'\]]+/g) ?? [];
  for (const match of matches) {
    const url = match.replace(/[.,;:]+$/, "");
    add({
      kind: "link",
      label: url.replace(/^https?:\/\//, ""),
      text: url,
      open: url,
      turn: turn.index
    });
  }
}
function isPath(text) {
  if (/\s/.test(text) || /^https?:\/\//.test(text)) return false;
  if (!text.includes("/") || text.includes("://")) return false;
  const anchor = /^(~\/|\.{1,2}\/|\/)/.exec(text);
  if (anchor) return /[\w.@-]/.test(text.slice(anchor[0].length));
  if (!/^[\w.@-]+(\/[\w.@-]+)+$/.test(text)) return false;
  const tail = text.slice(text.lastIndexOf("/") + 1);
  return /\.[A-Za-z][\w-]{0,8}$/.test(tail);
}
function looksLikeCode(text) {
  if (/[{}]|;\s*$|=>|\(\)|\)\s*[:{]|->|::/m.test(text)) return true;
  if (/^\s*(function|const|let|var|class|def|import|export|return|public|private|fn|package|#include|SELECT|CREATE)\b/m.test(
    text
  )) {
    return true;
  }
  return /^\s*[\w.-]+\s*=\s*\S/m.test(text);
}
var NOT_RUNNABLE = /[→⇒↩…]|\.\.\.$/;
function isCommand(text) {
  const trimmed = text.trim();
  if (trimmed.length > 160 || NOT_RUNNABLE.test(trimmed)) return false;
  const head = trimmed.split(/\s+/)[0] ?? "";
  if (!COMMAND_HEADS.has(head)) return false;
  return trimmed.includes(" ");
}
function withoutFences(text) {
  const out = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (marker) {
        fence = marker[1].charAt(0);
        continue;
      }
      out.push(line);
      continue;
    }
    if (marker && marker[1].charAt(0) === fence) fence = null;
  }
  return out.join("\n");
}

// src/journal.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync2 } from "node:fs";
import { join as join6 } from "node:path";
var DISK = {
  ensureDir(path) {
    mkdirSync2(path, { recursive: true });
  },
  exists: existsSync3,
  write(path, text) {
    writeAtomic(path, text);
  }
};
function journalTurns(turns, target, config, io = DISK) {
  const result = { written: [], skipped: 0, failed: 0 };
  const answered = turns.filter((turn) => turn.text !== "");
  if (answered.length === 0) return result;
  try {
    io.ensureDir(config.exportDir);
  } catch {
    result.failed = answered.length;
    return result;
  }
  for (const turn of answered) {
    const path = join6(config.exportDir, fileName(turn, target));
    if (io.exists(path)) {
      result.skipped += 1;
      continue;
    }
    try {
      io.write(path, buildMarkdown(turn, target, config));
      result.written.push(path);
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
function journalSummary(result) {
  const count = result.written.length;
  if (count === 0) return result.failed > 0 ? `journal failed \xD7${result.failed}` : void 0;
  const wrote = `journalled ${count} answer${count === 1 ? "" : "s"}`;
  return result.failed > 0 ? `${wrote} \xB7 ${result.failed} failed` : wrote;
}

// src/transcript/claude.ts
import { closeSync as closeSync2, openSync as openSync2, readSync, statSync as statSync2 } from "node:fs";
var WRITE_TOOLS = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path"
};
var WRAPPER_TAGS = [
  "system-reminder",
  "local-command-caveat",
  "local-command-stdout",
  "command-message",
  "command-args"
];
var PREFIX_BYTES = 32;
function emptyCursor() {
  return {
    offset: 0,
    pending: Buffer.alloc(0),
    closed: [],
    current: null,
    ino: 0,
    dev: 0,
    mtimeMs: 0,
    prefix: Buffer.alloc(0)
  };
}
function readTurns(path) {
  return readTurnsGrowing(path).turns;
}
function readTurnsGrowing(path, previous) {
  const info = statSync2(path);
  const cursor = previous && canContinue(previous, info, path) ? previous : emptyCursor();
  if (cursor.offset === info.size && cursor.pending.length === 0) {
    return { turns: snapshot(cursor), cursor };
  }
  const fd = openSync2(path, "r");
  try {
    const length = info.size - cursor.offset;
    if (length > 0) {
      const chunk = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = readSync(fd, chunk, read, length - read, cursor.offset + read);
        if (n === 0) break;
        read += n;
      }
      ingestBytes(cursor, chunk.subarray(0, read));
      cursor.offset += read;
    }
    flushPending(cursor);
    rememberFile(cursor, info, fd);
  } finally {
    closeSync2(fd);
  }
  return { turns: snapshot(cursor), cursor };
}
function canContinue(previous, info, path) {
  if (previous.offset === 0) return true;
  if (info.size < previous.offset) return false;
  if (previous.ino !== 0 && (info.ino !== previous.ino || info.dev !== previous.dev)) return false;
  if (info.size === previous.offset && info.mtimeMs !== previous.mtimeMs) return false;
  if (previous.prefix.length === 0) return true;
  const fd = openSync2(path, "r");
  try {
    const buf = Buffer.alloc(previous.prefix.length);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return n === previous.prefix.length && buf.equals(previous.prefix);
  } finally {
    closeSync2(fd);
  }
}
function rememberFile(cursor, info, fd) {
  cursor.ino = info.ino;
  cursor.dev = info.dev;
  cursor.mtimeMs = info.mtimeMs;
  if (cursor.prefix.length > 0 || info.size === 0) return;
  const n = Math.min(PREFIX_BYTES, info.size);
  const buf = Buffer.alloc(n);
  if (readSync(fd, buf, 0, n, 0) === n) cursor.prefix = buf;
}
function flushPending(cursor) {
  if (cursor.pending.length === 0) return;
  const line = cursor.pending.toString("utf8");
  if (line.trim() === "") {
    cursor.pending = Buffer.alloc(0);
    return;
  }
  try {
    JSON.parse(line);
  } catch {
    return;
  }
  ingestLine(cursor, line);
  cursor.pending = Buffer.alloc(0);
}
function ingestBytes(cursor, chunk) {
  const data = cursor.pending.length === 0 ? chunk : Buffer.concat([cursor.pending, chunk]);
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 10) continue;
    ingestLine(cursor, data.subarray(start, i).toString("utf8"));
    start = i + 1;
  }
  cursor.pending = start === 0 ? data : Buffer.from(data.subarray(start));
}
function ingestLine(cursor, line) {
  if (line.trim() === "") return;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  if (record.isSidechain === true) return;
  if (record.type === "user" && isPrompt(record)) {
    if (cursor.current) cursor.closed.push(finish(cursor.current));
    cursor.current = startTurn(cursor.closed.length + 1, record);
    return;
  }
  if (record.type === "assistant" && cursor.current) {
    accumulate(cursor.current, record);
  }
}
function snapshot(cursor) {
  if (!cursor.current) return cursor.closed.slice();
  return [...cursor.closed, finish(cloneTurn(cursor.current))];
}
function cloneTurn(turn) {
  return {
    ...turn,
    toolUses: turn.toolUses.map((use) => ({ ...use })),
    files: turn.files.map((file) => ({ ...file })),
    usage: { ...turn.usage }
  };
}
function isPrompt(record) {
  if (record.isMeta === true) return false;
  const content = record.message?.content;
  if (typeof content === "string") return cleanPrompt(content) !== "";
  if (!Array.isArray(content)) return false;
  const blocks = content;
  if (blocks.some((block) => block?.type === "tool_result")) return false;
  return cleanPrompt(textOf(blocks)) !== "";
}
function startTurn(index, record) {
  const content = record.message?.content;
  const raw = typeof content === "string" ? content : textOf(content);
  return {
    index,
    prompt: cleanPrompt(raw),
    promptAt: record.timestamp,
    text: "",
    thinking: "",
    toolUses: [],
    files: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    gitBranch: record.gitBranch,
    cwd: record.cwd,
    agentVersion: record.version
  };
}
function accumulate(turn, record) {
  const content = record.message?.content;
  const blocks = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
  for (const block of blocks) {
    if (!block) continue;
    if (block.type === "text" && block.text) {
      turn.text = turn.text === "" ? block.text : `${turn.text}

${block.text}`;
    } else if (block.type === "thinking" && block.thinking) {
      turn.thinking = turn.thinking === "" ? block.thinking : `${turn.thinking}

${block.thinking}`;
    } else if (block.type === "tool_use") {
      const name = block.name ?? "tool";
      addToolUse(turn.toolUses, name);
      addFileEdit(turn.files, name, block.input);
    }
  }
  if (record.message?.model) turn.model = record.message.model;
  if (record.timestamp) turn.endedAt = record.timestamp;
  if (record.gitBranch) turn.gitBranch = record.gitBranch;
  addUsage(turn.usage, record.message?.usage);
}
function finish(turn) {
  turn.text = turn.text.trim();
  turn.thinking = turn.thinking.trim();
  turn.files.sort((left, right) => right.edits - left.edits);
  if (turn.promptAt && turn.endedAt) {
    const ms = Date.parse(turn.endedAt) - Date.parse(turn.promptAt);
    if (Number.isFinite(ms) && ms >= 0) turn.durationMs = ms;
  }
  return turn;
}
function addToolUse(uses, name) {
  const existing = uses.find((use) => use.name === name);
  if (existing) existing.count += 1;
  else uses.push({ name, count: 1 });
}
function addFileEdit(files, name, input) {
  const field = WRITE_TOOLS[name];
  if (field === void 0 || typeof input !== "object" || input === null) return;
  const path = input[field];
  if (typeof path !== "string" || path.trim() === "") return;
  const existing = files.find((file) => file.path === path);
  if (existing) existing.edits += 1;
  else files.push({ path, edits: 1 });
}
function addUsage(usage, raw) {
  if (!raw) return;
  usage.input += num(raw["input_tokens"]);
  usage.output += num(raw["output_tokens"]);
  usage.cacheRead += num(raw["cache_read_input_tokens"]);
  usage.cacheCreation += num(raw["cache_creation_input_tokens"]);
}
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function textOf(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks.filter((block) => block?.type === "text" && block.text).map((block) => block.text).join("\n\n");
}
function cleanPrompt(raw) {
  let text = raw;
  for (const tag of WRAPPER_TAGS) {
    text = text.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), "");
  }
  text = text.replace(/<command-name>([\s\S]*?)<\/command-name>/g, (_m, name) => {
    const trimmed = name.trim();
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  });
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

// src/window.ts
function answers(turns) {
  return turns.filter((turn) => turn.text !== "");
}
function windowOf(turns, pinned) {
  const all = answers(turns);
  if (pinned === null) return all;
  const position = all.findIndex((turn) => turn.index === pinned);
  return position === -1 ? all : all.slice(0, position + 1);
}
function windowLabel(turns, pinned, size) {
  const window = windowOf(turns, pinned);
  const shown = window.slice(-Math.max(1, size));
  if (shown.length === 0) return "";
  if (pinned === null) return `last ${shown.length} turn${shown.length === 1 ? "" : "s"}`;
  return `turn ${shown[shown.length - 1].index} \xB7 ${answers(turns).length - window.length} back`;
}

// src/engine.ts
var EngineError = class extends Error {
};
async function main() {
  const [command = "", ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const config = loadConfig(true);
  switch (command) {
    case "state":
      return state(flags, config);
    case "copy":
      return copy(flags, config);
    case "clip":
      return clip2(flags);
    case "save":
      return save(flags, config);
    case "journal":
      return journal(flags, config);
    case "open":
      return open(flags, config);
    case "doctor":
      return doctor(flags, config);
    default:
      throw new EngineError(`unknown command "${command}"`);
  }
}
async function state(flags, config) {
  const { target, turns } = await load(flags);
  const pinned = flags.pin ?? null;
  const window = windowOf(turns, pinned);
  const turn = window.at(-1);
  const picks = pickKeys(config.keys);
  const items = extractItems(window, { turns: config.dockTurns, cwd: target.cwd }).map(
    (item, index) => ({ ...item, key: picks[index] })
  );
  const reply = {
    ok: true,
    target,
    answers: answers(turns).map((entry) => entry.index),
    pinned: pinned !== null && turn && turn.index !== answers(turns).at(-1)?.index ? pinned : null,
    label: windowLabel(turns, pinned, config.dockTurns),
    turn: turn ? view(turn) : null,
    items,
    keys: config.keys,
    exportDir: config.exportDir
  };
  if (flags.journal && config.journal) {
    reply.journal = journalSummary(journalTurns(turns, target, config)) ?? null;
  }
  return reply;
}
async function copy(flags, config) {
  const { target, turns } = await load(flags);
  const turn = pickTurn(turns, flags.turn);
  const text = flags.code ? codeOnly(turn.text) : flags.full ? buildMarkdown(turn, target, config) : turn.text;
  if (text.trim() === "") {
    throw new EngineError(flags.code ? "no code blocks in that answer" : "that answer has no text");
  }
  await toClipboard(text);
  return { ok: true, message: `copied ${flags.code ? "code" : "answer"} \xB7 turn ${turn.index}` };
}
async function clip2(flags) {
  if (flags.text === void 0 || flags.text === "") throw new EngineError("nothing to copy");
  await toClipboard(flags.text);
  return { ok: true, message: "copied" };
}
async function save(flags, config) {
  const { target, turns } = await load(flags);
  const turn = pickTurn(turns, flags.turn);
  const path = await saveMarkdown(turn, target, config);
  return { ok: true, path, message: `saved turn ${turn.index}` };
}
async function journal(flags, config) {
  const { target, turns } = await load(flags);
  const result = journalTurns(turns, target, config);
  const message2 = `${result.written.length} written \xB7 ${result.skipped} already there` + (result.failed > 0 ? ` \xB7 ${result.failed} failed` : "");
  return { ok: true, message: message2, exportDir: config.exportDir };
}
async function open(flags, config) {
  if (!flags.target) throw new EngineError("nothing to open");
  const argv = openArgs(flags.target, { link: flags.link, command: config.openCommand });
  if (!argv) throw new EngineError("no system opener on this platform");
  await launch(argv);
  return { ok: true, message: `opened ${flags.target}` };
}
async function doctor(flags, config) {
  const lines = [
    ["export dir", config.exportDir],
    ["claude projects", claudeProjectsDir()]
  ];
  for (const problem of config.keyProblems) lines.push(["keys", `IGNORED: ${problem}`]);
  try {
    const target = await resolveTerminal(requireTerminal(flags));
    lines.push(["terminal", target.paneId], ["agent", target.agent]);
    lines.push(["session", target.sessionId ?? "(none)"], ["cwd", target.cwd ?? "(unknown)"]);
    lines.push(["transcript", target.transcriptPath ?? "(not found)"]);
    if (target.transcriptPath) {
      const turns = readTurns(target.transcriptPath);
      lines.push(["turns", `${turns.length} (${answers(turns).length} with an answer)`]);
    }
  } catch (err) {
    lines.push(["resolve", `FAILED: ${message(err)}`]);
  }
  return { ok: true, lines };
}
async function load(flags) {
  const target = await resolveTerminal(requireTerminal(flags));
  if (target.agent !== "claude") {
    throw new EngineError(`agent "${target.agent}" is not supported yet \u2014 Fleece reads Claude Code`);
  }
  if (!target.transcriptPath) {
    throw new EngineError(`no Claude transcript for ${target.paneId} under ${claudeProjectsDir()}`);
  }
  return { target, turns: readTurns(target.transcriptPath) };
}
function requireTerminal(flags) {
  if (!flags.terminal) throw new EngineError("--terminal is required");
  return flags.terminal;
}
function pickTurn(turns, requested) {
  if (requested !== void 0) {
    const turn = turns[requested - 1];
    if (!turn) throw new EngineError(`turn ${requested} does not exist (${turns.length} turns)`);
    return turn;
  }
  const latest = answers(turns).at(-1);
  if (!latest) throw new EngineError("this session has no answer yet");
  return latest;
}
function view(turn) {
  return {
    index: turn.index,
    prompt: turn.prompt,
    text: turn.text,
    model: turn.model ?? null,
    endedAt: turn.endedAt ?? null,
    files: turn.files.length
  };
}
async function toClipboard(text) {
  const result = await copyToClipboard(text);
  if (!result.tool) throw new EngineError("no clipboard tool \u2014 install pbcopy, wl-copy or xclip");
}
function parseFlags(args) {
  const flags = { code: false, full: false, link: false, journal: false };
  const number = (value, name) => {
    const parsed = Number.parseInt(value ?? "", 10);
    if (!Number.isFinite(parsed) || parsed < 1) throw new EngineError(`${name} needs a positive number`);
    return parsed;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--terminal":
        flags.terminal = args[++i];
        break;
      case "--turn":
        flags.turn = number(args[++i], "--turn");
        break;
      case "--pin":
        flags.pin = number(args[++i], "--pin");
        break;
      case "--text":
        flags.text = args[++i];
        break;
      case "--target":
        flags.target = args[++i];
        break;
      case "--code":
        flags.code = true;
        break;
      case "--full":
        flags.full = true;
        break;
      case "--link":
        flags.link = true;
        break;
      case "--journal":
        flags.journal = true;
        break;
      default:
        throw new EngineError(`unknown flag "${arg}"`);
    }
  }
  return flags;
}
function message(err) {
  return err instanceof Error ? err.message : String(err);
}
main().then((reply) => process.stdout.write(`${JSON.stringify(reply)}
`)).catch((err) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message(err) })}
`);
  process.exitCode = 1;
});
