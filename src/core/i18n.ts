/**
 * UI language switching.
 *
 * Strings are handled in **3 categories**. Mixing them causes distinct classes of bugs
 * all at once — e.g. "switching language changed the name of a group I made earlier",
 * or "translating exception messages made them hard to search for".
 *
 * | Category | Example | Follows the language switch? |
 * |---|---|---|
 * | **UI label** (`t()`) | Save / Export / Layers | **Yes.** Resolved every time it's displayed |
 * | **Default name for generated data** (`defaultName()`) | "Group" for a new group | **No.** Fixed in the language at creation time and saved into the project file |
 * | **Developer-facing message** (throw) | "invalid CellRefKey" | **No.** Never shown on screen, so out of scope for translation |
 *
 * The second row is the crux. A default name is **data** the user can rename later, not
 * a display label. Resolving it on every display would turn a "Group" created under EN into its
 * JA translation the moment the language is switched, making the saved file's contents disagree
 * with what is on screen.
 */

export type Lang = 'en' | 'ja';

/** Dictionary of UI labels. EN is the source of truth, with JA alongside */
const UI = {
  // --- Left rail / panels ---
  'panel.layers': ['Layers', 'レイヤー'],
  'panel.blocks': ['Blocks', 'ブロック'],
  'panel.recipes': ['Patterns', 'パターン'],
  'panel.components': ['Components', 'コンポーネント'],
  'rail.sidePanels': ['Side panels', 'サイドパネル'],
  'rail.fileActions': ['File', 'ファイル操作'],
  'rail.fileActionsTitle': ['File (Save / Load / Clear)', 'ファイル操作 (保存 / 読込 / クリア)'],
  'rail.help': ['Keyboard guide', '操作ガイド'],
  'rail.helpTitle': ['Keyboard guide (H)', '操作ガイド (H)'],
  'rail.blockNameLang': ['Block name language', 'ブロック名の言語'],
  'rail.theme': ['Theme', '画面テーマ'],
  'rail.themeToDark': ['Switch to dark', 'ダークにする'],
  'rail.themeToLight': ['Switch to light', 'ライトにする'],
  'rail.github': ['GitHub repository', 'GitHubリポジトリ'],
  'rail.githubTitle': ['View the source and star on GitHub', 'GitHubでソースを見る・スターする'],

  // --- Small-screen guidance ---
  'mobile.title': ['Open on a desktop', 'PCで開いてください'],
  'mobile.description': [
    'Kigumi editing is designed for a larger screen and is not available on phones yet.',
    'Kigumiの編集は大きな画面向けです。現在、スマートフォンには対応していません。',
  ],
  'mobile.requirements': ['Keyboard + mouse or trackpad', 'キーボード ＋ マウスまたはトラックパッド'],

  // --- Document bar ---
  'doc.projectName': ['Project name', '作品名'],
  'doc.save': ['Save', '保存'],
  'doc.saveTitle': ['Download the project JSON', 'プロジェクトJSONを書き出す'],
  'doc.load': ['Load', '読込'],
  'doc.loadTitle': ['Load a project JSON', 'プロジェクトJSONを読み込む'],
  'doc.clear': ['Clear', 'クリア'],
  'doc.clearTitle': ['Delete every block', 'すべてのブロックを削除'],
  'doc.export': ['Export', '書き出し'],
  'doc.exportTitle': ['Export as a behavior pack', 'ビヘイビアパックとして書き出す'],
  'doc.unsaved': ['Unsaved changes', '未保存の変更あり'],
  'doc.autosavedAt': ['Autosaved {time}', '自動保存 {time}'],
  'doc.storageNote': ['Autosave stays in this browser. Save JSON for backup.', '自動保存はこのブラウザ内のみ。JSON保存でバックアップできます。'],

  // --- Palette ---
  'palette.stone': ['Stone', '石系'],
  'palette.wood': ['Wood', '木材系'],
  'palette.soil': ['Soil', '土・砂'],
  'palette.misc': ['Other', 'その他'],
  'palette.slab': ['Slab', 'ハーフ'],
  'palette.stairs': ['Stairs', '階段'],
  'palette.selected': ['Selected: {name}', '選択中: {name}'],

  // --- Stacked swatch ---
  'swatch.active': ['Current block', '手前のブロック'],
  'swatch.spare': ['Spare block', '控えのブロック'],
  'swatch.activeNamed': ['Current block: {name}', '手前のブロック: {name}'],
  'swatch.spareNamed': ['Spare block: {name}', '控えのブロック: {name}'],
  'swatch.swapWithKey': ['Swap current and spare (X)', '手前と控えを入れ替え (X)'],

  // --- Mix palette / recipes ---
  'recipes.title': ['Mix palette', 'ミックスパレット'],
  'recipes.new': ['+ New', '＋新規'],
  'recipes.inUse': ['In use', '使用中'],
  'recipes.delete': ['Delete pattern', 'パターンを削除'],
  'recipes.addBlock': ['+ Add {name}', '＋ {name} を追加'],
  'recipes.noBlockSelected': ['the selected block', '選択中のブロック'],
  'recipes.emptyHint': [
    'Create a pattern with "+ New", then add blocks to the mix. Each painted cell draws one by weight.',
    '「＋新規」でパターンを作って、配合ブロックを追加してね。塗るたびに重みで抽選されるよ。',
  ],
  'components.title': ['Components', 'コンポーネント'],
  'insp.makeComponent': ['Make component', 'コンポーネントにする'],
  'insp.editComponent': ['Edit component', 'コンポーネントを直す'],
  'insp.detachComponent': ['Detach from component', 'コンポーネントから外す'],
  'components.place': ['Place', '置く'],
  'components.placing': ['Click to place…', 'クリックで確定…'],
  'components.edit': ['Edit', '中身を直す'],
  'components.editing': ['Editing {name}', '{name} を直しています'],
  'components.finishEdit': ['Done', '直し終えた'],
  'components.renameHint': ['Double-click to rename', 'ダブルクリックで名前を変える'],
  'components.remove': [
    'Remove from the list (instances stay as plain groups)',
    '一覧から外す (置いてあるものは普通のグループとして残る)',
  ],
  'components.emptyHint': [
    'Select a group and turn it into a component. Editing the component updates every instance you placed.',
    'グループを選んでコンポーネントにしてね。コンポーネントを直すと、置いたインスタンスが全部ついてくるよ。',
  ],
  'recipes.addHint': [
    'Pick a block in the palette on the left, then "+ Add". Blocks are drawn in proportion to their weights.',
    '左のパレットでブロックを選んでから「＋追加」。重みの比率で抽選されるよ。',
  ],
  'recipeEditor.name': ['Pattern name', 'パターン名'],
  'recipeEditor.weightOf': ['Weight of {name}', '{name}の重み'],
  'recipeEditor.removeOf': ['Remove {name} from the pattern', '{name}をパターンから削除'],
  'recipeEditor.remove': ['Remove from pattern', 'パターンから削除'],
  'recipeEditor.addToCreate': ['Add blocks to build the pattern', 'ブロックを追加してパターンを作成'],

  // --- Layers panel ---
  'layers.count': ['{count} item(s)', '{count} 件'],
  'layers.show': ['Show', '表示する'],
  'layers.hide': ['Hide', '非表示にする'],
  'layers.unlock': ['Unlock', 'ロック解除'],
  'layers.lock': ['Lock', 'ロックする'],
  'layers.duplicateGroup': ['Duplicate group', 'グループを複製'],
  'layers.deleteGroup': ['Delete group', 'グループを削除'],
  'layers.noMatch': ['No matching layers', '一致するレイヤーがない'],
  'layers.empty': ['Nothing placed yet', 'まだ何も置かれていない'],
  'layers.filter': ['Filter layers', 'レイヤーを絞り込む'],
  'layers.expandAll': ['Expand all', 'すべて展開'],
  'layers.collapseAll': ['Collapse all', 'すべて折りたたむ'],

  // --- Inspector ---
  'insp.empty': ['Select an object to see its details', 'オブジェクトを選択すると詳細が表示されます'],
  'insp.name': ['Name', '名前'],
  'insp.position': ['Position', '位置'],
  'insp.positionOrigin': ['Position (origin)', '位置 (原点)'],
  'insp.size': ['Size', 'サイズ'],
  'insp.sizeCombined': ['Size (combined)', 'サイズ (結合)'],
  'insp.blockCount': ['{count} block(s)', '{count} ブロック'],
  'insp.blocks': ['Blocks', 'ブロック数'],
  'insp.sectionPosition': ['Position & size', '位置とサイズ'],
  'insp.sectionTransform': ['Transform', '変形'],
  'insp.sectionArray': ['Array', '配列'],
  'insp.sectionComponent': ['Component', 'コンポーネント'],
  'insp.sectionActions': ['Actions', '操作'],
  'insp.width': ['Width', '幅'],
  'insp.height': ['Height', '高さ'],
  'insp.depth': ['Depth', '奥行き'],
  'insp.block': ['Block', 'ブロック'],
  'insp.facing': ['Facing', '向き'],
  'insp.rotateFacing': ['Rotate facing', '向きを回転'],
  'insp.flipVertical': ['Flip vertically', '上下反転'],
  'insp.cycleAxis': ['Cycle axis (Y→X→Z)', '軸を切替 (Y→X→Z)'],
  'insp.axisLabel': ['{axis} axis', '{axis}軸'],
  'insp.rotateY': ['Rotate (Y axis)', '回転 (Y軸)'],
  'insp.rotateLeft': ['Rotate left 90°', '左へ90°回転'],
  'insp.rotateRight': ['Rotate right 90°', '右へ90°回転'],
  'insp.mirror': ['Mirror', '反転'],
  'insp.mirrorX': ['Mirror on X axis', 'X軸で反転'],
  'insp.mirrorY': ['Mirror on Y axis', 'Y軸で反転'],
  'insp.mirrorZ': ['Mirror on Z axis', 'Z軸で反転'],
  'insp.arrayDuplicate': ['Array duplicate', '配列複製'],
  'insp.direction': ['Direction', '方向'],
  'insp.count': ['Count', '個数'],
  'insp.gap': ['Gap', '間隔'],
  'insp.arrange': ['Arrange evenly', '等間隔に並べる'],
  'insp.dirPlusY': ['+Y (up)', '+Y (上)'],
  'insp.dirMinusY': ['−Y (down)', '−Y (下)'],
  'insp.dirMinusX': ['−X', '−X'],
  'insp.dirMinusZ': ['−Z', '−Z'],
  'insp.countMustBePositive': ['Count must be a whole number of 1 or more', '個数は 1 以上の整数で指定して'],
  'insp.gapMustBeNonNegative': ['Gap must be a whole number of 0 or more', '間隔は 0 以上の整数で指定して'],
  'insp.duplicate': ['Duplicate', '複製'],
  'insp.group': ['Group', 'グループ化'],
  'insp.ungroup': ['Ungroup', 'グループ解除'],
  'insp.delete': ['Delete', '削除'],
  'insp.replaceWithActive': ['Replace with palette block ({name})', 'パレットの選択ブロックに変更 ({name})'],
  // Repainting the selection
  'insp.repaint': ['Repaint selection', '選択範囲を塗り替え'],
  'insp.repaintScope': ['Target', '対象'],
  'insp.repaintAll': ['Everything selected', '選択したすべて'],
  'insp.repaintOnly': ['{name} only ({count})', '{name} だけ ({count})'],
  'insp.repaintWithBlock': ['Repaint with {name}', '{name} で塗る'],
  'insp.repaintWithPattern': ['Repaint with pattern ({name})', 'パターンで塗る ({name})'],

  // --- Change picker ---
  'picker.title': ['Change block', 'ブロックを変更'],
  'picker.ariaLabel': ['Block change', 'ブロック変更'],
  'picker.close': ['Close', '閉じる'],
  'picker.closePicker': ['Close picker', 'ピッカーを閉じる'],
  'picker.method': ['Change method', '変更方法'],
  'picker.tabBlocks': ['Blocks', 'ブロック'],
  'picker.tabPatterns': ['Patterns', 'パターン'],
  'picker.search': ['Search blocks', 'ブロックを検索'],
  'picker.noMatch': ['No matching blocks', '一致するブロックがありません'],
  'picker.catAll': ['All', 'すべて'],
  'picker.catStone': ['Stone', '石系'],
  'picker.catWood': ['Wood', '木材系'],
  'picker.catSoil': ['Soil', '土・砂'],
  'picker.catMisc': ['Other', 'その他'],
  'picker.viewLabel': ['Block view', 'ブロック表示'],
  'picker.viewTiles': ['Tiles', 'タイル表示'],
  'picker.viewList': ['List', 'リスト表示'],
  'picker.newPattern': ['New', '新規'],
  'picker.editPattern': ['Edit pattern', 'パターンを編集'],
  'picker.deletePattern': ['Delete pattern', 'パターンを削除'],
  'picker.deleteNamed': ['Delete {name}', '{name}を削除'],
  // Don't put line breaks in the dictionary (fragile with escape handling). Caller concatenates the two lines
  'picker.deleteConfirmQ': ['Delete "{name}"?', '「{name}」を削除しますか？'],
  'picker.deleteConfirmNote': [
    'Cells already painted with it can no longer be edited as a pattern.',
    '適用済みセルではパターンを編集できなくなります。',
  ],
  'picker.applyPattern': ['Change to this pattern', 'このパターンに変更'],
  'picker.reapplyPattern': ['Reshuffle pattern', 'パターンを再適用'],
  'picker.addBlock': ['Add block', 'ブロックを追加'],
  'picker.closeAdd': ['Done adding', '追加を閉じる'],
  'picker.emptyHint': ['Create a pattern to repaint with a mix of blocks.', 'パターンを作成すると、配合したブロックで塗り直せます。'],
  'picker.weightHint': ['Each cell draws a replacement block in proportion to the weights.', '重みの比率で、置き換えるブロックがセルごとに抽選されます。'],

  // --- Blocks-in-use list ---
  'usage.title': ['Blocks in use', '使用ブロック'],
  'usage.whole': ['Whole project', '作品全体'],
  'usage.groups': ['{count} group(s)', '{count} グループ'],
  'usage.scope': ['Scope: {label}', '集計範囲: {label}'],
  // Spans the singular/plural boundary, so "kinds / blocks" is phrased without inflection
  // (avoids outputting English like "1 kinds". Doesn't pull in full i18n plural rules)
  'usage.summary': ['{kinds} kind(s) · {total} block(s)', '{kinds} 種類 / {total} 個'],
  'usage.empty': ['Nothing placed yet', 'まだ何も置かれていない'],
  'usage.emptyGroup': ['This group is empty', 'このグループは空'],
  'usage.change': ['Change', '変更'],
  'usage.edit': ['Edit', '編集'],
  'usage.pattern': ['Pattern', 'パターン'],
  'usage.unknownPattern': ['Unknown pattern', '不明なパターン'],
  'usage.changeTargetOf': ['Choose what to change {name} into', '{name}の変更先を選ぶ'],
  'usage.changeAriaOf': ['Change {name} to another block or pattern', '{name}を別のブロックまたはパターンに変更'],
  'usage.editMixOf': ['Edit the mix of {name}', '{name}の配合を編集する'],
  'usage.editOrChangeOf': ['Edit or change {name}', '{name}を編集または変更'],
  'usage.replaced': ['replaced', '置き換えた'],
  'usage.blockChanged': ['changed the block', 'ブロックを変更した'],
  'usage.patternReshuffled': ['reshuffled the pattern layout', 'パターン配置を更新した'],
  'usage.appliedTo': ['Applied the pattern to {count} block(s)', '{count} ブロックへパターンを適用した'],
  'usage.opResult': ['{what} {count} block(s)', '{count} ブロックを{what}'],

  // --- Status bar / toast ---
  'status.line': ['Blocks: {blocks} ｜ Cursor: {hover}{sel}{guide}', 'ブロック: {blocks} ｜ カーソル: {hover}{sel}{guide}'],
  /** Guidance shown only while idle. Yields its spot to the dimensions display during a range operation */
  'status.guide': [
    ' ｜ WASD: move / right drag: orbit / H: keyboard guide',
    ' ｜ WASD: 移動 / 右ドラッグ: 回転 / H: 操作ガイド',
  ],
  'status.selPart': [' ｜ Selected: {count}', ' ｜ 選択: {count}'],
  'status.sizePart': [' ｜ Size: {size}', ' ｜ 範囲: {size}'],
  'toast.loadFailed': [
    'Load failed (your current work is untouched): {message}',
    '読込失敗 (現在の作業は無事): {message}',
  ],
  'confirm.clearAll': ['Delete all {count} block(s)?', '全 {count} ブロックを削除する？'],
  'ground.neutral': ['Gray', 'グレー'],
  'ground.grass': ['Grass', '草原'],

  // --- Toolbar / view ---
  'tool.select': ['Select', '選択'],
  'tool.place': ['Place', '設置'],
  'tool.erase': ['Erase', '削除'],
  'tool.fill': ['Cuboid', '直方体'],
  'tool.pick': ['Eyedropper', 'スポイト'],
  'tool.withKey': ['{label} ({key})', '{label} ({key})'],
  'view.top': ['Top', '上面'],
  'view.front': ['Front', '正面'],
  'view.side': ['Side', '側面'],
  'view.orientation': ['Orientation', '視点'],
  'toolbar.voidEdges': ['Void', '空白'],
  'toolbar.voidEdgesTitle': [
    'Show or hide the outlines that mark void blocks',
    '空白ブロックの位置を示す輪郭線を出すか',
  ],
  'view.appearance': ['Appearance', '表示'],
  'view.ariaLabel': ['{label} view', '{label}ビュー'],
  'view.title': ['{label} view ({key})', '{label}面ビュー ({key})'],
  'history.undo': ['Undo', '元に戻す'],
  'history.undoTitle': ['Undo (Ctrl+Z)', '元に戻す (Ctrl+Z)'],
  'history.redo': ['Redo', 'やり直す'],
  'history.redoTitle': ['Redo (Ctrl+Y)', 'やり直す (Ctrl+Y)'],

  // --- Select tool toasts ---
  'sel.tooLargeToMove': [
    'Selection is too large to move ({count} > {max} blocks)',
    '選択が大きすぎて移動できない ({count} > {max} ブロック)',
  ],
  'sel.rangeTooLarge': ['Range is too large ({count} > {max} blocks)', '範囲が大きすぎる ({count} > {max} ブロック)'],
  'sel.nothingInRange': ['Nothing in range', '対象がなかった'],
  'sel.selectGroupToUngroup': ['Select a group to ungroup', 'グループを選択してから解除して'],
  'sel.selectGroupToRotate': ['Select a group to rotate', 'グループを選択してから回転して'],
  'sel.nothingToCopy': ['Nothing selected to copy', 'コピーする選択がない'],
  'sel.clipboardEmpty': ['Clipboard is empty', 'クリップボードが空'],
  'project.saved': ['Project saved', 'プロジェクトを保存した'],
  'project.backupReminder': [
    'Your build is taking shape. Save a JSON backup so it does not live only in this browser.',
    '作品が育ってきました。ブラウザだけに残さず、JSON保存でバックアップしましょう。',
  ],

  // --- Toolbar / ground & display ---
  'toolbar.ground': ['Ground', '地面'],
  'toolbar.groundTitle': ['Ground: {label}', '地面表示: {label}'],
  'toolbar.textured': ['Textured', '質感あり'],
  'toolbar.flat': ['Flat', 'フラット'],
  'toolbar.displayTextured': ['Display: textured', '表示: テクスチャ'],
  'toolbar.displayFlat': ['Display: flat', '表示: フラット'],

  // --- Static region names in index.html (for screen readers, looked up from data-i18n-aria) ---
  'aria.rail': ['Switch panels', 'パネル切替'],
  'aria.worldControls': ['World display', 'ワールド表示'],
  'aria.blockUsage': ['Blocks in use', '使用ブロック'],
  'aria.toolbar': ['Editing tools', '編集ツール'],

  // --- Place / erase toasts ---
  'edit.placedOrErased': ['{verb} {count} blocks', '{count} ブロック{verb}'],
  'edit.verbPlace': ['Placed', '設置'],

  // --- Export / load notifications ---
  'export.done': [
    'Exported ({sx}×{sy}×{sz}, {blocks} blocks). In game: /structure load {ns}:{name}',
    '書き出した ({sx}×{sy}×{sz}, {blocks}ブロック)。ゲーム内: /structure load {ns}:{name}',
  ],
  'export.doneOversize': [
    'Exported ({sx}×{sy}×{sz}). ⚠ Sides longer than 64 may not fit a structure block',
    '書き出した ({sx}×{sy}×{sz})。⚠ 一辺64超えはストラクチャーブロックで扱えないことがあるよ',
  ],
  'load.done': ['Loaded {count} blocks', '読み込んだ ({count}ブロック)'],
  'load.doneWithSkipped': [
    'Loaded {count} blocks ({skipped} unsupported skipped)',
    '読み込んだ ({count}ブロック、未対応{skipped}件スキップ)',
  ],
  'load.restored': ['Restored your last session ({count} blocks)', '前回の続きを復元した ({count}ブロック)'],

  // --- Shape generator ---
  // box isn't an "other shape" — it's a peer entry, so it's listed under shape.* like the rest
  'shape.box': ['Box', '直方体'],
  'shape.sphere': ['Sphere', '球'],
  'shape.cylinder': ['Cylinder', '円柱'],
  'shape.dome': ['Dome', 'ドーム'],
  'shape.slope': ['Slope', 'スロープ'],
  'shape.menu': ['Shape', '形状'],
  'shape.menuTitle': ['Choose a shape to fill with', '範囲を埋める形状を選ぶ'],
  'shape.void': ['Void', '空白'],
  'shape.voidTitle': [
    'Paint void instead of a block (carves what is behind it, non-destructive)',
    'ブロックの代わりに空白を敷く (背面をくり抜く、非破壊)',
  ],
  'shape.hollow': ['Hollow', '中空'],
  'shape.hollowTitle': ['Fill only the outer shell', '外殻だけを埋める'],
  'shape.current': ['Shape: {name} ({key})', '形状: {name} ({key})'],
  'shape.axis': ['Axis', '軸'],
  'shape.axisTitle': ['Which way the cylinder runs', '円柱を伸ばす向き'],
  'shape.axisX': ['X', 'X'],
  'shape.axisY': ['Y', 'Y'],
  'shape.axisZ': ['Z', 'Z'],
  'shape.step': ['Step height', '段の高さ'],
  'shape.stepTitle': ['How many blocks each step rises', '1 段で何ブロック上がるか'],
  'shape.tooLarge': [
    'Too large to fill ({count} > {max} blocks)',
    '範囲が大きすぎて埋められない ({count} > {max} ブロック)',
  ],
  'shape.bboxTooLarge': [
    'The range is too big to compute ({count} > {max} cells). Drag a smaller range',
    '範囲が広すぎて計算できない ({count} > {max} セル)。もう少し狭く指定して',
  ],

  // --- Generic fallback at the display boundary ---
  // Exceptions that aren't a DisplayableError fall through here instead of showing the raw message.
  // Developer-facing detail stays in the console
  'err.loadFailed': [
    'Not a valid blocksmith project file',
    'blocksmith のプロジェクトファイルとして読めなかった',
  ],
  'err.exportFailed': ['Export failed', '書き出せなかった'],
  'err.exportNotSaved': [
    'Export canceled: could not save this project, so the pack would not update in Minecraft',
    '書き出しを中止した (保存できなかったので、取り込んでも Minecraft 側が更新されない)',
  ],

  // --- Export failures (throw → toast) ---
  'exportErr.empty': ['No blocks have been placed', 'ブロックが 1 つも置かれていない'],
  'exportErr.invalidCoords': [
    'Some blocks are out of range or at invalid coordinates (check the loaded data)',
    '範囲外または不正な座標のブロックが含まれている (読込データを確認して)',
  ],
  'exportErr.sideTooLong': [
    'Export range is too large ({sx}×{sy}×{sz}, max side {max})',
    '書き出し範囲が大きすぎる ({sx}×{sy}×{sz}、一辺の上限 {max})',
  ],
  'exportErr.volumeTooLarge': [
    'Export range is too large ({sx}×{sy}×{sz} = {volume} cells, max {max}). Remove distant blocks or split the build.',
    '書き出し範囲が大きすぎる ({sx}×{sy}×{sz} = {volume} セル、上限 {max})。離れた場所のブロックを消すか分割して',
  ],
} as const satisfies Record<string, readonly [string, string]>;

