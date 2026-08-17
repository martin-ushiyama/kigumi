export interface FlipbookEntry {
  frames: number[] | null;
}

export function parseJsonc(text: string): unknown;
export function parseTextureSource(value: unknown): { commit: string } | null;
export function buildFlipbookMembership(
  entries: readonly { flipbook_texture?: string; frames?: unknown }[],
): Map<string, FlipbookEntry>;

export function frameCountFromSize(size: {
  width: number;
  height: number;
}): { ok: true; frameCount: number } | { ok: false; reason: string };

export function validateFrameIndices(args: {
  frames: unknown;
  frameCount: number;
}): { ok: true } | { ok: false; reason: string };

export function verifyFrameStructure(args: {
  membership: Map<string, FlipbookEntry>;
  frames: Record<string, number>;
  referenced?: Iterable<string>;
}): string[];
