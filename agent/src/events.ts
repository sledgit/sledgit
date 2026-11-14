// The vault's NEP-297 event standard. Testnet vaults deployed before the rename log the legacy "irontrade".
export const EVENT_STANDARD = "sledgit";
export const LEGACY_EVENT_STANDARD = "irontrade";
export const isVaultStandard = (s: unknown): boolean => s === EVENT_STANDARD || s === LEGACY_EVENT_STANDARD;
