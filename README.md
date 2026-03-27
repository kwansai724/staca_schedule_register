# storica-schedule-register

ストアカ講座の日程登録を自動化するシステム。
GAS（Google Apps Script）からのバッチ送信を受け、GitHub Actions上でPlaywrightがストアカに日程を登録する。

## アーキテクチャ

```
Googleフォーム（講師が日程申請）
  ↓
GAS onFormSubmit（重複チェック → workシートに書き込み）
  ↓
GAS 定期バッチ（1時間に1回）
  ↓ repository_dispatch
GitHub Actions（本リポジトリ）
  → Playwrightでストアカに日程登録
  → 結果をGAS webhookにPOST
  ↓
GAS doPost（workシート更新 → 管理者に結果メール）
```

## 技術スタック

- TypeScript + [tsx](https://github.com/privatenumber/tsx)
- [Playwright](https://playwright.dev/)（Chromium headless）
- GitHub Actions（`repository_dispatch` / `workflow_dispatch`）

## セットアップ

GitHub SecretsとGAS Script Propertiesの設定が必要です。詳細は`.env.example`およびワークフロー定義を参照してください。

### ローカル開発（任意）

```bash
npm install
npx playwright install chromium
cp .env.example .env
# .env を編集
npm start
```

## 実行方法

- **自動実行**: GASの定期バッチが`repository_dispatch`でトリガー
- **手動実行**: スプレッドシートのメニュー「🚀日程登録バッチを手動実行」
- **Actions手動実行**: GitHubのActionsタブから`workflow_dispatch`

## ファイル構成

```
src/
├── index.ts      … メインオーケストレーション
├── auth.ts       … セッションCookie認証
├── config.ts     … payload解析・型定義
├── register.ts   … Playwright日程登録ロジック
├── notify.ts     … GAS webhook結果送信
└── utils.ts      … ログ・遅延・スクリーンショット
```
