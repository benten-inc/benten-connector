#!/usr/bin/env node
/**
 * benten-connector codex-sync — OpenAI Codex のセッションを Benten に送る。
 *
 * Claude Code 版（sync.mjs）と同じ受け口（benten-mcp の ingest_transcript, source=codex）に
 * 同じ turn 構造で送る。違いは3つ:
 *   - Codex にはセッション終了フックが無い（Stop は1ターンごとに鳴る）ので、launchd で
 *     定期的に ~/.codex を見回り、しばらく書き込みが止まったセッションを送る。
 *   - 送るのは全セッション（フォルダの選択制は無い）。Codex desktop はタスクごとに
 *     作業フォルダを自動で切るので、フォルダ指定だとほぼ何も拾えないため。
 *   - AI 側は「最終回答」だけ送る。途中経過の実況（phase=commentary）は落とす。
 *
 * 呼ばれ方:
 *   --catch-up        ~/.codex/sessions と archived_sessions を走査し、未送信/変化分を送る
 *   --dry-run         送らずに、拾えるセッションの要約を stdout に出す（--limit N 可）
 *   --install         トークン確認 → 接続テスト → launchd（30分おき）に登録
 *   --uninstall       launchd から外す
 *   --status          設定と同期状態の要約を stdout に出す
 *   --since ISO       これより前に最後に書かれたセッションは送らない（--install で config に保存）
 *
 * 原則（sync.mjs と同じ）:
 *   - どんな失敗でも exit 0。ログは ~/.benten/codex-sync.log。
 *   - 送るのはあなたの発言と Codex の最終回答だけ。コマンド実行・ツール結果・思考・
 *     サブエージェントの会話は送らない。
 *   - 設定（token / url）は Claude Code 版と共有の ~/.benten/config.json。
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  readdirSync,
  statSync,
  existsSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL, fileURLToPath } from "node:url";

const BENTEN_DIR = join(homedir(), ".benten");
const CONFIG_PATH = join(BENTEN_DIR, "config.json");
const STATE_PATH = join(BENTEN_DIR, "codex-sync-state.json");
const LOG_PATH = join(BENTEN_DIR, "codex-sync.log");
const LOCK_DIR = join(BENTEN_DIR, "codex-sync.lock");
const CODEX_DIR = join(homedir(), ".codex");
const SCAN_DIRS = [join(CODEX_DIR, "sessions"), join(CODEX_DIR, "archived_sessions")];
const LAUNCHD_LABEL = "io.benten.codex-sync";
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const DEFAULT_URL = "https://benten-mcp-ud7nswm4wq-an.a.run.app/mcp";

const MAX_TURNS = 2000;
const MAX_TURN_CHARS = 50_000;
const MAX_PAYLOAD_BYTES = 3_800_000; // サーバ(express)の 4mb 制限の手前
// 最後の書き込みからこれだけ経ったら「止まった」とみなして送る。短いと作業中に何度も
// 送り直し（サーバ側で消して作り直し）になるので、ターンの合間より長めに取る。
const IDLE_MS = 15 * 60 * 1000;
const LOCK_STALE_MS = 30 * 60 * 1000;
const INTERVAL_SEC = 30 * 60;
const VERSION = "0.2.0";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argAfter = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);

function log(msg) {
  try {
    mkdirSync(BENTEN_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ログすら書けない場合も黙って続行 */
  }
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

function loadConfig() {
  return readJson(CONFIG_PATH, null);
}

