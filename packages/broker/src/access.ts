import type { Authentik, AkBinding, AkGroup, AkUser } from "./authentik.js";
import type { BootstrapResult } from "./bootstrap.js";
import { ADMIN_APP_SLUG } from "./bootstrap.js";
import type { Db } from "./db.js";
import type { Logger } from "./log.js";

/**
 * Which products a user may sign in to. A product is open to every firm user
 * until an administrator marks it *restricted* (D11: nothing changes until the
 * firm opts in). Enforcement is authentik's own: a restricted product's
 * application gets two group policy bindings — `vibe-app-<slug>` (the people
 * picked in the admin console) and `vibe-admin` (so administrators can never be
 * locked out; the policy engine has no superuser bypass). An application with
 * zero bindings admits everyone, so "open" simply means "no bindings".
 *
 * Membership lives only in authentik. The restricted flag lives in
 * vibe_broker_state under "access:<slug>", which Registrations.remove() never
 * touches: disabling and re-registering a product cannot silently reopen it.
 *
 * Limits (documented for firms): this gates single sign-on. In `both` mode a
 * user who still has a local product password can sign in locally (D6).
 */

export const ACCESS_PREFIX = "access:";
export const ADMIN_GROUP = "vibe-admin";
export const appGroupName = (slug: string) => `vibe-app-${slug}`;

export interface AccessState {
  restricted: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

export interface AccessTarget {
  slug: string;
  edgeGate: boolean;
  displayName?: string;
}

export interface AccessMatrix {
  apps: Array<{ slug: string; displayName: string; restricted: boolean; registered: boolean; members: number }>;
  users: Array<{ pk: number; apps: string[]; admin: boolean }>;
}

type Store = Pick<Db, "getState" | "setState" | "deleteState" | "listState">;
type Ak = Pick<Authentik, "groupByName" | "createGroup" | "addUserToGroup" | "removeUserFromGroup" | "users" | "user" | "applicationBySlug" | "patchApplication" | "bindings" | "createGroupBinding" | "deleteBinding">;

const isPerson = (u: AkUser) => u.type !== "service_account" && u.type !== "internal_service_account";

export class AppAccess {
  constructor(
    private ak: Ak,
    private db: Store,
    private boot: () => Pick<BootstrapResult, "groups">,
    private log: Logger,
  ) {}

  async get(slug: string): Promise<AccessState> {
    return (await this.db.getState<AccessState>(ACCESS_PREFIX + slug)) ?? { restricted: false };
  }

  private adminGroupPk(): string {
    const pk = this.boot().groups[ADMIN_GROUP];
    if (!pk) throw new Error(`${ADMIN_GROUP} group missing; refusing to restrict a product without lockout protection`);
    return pk;
  }

  private async ensureGroup(slug: string): Promise<{ group: AkGroup; created: boolean }> {
    const name = appGroupName(slug);
    const found = await this.ak.groupByName(name);
    if (found) return { group: found, created: false };
    return { group: await this.ak.createGroup({ name, is_superuser: false, attributes: { "vibe.managed": true, "vibe.app": slug } }), created: true };
  }

  /** Bindings the broker owns: a plain group binding for the product's access group or vibe-admin. Anything else is left alone. */
  private owned(bindings: AkBinding[], groupPks: Array<string | undefined>): AkBinding[] {
    const mine = new Set(groupPks.filter((x): x is string => !!x));
    return bindings.filter((b) => !b.policy && b.user == null && !!b.group && mine.has(b.group));
  }

  /**
   * Flip a product between open and restricted. When restricting, the group is created and
   * (optionally) seeded BEFORE the bindings exist, so nobody is denied half-way through.
   */
  async set(target: AccessTarget, restricted: boolean, actor: string, seed: "everyone" | "none" = "none"): Promise<{ seeded: number }> {
    if (target.slug === ADMIN_APP_SLUG) throw new Error("the admin console cannot be restricted; it already admits only vibe-admin and vibe-it");
    let seeded = 0;
    if (restricted) {
      this.adminGroupPk();
      const { group } = await this.ensureGroup(target.slug);
      if (seed === "everyone") {
        const name = appGroupName(target.slug);
        for (const u of await this.ak.users({ is_active: true })) {
          if (!isPerson(u) || (u.groups_obj ?? []).some((g) => g.name === name)) continue;
          await this.ak.addUserToGroup(group.pk, u.pk);
          seeded++;
        }
      }
    }
    await this.db.setState(ACCESS_PREFIX + target.slug, { restricted, updatedAt: new Date().toISOString(), updatedBy: actor } satisfies AccessState);
    await this.sync(target);
    return { seeded };
  }

  /** Forget a product that is no longer registered (the access group and its members are kept in authentik). */
  async forget(slug: string): Promise<void> {
    await this.db.deleteState(ACCESS_PREFIX + slug);
  }

