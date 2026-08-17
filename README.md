# blocksmith

Minecraft Bedrock 版の建築勢のためのブラウザ 3D エディタ。
ブロックをぽちぽち置いて設計して、**.mcpack 一発でワールドに取り込める**。Figma ライクなレイヤー/グループ管理・インスペクタを備える。

本命機能は **ミックスパレット** — 「石レンガ40% / 丸石30% / 安山岩20% / 苔むした丸石10%」みたいな配合レシピを作ると、塗るたびにランダム抽選して置いてくれる。道や壁の風合い出しで 5 種類のブロックを手持ち替えする作業が一発になる。

`src/` のレイヤー構成・依存ルール (何をどこに置くか) は [docs/architecture.md](docs/architecture.md) 参照。
`Document` / `World` / `SceneTree` の読み取り・変更 API 境界 (何がどこ経由でしか変更できないか) は [docs/document-api.md](docs/document-api.md) 参照。
書き出し先 (Minecraft Bedrock) 側の仕様 — ブロック状態の値の意味、`.mcstructure` の並び、実機での確かめ方 — は [docs/bedrock-format.md](docs/bedrock-format.md) 参照。**実機で試す前にここを見る。**

## 起動

```bash
npm install
npm run dev      # http://localhost:5199 (固定。埋まっていると起動に失敗する)
npm test         # vitest (NBT/mcstructure/抽選/選択ツール 等のユニットテスト)
npm run build    # 型チェック + 本番ビルド
```

## CI / ローカルでの再現手順

PR作成・更新時に GitHub Actions (`.github/workflows/ci.yml`) が `quality` job と `e2e` job を自動実行する。ローカルで同じチェックを再現する手順:

```bash
npm ci                    # CI と同じ依存関係を再現 (Node バージョンは .nvmrc / package.json#engines に従う)

# quality job 相当
npm run lint               # ESLint
npm run typecheck          # tsc --noEmit (TypeScript 7 ネイティブコンパイラ)
npm run test:coverage      # Vitest + カバレッジ閾値チェック (vite.config.ts の thresholds)
npm run build              # 型チェック + 本番ビルド (dist/)
npm run check:bundle-size  # dist/assets の gzip 合計サイズが budget 内か確認 (要: 直前に build 済み)

# e2e job 相当 (初回のみ Playwright の Chromium バイナリが必要)
npx playwright install --with-deps chromium
npm run build               # e2e は dist (npm run preview) に対して実行するため事前ビルドが必要
npm run test:e2e            # Playwright、専用ポート4319で preview サーバーを自動起動
```

- `test:e2e` は `playwright.config.ts` の `webServer` で `npm run preview -- --port 4319 --strictPort` を自動起動する。ローカルの他プロジェクトの Vite 既定ポート (5173等) と衝突しないよう専用ポートに固定している
- 失敗時は `playwright-report/` (HTML レポート) と `test-results/` (screenshot・trace) が残る。`npx playwright show-trace test-results/.../trace.zip` で確認できる
- `npm audit --omit=dev` は PR 必須チェックには含めず、週次の `.github/workflows/audit.yml` (`workflow_dispatch` でも手動実行可) に分離している
- 上流スナップショットの取得を伴う再生成 (`gen-blocks` = ブロックカタログ / `gen-textures` = テクスチャ manifest) は `.github/workflows/regen-from-upstream.yml` の手動実行 (`workflow_dispatch`) に分離している (自動 commit はしない、差分は手動で確認して PR を作る)。**生成スクリプト自体はネットワークを使わない** — 上流は下記スナップショットから読む
- PR の CI で回すのは committed だけで検査できるものに限る。テクスチャ manifest については「カタログと ID 集合が一致」「裁定 (`src/data/texture-ledger.json`) と一致」「射影規則そのもの」の 3 つを unit test が守る (再生成による突き合わせは上記の手動ワークフロー)
- typescript-eslint は TypeScript 7 (ネイティブコンパイラ) と互換性のない `typescript` パッケージの API を要求するため、公式の [side-by-side 構成](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0) (`package.json` の `@typescript/native` / `typescript` エイリアス) で解決している。`tsc`/`typecheck`/`build` は TS7 ネイティブのまま、typescript-eslint が読む `typescript` だけ TS6 互換 API になる

