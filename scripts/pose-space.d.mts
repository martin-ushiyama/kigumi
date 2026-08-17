/** Builds the pose space from the upstream data (#131 PR 1). Implemented in pose-space.mjs */

export type PoseValue = string | number | boolean;

/** The states that make up a pose. **The order is the digit weight** (the first is the highest digit) */
export declare const POSE_STATES: string[];

/** The states already judged not to be poses. A state in neither this nor POSE_STATES fails the check */
export declare const NON_POSE_STATES: string[];

/** Takes the pose states and value ranges out of one upstream declaration */
export declare function poseStatesOf(
  dataItem: { properties?: Array<{ name: string }> } | undefined,
  domains: Map<string, PoseValue[]>,
): { pose: Record<string, PoseValue[]>; unknownStates: string[] };

/** The size of the pose space (the product of the value ranges) */
export declare function poseSpaceSize(pose: Record<string, PoseValue[]>): number;

/** Folds the pose spaces per shape. A disagreement within one shape appears in conflicts */
export declare function foldPoseSpacesByShape(
  blocks: Array<{ id: string; shape: string; pose: Record<string, PoseValue[]> }>,
): { spaces: Record<string, Record<string, PoseValue[]>>; conflicts: string[] };
