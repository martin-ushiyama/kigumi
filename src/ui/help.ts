import { onLangChange, state } from '../state';

/**
 * The help panel listing shortcuts. Toggled by H / ? / the rail's help button.
 *
 * **This file holds Japanese and English text as pairs, in place** (#70). Scattered labels
 * are consolidated in `core/i18n.ts`'s dictionary, but since this is a single self-contained
 * table, keeping the correspondence visible at a glance is easier to maintain than pushing
 * 70+ keys into the dictionary.
 *
 * The key column (`W A S D` etc.) is language-independent, so it's not translated.
 */
type Bi = readonly [en: string, ja: string];

const SECTIONS: { title: Bi; rows: readonly (readonly [key: string, desc: Bi])[] }[] = [
  {
    title: ['Mouse', 'マウス'],
    rows: [
      [
        'Left click / drag',
        [
          'Use the current tool (place puts one block per click; erase can be dragged across cells)',
          'ツール実行 (設置はクリック 1 回で 1 個。削除はドラッグでなぞって消せる)',
        ],
      ],
      ['Right drag', ['Orbit the camera', '視点回転']],
      ['Middle drag', ['Pan', '平行移動']],
      ['Wheel', ['Zoom', 'ズーム']],
      [
        'Space + left drag',
        ['Pan. Takes priority over the tool while held', '平行移動 (パン、押している間だけツール操作より優先)'],
      ],
    ],
  },
  {
    title: ['Camera', 'カメラ'],
    rows: [
      ['W A S D / Arrows', ['Move relative to where you are facing', '平行移動 (向いてる方向基準)']],
      ['Z / C', ['Rise / descend', '上昇 / 下降']],
      ['Q / E', ['Turn left / right', '左回転 / 右回転']],
      ['F', ['Focus on the build', '建築物にフォーカス']],
      ['R', ['Reset the view', '視点リセット']],
      [
        'Shift+7 / 1 / 3',
        ['Top / front / side view (also in View, top right)', '上面 / 正面 / 側面ビュー (右上の View からも)'],
      ],
    ],
  },
  {
    title: ['Tools and editing', 'ツール・編集'],
    rows: [
      [
        '1 / 2 / 3 / 4',
        ['Place / erase / shape fill / eyedropper (select is the startup tool)', '設置 / 削除 / 形状フィル / スポイト (起動時は選択ツール)'],
      ],
      [
        'Shape fill (3)',
        [
          'Drag to set the footprint, release, then move the mouse up and down to set the height and click to place. Filled as one group — existing blocks are not overwritten, the new ones stack over them (what is underneath stays visible in the layers panel)',
          'ドラッグで底面の範囲を取り、離したあとマウスの上下で高さを決めてクリックで確定する。範囲は 1 つのグループとして置かれ、既存ブロックは上書きせず重なる (下敷きはレイヤーパネルで見える)',
        ],
      ],
      [
        'Shape fill — height',
        [
          'The height step starts when you release the button. Click to place, Escape to cancel. Placing without moving keeps it flat',
          '高さの指定はボタンを離した時点で始まる。クリックで確定、Escape でキャンセル。動かさずに確定すれば平たいまま置ける',
        ],
      ],
      [
        '3 / O / Y / M / K',
        [
          'Choose the shape to fill with: box / sphere / cylinder / dome / slope. The tool stays the same — only the way the range is filled changes',
          '埋める形状を選ぶ: 直方体 / 球 / 円柱 / ドーム / スロープ。ツールは同じで、範囲の埋め方だけ変わる',
        ],
      ],
      [
        'Shape options',
        [
          'The caret next to the shape button opens hollow (shell only), the cylinder axis, and the slope step height',
          '形状ボタン横のキャレットで、中空 (外殻だけ) / 円柱の軸 / スロープの段の高さを指定できる',
        ],
      ],
      ['V', ['Select tool', '選択ツール']],
      [
        'T',
        [
          'Rotate stair facing / cycle the axis y→x→z on logs and other pillar_axis blocks (no effect on plain slabs and full blocks)',
          '階段の向きを回転 / 原木等 (pillar_axis持ち) は軸を y→x→z循環 (それ以外のslab/fullでは無効)',
        ],
      ],
      ['G', ['Flip a slab top/bottom or a stair upside down', 'スラブの上下半分 / 階段の上下反転を切替']],
      [
        'Click / Ctrl+click / double click',
        ['Select a block / toggle multi-select / step one level into a group', 'ブロック選択 / 複数選択トグル / グループを1段掘る'],
      ],
      ['Shift + click (select tool)', ['Select existing blocks in the range', '範囲内の既存ブロックを選択']],
      [
        'Arrows (with a selection)',
        [
          'Nudge the selection by one cell, in screen terms: left / right and toward / away from you. Works whichever tool is active. Shift+↑↓ extends the layer selection (falls back to camera movement when it cannot). Nothing happens while Ctrl or Alt is held',
          '選択を1マスナッジ移動。向きは **いま見えている画面基準** (左右と手前奥) で、視点を回すと行き先も変わる。ツールは問わない。Shift+↑↓ はレイヤーの範囲選択 (使えないときはカメラ移動)。Ctrl / Alt を押しているときは何も起きない',
        ],
      ],
      [
        'PageUp / PageDown (with a selection)',
        [
          'Nudge the selection up / down one cell. Height is always up / down, whichever way you are facing',
          '選択を上下に1マスナッジ移動。高さは視点によらず常に上下',
        ],
      ],
      [
        '[ / ] (select tool, group selected)',
        [
          'Rotate the group 90° around Y (counter-clockwise / clockwise), about the group pivot',
          'グループをY軸90度回転 (左回り / 右回り)。回転中心はグループのpivot',
        ],
      ],
      [
        'Shift+X / Shift+Y / Shift+Z (select tool, with a selection)',
        [
          'Mirror the selection on each axis, about the centre of its bounding box. Stair and slab facing is mirrored too. Shift+Z only beats the camera while something is selected',
          '選択を各軸で反転 (ミラー)。鏡映面は選択のbbox中心、階段やスラブの向きも鏡像になる。Shift+Zは選択がある時だけカメラ操作より優先',
        ],
      ],
      [
        'Ctrl+D / "Array duplicate" in the inspector',
        [
          'Duplicate the selection next to itself / lay out N copies evenly by direction, count and gap',
          '選択を隣接に1個複製 / 方向・個数・間隔を指定して等間隔にN個並べる',
        ],
      ],
      ['Delete', ['Delete the selected blocks', '選択したブロックを削除']],
      ['Ctrl+Z / Ctrl+Y', ['Undo / redo', '元に戻す / やり直す']],
      [
        'Esc',
        ['Cancel a shape fill, range selection or selection / close this help', '形状フィル・範囲選択・選択解除のキャンセル / ヘルプを閉じる'],
      ],
      ['H or ?', ['This help', 'このヘルプ']],
      ['Display mode (textured / flat)', ['In View, top right', '右上の View']],
      [
        'Visibility / lock in the layers panel',
        [
          'Toggle a group hidden or locked (inherited by descendants). Hidden groups are not drawn or picked; locked groups cannot be selected, placed into or erased',
          'グループの非表示・ロック切替 (子孫グループにも継承。非表示は描画・選択対象外、ロックは選択・設置/削除対象外)',
        ],
      ],
      [
        'Shift+↑ / ↓ (layers)',
        [
          'Grow or shrink the selection along the layer order. Group rows and block rows are never mixed, so it walks rows of the same kind',
          'レイヤーパネルの並びに沿って選択範囲を伸ばす・縮める (グループ行とブロック行はまたげないので、同じ種類の行だけを辿る)',
        ],
      ],
      [
        'Filter in the layers panel',
        [
          'Filter rows by group name and block display name. Parent groups of a match open even when collapsed. Collapsing is disabled while filtering (⌄ / ⌃ expand or collapse everything)',
          'グループ名とブロックの表示名で行を絞る (一致した行の親グループは畳んでいても開いて表示。絞り込み中は折りたたみ操作なし。⌄ / ⌃ ですべて展開・折りたたみ)',
        ],
      ],
      [
        'Blocks in use (right panel)',
        [
          'Blocks and counts used in the selected group (the whole project when nothing is selected). "Change" opens the block / pattern picker, where you can pick a replacement or edit the pattern in place. Either way one undo reverts it',
          '選択中のグループ (未選択なら作品全体) で使われているブロックと個数。「変更」でブロック / パターンのピッカーを開き、変更先の選択やパターン編集をその場で行う。どちらも undo 1 回で戻る',
        ],
      ],
      [
        'Dragging a layer row',
        [
          'Move everything selected together (into a group / reorder among siblings). Grabbing a row outside the selection moves just that row',
          '選択中のものをまとめて移動 (グループの中へ / 兄弟順の並べ替え)。選択外の行を掴んだらその行だけが対象になる',
        ],
      ],
    ],
  },
];