## 使い方

| 操作 | 内容 |
|------|------|
| 左クリック / ドラッグ | 選択ツールの実行 (設置はドラッグで連続置き) |
| 右ドラッグ | 視点回転 |
| 中ドラッグ / ホイール | 移動 / ズーム |
| `Space` を押しながら左ドラッグ | パン (Figma 等の業界標準に合わせた仕様。押している間だけツール操作より優先される) |
| `W A S D` / 矢印キー | カメラ平行移動 (向いてる方向基準、選択ツールで何か選択中は矢印キーをナッジ移動に譲る) |
| `Z` / `C` | カメラ上昇 / 下降 |
| `Q` / `E` | カメラ左回転 / 右回転 |
| `F` / `R` | 建築物にフォーカス / 視点リセット |
| `Shift+7` / `Shift+1` / `Shift+3` | 上面 / 正面 / 側面ビュー (右上の View からも) |
| `1` 設置 / `2` 削除 / `3` 直方体 / `4` スポイト / `V` 選択 | ツール切替 |
| `T` | 階段の向きを回転 / 原木・玄武岩・クォーツ柱等 (pillar_axis持ち) は軸を y→x→z循環 (それ以外は無効) |
| `G` | スラブの上下半分 / 階段の上下反転を切替 |
| クリック / ダブルクリック / Ctrl+クリック (選択ツール) | 最外グループを選択 / 1段掘る / 複数選択トグル |
| Shift+クリック ×2 (選択ツール) | 点A→点Bの範囲内の既存ブロックを選択 |
| クリック+ドラッグ (選択ツール) | 空き/未選択セル上は矩形マーキー選択、選択済みセル上はそのままドラッグ移動 (Shift併用で垂直移動) |
| 矢印キー / `PageUp` `PageDown` (選択ツール、選択中) | 選択を1マスナッジ移動 (`PageUp`/`PageDown` は上下) |
| `[` / `]` (選択ツール、グループ選択中) | グループを Y 軸 90 度回転 (左回り / 右回り)。回転中心はグループの pivot |
| `Shift+X` / `Shift+Y` / `Shift+Z` (選択ツール、**選択中のみ**) | 選択を各軸で反転 (ミラー)。鏡映面は選択の bbox 中心。回転と違いグループ選択でもブロック選択でも効く。`Shift+Z` はカメラの上下移動と同じキーなので、**選択がある時だけ反転が優先**され、選択なしでは従来どおりカメラが動く |
| `Ctrl+G` / `Ctrl+Shift+G` | 選択をグループ化 / グループ解除 |
| `Ctrl+D` | 選択を複製 (隣接に 1 個)。**等間隔に N 個並べたい時**はインスペクタの「配列複製」から方向・個数・間隔を指定する |
| `Ctrl+C` / `Ctrl+V` | 選択をコピー / 貼り付け |
| `Delete` / `Backspace` | 選択したブロック・グループを削除 |
| Ctrl+Z / Ctrl+Y | 元に戻す / やり直す |
| Esc | 直方体・範囲選択・ドラッグ移動・選択解除のキャンセル / ヘルプを閉じる |
| `H` または `?` | 操作ガイド (上部バーのヘルプボタンでも開く) |