function saveConfig(config) {
  mkdirSync(BENTEN_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

/** 送信済み state。接続先（url）が変わったらリセットする（sync.mjs と同じ理由）。 */
function loadState(config) {
  const url = config?.url ?? DEFAULT_URL;
  const state = readJson(STATE_PATH, { sessions: {}, files: {} });
  if (state.url !== url) return { url, sessions: {}, files: {} };
  return state;
}

function saveState(state) {
  mkdirSync(BENTEN_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// rollout JSONL → turns
// ---------------------------------------------------------------------------

/**
 * Codex が本人の発言の前に差し込む文脈を外す。差し込みは2種類あり、どちらも
 * 「## My request for Codex:」（版により「## My request:」）の見出しの後ろが本人の依頼:
 *   - ファイル添付時の「# Files mentioned by the user」
 *   - アプリ内ブラウザの状態「<in-app-browser-context …>」
 */
function stripInjectedPrefix(text) {
  const head = text.trimStart();
  if (!head.startsWith("# Files mentioned by the user") && !head.startsWith("<in-app-browser-context")) return text;
  const marks = [...text.matchAll(/^## My request(?: for Codex)?:[ \t]*$/gm)];
  const last = marks[marks.length - 1];
  if (last) return text.slice(last.index + last[0].length);
  // 見出しが無ければ、ブラウザ文脈のブロックだけ外す
  const close = text.indexOf("</in-app-browser-context>");
  return close >= 0 ? text.slice(close + "</in-app-browser-context>".length) : text;
}

function textOf(item) {
  return (item.content ?? [])
    // UserMessage は "text"、AgentMessage は "Text"。画像（image / local_image）は落とす。
    .filter((c) => c && String(c.type).toLowerCase() === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

/**
 * rollout-*.jsonl → { meta, turns }。
 *
 * 拾うのは event_msg/item_completed の UserMessage と AgentMessage だけ。response_item の
 * user 発話には Codex が差し込む文脈（<recommended_plugins>、AGENTS.md 等）が混ざるので使わない。
 * AI 側はターン（turn_id）ごとに最終回答だけ:
 *   - phase=final_answer があればそれ
 *   - phase の無い旧形式は、そのターン最後の AgentMessage
 */
export function extractCodexSession(path) {
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  let meta = null;
  const entries = []; // { ord, role, text, ts, turnId, phase }
  let ord = 0;
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 形式はバージョンで変わりうる。読めない行は黙って飛ばす
    }
    const p = obj.payload ?? {};
    if (obj.type === "session_meta" && !meta) {
      meta = p;
      continue;
    }
    if (obj.type !== "event_msg" || p.type !== "item_completed" || !p.item) continue;
    const item = p.item;
    if (item.type === "UserMessage") {
      const text = stripInjectedPrefix(textOf(item)).trim();
      if (text.trim()) entries.push({ ord: ord++, role: "user", text, ts: obj.timestamp, turnId: p.turn_id });
    } else if (item.type === "AgentMessage") {
      const text = textOf(item);
      if (text.trim())
        entries.push({ ord: ord++, role: "assistant", text, ts: obj.timestamp, turnId: p.turn_id, phase: item.phase });
    }
  }

  // ターンごとに残す AgentMessage を決める
  const keep = new Set();
  const byTurn = new Map();
  for (const e of entries) {
    if (e.role !== "assistant") continue;
    const k = e.turnId ?? `__no_turn_${e.ord}`;
    if (!byTurn.has(k)) byTurn.set(k, []);
    byTurn.get(k).push(e);
  }
  for (const list of byTurn.values()) {
    const finals = list.filter((e) => e.phase === "final_answer");
    if (finals.length > 0) finals.forEach((e) => keep.add(e.ord));
    else if (list.every((e) => !e.phase)) keep.add(list[list.length - 1].ord);
    // commentary しか無いターン（中断など）は何も残さない
  }

  const turns = entries
    .filter((e) => e.role === "user" || keep.has(e.ord))
    .map((e) => ({ role: e.role, text: e.text, ...(e.ts ? { ts: e.ts } : {}) }));
  return { meta, turns };
}

/** サブエージェントのスレッドか（親セッション側に最終回答が出るので送らない）。 */
function isSubagent(meta) {
  return Boolean(meta?.source && typeof meta.source === "object" && meta.source.subagent) || meta?.thread_source === "subagent";
}

/** project 名: git リポジトリ名 > cwd の basename（Codex が自動で切る作業フォルダは名前にしない）。 */
function projectName(meta) {
  const repo = meta?.git?.repository_url;
  if (typeof repo === "string" && repo) return basename(repo).replace(/\.git$/, "");
  const cwd = meta?.cwd;
  if (!cwd || cwd.includes("/Documents/Codex/")) return undefined;
  return basename(cwd);
}

function capTurns(turns, sessionId) {
  let capped = turns;
  if (capped.length > MAX_TURNS) {
    log(`warn session=${sessionId} turns ${capped.length} > ${MAX_TURNS}, keeping first ${MAX_TURNS}`);
    capped = capped.slice(0, MAX_TURNS);
  }
  return capped.map((t) =>
    t.text.length > MAX_TURN_CHARS ? { ...t, text: t.text.slice(0, MAX_TURN_CHARS) + "\n…（長文のため省略）" } : t,
  );
}

function turnsHash(turns) {
  return createHash("sha1").update(JSON.stringify(turns)).digest("hex").slice(0, 24);
}

/** 送る形（ingest_transcript の arguments）を作る。対象外なら null。 */
function buildPayload(path) {
  const { meta, turns } = extractCodexSession(path);
  if (!meta || isSubagent(meta)) return null;
  const sessionId = meta.session_id ?? meta.id;
  if (!sessionId) return null;
  if (!turns.some((t) => t.role === "user")) return null;
  const capped = capTurns(turns, sessionId);
  return {
    source: "codex",
    session_id: sessionId,
    project: projectName(meta),
    cwd: meta.cwd,
    git_branch: meta.git?.branch,
    client_version: `benten-connector-codex/${VERSION}`,
    turns: capped,
  };
}

// ---------------------------------------------------------------------------
// 送信
// ---------------------------------------------------------------------------

/** benten-mcp へ JSON-RPC 1発（stateless streamable HTTP）。sync.mjs と同じ。 */
async function mcpCall(config, method, params) {
  const url = config.url ?? DEFAULT_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    let payload = text;
    if (text.startsWith("event:") || text.includes("\ndata:") || text.startsWith("data:")) {
      const datas = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      payload = datas[datas.length - 1] ?? "";
    }
    const rpc = JSON.parse(payload);
    if (rpc.error) throw new Error(`RPC ${rpc.error.code}: ${rpc.error.message}`);
    return rpc.result;
  } finally {
    clearTimeout(timer);
  }
}

async function syncOne(config, state, path) {
  const payload = buildPayload(path);
  if (!payload) return null;
  const hash = turnsHash(payload.turns);
  if (state.sessions[payload.session_id]?.hash === hash) return "unchanged";
  if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) {
    log(`warn session=${payload.session_id} payload too large even after caps, skipped`);
    return null;
  }
  const result = await mcpCall(config, "tools/call", { name: "ingest_transcript", arguments: payload });
  const body = result?.content?.find((c) => c.type === "text")?.text ?? "{}";
  if (result?.isError) throw new Error(`tool error: ${body.slice(0, 300)}`);
  let outcome = "unknown";
  try {
    outcome = JSON.parse(body).outcome ?? "unknown";
  } catch {
    /* 応答が想定外でも送れてはいる */
  }
  state.sessions[payload.session_id] = { hash, at: new Date().toISOString() };
  saveState(state);
  log(`sync session=${payload.session_id} turns=${payload.turns.length} outcome=${outcome}`);
  return outcome;
}

/** ~/.codex/{sessions,archived_sessions} 配下の rollout-*.jsonl を再帰で列挙。 */
function listRollouts() {
  const out = [];
  const walk = (dir) => {
    let names = [];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name.startsWith("rollout-") && d.name.endsWith(".jsonl")) out.push(p);
    }
  };
  SCAN_DIRS.forEach(walk);
  return out.sort();
}

function acquireLock() {
  try {
    mkdirSync(BENTEN_DIR, { recursive: true });
    mkdirSync(LOCK_DIR);
    return true;
  } catch {
    try {
      if (Date.now() - statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS) {
        rmSync(LOCK_DIR, { recursive: true, force: true });
        mkdirSync(LOCK_DIR);
        return true;
      }
    } catch {
      /* 競合で消えた等 → 譲る */
    }
    return false;
  }
}

function releaseLock() {
  try {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function sinceMs(config) {
  const s = argAfter("--since") ?? config?.codex_since;
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : 0;
}

async function runCatchUp(limit) {
  const config = loadConfig();
  if (!config?.token) return;
  if (!acquireLock()) {
    log("catch-up skipped: another codex-sync is running");
    return;
  }
  try {
    const state = loadState(config);
    const since = sinceMs(config);
    let sent = 0;
    let failed = 0;
    for (const path of listRollouts()) {
      if (limit && sent >= limit) break;
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.mtimeMs < since) continue;
      if (Date.now() - st.mtimeMs < IDLE_MS) continue; // 進行中のセッションは触らない
      const prev = state.files[path];
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
      try {
        const outcome = await syncOne(config, state, path);
        if (outcome && outcome !== "unchanged") sent++;
        state.files[path] = { size: st.size, mtimeMs: st.mtimeMs };
        saveState(state);
      } catch (e) {
        failed++;
        log(`error ${basename(path)}: ${String(e).slice(0, 300)}`);
        // 失敗したファイルは state.files を進めない（次回リトライ）
      }
    }
    log(`catch-up done sent=${sent} failed=${failed}`);
  } finally {
    releaseLock();
  }
}

function runDryRun(limit) {
  const config = loadConfig();
  const since = sinceMs(config);
  const rows = [];
  let skipped = 0;
  for (const path of listRollouts()) {
    if (limit && rows.length >= limit) break;
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.mtimeMs < since) continue;
    let payload = null;
    try {
      payload = buildPayload(path);
    } catch {
      /* 壊れたファイル */
    }
    if (!payload) {
      skipped++;
      continue;
    }
    const firstUser = payload.turns.find((t) => t.role === "user")?.text.split("\n")[0] ?? "";
    rows.push({
      session_id: payload.session_id,
      project: payload.project ?? null,
      user_turns: payload.turns.filter((t) => t.role === "user").length,
      assistant_turns: payload.turns.filter((t) => t.role === "assistant").length,
      chars: payload.turns.reduce((n, t) => n + t.text.length, 0),
      first: firstUser.slice(0, 60),
    });
  }
  console.log(JSON.stringify({ sendable: rows.length, skipped, sessions: rows }, null, 2));
}

// ---------------------------------------------------------------------------
// install / status
// ---------------------------------------------------------------------------

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
  } finally {
    rl.close();
  }
}

