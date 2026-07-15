#!/usr/bin/env node
/**
 * benten-connector sync — Claude Code セッションを Benten に送る。
 *
 * 呼ばれ方:
 *   --hook            SessionEnd フック。stdin の hook JSON から transcript_path を得て1本送る
 *   --catch-up        ~/.claude/projects を走査し、未送信/変化分を送る（取りこぼし回収・初回バックフィル）
 *   --detach          自分を detach で再起動して即 exit（SessionStart をブロックしない）
 *   --limit N         catch-up の送信上限（テスト用）
 *   --verify          接続テスト（tools/list）。結果を stdout に出す（setup skill 用）
 *   --status          設定と同期状態の要約を stdout に出す（setup skill 用）
 *   --add-project P   同期対象プロジェクト（絶対パス）を allowlist に追加
 *
 * 原則:
 *   - フック経路（--hook / --catch-up）は stdout に何も出さない（SessionStart の
 *     stdout は Claude のコンテキストに注入されるため）。ログは ~/.benten/sync.log。
 *   - どんな失敗でも exit 0（ユーザーのセッションを絶対に壊さない）。
 *   - 送るのは user/assistant の発話テキストのみ。ツールの実行結果・思考・
 *     サブエージェント会話は送らない。
 *   - 選択制: config.projects（絶対パスの allowlist）配下の cwd のセッションだけ送る。
 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const BENTEN_DIR = join(homedir(), ".benten");
const CONFIG_PATH = join(BENTEN_DIR, "config.json");
const STATE_PATH = join(BENTEN_DIR, "sync-state.json");
const LOG_PATH = join(BENTEN_DIR, "sync.log");
const PROJECTS_DIR = join(homedir(), ".claude", "projects");

const MAX_TURNS = 2000;
const MAX_TURN_CHARS = 50_000;
const MAX_PAYLOAD_BYTES = 3_800_000; // サーバ(express)の 4mb 制限の手前
const ACTIVE_GRACE_MS = 5 * 60 * 1000; // 直近5分に書かれたファイルは「進行中」とみなし送らない
const VERSION = "0.1.0";

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

/**
 * 送信済み state。接続先（url）が変わったら sessions/files をリセットする
 * （dev→本番 切替時に「送信済み」が別サーバへ持ち越されて欠落するのを防ぐ）。
 */
function loadState(config) {
  const state = readJson(STATE_PATH, { sessions: {}, files: {} });
  const url = config?.url ?? "https://mcp.benten.io/mcp";
  if (state.url !== url) {
    return { url, sessions: {}, files: {} };
  }
  return state;
}

function saveState(state) {
  mkdirSync(BENTEN_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

/** 選択制 allowlist: cwd が config.projects のどれかの配下か。 */
function projectAllowed(config, cwd) {
  if (!cwd || !Array.isArray(config?.projects)) return false;
  return config.projects.some((p) => cwd === p || cwd.startsWith(p.endsWith("/") ? p : p + "/"));
}

/** transcript JSONL → { turns, meta }。user/assistant のテキストだけ拾う。 */
function extractTurns(path) {
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  const turns = [];
  let meta = {};
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 形式はバージョンで変わりうる。読めない行は黙って飛ばす
    }
    if (obj.isSidechain) continue; // サブエージェントの会話は除外
    if (obj.type === "user" && obj.message?.role === "user") {
      if (obj.cwd) meta = { cwd: obj.cwd, git_branch: obj.gitBranch, session_id: obj.sessionId };
      const c = obj.message.content;
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c))
        text = c.filter((b) => b.type === "text").map((b) => b.text).join("\n"); // tool_result はここで落ちる
      if (text.trim()) turns.push({ role: "user", text, ts: obj.timestamp });
    } else if (obj.type === "assistant" && obj.message?.role === "assistant") {
      const text = (obj.message.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n"); // tool_use / thinking は落とす
      if (text.trim()) turns.push({ role: "assistant", text, ts: obj.timestamp });
    }
  }
  return { turns, meta };
}

function capTurns(turns, sessionId) {
  let capped = turns;
  if (capped.length > MAX_TURNS) {
    log(`warn session=${sessionId} turns ${capped.length} > ${MAX_TURNS}, keeping first ${MAX_TURNS}`);
    capped = capped.slice(0, MAX_TURNS);
  }
  capped = capped.map((t) =>
    t.text.length > MAX_TURN_CHARS
      ? { ...t, text: t.text.slice(0, MAX_TURN_CHARS) + "\n…（長文のため省略）" }
      : t,
  );
  return capped;
}

function turnsHash(turns) {
  return createHash("sha1").update(JSON.stringify(turns)).digest("hex").slice(0, 24);
}