export type UiKey = keyof typeof UI;

/** Default name for generated data. **Resolved once at creation time**, then kept as a plain string thereafter */
const DEFAULT_NAMES = {
  group: ['Group', 'グループ'],
  cuboid: ['Cuboid', '直方体'],
  /** Material name used when filled with void. Becomes e.g. `Cuboid: Void` */
  void: ['Void', '空白'],
  /**
   * Default name combining shape + material. Appends the
   * material like `Cuboid: Cobblestone`, so multiple "Cuboid" entries can be told apart in the layer tree.
   *
   * **Fixed once, using the material at creation time.** Swapping the material later doesn't
   * update the name — the name is a record of that moment, not a derived value, and following
   * the material would overwrite a name the user manually renamed. Built as a component so the
   * separator can vary per language.
   */
  shapeWithMaterial: ['{shape}: {material}', '{shape}：{material}'],
  // Default name per shape. Lets the layer tree distinguish what was placed
  sphere: ['Sphere', '球'],
  cylinder: ['Cylinder', '円柱'],
  dome: ['Dome', 'ドーム'],
  slope: ['Slope', 'スロープ'],
  project: ['Untitled', '作品'],
  /** `{n}` is a 1-based sequence number */
  recipe: ['Pattern {n}', 'パターン {n}'],
} as const satisfies Record<string, readonly [string, string]>;

