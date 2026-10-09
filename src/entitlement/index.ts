import type { Identity } from "../auth/index.js";
import type { GatewayConfig, PlanConfig } from "../config.js";
import { forbidden } from "../edge/errors.js";

/** What a resolved identity may do against one upstream. */
export interface Grant {
  plan: string;
  upstream: string;
  tools: ReadonlySet<string>;
  /** Prompts this caller may list and get. Empty when the upstream has no prompts_allow. */
  prompts: ReadonlySet<string>;
  /** True when the upstream has a prompts_allow list, so prompts/* is routed at all. */
  promptsRouted: boolean;
  /**
   * Resource URI prefixes this caller may list and read. A resource is allowed when its URI starts
   * with any prefix. Empty when the upstream has no resources_allow.
   */
  resources: readonly string[];
  /** True when the upstream has a resources_allow list, so resources/* is routed at all. */
  resourcesRouted: boolean;
  rpm: number;
}

/** True when `uri` starts with any of the allowed prefixes. Plain string prefix match. */
export function resourceAllowed(prefixes: readonly string[], uri: string): boolean {
  return prefixes.some((prefix) => uri.startsWith(prefix));
}

/**
 * Entitlement map: identity -> plan -> allowed upstreams and tools.
 *
 * The plan comes from the token (JWT claim, or static token entry). The map of plans is static
 * config. Unknown plans, upstreams not on the plan, and tools, prompts or resources not on the
 * upstream's allow list are all denied with an explicit reason. Prompts and resources are deny by
 * default: an upstream without prompts_allow or resources_allow grants none.
 */
export class EntitlementMap {
  private readonly plans: Record<string, PlanConfig>;
  private readonly upstreams: GatewayConfig["upstreams"];

  constructor(config: Pick<GatewayConfig, "entitlements" | "upstreams">) {
    this.plans = config.entitlements;
    this.upstreams = config.upstreams;
  }

  resolvePlan(identity: Identity): PlanConfig & { name: string } {
    if (!identity.plan) throw forbidden("no plan on this identity", { subject: identity.subject });
    const plan = this.plans[identity.plan];
    if (!plan) throw forbidden(`plan "${identity.plan}" is not recognised`, { plan: identity.plan });
    return { ...plan, name: identity.plan };
  }

  /** Grant for one upstream, or throw. */
  grant(identity: Identity, upstreamName: string): Grant {
    const plan = this.resolvePlan(identity);
    const upstream = this.upstreams[upstreamName];
    if (!upstream) throw forbidden(`upstream "${upstreamName}" is not configured`, { upstream: upstreamName });
    if (!plan.upstreams.includes(upstreamName)) {
      throw forbidden(`plan "${plan.name}" does not include upstream "${upstreamName}"`, {
        plan: plan.name,
        upstream: upstreamName,
      });
    }
    const narrowed = plan.tools?.[upstreamName];
    const tools = new Set(narrowed ?? upstream.tools_allow);
    const promptsRouted = upstream.prompts_allow !== undefined;
    const prompts = new Set(promptsRouted ? (plan.prompts?.[upstreamName] ?? upstream.prompts_allow) : []);
    const resourcesRouted = upstream.resources_allow !== undefined;
    const resources = resourcesRouted ? [...(plan.resources?.[upstreamName] ?? upstream.resources_allow ?? [])] : [];
    return { plan: plan.name, upstream: upstreamName, tools, prompts, promptsRouted, resources, resourcesRouted, rpm: plan.rpm };
  }

  /** Throw if `tool` is outside the grant. */
  assertTool(grant: Grant, tool: string): void {
    if (!grant.tools.has(tool)) {
      throw forbidden(`tool "${tool}" is not available on plan "${grant.plan}" for upstream "${grant.upstream}"`, {
        plan: grant.plan,
        upstream: grant.upstream,
        tool,
      });
    }
  }

  /** Throw if `prompt` is outside the grant. Same error shape as an un-granted tool. */
  assertPrompt(grant: Grant, prompt: string): void {
    if (!grant.prompts.has(prompt)) {
      throw forbidden(`prompt "${prompt}" is not available on plan "${grant.plan}" for upstream "${grant.upstream}"`, {
        plan: grant.plan,
        upstream: grant.upstream,
        prompt,
      });
    }
  }

  /** Throw if `uri` is outside every granted prefix. Same error shape as an un-granted tool. */
  assertResource(grant: Grant, uri: string): void {
    if (!resourceAllowed(grant.resources, uri)) {
      throw forbidden(`resource "${uri}" is not available on plan "${grant.plan}" for upstream "${grant.upstream}"`, {
        plan: grant.plan,
        upstream: grant.upstream,
        resource: uri,
      });
    }
  }
}