/** benten-mcp へ JSON-RPC 1発（stateless streamable HTTP）。 */
async function mcpCall(config, method, params) {
  const url = config.url ?? "https://mcp.benten.io/mcp";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
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
    // SSE (text/event-stream) と素の JSON の両対応
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

/** 1セッション送信。戻り値は outcome 文字列 or null（対象外/スキップ）。 */
async function syncOne(config, state, transcriptPath) {
  const { turns, meta } = extractTurns(transcriptPath);
  const sessionId = meta.session_id ?? basename(transcriptPath, ".jsonl");
  if (!projectAllowed(config, meta.cwd)) return null;
  if (turns.length === 0) return null;

  const capped = capTurns(turns, sessionId);
  const hash = turnsHash(capped);
  if (state.sessions[sessionId]?.hash === hash) return "unchanged";

  const argumentsPayload = {
    source: "claude-code",
    session_id: sessionId,
    project: meta.cwd ? basename(meta.cwd) : undefined,
    cwd: meta.cwd,
    git_branch: meta.git_branch,
    client_version: `benten-connector/${VERSION}`,
    turns: capped,
  };
  if (JSON.stringify(argumentsPayload).length > MAX_PAYLOAD_BYTES) {
    log(`warn session=${sessionId} payload too large even after caps, skipped`);
    return null;
  }

  const result = await mcpCall(config, "tools/call", {
    name: "ingest_transcript",
    arguments: argumentsPayload,
  });
  const body = result?.content?.find((c) => c.type === "text")?.text ?? "{}";
  let outcome = "unknown";
  try {
    outcome = JSON.parse(body).outcome ?? "unknown";
  } catch {
    /* 応答が想定外でも state は進めない */
  }
  if (result?.isError) throw new Error(`tool error: ${body.slice(0, 300)}`);

  state.sessions[sessionId] = { hash, at: new Date().toISOString() };
  saveState(state);
  log(`sync session=${sessionId} turns=${capped.length} outcome=${outcome}`);
  return outcome;
}

async function runHook() {
  const config = loadConfig();
  if (!config?.token) return; // 未設定なら静かに何もしない
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let hook;
  try {
    hook = JSON.parse(input);
  } catch {
    log("warn --hook: stdin is not JSON");
    return;
  }
  if (!hook.transcript_path || !existsSync(hook.transcript_path)) return;
  const state = loadState(config);
  try {
    await syncOne(config, state, hook.transcript_path);
  } catch (e) {
    log(`error --hook session=${hook.session_id}: ${String(e).slice(0, 300)}`);
  }
}

async function runCatchUp(limit) {
  const config = loadConfig();
  if (!config?.token) return;
  const state = loadState(config);
  let sent = 0;
  let dirs = [];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch {
    return;
  }
  for (const dir of dirs) {
    let files = [];
    const dirPath = join(PROJECTS_DIR, dir);
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      if (limit && sent >= limit) return;
      const path = join(dirPath, f);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (Date.now() - st.mtimeMs < ACTIVE_GRACE_MS) continue; // 進行中セッションは触らない
      const prev = state.files[path];
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue; // 前回から不変
      try {
        const outcome = await syncOne(config, state, path);
        if (outcome && outcome !== "unchanged") sent++;
        state.files[path] = { size: st.size, mtimeMs: st.mtimeMs };
        saveState(state);
      } catch (e) {
        log(`error --catch-up ${f}: ${String(e).slice(0, 300)}`);
        // 失敗した file は state.files を進めない（次回リトライ）
      }
    }
  }
  log(`catch-up done sent=${sent}`);
}

async function runVerify() {
  const config = loadConfig();
  if (!config?.token) {
    console.log(JSON.stringify({ ok: false, reason: "token not set. Run /benten-connector:setup" }));
    return;
  }
  try {
    const result = await mcpCall(config, "tools/list", {});
    const hasIngest = (result?.tools ?? []).some((t) => t.name === "ingest_transcript");
    console.log(
      JSON.stringify({ ok: true, url: config.url ?? "https://mcp.benten.io/mcp", ingest_tool_available: hasIngest, projects: config.projects ?? [] }),
    );
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e).slice(0, 300) }));
  }
}

function runStatus() {
  const config = loadConfig();
  const state = loadState(config);
  console.log(
    JSON.stringify(
      {
        config_path: CONFIG_PATH,
        token_set: Boolean(config?.token),
        url: config?.url ?? "https://mcp.benten.io/mcp",
        projects: config?.projects ?? [],
        synced_sessions: Object.keys(state.sessions).length,
        log_path: LOG_PATH,
      },
      null,
      2,
    ),
  );
}

function runAddProject(path) {
  if (!path || !path.startsWith("/")) {
    console.log(JSON.stringify({ ok: false, reason: "absolute path required" }));
    return;
  }
  mkdirSync(BENTEN_DIR, { recursive: true });
  const config = loadConfig() ?? {};
  config.projects = Array.from(new Set([...(config.projects ?? []), path]));
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  console.log(JSON.stringify({ ok: true, projects: config.projects }));
}

async function main() {
  if (has("--detach")) {
    const rest = args.filter((a) => a !== "--detach");
    spawn(process.execPath, [process.argv[1], ...rest], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (has("--hook")) return runHook();
  if (has("--catch-up")) return runCatchUp(Number(argAfter("--limit")) || undefined);
  if (has("--verify")) return runVerify();
  if (has("--status")) return runStatus();
  if (has("--add-project")) return runAddProject(argAfter("--add-project"));
  console.log("usage: sync.mjs --hook | --catch-up [--limit N] [--detach] | --verify | --status | --add-project <abs-path>");
}

main()
  .catch((e) => log(`fatal: ${String(e).slice(0, 300)}`))
  .finally(() => process.exit(0));