const PANEL_TITLE: Bi = ['Keyboard guide', '操作ガイド'];
const CLOSE_LABEL: Bi = ['Close (Esc)', '閉じる (Esc)'];

export interface HelpHandle {
  isVisible: () => boolean;
  /** Equivalent of the h / ? key. Called from InputRouter's (#12) SHORTCUTS */
  toggle: () => void;
  /** Called from the Escape broadcast. No-op while hidden (self-guarded via root.hidden, unchanged from the old implementation) */
  close: () => void;
}

export function initHelp(root: HTMLElement): HelpHandle {
  const panel = document.createElement('div');
  panel.className = 'help-panel';
  root.appendChild(panel);
  root.hidden = true;

  const pick = (bi: Bi): string => (state.lang === 'ja' ? bi[1] : bi[0]);

  function render(): void {
    panel.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'help-title';
    title.textContent = pick(PANEL_TITLE);
    panel.appendChild(title);

    for (const section of SECTIONS) {
      const h = document.createElement('div');
      h.className = 'help-section';
      h.textContent = pick(section.title);
      panel.appendChild(h);
      for (const [key, desc] of section.rows) {
        const row = document.createElement('div');
        row.className = 'help-row';
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        const span = document.createElement('span');
        span.textContent = pick(desc);
        row.append(kbd, span);
        panel.appendChild(row);
      }
    }

    const close = document.createElement('button');
    close.className = 'help-close';
    close.textContent = pick(CLOSE_LABEL);
    close.addEventListener('click', () => setVisible(false));
    panel.appendChild(close);
  }

  function setVisible(visible: boolean): void {
    root.hidden = !visible;
  }

  render();
  onLangChange(render);

  root.addEventListener('click', (e) => {
    if (e.target === root) setVisible(false); // Close on background click
  });

  window.addEventListener('bs-toggle-help', () => setVisible(Boolean(root.hidden)));

  // The old window keydown handler (h/?/Escape) was moved to InputRouter's (#12) SHORTCUTS / Escape broadcast.
  return {
    isVisible: () => !root.hidden,
    toggle: () => setVisible(Boolean(root.hidden)),
    close: () => {
      if (!root.hidden) setVisible(false);
    },
  };
}