export type DefaultNameKey = keyof typeof DEFAULT_NAMES;

function pick(pair: readonly [string, string], lang: Lang): string {
  return lang === 'ja' ? pair[1] : pair[0];
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const v = vars[key];
    return v === undefined ? whole : String(v);
  });
}

/** Resolves a UI label. Call it every time it's displayed (so it follows language switching) */
export function translate(key: UiKey, lang: Lang, vars?: Record<string, string | number>): string {
  return interpolate(pick(UI[key], lang), vars);
}

/**
 * Resolves the default name for generated data. **Call it only once, at creation time.**
 * Don't call it again when displaying an already-stored name (it would garble on a language switch).
 */
export function defaultName(key: DefaultNameKey, lang: Lang, vars?: Record<string, string | number>): string {
  return interpolate(pick(DEFAULT_NAMES[key], lang), vars);
}


/**
 * Dictionary of errors returned by the editor layer (ops.ts).
 *
 * **The editor layer can't depend on state** (the layering rule in docs/architecture.md,
 * enforced by ESLint). So ops returns a **key**, not a string, and the composition root
 * translates it with `translateOpError` before showing it in a toast. This is kept separate
 * from the UI label dictionary because it's a distinct vocabulary — "reasons an operation
 * failed" — and mixing it into the UI label dictionary would make both harder to search.
 */