- **パレット (左)**: 素材ごとに フル→ハーフ(スラブ)→階段 の順で並ぶ。アイコンは形状に合わせて見た目もマスクされる (フル=全面、ハーフ=上半分、階段=L字)。収録は石系・木材系・土砂系 — **何を入れるかは `src/data/curation.json`** (下記「収録ポリシー」)。ID は Mojang 公式 [bedrock-samples](https://github.com/Mojang/bedrock-samples) と突合済で、**推測命名はしない** (突合に失敗したら生成を中断する)。スラブ・階段は公式に存在する組み合わせだけ — 対応表は `scripts/materials-with-variants.mjs`、抜けは `variant-coverage` が検出する
- **最近使った履歴 (パレット上部)**: 選んだブロックが新しい順に2行5列で並ぶ (最大10件、セッション内のみ)
- **地面**: 右上の View でグレー/草原を切替。草原は本物の草テクスチャ (`grass_top.png`) をタイル敷きし、空もマイクラ風のグラデーション空+雲に切り替わる (未取得時はフラットカラーにフォールバック)
- **向きの決め方**: スラブ/階段を選ぶと `T`/`G` でプレビューの向きが変わる。ドラッグで連続設置する間は最初に決めた向きのまま塗れる。形状フィルは一括操作のため基本はデフォルト向き (スラブ=下半分、階段=向き0・反転なし) だが、原木等 (pillar_axis持ち) だけは例外で範囲の方向 (A地点→B地点で長い方の軸) に自動で向く
- **原木等の軸 (pillar_axis)**: 原木・玄武岩・クォーツ柱等は `T` で軸を y→x→z循環できる (単発設置・連続ドラッグに反映)。形状フィルでは上記の通り自動検出が優先される。それ以外のブロックには影響しない
- **ミックスパレット (右)**: 「＋新規」→ 左パレットでブロックを選んで「＋追加」→ 重みを編集。レシピ行をクリックすると「使用中」になり、設置・直方体フィルが配合抽選になる
- **直方体**: ドラッグで範囲指定して一括設置。ミックス使用中は 1 セルずつ抽選される

## レイヤーパネル

左サイドバーの「レイヤー」タブに、グループ構造をツリー表示する。

- **並びは上が前面** (重なりで勝つ側)。Photoshop / Illustrator / Figma と同じ向き。同じ座標に複数のグループがあるとき、リストで上にあるものが見える。未分類ブロックは最背面なのでリストの一番下に並ぶ
- グループを展開すると中の子グループ・ブロックが見える。グループ行は自分の中身より上に出る (グループ直属ブロックはその中で最背面なので、子グループより下)
- 全ブロックがテクスチャアイコン (テクスチャ未取得ブロックはべったり色のスウォッチ) 付きで表示される
- 画面上の選択とレイヤーパネルの選択は双方向に連動する (選択すると祖先グループが自動展開され、該当行までスクロールする)
- グループ名は行のダブルクリックでリネーム、行のボタンから複製・削除も可能
- 行のクリックで単一選択、`Ctrl`+クリック または `Shift`+クリックで複数選択トグル (Figma は Shift 派、Windows のリスト操作は Ctrl 派なので両対応)
- 行をドラッグして並べ替え・移動できる: 対象行の上端/下端付近にドロップすると重なり順の並べ替え (**上端 = その行より前面へ / 下端 = 背面へ**)、中央付近にドロップするとそのグループの中へ移動 (グループのみ、入れたものは中の最前面 = 一番上に来る)。ブロック行は兄弟順という概念が無いため、常に「ドロップ先のグループへ移動」の扱いになる。パネル内の空白へドロップすると未分類 (ルート) に戻る。ロック中の行は掴めない、ロック中グループの中へは移動できない、自分自身/子孫グループの中への移動 (循環) も拒否される
- 複数選択した状態でグループ化すると、選択していたオブジェクトをまとめた新しいグループができる
- 各グループ行の 👁 / 🔓 ボタンで非表示・ロックを切替できる (Figma 同様、子孫グループにも継承される)。非表示は描画・ピッキング対象外、ロックは選択・設置/削除/フィルからの編集対象外になる (プロジェクト保存にも反映される)

## インスペクタ (右パネル)

選択種別に応じて表示内容が切り替わる。

| 選択 | 表示内容 |
|------|---------|
| 単一グループ | 名前 (編集可) / 位置 (原点、数値編集可) / サイズ / ブロック数 / 回転ボタン (Y軸90度、左右) / 複製・グループ解除・削除ボタン |
| 単一 cell | ブロック情報 (スウォッチ+名前) / パレットの選択ブロックに差し替えるボタン / スラブ・階段なら向き変更ボタン (回転・上下反転) / 位置 (数値編集可) |
| 複数選択 | 結合サイズ / ブロック数 / グループ化ボタン |

## 表示モード

右上の View にある「質感あり / フラット」でいつでも切り替えられる (選択状態は localStorage に保存され次回起動時も復元される)。フラット表示中はブロックの輪郭線 (エッジ) も表示され、形状の境目が分かりやすくなる。

## 上流データ (Mojang bedrock-samples)

ブロックカタログの素は Mojang 公式 [bedrock-samples](https://github.com/Mojang/bedrock-samples) にある。これらは `(c) Mojang AB. All rights reserved.` (Minecraft EULA 準拠) なので、**テクスチャ画像と同じくリポジトリには含めず各自ローカルで取得する**。

```bash
npm run fetch-bedrock-snapshot                     # 記録された commit のまま取得 (再現、記録は書き換えない)
npm run fetch-bedrock-snapshot -- --update         # 上流 main の最新に更新する
npm run fetch-bedrock-snapshot -- --commit <sha>   # commit を据え置いて取り直し、記録も書く
```

- 取得先は `data/bedrock/` (gitignore)。**取得対象の正本は `scripts/bedrock-snapshot.mjs` の `SNAPSHOT_FILES`** — ここに書き写すと片方だけ古くなるので、役割だけ挙げる: 全ブロックと block states の値域 / ブロック ID からテクスチャ名への橋渡し / テクスチャ名から実ファイルパスへの辞書 / アニメーションテクスチャの判定 / 英語表示名
- 記録が変わる理由は 2 つあり、別の操作として区別する。**上流の版を上げる**なら `--update` (main の HEAD を解決)、**取得対象を増減した / 特定の commit へ戻す**なら `--commit <sha>` (上流の版は据え置き)
- コミットするのは `data/bedrock/SOURCE.json` だけ。**どの commit の何を前提にしているか**を commit SHA と sha256 で記録する。上流ファイル自体は再配布しない
- 記録の内容は**上流の状態だけ**から決まる。取得時刻のような実行のたびに変わる値は持たない (持つと、同じ commit を取り直しただけで追跡中のファイルが変更扱いになる)。いつ取り込んだかは `SOURCE.json` の commit 履歴が正本
- 記録を書き換えられるのは `--update` だけ。引数なしの取得は「記録どおりに復元する」操作なので、取得結果が記録と食い違ったら上書きせずに停止する
- 以前は `gen-blocks` が実行のたびに `main` を fetch していたため、いつ回したかで生成物が変わり、どの時点の Bedrock を前提にしたカタログかも残らなかった。commit で固定したことで **`gen-blocks` はオフラインで再現できる**
- 記録と実ファイルが食い違う (取得が途中で切れた / 別 commit のファイルが残っている) 場合は、生成物を書き出す前に取り直しを促して停止する

### 統合 DB (block-db)

スナップショットの 4 ソースを 1 レコードへ束ねた `data/block-db.json` を作れる (#97 段階 2)。ネットワークは要らない。

```bash
npm run build:block-db            # data/block-db.json を作る
npm run build:block-db -- --check # 書かずに、組み立てられるかと要約だけ出す
```

- **テクスチャ manifest (`src/data/textures.json`) はここからの射影**。射影は `scripts/texture-manifest.mjs` が持つ (#97 段階 3、下記「テクスチャ表示」)。DB 自体はアプリから読まない — 収録分だけを射影したものをコミットする
- **lossless** — 面ごとの指定と候補の複数性を落とさない。`{ side, top }` への縮約は射影側の仕事
- 上流の値はそのままの形で持ち、6 面への展開結果は持たない (同じ事実を 2 つの形で持つと片方が古くなる)。展開が要る側は `expandFaceRefs` を呼ぶ
- 解釈できないもの・欠けているものは黙って埋めず `diagnostics` に出す
- アニメーションのコマ数は持たない。物理コマ数には PNG の寸法が要り 4 ソースからは導出できないので、正本はアニメーションテクスチャ側 (下記)
- 日本語名・カテゴリ・代表色・収録可否も持たない。これは Mojang 由来ではなく**こちらの判断**なので `src/data/curation.json` が持つ (#97 段階 4、下記「収録ポリシー」)
- 生成物は gitignore。上流の事実をほぼそのまま束ねたものなので、上流ファイルを再配布しない判断と揃える。コミットするのは収録分だけを射影した `src/data/*.json`
- build 時に、収録カタログが DB 経由で 6 面すべて実ファイルまで到達するかを検査する (manifest への射影が成立する前提なので、崩れたら止める)

### 収録ポリシー (curation)

**何を収録するか / 日本語名 / カテゴリ / 代表色は `src/data/curation.json`** (#97 段階 4)。Mojang 由来の事実ではなく**こちらの判断**なので、上流スナップショットと分けて持つ。以前は `gen-blocks.mjs` の中に 100 行の手書きリストとして入っていて、上流を読む規則と混ざっていた。

```json
"minecraft:crimson_stem": { "nameJa": "真紅の幹", "category": "wood", "color": "#5c1f38", "included": true }
```

- **収録を増減するのはこのファイルだけ**。`included: false` にすると、**判断を消さずに**カタログから外せる (行を消すと「なぜこの色だったか」も消える)。**素材を外すとその派生 (ハーフ / 階段) も一緒に消える** — 何が落ちたかは生成時に件数と id で出る
- `included` は **`true` / `false` の boolean 必須**。欠落・null・文字列 `"true"` は「外した」と区別できないので生成を止める
- `category` は並び順そのもの (`stone` → `wood` → `soil`)。同じカテゴリ内は記載順がパレットの順になる。知らない category は末尾へ流さず生成を止める
- **派生 (ハーフ / 階段) は書かない**。素材から導出する (対応表は `scripts/materials-with-variants.mjs`)
- **上流をどう読むかは持ち込まない**。`en_US.lang` のキーが id と揃っていない場合の解決などは `gen-blocks.mjs` 側に残す。混ぜると、上流の版を上げたときに「なぜこの値が必要だったか」が追えなくなる
- 読み取り規則は `scripts/curation.mjs` (純関数)。コミット済みの curation とカタログが噛み合っているかは unit test が守る (再生成はスナップショットが要るので CI では回せない)

## テクスチャ表示

既定はフラットカラー表示だが、`public/textures/` にテクスチャ画像を置くとブロックごとに本物のテクスチャで表示される (Mojang のテクスチャは再配布禁止のため、リポジトリには含めず各自ローカルで取得する)。

```bash
npm run fetch-textures   # Mojang 公式 bedrock-samples から取得して public/textures/blocks/ に保存
```

### アニメーションテクスチャ

一部のテクスチャ (輝くプリズマリン、真紅・歪んだ幹) は、コマを縦に連結した 16xN の 1 枚絵で配布されている。そのまま貼ると縦に潰れるので、**先頭 1 コマだけを切り出して静止画として表示する** (アニメーション再生はしない)。

- どのファイルがアニメーションかは上流の `flipbook_textures.json` が決め、**何コマかは PNG の縦横比**で決まる。`flipbook` 側の `frames` は再生シーケンス (同じコマの繰り返しを含む) なのでコマ数には使えない
- コマ数は `src/data/texture-frames.json` に記録される。**手で編集しない** — PNG が揃っている環境で `npm run fetch-textures` を実行したときだけ更新される派生値
- PNG の取得元は**スナップショットと同じ commit に固定**される。`main` から取ると `flipbook_textures.json` と世代がずれ、「membership にはあるのに寸法が合わない」が起きる

**検証できる範囲は、手元にある入力で決まる。** スナップショットも PNG も gitignore なので、実行環境によって届く深さが違う。`npm run gen-texture-frames` は到達した深さを必ず出力する。

| depth | 手元にあるもの | 検証できること |
|---|---|---|
| 0 | committed のみ (CI) | manifest と記録の構造整合 |
| 1 | + スナップショット | flipbook membership、再生シーケンスの index 範囲 |
| 2 | + PNG **全件** | 実寸との一致、「縦長なのに flipbook に載っていない」逆方向検査 |

PNG は「1 枚でもあれば」ではなく**対象が全件揃っているか**で判定する。一部だけ取得済みの状態を「実寸まで検証済み」と名乗ると、残りが古いまま通る。

- **収録ブロックとテクスチャ manifest は同じ集合**であることが CI 契約 (#92)。片方だけ増減したらテストが落ちるので、「何種のうち何種」を数えて書き留める必要がない
- 実ファイル名の正本は上流の `terrain_texture.json` (#92)。命名規則からの推測では届かないものがある — 例えば `crimson_stem` の実ファイルは `huge_fungus/crimson_log_side` で、crimson だけ "log" 名になっている
- **手書きの対応表は持たない** (#97 段階 3)。`src/data/textures.json` は統合 DB (`data/block-db.json`) からの射影で、`scripts/texture-manifest.mjs` が 6 面 → `{ side, top? }` に潰す。上流の事実だけでは決まらない判断 (旧世代 data value 多重化のどれを採るか / 下面を捨てること / 現行と見た目が変わる裁定) は `src/data/texture-ledger.json` に理由付きで置き、**裁定と違う結果になったら生成が落ちる**
- 上下で絵が違うブロック (砂岩系) は下面が捨てられる。renderer は `top` を +y と -y の両方に貼るため。承認は ledger の `dropsDownFace`
- テクスチャ未取得のブロックは自動的にフラットカラーにフォールバックする (取得の有無に関わらず動作する)

## ワールドへの取り込み

1. 上部バーの「書き出し」→ ダウンロードされた `.mcpack` をダブルクリック (Minecraft が自動取り込み)
2. ワールド設定 → ビヘイビアパック → 取り込んだパックを適用
3. ゲーム内で `/structure load bs:<作品名>` (トーストに実際のコマンドが出る)。ストラクチャーブロック (ロードモード) でも `bs:<作品名>` を指定できる

作品名が日本語のみの場合、構造物 ID は `structure` になる (英数字の名前推奨)。

## プロジェクトの保存

- 1 秒ごとに localStorage へ自動保存、次回起動時に復元
- 「保存」で JSON をダウンロード / 「読込」で復元 (レシピも同梱)

## 技術メモ

- Vite + TypeScript + Three.js (InstancedMesh + ボクセル DDA ピッキング)
- `.mcstructure` = リトルエンディアン・無圧縮 NBT を自前 writer で生成 ([format 資料](https://wiki.bedrock.dev/nbt/mcstructure))
- block_indices は ZYX 順・2 レイヤー (レイヤー 2 は全 -1)、palette version は 1.21.60 系 (`18168865`)
- Mojang のテクスチャは再配布不可のため既定はフラットカラー表示 (取得済みなら自動でテクスチャに切り替わる)

## v2 候補

- crimson / warped 系のテクスチャファイル特定
- 選択範囲のミラー (反転)
- weirdo_direction (階段の向き) の実機検証 (`scripts/gen-stairs-probe.mjs` 参照、結果待ち)

## ライセンス

MIT License。全文は [LICENSE](LICENSE) を参照。

## 免責・商標

**NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.**

- 本プロジェクトは非公式のファンメイドツールであり、Mojang Studios および Microsoft とは一切関係ない
- Minecraft および関連する名称・ブランド・アセットは Mojang および Microsoft の権利物 (現行の [Minecraft Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines) に従う)
- Minecraft 由来のアセット (テクスチャ等) は本リポジトリに同梱しない。利用したい場合は各自が `npm run fetch-textures` を実行し、Mojang 公式 [bedrock-samples](https://github.com/Mojang/bedrock-samples) から自身の環境に取得する (Minecraft の利用規約・使用ガイドラインの範囲での利用は利用者の責任)。未取得時はフラットカラー表示で全機能が動作する
