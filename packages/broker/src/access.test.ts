import { describe, expect, it, vi } from "vitest";
import { AppAccess, appGroupName } from "./access.js";
import type { AkBinding, AkGroup, AkUser } from "./authentik.js";
import { ADMIN_APP_SLUG } from "./bootstrap.js";

const ADMIN_PK = "g-admin";

/** Stateful fake authentik: groups, memberships, applications and bindings behave like the real thing. */
function harness(o: { apps?: string[]; users?: Array<Partial<AkUser> & { pk: number; groups?: string[] }> } = {}) {
  const calls: string[] = [];
  const state = new Map<string, unknown>();
  const groups = new Map<string, AkGroup>([["vibe-admin", { pk: ADMIN_PK, name: "vibe-admin", is_superuser: false }]]);
  const members = new Map<string, Set<number>>([[ADMIN_PK, new Set()]]);
  const apps = new Map((o.apps ?? ["tb"]).map((slug) => [slug, { pk: `app-${slug}`, slug, name: slug, provider: 1, meta_launch_url: "", group: "Vibe", policy_engine_mode: "any" as "any" | "all" }]));
  let bindings: AkBinding[] = [];
  let seq = 0;
  const people = (o.users ?? []).map((u) => ({ uuid: `u${u.pk}`, username: `user${u.pk}`, name: `User ${u.pk}`, email: `u${u.pk}@firm.test`, is_active: true, is_superuser: false, last_login: null, type: "internal", ...u }));
  for (const u of people) for (const g of u.groups ?? []) {
    if (!groups.has(g)) groups.set(g, { pk: `g-${g}`, name: g, is_superuser: false });
    const pk = groups.get(g)!.pk;
    members.set(pk, (members.get(pk) ?? new Set()).add(u.pk));
  }
  const view = (u: (typeof people)[number]): AkUser => {
    const mine = [...groups.values()].filter((g) => members.get(g.pk)?.has(u.pk));
    return { ...u, groups: mine.map((g) => g.pk), groups_obj: mine.map((g) => ({ pk: g.pk, name: g.name })) } as AkUser;
  };

  const ak = {
    groupByName: vi.fn(async (name: string) => groups.get(name) ?? null),
    createGroup: vi.fn(async (b: { name: string; is_superuser?: boolean; attributes?: Record<string, unknown> }) => {
      const g: AkGroup = { pk: `g-${b.name}`, name: b.name, is_superuser: false, attributes: b.attributes };
      groups.set(b.name, g);
      members.set(g.pk, new Set());
      calls.push(`createGroup:${b.name}`);
      return g;
    }),
    addUserToGroup: vi.fn(async (groupPk: string, userPk: number) => {
      members.get(groupPk)!.add(userPk);
      calls.push(`add:${groupPk}:${userPk}`);
    }),
    removeUserFromGroup: vi.fn(async (groupPk: string, userPk: number) => {
      members.get(groupPk)?.delete(userPk);
      calls.push(`remove:${groupPk}:${userPk}`);
    }),
    users: vi.fn(async (q: Record<string, unknown> = {}) => people.filter((u) => (q.is_active === undefined ? true : u.is_active === q.is_active)).map(view)),
    user: vi.fn(async (pk: number) => view(people.find((u) => u.pk === pk)!)),
    applicationBySlug: vi.fn(async (slug: string) => apps.get(slug) ?? null),
    patchApplication: vi.fn(async (slug: string, body: Record<string, unknown>) => {
      Object.assign(apps.get(slug)!, body);
      calls.push(`patchApp:${slug}`);
      return apps.get(slug)!;
    }),
    bindings: vi.fn(async (target: string) => bindings.filter((b) => b.target === target)),
    createGroupBinding: vi.fn(async (target: string, groupPk: string, order: number) => {
      const b: AkBinding = { pk: `b${++seq}`, target, group: groupPk, user: null, policy: null, enabled: true, order };
      bindings.push(b);
      calls.push(`bind:${target}:${groupPk}`);
      return b;
    }),
    deleteBinding: vi.fn(async (pk: string) => {
      bindings = bindings.filter((b) => b.pk !== pk);
      calls.push(`unbind:${pk}`);
    }),
  };
  const db = {
    getState: async (k: string) => (state.has(k) ? state.get(k) : null),
    setState: async (k: string, v: unknown) => void state.set(k, JSON.parse(JSON.stringify(v))),
    deleteState: async (k: string) => void state.delete(k),
    listState: async (prefix: string) => [...state.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
  };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const access = new AppAccess(ak as unknown as ConstructorParameters<typeof AppAccess>[0], db as unknown as ConstructorParameters<typeof AppAccess>[1], () => ({ groups: { "vibe-admin": ADMIN_PK } }), log);
  return {
    access,
    ak,
    calls,
    state,
    log,
    groups,
    members,
    bindings: () => bindings,
    setBindings: (b: AkBinding[]) => (bindings = b),
    deleteGroup: (name: string) => {
      const g = groups.get(name)!;
      groups.delete(name);
      bindings = bindings.filter((b) => b.group !== g.pk); // authentik cascades
    },
  };
}

const TB = { slug: "tb", edgeGate: false, displayName: "Trial Balance" };

describe("AppAccess", () => {
  it("leaves an open product alone: no group, no bindings", async () => {
    const h = harness();
    await h.access.sync(TB);
    expect(h.calls).toEqual([]);
    expect(await h.access.get("tb")).toEqual({ restricted: false });
    expect(await h.access.problems(TB)).toEqual([]);
  });

  it("restricting binds the product group and vibe-admin, and is idempotent", async () => {
    const h = harness();
    await h.access.set(TB, true, "kurt@firm.test");
    expect(h.groups.get("vibe-app-tb")?.attributes).toEqual({ "vibe.managed": true, "vibe.app": "tb" });
    expect(h.bindings().map((b) => [b.target, b.group])).toEqual([
      ["app-tb", ADMIN_PK],
      ["app-tb", "g-vibe-app-tb"],
    ]);
    expect(await h.access.get("tb")).toMatchObject({ restricted: true, updatedBy: "kurt@firm.test" });
    const before = h.calls.length;
    await h.access.sync(TB);
    await h.access.sync(TB);
    expect(h.calls.length).toBe(before);
    expect(await h.access.problems(TB)).toEqual([]);
  });

  it("puts the same bindings on the edge-gate application", async () => {
    const h = harness({ apps: ["tb", "tb-edge"] });
    await h.access.set({ ...TB, edgeGate: true }, true, "admin");
    expect(h.bindings().map((b) => b.target).sort()).toEqual(["app-tb", "app-tb", "app-tb-edge", "app-tb-edge"]);
  });

  it("seeds active people before any binding exists, skipping service accounts, inactive users and existing members", async () => {
    const h = harness({
      users: [
        { pk: 1 },
        { pk: 2, groups: ["vibe-app-tb"] },
        { pk: 3, is_active: false },
        { pk: 4, type: "service_account" },
        { pk: 5, type: "internal_service_account" },
      ],
    });
    const r = await h.access.set(TB, true, "admin", "everyone");
    expect(r.seeded).toBe(1);
    expect([...h.members.get("g-vibe-app-tb")!].sort()).toEqual([1, 2]);
    const firstBind = h.calls.findIndex((c) => c.startsWith("bind:"));
    const lastAdd = h.calls.map((c) => c.startsWith("add:")).lastIndexOf(true);
    expect(lastAdd).toBeGreaterThanOrEqual(0);
    expect(lastAdd).toBeLessThan(firstBind);
  });

  it("opening removes only the broker's bindings and keeps the group, its members and foreign bindings", async () => {
    const h = harness({ users: [{ pk: 1, groups: ["vibe-app-tb"] }] });
    await h.access.set(TB, true, "admin");
    const foreign: AkBinding = { pk: "x1", target: "app-tb", group: null, user: null, policy: "some-policy", enabled: true, order: 5 };
    h.setBindings([...h.bindings(), foreign]);
    await h.access.set(TB, false, "admin");
    expect(h.bindings()).toEqual([foreign]);
    expect(h.groups.has("vibe-app-tb")).toBe(true);
    expect([...h.members.get("g-vibe-app-tb")!]).toEqual([1]);
    expect(await h.access.problems(TB)).toEqual(["product is marked open but tb still has 1 access binding(s) in authentik"]);
  });

  it("never restricts the admin console", async () => {
    const h = harness({ apps: [ADMIN_APP_SLUG] });
    await expect(h.access.set({ slug: ADMIN_APP_SLUG, edgeGate: false }, true, "admin")).rejects.toThrow(/cannot be restricted/);
    h.state.set(`access:${ADMIN_APP_SLUG}`, { restricted: true }); // even if the flag were forced
    await h.access.sync({ slug: ADMIN_APP_SLUG, edgeGate: false });
    expect(h.bindings()).toEqual([]);
  });

  it("reports and repairs bindings deleted by hand (which would otherwise fail open)", async () => {
    const h = harness();
    await h.access.set(TB, true, "admin");
    h.setBindings([]);
    expect(await h.access.problems(TB)).toEqual(["access is restricted but tb has no binding for vibe-app-tb", "access is restricted but tb has no binding for vibe-admin"]);
    await h.access.sync(TB);
    expect(h.bindings()).toHaveLength(2);
    expect(await h.access.problems(TB)).toEqual([]);
  });

  it("recreates a hand-deleted access group, warns that memberships were lost, and replaces a disabled binding", async () => {
    const h = harness();
    await h.access.set(TB, true, "admin");
    h.deleteGroup("vibe-app-tb");
    expect((await h.access.problems(TB))[0]).toMatch(/group vibe-app-tb is missing/);
    expect((await h.access.sync(TB)).groupRecreated).toBe(true);
    expect(h.log.warn).toHaveBeenCalled();
    h.setBindings(h.bindings().map((b) => (b.group === ADMIN_PK ? { ...b, enabled: false } : b)));
    await h.access.sync(TB);
    expect(h.bindings().filter((b) => b.group === ADMIN_PK)).toEqual([expect.objectContaining({ enabled: true })]);
  });

  it("re-registration: a re-created application gets its bindings back from the surviving flag", async () => {
    const h = harness();
    await h.access.set(TB, true, "admin");
    h.setBindings([]); // authentik cascades bindings when the application is deleted
    await h.access.sync(TB); // Registrations.upsert → access.sync
    expect(h.bindings()).toHaveLength(2);
  });

  it("setUserApps diffs memberships and reports only restricted removals as revoked", async () => {
    const h = harness({ apps: ["tb", "payroll", "books"], users: [{ pk: 7, groups: ["vibe-app-tb", "vibe-app-payroll", "vibe-app-gone"] }] });
    await h.access.set(TB, true, "admin");
    const r = await h.access.setUserApps(7, ["books", "not-registered", ADMIN_APP_SLUG], ["tb", "payroll", "books", ADMIN_APP_SLUG]);
    expect(r).toEqual({ added: ["books"], removed: ["tb", "payroll"], revoked: ["tb"] });
    expect([...h.members.get("g-vibe-app-books")!]).toEqual([7]);
    expect(h.members.get("g-vibe-app-tb")!.has(7)).toBe(false);
    expect(h.members.get("g-vibe-app-gone")!.has(7)).toBe(true); // unregistered products are never touched
    expect(await h.access.setUserApps(7, ["books"], ["tb", "payroll", "books"])).toEqual({ added: [], removed: [], revoked: [] });
  });

  it("matrix lists people only, counts active members, flags admins and surfaces orphaned restrictions", async () => {
    const h = harness({
      apps: ["tb", "payroll", ADMIN_APP_SLUG],
      users: [
        { pk: 1, groups: ["vibe-app-tb"] },
        { pk: 2, groups: ["vibe-admin"] },
        { pk: 3, groups: ["vibe-app-tb"], is_active: false },
        { pk: 4, type: "service_account", groups: ["vibe-app-tb"] },
      ],
    });
    await h.access.set(TB, true, "admin");
    h.state.set("access:old-product", { restricted: true });
    h.state.set("access:opened-then-removed", { restricted: false });
    const m = await h.access.matrix([TB, { slug: "payroll", edgeGate: false, displayName: "Payroll" }, { slug: ADMIN_APP_SLUG, edgeGate: false }]);
    expect(m.apps).toEqual([
      { slug: "tb", displayName: "Trial Balance", restricted: true, registered: true, members: 1 },
      { slug: "payroll", displayName: "Payroll", restricted: false, registered: true, members: 0 },
      { slug: "old-product", displayName: "old-product", restricted: true, registered: false, members: 0 },
    ]);
    expect(m.users).toEqual([
      { pk: 1, apps: ["tb"], admin: false },
      { pk: 2, apps: [], admin: true },
      { pk: 3, apps: ["tb"], admin: false },
    ]);
    await h.access.forget("old-product");
    expect((await h.access.matrix([TB])).apps.map((a) => a.slug)).toEqual(["tb"]);
  });

  it("uses the group name helper consistently", () => {
    expect(appGroupName("trial-balance")).toBe("vibe-app-trial-balance");
  });
});
