// @kisaesdevlab/vibe-auth — server entry
export { createVibeAuth, VibeAuth, type VibeAuthOptions, type AuthStatus, type Logger } from "./engine.js";
export { vibeAuthExpress, guardLocalLogin, toHttpRequest, sendHttpResponse } from "./express.js";
export { vibeAuthFastify, type VibeAuthFastifyOptions } from "./fastify.js";
export * from "./adapters/types.js";
export { MemoryIdentityStore, MemoryRevocationList } from "./adapters/memory.js";
export { createPgStores, createPgIdentityStore, createPgSettingsStore, createPgRevocationList, type QueryFn, type PgStoresOptions } from "./adapters/pg.js";
export { MemorySettingsStore, plaintextSecretWrap, resolveEffectiveConfig } from "./settings.js";
export { consoleAuditSink, combineAuditSinks, makeAudit, type Audit } from "./audit.js";
export { loadEnvConfig, envSchema, defaultRoleMapFor, unmappedDefaultGroups, defaultBreakglassEmail, DEFAULT_VIBE_GROUPS, AUTH_MODES, type AuthMode, type EnvConfig, type EffectiveConfig, type OidcConfig, type RoleVocabulary } from "./config.js";
export { discover, rewriteToInternalBase, normalizeIssuer, forwardedHeadersFor, type ResolvedProvider, type DiscoveryDocument } from "./discovery.js";
export { resolveRole, amrSatisfiesMfa, mostPrivileged, type RoleResolution } from "./roles.js";
export { linkOrProvision, type LinkResult } from "./identity.js";
export { validateIdToken, validateLogoutToken, exchangeCode, fetchUserInfo, type IdTokenClaims } from "./tokens.js";
export { breakglassEnsure, breakglassRotate, breakglassStatus, breakglassVerify, generatePassword, type BreakglassResult, type BreakglassStatus, type BreakglassCheck } from "./breakglass.js";
export { MemoryPendingLoginStore, type PendingLoginStore, type PendingLogin } from "./pkce.js";
export type { HttpRequest, HttpResponse } from "./http.js";
export type { VibeAuthCliAdapter } from "./cli.js";
