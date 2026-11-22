# okura-web

家族の書類（バイトの給与明細・源泉徴収票・医療費や経費の領収書など）をぺたっと貼って、あとから原本の写真に戻れる形で記録し、
[okura-gov](https://github.com/youseiushida/okura-gov)（法令の関数 `evaluate(中間表現, 問い, 注入データ)`）で
家族全員の所得税・住民税・国保・国年・被扶養者（扶養）を根拠つきで計算する、家族のための Web アプリ。

- okura-gov は `vendor/okura-gov` のサブモジュールとして **版（コミット）を固定** して使う。アプリ側で書き換えない。
- 保存・画面・アカウント・AI・エージェント連携はアプリ（このリポジトリ）の責務（okura-gov SCOPE §3・§4、HANDOFF D8・D17）。
- 計算の結果は判定コアの値をそのまま出す（丸めない・推奨しない）。e-Tax への送信や作成コーナーへの自動入力はしない。

## 1. 構成

```
ブラウザ（Vite + React + React Router。ビルドした frontend/dist を配る。外部のスクリプト・フォントを読まない）
   │ HTTP（127.0.0.1。Cookie は HttpOnly・SameSite=Strict、CSRF のトークン）
   ▼
okura_web（標準ライブラリだけの Python。.work/venvs/web）
   ├─ SQLite：アカウント・人の表示名・同意・証憑の目録・確認待ち・ジョブ・注入データ・設定
   ├─ 世帯の台帳（data/households/<ID>/ledger/）：facts.jsonl・judgments.jsonl（追記のみ）・main.beancount・evidence/
   ├─ 計算のジョブ（バックグラウンド。結果は入力のハッシュでキャッシュ）
   │
   ├─ サブプロセス（-I -X utf8）→ okura_records（.work/venvs/records：beancount、GPL）  台帳 → 中間表現（JSON）
   └─ サブプロセス（-I -X utf8）→ okura_core（.work/venvs/core：OpenFisca、AGPL）     中間表現＋問い＋注入データ → 結果（JSON）

mcp_server.py（stdio）── HTTP（トークン）──▶ /api/v1/tools   外部のエージェント
アプリ内の AI ── OpenAI 互換の API（既定は手元の Ollama など）── 同じ道具
```

- Web のサーバーは okura_core・okura_records を **import しない**。別の仮想環境・別のプロセスで、JSON だけでやり取りする（okura-gov SCOPE §6-2）。
- アプリが入力した記録は、記録層の約束（records README §4.3「取引の種類も事実台帳に書ける」）どおり **事実台帳**（追記のみの JSON Lines）に書く。
  訂正・取消しも「訂正の行」「取消しの行」（理由つき）を追記するので履歴が消えない。手で beancount を付けたい人は `main.beancount` に書けばそのまま読まれる。
- 書き込みは、台帳の写しで `append` → `build-ir`（中間表現の検査）を通してから本物に置き換える。台帳を壊す入力は本物に届かない。
- beancount の台帳は記録層の `safe_loader.load_ledger` を通る `build-ir`・`transactions` コマンドでだけ読む（D11）。

## 2. 始め方（Windows）

```
git submodule update --init                 # okura-gov（固定した版）
uv run --no-project --python 3.11 python -I -X utf8 tools/setup_env.py   # 仮想環境（wheel だけ・okura_dev.pth）
npm ci --ignore-scripts                     # 画面の道具（版は固定。インストール時のスクリプトは動かさない）
npm run build                               # 画面をビルドする（frontend/dist）
start.cmd                                   # または .work\venvs\web\Scripts\python.exe -I -X utf8 serve.py
```

http://127.0.0.1:8765/ を開くと、最初の設定（世帯・あなたのアカウント）になる。データは `data/`（git に入れない）に置く。

- 使い方の流れ：**書類**（撮影・アップロード）→ 書類の種類を選んで値を入れる（AI で読み取ってもよい）→ **登録** → 自動で再計算（数十秒）→
  **質問**（未確定の分かれ目に答える）→ **計算結果** → **申告書**（作成コーナーに人が入力）。
- 家族の端末から LAN で使うとき：`serve.py --host 0.0.0.0 --allow-host 192.168.x.x:8765`。HTTP は暗号化されないので家の LAN の中だけで。
  外（クラウド）に置くなら暗号化が要る。**置き場所を決める前に相談する**（今はローカルだけ）。

## 3. 家族の機微な情報（いちばん大事）

| 決まり | 実装 |
|---|---|
| データは既定で手元 | `data/`（SQLite・台帳・写真・結果）。外へ出る通信は、設定した LLM の API と MCP のトークンを使うエージェントだけ |
| マイナンバーは保存しない | 入れる欄がない。中間表現にもない。名前はアプリの DB の表示名だけで、台帳・中間表現に書かない |
| 外部の LLM に送るかはあなたが決める | 既定は手元の OpenAI 互換のモデル（`http://127.0.0.1:11434/v1`）。外部の URL にすると、設定のとき・会話を始めるとき・写真を送るときに範囲を見せて同意を求める |
| 送る範囲を出して、本人の同意を取り、伏せる | 本人の `external_ai` の同意がない人の記録・値は送らない。名前・会社や病院の名前・住所（団体コード）・自由記述・ASCII でない文字は「［伏せ字］」、生年月日は年だけ、人は仮名（人物1…）。原本は送らない（読み取りを頼んだ写真だけ、同意のあとで） |
| MCP も同じ | 外部のトークンは同じ伏せ字・同意の規則を通る（`/api/v1/tools`） |
| ログ・エラーに家族のデータを出さない | アクセスのログは方法とパスだけ。サブプロセスの標準エラー出力はそのまま出さない。操作の記録（audit）は「何を・誰が・いつ」だけ |
| テストは架空の家庭だけ | `tests/` は架空の家庭（架空太郎など）だけ |

**見える範囲（⑭）**：扶養の判定には家族全員の記録を使う（計算はこの PC の中）。家族のほかの人に見えるかは、本人が決める同意で分ける。

| 同意 | 見えるもの |
|---|---|
| `share_numbers` | 計算に使う数字（所得・税額・判定の結果） |
| `share_details` | 明細（記録の中身）。記録に出てくる人の全員の同意が要る（自分が関わる・自分が入れた記録は見える） |
| `share_originals` | 原本（写真・PDF） |
| `external_ai` | 外部の AI に（伏せ字で）渡してよい |

アカウントのない人（小さい子・祖父母など）は、その人を足した人が管理する人として代わりに決める。だれがいつ決めたかを追記のみで残す。

## 4. 人が決めることを AI に決めさせない（⑬）

- 生計を一にする・事業と称するに至る程度・どちらの扶養に入れるか・還付申告をするか などの判断・選択は、判断台帳に **決めた人（judged_by／chosen_by）と日時** つきで追記する。見直すときは新しい判断（`replaces`）を足す（消さない。D12）。
- アプリ内の AI も MCP の外部のエージェントも、道具は「読む・計算する・説明する」と「提案する」だけ。提案は **要確認** に入り、画面で人が「確定」を押したときだけ台帳に書かれる。
  エージェントのトークンでは、確定・記録の API を呼べない（サーバーが 403 で止める）。
- OCR・AI が読んだ値は「AI・未確認」の印が付き、人が画像と見比べて「確かめた」に印を付けるか直すまで確定できない（⑫）。
- 見込み（`見込み.年間収入` など）には「予測」の印が付き、予測からは申告用の値が出ない（okura-gov D19）。

## 5. 結果の出し方（⑩）

- **未確定**：何で分かれているか（判断・事実・注入・一次情報・公表待ち）と候補ごとの値を出し、「決めること」の質問のカードにする（答える前に、候補ごとに何が変わるかを見せる）。
- **対象外**：理由の文をそのまま。年分の外は「まだ計算できない」。
- **根拠**：値ごとに、法令・出典（okura-gov の docs の節）・適用開始日・使った記録の ID（→ 記録 → 原本の写真へ戻れる）。
- **境目**：あといくらで結論が変わるか（扶養の所得要件・被扶養者の年収の基準など）。被扶養者の年収の境目は、時給を入れておけば時間にも直す（画面の計算。法令の計算ではない）。
- **版**：結果ごとに okura-gov のコミット・okura_core・openfisca-core・パラメータの SHA-256 を表示する。
- **様式の欄**：確定申告書の欄ごとの値を、人が作成コーナーに写す前提で並べる（コピー・「写した」の印）。令和8年分は様式が未公表なので、okura-gov が「未公表」で止める。

対象の範囲（okura-gov）：所得税 令和7年分・令和8年分、住民税・国保・国年 2026・2027年度、被扶養者の判定日 2025-01-01〜2027-12-31。

## 6. okura-gov の版の上げ方（⑦）

1. 計算の不具合を見つけたら、okura-gov 側で（okura-gov の AGENTS.md の手順で）直す。法令改正は okura-gov の監視が issue を作る → okura-gov を直す。
2. `git -C vendor/okura-gov fetch && git -C vendor/okura-gov checkout <新しいコミット>`
3. `git add vendor/okura-gov && git commit`（アプリが使う版を記録する）
4. アプリを起動し直して「計算する」。結果のキャッシュは okura-gov のコミットを含む入力のハッシュで分かれる。
   設定 → 版 に、固定した版（サブモジュールの記録）と実際の版が一致しているか、手元の書き換えがないかが出る。

## 7. 市町村・保険者ごとの値（⑮）

設定 → 市町村・保険者の値。okura-gov の注入点（`injection_points.POINTS`）を選び、団体・適用期間・値・**出典の URL と取得日**（必須）を入れる。
判定コアの検査（`parse_injected`。同じ団体・注入点の適用期間の重なりも止める）を通ったものだけを保存する。データはこの PC の DB に置き、リポジトリには置かない（HANDOFF D17・D19）。
外すときは「外した」印を付ける（消さない）。

## 8. エージェント連携（③）

- 設定 → AI連携 で、アクセストークンを発行し、接続先（Claude Web・Claude Desktop・Claude Code・ChatGPT・Codex CLI・Gemini CLI・Cursor・VS Code・Windsurf・Zed・Cline・このパソコン）ごとの手順を見る。公式アイコンつき。
- リモートの MCP：`https://okura.example.com/mcp`（Streamable HTTP、POST だけ）。認証は `Authorization: Bearer okt_…`。ヘッダーを送れないアプリ（Claude Web・Desktop・ChatGPT）は `?token=okt_…`。
  Cloudflare Access は `/mcp` だけ Bypass（アプリ `okura-web-mcp`）。ほかのページは Access のまま。
- このパソコンからは stdio の `mcp_server.py` も使える。
- HTTP：`GET /api/v1/tools`、`POST /api/v1/tools/<名前>`（`Authorization: Bearer okt_…`）、`GET /api/v1/openapi.json`。
- 道具：household_overview・list_records・get_record・vocabulary・list_proposals（読む）、run_calculation・calculation_status（計算する）、
  calculation_summary・explain_value・list_questions・list_out_of_scope・list_boundaries・form_fields（説明する）、propose_record・propose_judgment・propose_forecast・propose_person（家族の追加）・propose_change（記録の取消し・訂正）・find_municipality（市区町村コードを一覧から探す）・add_document（書類を保存する。記録は作らない。大きいファイルは POST /mcp/documents にそのまま送る）・setting_points と propose_setting（市区町村・保険者ごとの値を、出典つきで提案）（提案する）。
- 接続先の手順とアイコンの元：`tools/mcp_clients.source.json` → `tools/build_mcp_clients.py` → `frontend/src/lib/mcp_clients.js`（アイコンはパスと色だけに絞って検査する）。

## 9. アプリ内の AI（⑤）

設定 → AI で OpenAI の Chat Completions 互換の API を設定する（既定 `http://127.0.0.1:11434/v1`。Ollama・LM Studio・llama.cpp の server）。
右上の「AI に聞く」で会話。道具は上と同じで、確定はしない。写真の読み取りは画像を読めるモデル（vision）を使う（PDF・HEIC は手で入れる）。

## 10. ライセンス

このリポジトリにはライセンスを付けていない（著作権は作者が留保する。読むことはできるが、利用・改変・再配布の許諾はしていない）。

使っているもののライセンス：okura-gov の判定コアは OpenFisca-Core（AGPL-3.0）、記録層は beancount（GPL-2.0）の上にある（このアプリはサブプロセスで呼ぶ）。
画面は React・React Router（MIT）。パスキーは webauthn（BSD-3）。

## 11. テスト

```
.work/venvs/web/Scripts/python.exe -I -X utf8 -m unittest discover -s tests -t .
```

ユニットテストだけ（関数を直接呼ぶ。サブプロセス・ネットワーク・okura-gov の計算は通さない）。データは架空の家庭だけ。

## 12. 依存

- Web のサーバー・MCP のサーバー：Python 3.11 の標準ライブラリだけ（サードパーティのパッケージなし）。
- 画面：React 19・React Router 8（ブラウザに入るのはこの2つと react-dom だけ）。ビルドは Vite 8、型は TypeScript。版は `package.json` に固定し、`npm ci --ignore-scripts` で入れる。
  外部の CDN・フォント・画像を読まない（CSP `default-src 'self'`。インラインのスクリプトなし）。
- okura-gov が使う openfisca-core 46.0.1・beancount 3.2.3・beanquery 0.2.0（okura-gov の決定 D6・D11 のとおり、wheel だけで入れる）。

## 13. まだのこと・限界

- 写真の読み取りは OpenAI 互換の vision モデルが要る（OCR のエンジンは同梱しない）。読み取りの値は必ず人が確かめる。
- beancount の台帳はアプリから書かない（手で付ける人のため）。アプリの記録は事実台帳に入る。
- 外部（クラウド）に置く・暗号化して置く仕組みはない（置き場所を決めてから足す）。LAN で使うときの HTTPS もない。
- 事実台帳の末尾の行を消す改ざん（切り詰め）は記録層のハッシュの連鎖では見つけられない（records README §4.2）。
- UI の参考にしたもの：`docs/ui-references.md`。

## 14. 家の外から使う（例：Cloudflare トンネルと Cloudflare Access）

- トンネル `okura`（`~/.cloudflared/okura.yml`）→ `http://127.0.0.1:8765`。DNS は `okura.example.com` の CNAME。
- 公開するホスト名は `.work/public-host.txt`（1行。git に入れない）に書くか、`start.ps1 -PublicHost` で渡す。
- 常駐：`ops/windows/start.ps1`（サーバーとトンネルを起動し、落ちたら起こし直す）。ログオン時にタスク `okura-web` が起動する（`ops/windows/register-autostart.ps1`）。止める：`ops/windows/stop.ps1`。ログ：`logs/`（方法とパスだけ）。
- 二重の守り：サーバーは `--public-host okura.example.com` で来たリクエストの、手前の認証の JWT（RS256）を確かめる（`okura_web/proxyauth.py`）。
  アプリは Cloudflare に依存しない。設定は `.work/proxy-auth.json`（汎用：`jwks_url`・`issuer`・`audience`・`header`・`cookie`・`email_claim`。
  Authelia・Authentik・Pomerium・oauth2-proxy など）か、`.work/cf-access.json`（Cloudflare Access：チームのドメインと AUD）。
  どちらもない間は、公開の URL からのリクエストを全部 403 で断る。
- Access の設定・メールアドレスの追加：

```
powershell -ExecutionPolicy Bypass -File ops\cloudflare\setup-access.ps1 -Hostname okura.example.com -Zone example.com -Emails you@example.com,parent@example.com
```

  API トークンの権限：Account / Access: Apps and Policies / Edit、Account / Access: Organizations, Identity Providers, and Groups / Read、Zone / Zone / Read。トークンはプロンプトに貼る（保存しない）。
- 通信は Cloudflare を通る（TLS は Cloudflare で終わる）。データそのものはこの PC の `data/` にある。家族以外に使わせると AGPL のソース公開の義務がかかる。

## 15. 回答の依頼（招待リンク）

- アカウントのない家族に、その人あての質問（選んで答える判断）をリンクで聞く。質問の画面の「〇〇さんに聞く」、または 設定 → 依頼。
- リンクは1回だけ・期限付き（最長 30 日）・取り消せる。開いた端末がその人の端末になり、30 日の間は同じ端末で答えられる。
  端末でできるのは自分あての質問を見て答えることだけ（金額は見せない。ほかの API は 403）。
- 答えは判断台帳に「その人が決めた」として追記する（根拠に招待の ID。メール・名前は台帳に書かない）。
- メールを入れた依頼は、手前の認証で確かめたメールと一致する人だけが使える。確かめたメールは依頼の一覧に出る。
- この家の置き方（Cloudflare Access）では、親のメールアドレスを Access の許可リストにも足す（`ops/cloudflare/setup-access.ps1 -Emails`）。

## 16. 家計簿

- 置き場所：`data/households/<世帯ID>/book/`。`book.jsonl`（出来事の記録。追記のみ・ハッシュの鎖）が正本で、`book.beancount` はそこから作る写し（Fava などで見られる）。
- 申告の台帳（`ledger/`）とは別に置き、判定コアの計算には入れない。書くときは okura-gov の記録層の安全な読み込みで beancount を確かめてから置き換える。
- 取得はしない。取得するもの（Okura など）は取り込みの API に送る：`docs/import-api.md`。取り込んだ取引は、画面で人が確定するまで台帳に入らない。
- 見える範囲：口座ごとに「共有」か「自分だけ」（新しい口座は自分だけ）。自分だけの口座は、ほかの家族には名前・残高・合計への寄与も見えない。
- 画面：家計簿（収支・予算・推移）、入出金（登録待ち・未分類・検索、長押しでまとめて変更、登録待ちはスワイプ・まとめて登録・元に戻す）、口座（残高を調整）、
  設定 → カテゴリ（隠す・中項目の追加・繰り返し・分類ルール）。1件の分割、繰り返し（毎日・毎週・毎月・月末。家計簿を開いたときに期日の分を記録）。
- 申告に使う：医療費・寄附・社会保険料・共済・保険料のカテゴリの入出金から、申告の記録（事実台帳）の入力を開く。保存は人が行い、入出金と結びつける。

## 17. パスキー

- 設定 → ログイン で追加する（公開のアドレス https://okura.example.com で開いたときだけ。IP アドレス・http ではパスキーを使えない）。
  ログインの画面に「パスキーでログイン」が出る。この PC で直接開くときはパスワード。
- 検証は Duo Labs の `webauthn`（BSD-3）を専用の仮想環境 `.work/venvs/auth` で動かす。版とハッシュは `tools/auth-requirements.txt`（`tools/setup_env.py` が入れる）。
- challenge はサーバーが作り1回だけ・5分。RP ID と origin は `--public-host` から作る。ユーザーの確認（指紋・顔・PIN）は必須。

## 18. AI の会話（チャット）

- 写真・PDF・Excel・CSV・貼り付けた表を AI に渡し、AI が読んだ内容を「この内容で登録します」のカードで出す。登録は人が押す。
  質問は選択肢のボタン、家計簿の明細は家計簿の登録待ちに入る。設計：`docs/chat.md`。
- AI は cliproxy（`127.0.0.1:8317`、OpenAI 互換）経由の Claude にもつなげる。この PC の中継でもその先は外部のサービスなので、
  設定 → AI で「この先で外部のサービスにつながる」をオンにする（外部の AI として、同意・伏せ字・送る範囲の確認が効く）。

