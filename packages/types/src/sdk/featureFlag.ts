export enum FeatureFlag {
  PER_CREATOR_PER_USER_PRICE = "PER_CREATOR_PER_USER_PRICE",
  PER_CREATOR_PER_USER_PRICE_ALERT = "PER_CREATOR_PER_USER_PRICE_ALERT",
  AI_CUSTOM_CONFIGS = "AI_CUSTOM_CONFIGS",
}

export interface TenantFeatureFlags {
  [key: string]: FeatureFlag[]
}