  /**
   * Idempotent: make authentik match the stored flag. Called on every (re-)registration —
   * a re-created application has a new pk and therefore no bindings — and for every
   * registration at broker start, because deleting both bindings by hand fails open.
   */
  async sync(target: AccessTarget): Promise<{ groupRecreated: boolean }> {
    if (target.slug === ADMIN_APP_SLUG) return { groupRecreated: false };
    const state = await this.get(target.slug);
    const appSlugs = [target.slug, ...(target.edgeGate ? [`${target.slug}-edge`] : [])];

    if (!state.restricted) {
      const group = await this.ak.groupByName(appGroupName(target.slug));
      for (const appSlug of appSlugs) {
        const app = await this.ak.applicationBySlug(appSlug);
        if (!app) continue;
        for (const b of this.owned(await this.ak.bindings(app.pk), [group?.pk, this.boot().groups[ADMIN_GROUP]])) await this.ak.deleteBinding(b.pk);
      }
      return { groupRecreated: false };
    }

    const adminPk = this.adminGroupPk();
    const { group, created } = await this.ensureGroup(target.slug);
    if (created) this.log.warn("access group was missing for a restricted product and has been recreated empty; re-tick its users", { slug: target.slug, group: group.name });
    for (const appSlug of appSlugs) {
      const app = await this.ak.applicationBySlug(appSlug);
      if (!app) continue;
      if (app.policy_engine_mode !== "any") await this.ak.patchApplication(appSlug, { policy_engine_mode: "any" });
      const have = await this.ak.bindings(app.pk);
      const want: Array<[string, number]> = [
        [adminPk, 0],
        [group.pk, 10],
      ];
      for (const [groupPk, order] of want) {
        const mine = this.owned(have, [groupPk]);
        if (mine.some((b) => b.enabled)) continue;
        for (const b of mine) await this.ak.deleteBinding(b.pk); // disabled by hand: replace rather than guess
        await this.ak.createGroupBinding(app.pk, groupPk, order);
      }
    }
    return { groupRecreated: created };
  }

  /** Read-only drift report for Registrations.verify(). */
  async problems(target: AccessTarget): Promise<string[]> {
    if (target.slug === ADMIN_APP_SLUG) return [];
    const out: string[] = [];
    const state = await this.get(target.slug);
    const group = await this.ak.groupByName(appGroupName(target.slug));
    const adminPk = this.boot().groups[ADMIN_GROUP];
    if (state.restricted && !group) out.push(`access is restricted but group ${appGroupName(target.slug)} is missing in authentik (memberships lost; re-register to recreate it)`);
    for (const appSlug of [target.slug, ...(target.edgeGate ? [`${target.slug}-edge`] : [])]) {
      const app = await this.ak.applicationBySlug(appSlug);
      if (!app) continue;
      const bindings = await this.ak.bindings(app.pk);
      if (state.restricted) {
        const enabled = (pk?: string) => this.owned(bindings, [pk]).some((b) => b.enabled);
        if (group && !enabled(group.pk)) out.push(`access is restricted but ${appSlug} has no binding for ${group.name}`);
        if (!enabled(adminPk)) out.push(`access is restricted but ${appSlug} has no binding for ${ADMIN_GROUP}`);
        if (app.policy_engine_mode && app.policy_engine_mode !== "any") out.push(`${appSlug} policy engine mode is "${app.policy_engine_mode}", expected "any"`);
      } else if (bindings.length) out.push(`product is marked open but ${appSlug} still has ${bindings.length} access binding(s) in authentik`);
    }
    return out;
  }

  /**
   * Set exactly which products a user is ticked for (among `registered`). `revoked` lists the
   * restricted products they lost, i.e. the removals that actually change what they can reach.
   */
  async setUserApps(userPk: number, apps: string[], registered: string[]): Promise<{ added: string[]; removed: string[]; revoked: string[] }> {
    const slugs = registered.filter((s) => s !== ADMIN_APP_SLUG);
    const want = new Set(apps.filter((s) => slugs.includes(s)));
    const user = await this.ak.user(userPk);
    const have = new Set((user.groups_obj ?? []).map((g) => g.name));
    const added: string[] = [];
    const removed: string[] = [];
    const revoked: string[] = [];
    for (const slug of slugs) {
      const name = appGroupName(slug);
      if (want.has(slug) && !have.has(name)) {
        const { group } = await this.ensureGroup(slug);
        await this.ak.addUserToGroup(group.pk, userPk);
        added.push(slug);
      } else if (!want.has(slug) && have.has(name)) {
        const group = await this.ak.groupByName(name);
        if (group) await this.ak.removeUserFromGroup(group.pk, userPk);
        removed.push(slug);
        if ((await this.get(slug)).restricted) revoked.push(slug);
      }
    }
    return { added, removed, revoked };
  }

  /** Everything the admin console needs, from one users call. Restricted-but-unregistered products show as orphans. */
  async matrix(registered: AccessTarget[]): Promise<AccessMatrix> {
    const regs = registered.filter((r) => r.slug !== ADMIN_APP_SLUG);
    const people = (await this.ak.users({})).filter(isPerson);
    const names = (u: AkUser) => new Set((u.groups_obj ?? []).map((g) => g.name));
    const members = (slug: string) => people.filter((u) => u.is_active && names(u).has(appGroupName(slug))).length;
    const apps: AccessMatrix["apps"] = [];
    for (const r of regs) apps.push({ slug: r.slug, displayName: r.displayName ?? r.slug, restricted: (await this.get(r.slug)).restricted, registered: true, members: members(r.slug) });
    for (const { key, value } of await this.db.listState<AccessState>(ACCESS_PREFIX)) {
      const slug = key.slice(ACCESS_PREFIX.length);
      if (value?.restricted && slug !== ADMIN_APP_SLUG && !regs.some((r) => r.slug === slug)) apps.push({ slug, displayName: slug, restricted: true, registered: false, members: members(slug) });
    }
    const known = apps.map((a) => a.slug);
    const users = people.map((u) => {
      const n = names(u);
      return { pk: u.pk, apps: known.filter((s) => n.has(appGroupName(s))), admin: n.has(ADMIN_GROUP) };
    });
    return { apps, users };
  }
}
