import { describe, expect, it, vi } from "vitest";
import type { Authentik } from "./authentik.js";
import { ensureScopeMapping, missingStandardScopes, SCOPE_MAPPING_NAME, waitForDefaults } from "./bootstrap.js";

/**
 * A provider copies the scope-mapping list the broker captured at bootstrap. authentik creates the
 * standard openid/email/profile mappings from one of its own default blueprints, some time after the
 * API starts answering. Captured too early, the list has no email mapping, every registered provider
 * is created without it, and every product sign-in fails with "no_email" (v1.0.6 release CI).
 */

const std = (scope: string) => ({ pk: `pk-${scope}`, name: `authentik default OAuth Mapping: ${scope}`, scope_name: scope, expression: "", managed: `goauthentik.io/providers/oauth2/scope-${scope}` });
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("standard scope mappings", () => {
  it("names the ones authentik has not created yet", () => {
    expect(missingStandardScopes([])).toEqual(["openid", "email", "profile"]);
    expect(missingStandardScopes([std("openid"), std("profile")])).toEqual(["email"]);
    expect(missingStandardScopes([std("openid"), std("email"), std("profile"), { managed: null }, { managed: "goauthentik.io/providers/oauth2/scope-offline_access" }])).toEqual([]);
  });

  it("ensureScopeMapping refuses to cache an incomplete list, and creates nothing while it waits", async () => {
    const createScopeMapping = vi.fn();
    const ak = { scopeMappings: vi.fn(async () => [std("openid"), std("profile")]), createScopeMapping, updateScopeMapping: vi.fn() } as unknown as Authentik;
    await expect(ensureScopeMapping(ak)).rejects.toThrow(/standard scope mappings not applied yet: email/);
    expect(createScopeMapping).not.toHaveBeenCalled();
  });

  it("returns the three standard mappings plus the Vibe roles mapping once they exist", async () => {
    const ak = {
      scopeMappings: vi.fn(async () => [std("openid"), std("email"), std("profile")]),
      createScopeMapping: vi.fn(async (b: { name: string }) => ({ pk: "pk-vibe", ...b })),
      updateScopeMapping: vi.fn(),
    } as unknown as Authentik;
    expect(await ensureScopeMapping(ak)).toEqual(["pk-openid", "pk-email", "pk-profile", "pk-vibe"]);
    expect((ak.createScopeMapping as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ name: SCOPE_MAPPING_NAME, scope_name: "profile" });
  });

  it("waitForDefaults keeps waiting until the email mapping appears", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const ak = {
      defaultBrand: vi.fn(async () => ({ brand_uuid: "b" })),
      flowBySlug: vi.fn(async (slug: string) => ({ pk: slug, slug })),
      validateStageByName: vi.fn(async () => ({ pk: "s", name: "vibe-mfa-validation" })),
      scopeMappings: vi.fn(async () => (++calls < 3 ? [std("openid"), std("profile")] : [std("openid"), std("email"), std("profile")])),
    } as unknown as Authentik;
    const done = waitForDefaults(ak, log, 60_000);
    await vi.advanceTimersByTimeAsync(11_000);
    await done;
    expect(calls).toBe(3);
    expect(log.info).toHaveBeenCalledWith("waiting for authentik blueprints", expect.objectContaining({ missing: ["scope-mapping:email"] }));
    vi.useRealTimers();
  });
});