function plistXml(nodePath, scriptPath) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(nodePath)}</string>
    <string>${esc(scriptPath)}</string>
    <string>--catch-up</string>
  </array>
  <key>StartInterval</key><integer>${INTERVAL_SEC}</integer>
  <key>RunAtLoad</key><true/>
  <key>LowPriorityIO</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${esc(LOG_PATH)}</string>
</dict>
</plist>
`;
}

function launchctl(...a) {
  try {
    execFileSync("launchctl", a, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function runInstall() {
  if (process.platform !== "darwin") {
    console.log("いまは macOS だけに対応しています。");
    return;
  }
  const config = loadConfig() ?? {};
  if (!config.token) {
    console.log("https://shelf.benten.io/settings/access-tokens でアクセストークンを発行して貼り付けてください。");
    const token = await ask("アクセストークン: ");
    if (!token.startsWith("benten_")) {
      console.log("benten_ で始まるトークンではありません。やり直してください。");
      return;
    }
    config.token = token;
  }
  // 過去分をどこから送るか。既定は「いまから」（過去分は --since で明示したときだけ）。
  config.codex_since = argAfter("--since") ?? config.codex_since ?? new Date().toISOString();
  saveConfig(config);

  try {
    const result = await mcpCall(config, "tools/list", {});
    if (!(result?.tools ?? []).some((t) => t.name === "ingest_transcript")) {
      console.log("接続はできましたが、送り先の受け口が見つかりません。");
      return;
    }
  } catch (e) {
    console.log(`接続できませんでした（トークンの貼り間違いが最も多い原因です）: ${String(e).slice(0, 200)}`);
    return;
  }

  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(PLIST_PATH, plistXml(process.execPath, fileURLToPath(import.meta.url)));
  const domain = `gui/${process.getuid()}`;
  launchctl("bootout", `${domain}/${LAUNCHD_LABEL}`);
  if (!launchctl("bootstrap", domain, PLIST_PATH)) {
    console.log(`自動実行の登録に失敗しました。${PLIST_PATH} を確認してください。`);
    return;
  }
  console.log(
    `つながりました。30 分おきに Codex のセッションが送られます（${config.codex_since} 以降に動いたもの）。ログ: ${LOG_PATH}`,
  );
}

function runUninstall() {
  launchctl("bootout", `gui/${process.getuid()}/${LAUNCHD_LABEL}`);
  try {
    rmSync(PLIST_PATH, { force: true });
  } catch {
    /* 無ければそれでよい */
  }
  console.log("Codex の自動送信を止めました。");
}

function runStatus() {
  const config = loadConfig();
  const state = loadState(config);
  console.log(
    JSON.stringify(
      {
        config_path: CONFIG_PATH,
        token_set: Boolean(config?.token),
        url: config?.url ?? DEFAULT_URL,
        since: config?.codex_since ?? null,
        launchd_installed: existsSync(PLIST_PATH),
        synced_sessions: Object.keys(state.sessions).length,
        log_path: LOG_PATH,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const limit = Number(argAfter("--limit")) || undefined;
  if (has("--catch-up")) return runCatchUp(limit);
  if (has("--dry-run")) return runDryRun(limit);
  if (has("--install")) return runInstall();
  if (has("--uninstall")) return runUninstall();
  if (has("--status")) return runStatus();
  console.log("usage: codex-sync.mjs --catch-up [--limit N] | --dry-run [--limit N] | --install [--since ISO] | --uninstall | --status");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((e) => log(`fatal: ${String(e).slice(0, 300)}`))
    .finally(() => process.exit(0));
}
