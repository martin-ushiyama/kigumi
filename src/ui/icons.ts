export type IconName =
  | 'box'
  | 'shape-sphere'
  | 'shape-cylinder'
  | 'shape-dome'
  | 'shape-slope'
  | 'chevron-down'
  | 'chevron-up'
  | 'close'
  | 'copy'
  | 'cursor'
  | 'eraser'
  | 'eye'
  | 'eye-off'
  | 'eyedropper'
  | 'grid'
  | 'help'
  | 'layers'
  | 'lock'
  | 'list'
  | 'redo'
  | 'rotate-ccw'
  | 'rotate-cw'
  | 'mirror-x'
  | 'mirror-y'
  | 'mirror-z'
  | 'component'
  | 'detach'
  | 'group'
  | 'ungroup'
  | 'square-plus'
  | 'swap'
  | 'theme'
  | 'texture'
  | 'replace'
  | 'void'
  | 'trash'
  | 'undo'
  | 'unlock'
  | 'view-front'
  | 'view-side'
  | 'view-top';

const CONTENT: Record<IconName, string> = {
  cursor: '<path d="m5 3 11 8-5 1.5L8.5 17z"/><path d="m11 12.5 3.5 5"/>',
  'square-plus': '<rect x="3.5" y="3.5" width="13" height="13" rx="1.5"/><path d="M10 7v6M7 10h6"/>',
  eraser: '<path d="m4 13 7.5-8a2 2 0 0 1 3 0l1 1a2 2 0 0 1 0 3L9 16H6z"/><path d="m9 8 5 5M9 16h7"/>',
  box: '<path d="m10 2.8 7 3.7v7L10 17.2 3 13.5v-7z"/><path d="m3 6.5 7 3.7 7-3.7M10 10.2v7"/>',
  // Shape generator. Ranks alongside `box` as an equal option, so drawn with the same stroke width and padding
  'shape-sphere': '<circle cx="10" cy="10" r="7"/><path d="M3.2 8.6a12 12 0 0 0 13.6 0M3.2 11.4a12 12 0 0 1 13.6 0"/>',
  'shape-cylinder': '<ellipse cx="10" cy="5.5" rx="6" ry="2.5"/><path d="M4 5.5v9a6 2.5 0 0 0 12 0v-9"/>',
  'shape-dome': '<path d="M3 14.5a7 7 0 0 1 14 0"/><ellipse cx="10" cy="14.5" rx="7" ry="2.2"/>',
  'shape-slope': '<path d="M3 16.5V13h3.5V9.5H10V6h3.5V2.5H17v14z"/>',
  eyedropper: '<path d="m12.5 3.5 4 4-8 8H5v-3.5z"/><path d="m10.5 5.5 4 4M4 17h5"/>',
  eye: '<path d="M2.5 10s2.7-4.5 7.5-4.5 7.5 4.5 7.5 4.5-2.7 4.5-7.5 4.5S2.5 10 2.5 10Z"/><circle cx="10" cy="10" r="2"/>',
  'eye-off': '<path d="m3 3 14 14"/><path d="M8.2 5.8A7 7 0 0 1 10 5.5c4.8 0 7.5 4.5 7.5 4.5a10.8 10.8 0 0 1-2.1 2.6M11.9 14.2a7 7 0 0 1-1.9.3C5.2 14.5 2.5 10 2.5 10a11 11 0 0 1 2.2-2.7"/>',
  lock: '<rect x="4.5" y="8.5" width="11" height="8" rx="1.5"/><path d="M7 8.5V6a3 3 0 0 1 6 0v2.5"/>',
  list: '<path d="M7 5h10M7 10h10M7 15h10"/><path d="M3.5 5h.01M3.5 10h.01M3.5 15h.01"/>',
  unlock: '<rect x="4.5" y="8.5" width="11" height="8" rx="1.5"/><path d="M7 8.5V6a3 3 0 0 1 5.5-1.6"/>',
  copy: '<rect x="6.5" y="6.5" width="10" height="10" rx="1.5"/><path d="M13.5 6.5v-2a1 1 0 0 0-1-1h-9v9a1 1 0 0 0 1 1h2"/>',
  trash: '<path d="M4 5.5h12M8 5.5v-2h4v2M6 5.5l.7 11h6.6l.7-11M8.5 8.5v5M11.5 8.5v5"/>',
  'chevron-down': '<path d="m5 7.5 5 5 5-5"/>',
  'chevron-up': '<path d="m5 12.5 5-5 5 5"/>',
  close: '<path d="m5 5 10 10M15 5 5 15"/>',
  // Void outline. A dashed box conveys "no content"
  void: '<path d="M3.5 3.5h13v13h-13z" stroke-dasharray="2.5 2"/>',
  // Replace. **Distinct from swap.** Swap exchanges the two foreground /
  // spare slots; this is "change the current content to something else." Drawn as
  // opposing left/right arrows to convey "to something else."
  replace: '<path d="M3.5 8h11l-3-3"/><path d="M16.5 12h-11l3 3"/>',
  // A circle half-filled (light/dark boundary). Showing a sun/moon toggle wouldn't convey which side is currently active
  theme: '<circle cx="10" cy="10" r="7"/><path d="M10 3a7 7 0 0 0 0 14z" fill="currentColor" stroke="none"/>',
  undo: '<path d="M7 6 3.5 9.5 7 13"/><path d="M4 9.5h7a5 5 0 0 1 5 5"/>',
  redo: '<path d="m13 6 3.5 3.5L13 13"/><path d="M16 9.5H9a5 5 0 0 0-5 5"/>',
  'rotate-ccw': '<path d="M6 5.5H2.8V2.3"/><path d="M3.2 5.2A7 7 0 1 1 3.5 15"/><path d="M10 6.2v4.1l2.7 1.7"/>',
  'rotate-cw': '<path d="M14 5.5h3.2V2.3"/><path d="M16.8 5.2A7 7 0 1 0 16.5 15"/><path d="M10 6.2v4.1L7.3 12"/>',
  'mirror-x': '<path d="M10 2.5v15" stroke-dasharray="1.5 2"/><path d="M8 5 3.5 10 8 15zM12 5l4.5 5-4.5 5z"/>',
  'mirror-y': '<path d="M2.5 10h15" stroke-dasharray="1.5 2"/><path d="m5 8 5-4.5L15 8zM5 12l5 4.5 5-4.5z"/>',
  'mirror-z': '<path d="M10 2.5v15" stroke-dasharray="1.5 2"/><path d="M8 5 3.5 10 8 15zM12 5l4.5 5-4.5 5z"/><path d="M3 17h4M13 17h4"/>',
  component: '<path d="m6 2.7 3.3 3.3L6 9.3 2.7 6zM14 2.7 17.3 6 14 9.3 10.7 6zM6 10.7 9.3 14 6 17.3 2.7 14zM14 10.7l3.3 3.3-3.3 3.3-3.3-3.3z"/>',
  detach: '<path d="m6 2.7 3.3 3.3L6 9.3 2.7 6zM14 10.7l3.3 3.3-3.3 3.3-3.3-3.3z"/><path d="m11.2 4.3 4.5 4.5M15.7 4.3l-4.5 4.5"/>',
  group: '<rect x="2.7" y="4" width="6" height="8" rx="1"/><rect x="11.3" y="8" width="6" height="8" rx="1"/><path d="m8.7 9.5 2.6 1.5M8.7 12.5l2.6-1.5"/>',
  ungroup: '<rect x="2.7" y="4" width="6" height="8" rx="1"/><rect x="11.3" y="8" width="6" height="8" rx="1"/><path d="M8.7 7h2.6M8.7 13h2.6"/>',
  // Swap between the foreground and spare slots. An L-shaped round trip
  // going up and back to the left. Unlike the other icons, this one carries a
  // rotation transform — rotating a base shape preserves it better than
  // re-deriving the L's orientation as a new path (the corner radii and arrowhead
  // angles stay intact).
  swap: '<g transform="rotate(-90 10 10)"><path d="M4 12.5h9V4"/><path d="m10 7 3-3 3 3"/><path d="m7 9.5-3 3 3 3"/></g>',
  'view-top': '<path d="m10 3 7 3.5-7 3.5-7-3.5z"/><path d="m3 10 7 3.5 7-3.5M3 13.5 10 17l7-3.5"/>',
  'view-front': '<rect x="3.5" y="3.5" width="13" height="13" rx="1.5"/><path d="M3.5 8h13M8 3.5v13"/>',
  'view-side': '<path d="m5 3.5 10 2v9l-10 2z"/><path d="M10 4.5v11"/>',
  grid: '<path d="M3.5 3.5h13v13h-13zM8 3.5v13M12 3.5v13M3.5 8h13M3.5 12h13"/>',
  texture: '<path d="M3.5 3.5h13v13h-13z"/><path d="m3.5 11 4-4 3 3 2-2 4 4M13.5 6h.01"/>',
  help: '<circle cx="10" cy="10" r="7"/><path d="M8.4 8a1.8 1.8 0 1 1 2.5 1.7c-.7.3-.9.8-.9 1.5M10 14.5h.01"/>',
  // Stacked sheets = layers. Used for "Layers" in the left rail
  layers: '<path d="m10 2.6 7.2 3.9-7.2 3.9-7.2-3.9z"/><path d="m3.4 10.4 6.6 3.6 6.6-3.6M3.4 13.9 10 17.5l6.6-3.6"/>',
};

export function createIcon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('bs-icon');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = CONTENT[name];
  return svg;
}
