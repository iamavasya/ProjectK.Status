// Health checks: the cron probes every target, retries a failure once, and folds the result into
// the current-state row plus the hour and day counters.

import { type Env, num } from "./env";
import { notify } from "./telegram";

export type State = "up" | "degraded" | "down";

export interface Target {
  id: string;
  name: string;
  url: string;
  /** "health" reads Lilejka's /health JSON ({ status: "ready", version }); "http" needs a 2xx. */
  kind: "health" | "http";
}

export interface CheckResult {
  target: string;
  state: State;
  /** The probe's round trip, network included. Null when nothing answered. */
  latencyMs: number | null;
  /** The API's own median time on real requests, from /health; null when it reports none. */
  serverMs: number | null;
  version: string | null;
  detail: string | null;
}

export interface Thresholds {
  slowMs: number;
  timeoutMs: number;
}

export const thresholds = (env: Env): Thresholds => ({ slowMs: num(env.SLOW_MS, 3000), timeoutMs: num(env.TIMEOUT_MS, 10000) });

/** What a non-ready /health answered, for the check detail. */
function describe(body: { status?: unknown } | null): string {
  if (body === null) return "не JSON";
  const status = body.status;
  if (typeof status === "string" || typeof status === "number" || typeof status === "boolean") return String(status);
  return status === undefined || status === null ? "без status" : JSON.stringify(status);
}

export async function probe(target: Target, limits: Thresholds, now: () => number = Date.now): Promise<CheckResult> {
  const started = now();
  const result = (state: State, latencyMs: number | null, detail: string | null, version: string | null = null, serverMs: number | null = null): CheckResult => ({
    target: target.id,
    state,
    latencyMs,
    serverMs,
    version,
    detail,
  });

  let res: Response;
  try {
    res = await fetch(target.url, {
      headers: { "User-Agent": "projectk-status/1 (+https://status.rostyslav-mukha.dev)", Accept: "application/json, text/html;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(limits.timeoutMs),
      cache: "no-store",
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return result("down", null, timedOut ? `немає відповіді за ${Math.round(limits.timeoutMs / 1000)} с` : "помилка мережі");
  }

  const latency = now() - started;
  if (!res.ok) {
    await res.body?.cancel();
    return result("down", latency, `HTTP ${res.status}`);
  }

  let version: string | null = null;
  let serverMs: number | null = null;
  if (target.kind === "health") {
    const body = (await res.json().catch(() => null)) as { status?: unknown; version?: unknown; api?: { p50Ms?: unknown } } | null;
    version = typeof body?.version === "string" ? body.version.slice(0, 40) : null;
    serverMs = typeof body?.api?.p50Ms === "number" && Number.isFinite(body.api.p50Ms) && body.api.p50Ms >= 0 ? body.api.p50Ms : null;
    if (body?.status !== "ready") return result("degraded", latency, `health: ${describe(body)}`.slice(0, 120), version, serverMs);
  } else {
    await res.body?.cancel();
  }

  if (latency > limits.slowMs) return result("degraded", latency, `повільно: ${latency} мс`, version, serverMs);
  return result("up", latency, null, version, serverMs);
}

const rank: Record<State, number> = { up: 0, degraded: 1, down: 2 };

/**
 * One retry after a short pause, keeping the better answer, so a single dropped connection does not
 * paint the day. A slow answer is retried too: the cron runs in whatever colo is idle, and its first
 * request opens a new connection to the origin from there — 4–7 s while the API itself spent under
 * 20 ms on it (App Insights, 16.10.2026).
 */
export async function check(target: Target, limits: Thresholds, pauseMs = 2000): Promise<CheckResult> {
  const first = await probe(target, limits);
  if (first.state === "up") return first;
  await new Promise((r) => setTimeout(r, pauseMs));
  const second = await probe(target, limits);
  return rank[second.state] <= rank[first.state] ? second : first;
}

export const hourOf = (ms: number) => Math.floor(ms / 3_600_000);
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface StateRow {
  target: string;
  state: State;
}

export function recordStatements(db: D1Database, r: CheckResult, at: number, previous: State | undefined): D1PreparedStatement[] {
  const degraded = r.state === "degraded" ? 1 : 0;
  const down = r.state === "down" ? 1 : 0;
  // Latency counts only when something answered; the average divides by checks − down.
  const latency = r.state === "down" ? 0 : (r.latencyMs ?? 0);
  // The server's time counts only when /health reported one; the average divides by server_checks.
  const server = r.serverMs ?? 0;
  const serverChecks = r.serverMs === null ? 0 : 1;
  const counters = (table: "target_hours" | "target_days", key: "hour" | "day", value: number | string) =>
    db
      .prepare(
        `INSERT INTO ${table} (target, ${key}, checks, degraded, down, latency_sum, server_sum, server_checks) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (target, ${key}) DO UPDATE SET checks = checks + 1, degraded = degraded + ?3, down = down + ?4, latency_sum = latency_sum + ?5,
           server_sum = server_sum + ?6, server_checks = server_checks + ?7`,
      )
      .bind(r.target, value, degraded, down, latency, server, serverChecks);

  const statements = [
    db
      .prepare(
        `INSERT INTO target_state (target, state, since, checked_at, latency_ms, version, detail, server_ms) VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (target) DO UPDATE SET
           since = CASE WHEN target_state.state = excluded.state THEN target_state.since ELSE excluded.since END,
           state = excluded.state, checked_at = excluded.checked_at, latency_ms = excluded.latency_ms,
           version = COALESCE(excluded.version, target_state.version), detail = excluded.detail, server_ms = excluded.server_ms`,
      )
      .bind(r.target, r.state, at, r.latencyMs, r.version, r.detail, r.serverMs),
    counters("target_hours", "hour", hourOf(at)),
    counters("target_days", "day", dayOf(at)),
  ];
  if (previous !== r.state) {
    statements.push(
      db.prepare("INSERT INTO target_events (target, at, state, previous, detail) VALUES (?, ?, ?, ?, ?)").bind(r.target, at, r.state, previous ?? null, r.detail),
    );
  }
  return statements;
}

/** Alerts only on what needs a human: falling down, and coming back from down. */
export function alertText(target: Target, r: CheckResult, previous: State | undefined): string | null {
  if (previous === undefined || previous === r.state) return null;
  if (r.state === "down") return `🔴 ${target.name} лежить: ${r.detail ?? "без деталей"}\n${target.url}`;
  if (previous === "down") return `🟢 ${target.name} знову відповідає${r.latencyMs !== null ? ` (${r.latencyMs} мс)` : ""}`;
  return null;
}

export async function runChecks(env: Env, at: number, pauseMs = 2000): Promise<CheckResult[]> {
  const targets = env.TARGETS ?? [];
  if (targets.length === 0) return [];
  const limits = thresholds(env);
  const { results: rows } = await env.DB.prepare("SELECT target, state FROM target_state").all<StateRow>();
  const previous = new Map(rows.map((row) => [row.target, row.state]));

  const results = await Promise.all(targets.map((t) => check(t, limits, pauseMs)));
  await env.DB.batch(results.flatMap((r) => recordStatements(env.DB, r, at, previous.get(r.target))));

  const alerts = targets.map((t, i) => alertText(t, results[i], previous.get(t.id))).filter((t): t is string => t !== null);
  if (alerts.length > 0) await notify(env, alerts.join("\n\n"));
  return results;
}
