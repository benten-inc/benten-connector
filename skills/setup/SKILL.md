---
name: setup
description: Benten Connector の初期設定。アクセストークンの設定・同期するプロジェクトの選択・接続テスト・過去セッションのバックフィルを行う。Use when the user wants to set up, reconfigure, or troubleshoot Benten session sync.
---

# Benten Connector セットアップ

Claude Code のセッション（AIとの作業会話）を Benten に自動同期するための初期設定を、以下の手順で進める。ユーザーは非エンジニアの可能性もあるので、専門用語を避けて案内すること。

## 前提の説明（最初に一度だけ伝える）

- 同期されるのは**あなたと Claude の会話テキストだけ**。コマンドの実行結果やファイルの中身（ツール出力）は送られない。
- **選択したプロジェクト（フォルダ）のセッションだけ**が同期される（選択制）。
- 同期は SessionEnd（セッション終了時）と Claude Code 起動時の取りこぼし回収で自動的に行われる。

## 手順

### 1. 現状確認

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync.mjs" --status
```

`token_set: true` かつ `projects` に対象が入っていれば設定済み。ユーザーが再設定を求めている場合のみ先へ。

### 2. アクセストークンの設定

1. ユーザーに https://shelf.benten.io/settings/access-tokens を開いてもらい、トークンを発行して**チャットに貼り付けて**もらう（`benten_` で始まる文字列）。
2. 貼られたトークンを `~/.benten/config.json` に保存する。**シェルコマンドの引数にトークンを含めない**（履歴に残るため）。Read で既存の `~/.benten/config.json` を読み（無ければ新規）、`token` フィールドをマージして Write で書き戻すこと。他のフィールド（`projects` 等）は保持する。

```json
{
  "token": "benten_xxxxx",
  "projects": []
}
```

（開発時のみ: `url` フィールドで接続先を上書きできる。既定は `https://mcp.benten.io/mcp`）

### 3. 同期するプロジェクトの選択（選択制）

1. `ls ~/.claude/projects/` の結果からユーザーが Claude Code を使っているプロジェクト一覧を把握する（ディレクトリ名は実パスのスラッシュを `-` に置換したもの）。
2. ユーザーに「どのプロジェクトの会話を Benten に入れるか」を聞く。現在のプロジェクト（このセッションの作業ディレクトリ）を第一候補として提示する。
3. 選ばれた各プロジェクトの**絶対パス**を登録する:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync.mjs" --add-project /absolute/path/to/project
```

### 4. 接続テスト

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync.mjs" --verify
```

`{"ok": true, "ingest_tool_available": true, ...}` になることを確認。失敗したらエラー内容をユーザーに平易に説明する（トークンの貼り間違いが最多）。

### 5. 過去セッションのバックフィル（任意）

ユーザーに「過去の会話もまとめて取り込むか」を聞く。yes なら:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync.mjs" --catch-up
```

選択したプロジェクトの過去セッションが全件送られる（件数によっては数分かかる）。終わったら `--status` の `synced_sessions` を見せて完了を報告する。

### 6. 締め

「今後は自動で同期されます。shelf.benten.io の一覧で確認できます」と伝える。トラブル時は `~/.benten/sync.log` を見ること。
