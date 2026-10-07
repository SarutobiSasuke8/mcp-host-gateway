import type { Identity } from "../auth/index.js";
import type { GatewayConfig, PlanConfig } from "../config.js";
import { forbidden } from "../edge/errors.js";

/** What a resolved identity may do against one upstream. */
export interface Grant {
  plan: string;
  upstream: string;
  tools: ReadonlySet<string>;
  rpm: number;
}

/**
 * Entitlement map: identity -> plan -> allowed upstreams and tools.
 *
 * The plan comes from the token (JWT claim, or static token entry). The map of plans is static
 * config in v0. Unknown plans, upstreams not on the plan, and tools not on the upstream's allow
 * list are all denied with an explicit reason.
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
    return { plan: plan.name, upstream: upstreamName, tools, rpm: plan.rpm };
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
}
