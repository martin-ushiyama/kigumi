export const VARIANT_SUFFIXES: readonly string[];
export function variantRoots(baseId: string): Set<string>;
export function findMissingVariants(args: {
  fullIds: readonly string[];
  catalogIds: ReadonlySet<string>;
  officialIds: ReadonlySet<string>;
}): { baseId: string; missingId: string }[];
export function formatMissingVariant(entry: { baseId: string; missingId: string }): string;
