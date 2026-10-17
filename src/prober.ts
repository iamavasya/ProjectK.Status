// Where the checks run from. A cron trigger runs in whatever colo is idle — 34 of them in a day,
// Melbourne and Tokyo included — and from there the API in Poland is 1–1.3 s away and now and then
// not reachable within the timeout at all. Every outage the page showed on 16–17.10.2026 was one of
// those (Cloudflare analytics: 499, origin never answered, all from MEL, BNE, NRT), while people,
// who come in through Vienna and Warsaw, saw none. So the probes run in one Durable Object pinned
// near Eastern Europe, where the users are.

import { DurableObject } from "cloudflare:workers";
import { type CheckResult, probeAll, type Target, type Thresholds } from "./checks";
import type { Env } from "./env";

/** The one object's name; a fixed name means one object, created once and never moved. */
const NAME = "europe";

/** Created on its first call as near to this hint as Cloudflare can, and stays there. */
const LOCATION_HINT = "eeur";

export class Prober extends DurableObject<Env> {
  probe(targets: Target[], limits: Thresholds, pauseMs: number): Promise<CheckResult[]> {
    return probeAll(targets, limits, pauseMs);
  }
}

/** Probes from the pinned object; from here only if it cannot be reached, so the page keeps updating. */
export async function probeFromEurope(env: Env, targets: Target[], limits: Thresholds, pauseMs: number): Promise<CheckResult[]> {
  if (!env.PROBER) return probeAll(targets, limits, pauseMs);
  try {
    const stub = env.PROBER.get(env.PROBER.idFromName(NAME), { locationHint: LOCATION_HINT });
    return await stub.probe(targets, limits, pauseMs);
  } catch (e) {
    console.error("prober unreachable, probing from the cron's colo:", e);
    return probeAll(targets, limits, pauseMs);
  }
}
