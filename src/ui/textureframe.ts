import {
  TEXTURE_BASE,
  firstFrameBackground,
  firstFrameImageHeight,
  frameCountOf,
} from '../core/textureframe';

/**
 * The single channel for attaching a block texture to the DOM.
 *
 * The palette / swatch / change picker / layer icon all render the same image in
 * four separate places; writing `background-size` independently in each would
 * risk one of them missing the crop for animated textures. As long as everything
 * goes through here, frame-count handling stays defined in one place.
 */

/** Attach as a background image (palette / swatch / change picker) */
export function applyTextureBackground(el: HTMLElement, file: string): void {
  const { size, position } = firstFrameBackground(frameCountOf(file));
  el.style.backgroundImage = `url(${TEXTURE_BASE}${file})`;
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
  img.src = TEXTURE_BASE + file;
  img.style.imageRendering = 'pixelated';
  if (frames > 1) {
    wrap.style.overflow = 'hidden';
    img.style.height = firstFrameImageHeight(frames);
    img.style.objectFit = 'fill';
  }
}