const OP_ERRORS = {
  noSelection: ['Nothing selected', '選択がない'],
  noGroupableBlocks: ['No blocks can be grouped', 'グループ化できるブロックがない'],
  groupNotFound: ['Target group not found', '対象グループが見つからない'],
  blockNotFound: ['Target block not found', '対象ブロックが見つからない'],
  noPatternData: ['No pattern data', 'パターン編集データがない'],
  noPatternPaintToChange: ['No pattern paint to change', '変更するパターン塗りがない'],
  lockedGroupCannotMove: ['Locked groups cannot be moved', 'ロック中のグループは移動できない'],
  lockedGroupCannotRotate: ['Locked groups cannot be rotated', 'ロック中のグループは回転できない'],
  lockedBlocksCannotMove: ['Locked blocks cannot be moved', 'ロック中のブロックは移動できない'],
  lockedInMirror: ['Cannot mirror: the selection contains locked blocks', 'ロック中のブロックが含まれるため反転できない'],
  cannotMoveIntoLocked: ['Cannot move into a locked group', 'ロック中のグループの中には移動できない'],
  cannotMoveIntoSelf: ['Cannot move into itself or its own descendants', '自分自身または子孫グループの中には移動できない'],
  noGroupToMove: ['No group to move', '移動するグループがない'],
  noBlockToMove: ['No block to move', '移動するブロックがない'],
  outOfRangeMove: ['Cannot move outside the world bounds', '範囲外への移動はできない'],
  outOfRangeRotate: ['Cannot rotate: it would leave the world bounds', '回転すると範囲外へ出るため回転できない'],
  outOfRangeMirror: ['Cannot mirror: it would leave the world bounds', '範囲外へ出るため反転できない'],
  outOfRangeDuplicate: [
    'Cannot duplicate: {count} copies would leave the world bounds',
    '{count} 個ぶんが範囲外へ出るため複製できない',
  ],
  noRoomToDuplicate: ['No free space to duplicate into', '複製先の空きが見つからない'],
  duplicateGapZero: ['The duplicate gap is zero', '複製の間隔が 0 になっている'],
  duplicateCountInvalid: ['Copy count must be a whole number of 1 or more', '複製数は 1 以上の整数で指定して'],
  tooManyTargets: ['Too many targets (up to {max} blocks)', '対象が多すぎる ({max} ブロックまで)'],
  tooLargeAfterDuplicate: [
    'Too large after duplicating ({count} > {max} blocks)',
    '複製後が大きすぎる ({count} > {max} ブロック)',
  ],
  tooLargeToMirror: [
    'Selection is too large to mirror ({count} > {max} blocks)',
    '選択が大きすぎて反転できない ({count} > {max} ブロック)',
  ],
  tooLargeToMove: [
    'Selection is too large to move ({count} > {max} blocks)',
    '選択が大きすぎて移動できない ({count} > {max} ブロック)',
  ],
  // Also carries the wording for when owner is root, per language, so "(ungrouped)" doesn't leak untranslated into the English sentence
  overlapAtDestination: [
    'Cannot apply: the destination overlaps (group "{owner}" already has a block there)',
    '移動先が重なるため実行できない (グループ "{owner}" の同じ位置に既にブロックがある)',
  ],
  overlapAtDestinationRoot: [
    'Cannot apply: the destination overlaps (an ungrouped block is already there)',
    '移動先が重なるため実行できない (未分類の同じ位置に既にブロックがある)',
  ],
  onlyLockedGroups: ['Only locked groups are in range', 'ロック中のグループしか対象がない'],
  noBlocksToReplace: ['No blocks to replace', '置き換えるブロックがない'],
  rangeTooLarge: ['Range is too large ({count} > {max} blocks)', '範囲が大きすぎる ({count} > {max} ブロック)'],
  nothingInRange: ['Nothing in range', '対象がなかった'],
  // Components
  componentNeedsOneGroup: [
    'Select exactly one group to make a component',
    'コンポーネントにするグループを 1 つだけ選んで',
  ],
  componentAlreadyInstance: [
    'That group is already a component instance',
    'そのグループは既にコンポーネントのインスタンスになっている',
  ],
  componentNestedInstance: [
    'That group contains component instances. Detach them first',
    'その中にコンポーネントのインスタンスが入っている。先に解除して',
  ],
  componentEmpty: ['A component needs at least one block', 'コンポーネントには最低 1 ブロック要る'],
  componentNotFound: ['Component not found', 'コンポーネントが見つからない'],
  outOfRangePlaceComponent: [
    'Cannot place: it would leave the world bounds',
    '範囲外へ出るため配置できない',
  ],
} as const satisfies Record<string, readonly [string, string]>;

export type OpErrorKey = keyof typeof OP_ERRORS;

export function translateOpError(key: OpErrorKey, lang: Lang, vars?: Record<string, string | number>): string {
  return interpolate(pick(OP_ERRORS[key], lang), vars);
}

/**
 * Fallback value used when a loaded file has no name. **Kept language-independent.**
 * The language at save time can't be recovered, so a fixed value that doesn't change with switching is used.
 */
export const FALLBACK_PROJECT_NAME = 'Untitled';

/**
 * A displayable error.
 *
 * A throw from the export layer is caught by ProjectService and **shown in a toast**, so
 * "not shown on screen, hence out of scope for translation" doesn't hold here. But the
 * export layer can't depend on state either, so it **carries a key when thrown, and the
 * display side translates it**.
 */
export class DisplayableError extends Error {
  constructor(
    readonly key: UiKey,
    readonly vars?: Record<string, string | number>,
  ) {
    // message is kept in English (so it's readable on unhandled paths or in the developer console)
    super(translate(key, 'en', vars));
    this.name = 'DisplayableError';
  }
}
