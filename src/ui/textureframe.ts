import {
  firstFrameBackground,
  firstFrameImageHeight,
  frameCountOf,
  staticTextureUrl,
  type TextureUrlResolver,
} from '../core/textureframe';

/**
 * The single channel for attaching a block texture to the DOM.
 *
 * The palette / swatch / change picker / layer icon all render the same image in
 * four separate places; writing `background-size` independently in each would
 * risk one of them missing the crop for animated textures. As long as everything
 * goes through here, frame-count handling stays defined in one place.
 */

let resolveTextureUrl: TextureUrlResolver = staticTextureUrl;
const resolutionVersions = new WeakMap<HTMLElement, number>();

/** Configured once by the composition root; static files remain the fallback. */
export function configureTextureUrlResolver(resolver: TextureUrlResolver): void {
  resolveTextureUrl = resolver;
}

function setResolvedBackground(el: HTMLElement, file: string): void {
  const version = (resolutionVersions.get(el) ?? 0) + 1;
  resolutionVersions.set(el, version);
  el.dataset.textureFile = file;
  el.dataset.textureKind = 'background';
  el.style.backgroundImage = `url(${staticTextureUrl(file)})`;
  void Promise.resolve(resolveTextureUrl(file)).then((url) => {
    if (el.dataset.textureFile === file && resolutionVersions.get(el) === version) {
      el.style.backgroundImage = `url(${url})`;
    }
  });
}

function setResolvedImage(img: HTMLImageElement, file: string): void {
  const version = (resolutionVersions.get(img) ?? 0) + 1;
  resolutionVersions.set(img, version);
  img.dataset.textureFile = file;
  img.dataset.textureKind = 'image';
  img.src = staticTextureUrl(file);
  void Promise.resolve(resolveTextureUrl(file)).then((url) => {
    if (img.dataset.textureFile === file && resolutionVersions.get(img) === version) img.src = url;
  });
}

/** Re-resolves mounted texture elements after a pack is imported or removed. */
export function refreshTextureElements(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-texture-file]')) {
    const file = element.dataset.textureFile;
    if (!file) continue;
    if (element.dataset.textureKind === 'image' && element instanceof HTMLImageElement) setResolvedImage(element, file);
    else setResolvedBackground(element, file);
  }
}

/** Attach as a background image (palette / swatch / change picker) */
export function applyTextureBackground(el: HTMLElement, file: string): void {
  const { size, position } = firstFrameBackground(frameCountOf(file));
  setResolvedBackground(el, file);
  el.style.backgroundSize = size;
  el.style.backgroundPosition = position;
  el.style.backgroundRepeat = 'no-repeat';
  el.style.imageRendering = 'pixelated';
}

/**
 * Attach as an `<img>` (layer icon).
 *
 * The wrapper clips it, stretching the img vertically so only the first frame
 * shows. Not using a background image here keeps the path for catching load
 * failures via the `error` event open (failures can't be detected on a background image).
 */
export function applyTextureImage(wrap: HTMLElement, img: HTMLImageElement, file: string): void {
  const frames = frameCountOf(file);
  setResolvedImage(img, file);
  img.style.imageRendering = 'pixelated';
  if (frames > 1) {
    wrap.style.overflow = 'hidden';
    img.style.height = firstFrameImageHeight(frames);
    img.style.objectFit = 'fill';
  }
}
