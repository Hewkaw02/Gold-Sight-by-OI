export const FRONT_CORE_DTES = [7, 15, 30] as const;
export const FRONT_TARGET_DTES = [7, 15, 30, 60, 90] as const;

export type FrontTargetDte = typeof FRONT_TARGET_DTES[number];
