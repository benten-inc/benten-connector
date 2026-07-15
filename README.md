# benten-connector

Claude Code のセッション（AIとの作業会話）を [Benten](https://shelf.benten.io) に自動同期する Claude Code プラグイン。

会議（omi / Circleback）・Slack・カレンダーと並んで、「AI と何を相談してどう決めたか」が shelf の一覧・検索・wiki に乗るようになります。

## インストール

Claude Code 内で:

```
/plugin marketplace add benten-inc/benten-connector
/plugin install benten-connector@benten
/benten-connector:setup
```

setup が対話で以下を行います:

1. [shelf.benten.io/settings/access-tokens](https://shelf.benten.io/settings/access-tokens) で発行したトークンの設定
2. **同期するプロジェクトの選択**（選んだフォルダのセッションだけが同期されます）
3. 接続テストと、過去セッションのバックフィル（任意）

## 何が送られるか（プライバシー）

- 送られるのは **あなたと Claude の会話テキストのみ**
- ツールの実行結果（コマンド出力・ファイル内容）、Claude の思考、サブエージェントの会話は**送られません**
- 同期対象は選択したプロジェクトのみ（`~/.benten/config.json` の `projects`）

## 仕組み

| 部品 | 役割 |
|------|------|
| `hooks/hooks.json` | SessionEnd でそのセッションを送信。起動時（SessionStart）に取りこぼしを回収 |
| `scripts/sync.mjs` | 依存ゼロの送信スクリプト。content hash で差分検知し、変化したセッションだけ送る |
| `skills/setup/SKILL.md` | `/benten-connector:setup` — 対話セットアップ |

設定は `~/.benten/config.json`、送信済み状態は `~/.benten/sync-state.json`、ログは `~/.benten/sync.log`。

送信先は Benten の MCP サーバ（`mcp.benten.io`）の `ingest_transcript` ツールで、認証は Benten のアクセストークン（PAT）です。

## アンインストール

```
/plugin uninstall benten-connector@benten
```

`~/.benten/` を消せば設定・状態も消えます。取り込み済みデータの削除は shelf 側から行ってください。
