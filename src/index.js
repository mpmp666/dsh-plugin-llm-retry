/**
 * dsh-plugin-llm-retry — user-configurable model-request retry policy for
 * DeepSeek Harness.
 *
 * The harness ships `@deepseek-ai/dsh-llm-retry`, which retries a failed model
 * request on the `agent/request-error` waterfall using the provider-owned
 * policy: bounded exponential backoff with jitter, and no settings page. This
 * plugin prepends its own listener on the same waterfall and owns the retry
 * instead, so the whole schedule — first wait, growth per attempt, cap, attempt
 * count, jitter, provider `Retry-After` — is editable in
 * 设置 → 插件 → 模型重试.
 *
 * Each retry it schedules is appended to the session log as the harness's own
 * `llm/retry` and `llm/retry-started` events, so the conversation UI shows the
 * scheduled attempt and its delay exactly as it does for the built-in executor.
 *
 * DSH 0.1.7-rc.2 note: a plugin entry's settings namespace is its profile entry
 * id and is described automatically from the entry's own `Config`; the service
 * has no `register()` any more. Editability comes from marking the fields
 * `volatile`, which also makes a settings write update the running values in
 * place (`loader/volatile-update`) instead of restarting the listener.
 */
import Schema from '@deepseek-ai/schemastery';

/** Cordis plugin identity (matches cordis.patch.yml). */
export const name = 'llm-retry-settings';
/** No required service: the listener runs on the agent's waterfall event. */
export const inject = [];

/**
 * Settings namespace the harness describes for this entry: the profile entry id
 * from cordis.patch.yml, which is the plugin's own name. The browser half must
 * ask for exactly this string.
 */
export const SETTINGS_NS = name;

/** Upper bound for one scheduled wait, mirroring the harness timer range. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Failure codes the bundled retry executor treats as transient by default.
 * Only used as this namespace's schema default; the field is editable.
 */
export const DEFAULT_RETRYABLE_CODES = 'EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT';

/**
 * Read one resolved config field. A `volatile()` field arrives as a reference
 * whose `.get()` yields the current value; a plain field is already the value.
 * @param {unknown} value - resolved config field.
 * @returns {unknown} the current plain value.
 */
function fieldValue(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
}

/**
 * Wrap a resolved config in a plain object whose fields read through to the
 * live values, so every `current.<field>` access sees the latest settings.
 * @param {Record<string, unknown>} config - the entry's resolved config.
 * @returns {Record<string, unknown>} a live, enumerable view of it.
 */
function liveConfig(config) {
  const view = {};
  for (const key of Object.keys(config ?? {})) {
    Object.defineProperty(view, key, {
      enumerable: true,
      configurable: true,
      get: () => fieldValue(config[key]),
    });
  }
  return view;
}

/** Deployment + user-editable configuration. Every field has a default. */
export const Config = Schema.object({
  /** 总开关：关掉则完全不接管重试，交回 DSH 自带的 llm-retry。 */
  enabled: Schema.boolean().default(true).volatile(),
  /** 逐步加长等待（指数退避）：开=每次翻倍，关=线性/固定等待。 */
  exponentialBackoff: Schema.boolean().default(false).volatile(),
  /** 每次增加多少秒（exponentialBackoff 关闭时生效；0 = 每次都等固定时长）。 */
  stepSeconds: Schema.number().min(0).max(3600).default(0).volatile(),
  /** 最多重试多少次（在首次请求之外）。 */
  maxRetries: Schema.number().step(1).min(0).max(1000).default(5).volatile(),
  /** 初次等待多少秒（也是固定/线性模式的基准）。 */
  initialDelaySeconds: Schema.number().min(0.05).max(3600).default(1).volatile(),
  /** 等待上限（秒）：指数或线性增长都不会超过它。 */
  maxDelaySeconds: Schema.number().min(0.05).max(3600).default(60).volatile(),
  /** 抖动比例 0–1：0 = 严格按设置等待，0.1 = 每次 ±10% 随机。 */
  jitterRatio: Schema.number().min(0).max(1).default(0).volatile(),
  /** 采纳服务端 Retry-After 建议（不超过等待上限时使用建议值）。 */
  respectProviderRetryAfter: Schema.boolean().default(true).volatile(),
  /** 可重试的失败码（逗号或空格分隔）。 */
  retryableCodes: Schema.string().role('textarea').default(DEFAULT_RETRYABLE_CODES).volatile(),
});

/* ------------------------------------------------------------------ */
/* Configuration resolution                                            */
/* ------------------------------------------------------------------ */

/** Split the editable code list into a de-duplicated array of codes. */
export function parseCodes(value) {
  const parts = String(value ?? '')
    .split(/[\s,，;；]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return [...new Set(parts)];
}

/**
 * Resolve one settings value into the numbers the schedule uses. Values are
 * clamped rather than rejected: the settings schema already bounds them, and a
 * hand-edited document must not be able to stop the turn from recovering.
 * @param value - the resolved settings section.
 * @returns the resolved policy, in milliseconds, with an explicit applicability flag.
 */
export function resolveSettings(value) {
  const source = value === undefined || value === null ? {} : value;
  const codeList = parseCodes(source.retryableCodes === undefined
    ? DEFAULT_RETRYABLE_CODES
    : source.retryableCodes);
  const exponentialBackoff = source.exponentialBackoff === true;
  const maxRetries = clampInteger(source.maxRetries, 5, 0, 1000);
  // A wait is clamped to 50 ms so a hand-edited document cannot turn the retry
  // path into a request flood; an increment may legitimately be zero.
  const seconds = (raw, fallback) => clampNumber(Math.round(Number(raw) * 1000), fallback * 1000, 50, MAX_TIMER_DELAY_MS);
  const stepSeconds = (raw, fallback) => clampNumber(Math.round(Number(raw) * 1000), fallback * 1000, 0, MAX_TIMER_DELAY_MS);
  const initialDelayMs = seconds(source.initialDelaySeconds ?? 1, 1);
  const maxDelayMs = Math.max(seconds(source.maxDelaySeconds ?? 60, 60), initialDelayMs);
  return Object.freeze({
    enabled: source.enabled !== false,
    exponentialBackoff,
    stepMs: exponentialBackoff ? 0 : stepSeconds(source.stepSeconds ?? 0, 0),
    maxRetries,
    initialDelayMs,
    maxDelayMs,
    jitterRatio: clampNumber(Number(source.jitterRatio), 0, 0, 1),
    respectProviderRetryAfter: source.respectProviderRetryAfter !== false,
    codes: Object.freeze(codeList),
  });
}

/**
 * Clamp a candidate to a finite number inside a range.
 * @param value - candidate number (already coerced).
 * @param fallback - value used when the candidate is not a finite number.
 * @param min - inclusive lower bound; defaults to zero.
 * @param max - inclusive upper bound; defaults to the harness timer range.
 * @returns the bounded finite number.
 */
export function clampNumber(value, fallback, min = 0, max = MAX_TIMER_DELAY_MS) {
  const base = Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(base, min), max);
}

/**
 * Clamp a candidate to an integer inside a range.
 * @param value - candidate value.
 * @param fallback - value used when the candidate is not a finite number.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns the bounded integer.
 */
export function clampInteger(value, fallback, min, max) {
  return Math.round(clampNumber(Number(value), fallback, min, max));
}

/**
 * Stable identity of one retry chain: the failure routing plus every behavior
 * field of the schedule. Appended retry events carry it, and the session format
 * gates the attempt number on it, so changing any of these starts a new chain
 * instead of continuing the previous one — the same rule the bundled executor
 * follows. Deliberately plain concatenation rather than JSON: the keys are
 * compared for equality only.
 * @param policy - resolved settings.
 * @param mode - retry mode reported on the event (`normal`).
 * @returns an opaque policy key safe for the session log.
 */
export function policyKeyOf(policy, mode) {
  return [
    mode,
    `maxRetries=${String(policy.maxRetries)}`,
    `codes=${[...policy.codes].sort().join('|')}`,
    `initialDelayMs=${String(policy.initialDelayMs)}`,
    `maxDelayMs=${String(policy.maxDelayMs)}`,
    `jitterRatio=${String(policy.jitterRatio)}`,
    `stepMs=${String(policy.stepMs)}`,
  ].join(';');
}

/* ------------------------------------------------------------------ */
/* Schedule                                                            */
/* ------------------------------------------------------------------ */

/** Upper bound on the exponential table index; keeps `2 ** n` finite. */
const MAX_EXPONENT = 30;

/**
 * Local wait before retry number `retry` (1-based), before jitter.
 * @param policy - resolved settings.
 * @param retry - 1-based retry number.
 * @returns milliseconds, capped at the configured maximum.
 */
export function scheduleDelay(policy, retry) {
  const step = Math.max(retry - 1, 0);
  const grown = policy.exponentialBackoff
    ? policy.initialDelayMs * 2 ** Math.min(step, MAX_EXPONENT)
    : policy.initialDelayMs + policy.stepMs * step;
  return Math.min(grown, policy.maxDelayMs);
}

/**
 * Apply symmetric jitter and re-apply the cap, so the reported delay is exactly
 * what the plugin waits.
 * @param scheduleMs - uncapped local delay.
 * @param policy - resolved settings (its `jitterRatio` and `maxDelayMs` apply).
 * @param random - sample in the inclusive 0–1 range; injected for tests.
 * @returns the final delay in milliseconds.
 */
export function applyJitter(scheduleMs, policy, random) {
  const factor = 1 - policy.jitterRatio + 2 * policy.jitterRatio * random();
  return Math.round(Math.min(scheduleMs * factor, policy.maxDelayMs));
}

/**
 * Decide the wait for one retry: the provider's own `Retry-After` when it is
 * offered, honored, and inside the cap, otherwise the local schedule.
 * @param policy - resolved settings.
 * @param failure - the failed request's facts.
 * @param retry - 1-based retry number.
 * @param random - jitter sample source.
 * @returns the delay in milliseconds.
 */
export function delayForRetry(policy, failure, retry, random) {
  const suggested = failure?.providerRetryAfterMs;
  if (policy.respectProviderRetryAfter
    && Number.isFinite(suggested)
    && suggested > 0
    && suggested <= policy.maxDelayMs) {
    return Math.max(Math.round(suggested), 1);
  }
  return Math.max(applyJitter(scheduleDelay(policy, retry), policy, random), 1);
}

/* ------------------------------------------------------------------ */
/* Durable retry history                                               */
/* ------------------------------------------------------------------ */

/**
 * Find the retry event that owns this step's chain for one provider route and
 * policy. Read from the session log rather than process memory, so the attempt
 * number has exactly one authority across reloads and resumed sessions.
 * @param session - the live session.
 * @param coordinates - turn, step, and provider of the failure.
 * @param policyKey - the chain's policy key.
 * @returns the remembered attempt number and chain id.
 */
export function priorRetryOf(session, coordinates, policyKey) {
  const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'llm/retry') continue;
    const data = event.data;
    if (data === undefined || data === null) continue;
    if (data.turn !== coordinates.turn
      || data.step !== coordinates.step
      || data.provider !== coordinates.provider
      || data.policyKey !== policyKey) continue;
    return {
      retry: Number.isSafeInteger(data.retry) && data.retry > 0 ? data.retry : 0,
      retryId: typeof data.retryId === 'string' && data.retryId !== '' ? data.retryId : undefined,
    };
  }
  return { retry: 0, retryId: undefined };
}

/**
 * Wait, abortably. Resolves false when the signal fires first, so cancellation
 * never leaves a scheduled attempt behind.
 * @param delayMs - milliseconds to wait.
 * @param signal - cancellation.
 * @returns true when the wait completed, false when it was aborted.
 */
function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Retry action the agent loop understands: re-run the failed step. */
const RETRY_ACTION = Object.freeze({ kind: 'retry' });

/* ------------------------------------------------------------------ */
/* Plugin entry                                                        */
/* ------------------------------------------------------------------ */

/**
 * Mount the configurable retry schedule.
 * @param ctx - plugin context owning the listener, its lifetime, and the settings namespace.
 * @param config - composition-layer settings seed (the user layer overrides it).
 * @param internals - non-serializable test hooks.
 */
export function apply(ctx, config = {}, internals = {}) {
  const random = internals.random ?? Math.random;
  const lifetime = new AbortController();
  const active = new Set();

  // Live configuration: every field is a volatile reference the settings page
  // writes in place, so `current` always reads the accepted values and a change
  // never restarts this listener.
  const current = liveConfig(config);
  ctx.inject(['settings'], (scoped) => {
    // This plugin ships its own page (client/client.js), so no auto-generated one.
    scoped.effect(() => scoped.settings.configure({ auto: false }, ctx.fiber), 'llm-retry-settings: 自带配置页');
  });

  /** Collect an in-flight recovery so disposal can drain it. */
  function track(operation) {
    const tracked = operation.finally(() => active.delete(tracked));
    active.add(tracked);
    return tracked;
  }

  /**
   * Schedule one retry, or leave the failure to the rest of the chain.
   * Prepend registration makes this the outermost listener, so a decision here
   * is final and the bundled executor never double-schedules the same failure.
   */
  async function recover(payload, next) {
    if (lifetime.signal.aborted) return undefined;
    const { agent, turn, step, provider, failure, signal } = payload;
    const policy = resolveSettings(current);
    if (!policy.enabled || policy.codes.length === 0) return next();
    // Only this plugin's eligible codes; anything else (context overflow and
    // every other recovery policy) belongs to the downstream chain.
    if (!policy.codes.includes(failure.code)) return next();

    const mode = 'normal';
    const policyKey = policyKeyOf(policy, mode);
    const prior = priorRetryOf(agent.session, { turn, step, provider }, policyKey);
    if (prior.retry >= policy.maxRetries) return next();

    const retry = prior.retry + 1;
    const retryId = prior.retryId ?? (globalThis.crypto?.randomUUID?.() ?? `retry-${Date.now()}-${Math.random()}`);
    const delayMs = delayForRetry(policy, failure, retry, random);

    const fusedSignal = AbortSignal.any([signal, lifetime.signal]);
    if (fusedSignal.aborted) return undefined;

    // Durable before the wait: a cancelled or crashed turn still shows the
    // scheduled attempt, and the attempt number has one authority.
    agent.session.append('llm/retry', {
      retryId, turn, step, provider, mode, policyKey, retry,
      maxRetries: policy.maxRetries, delayMs, failure,
    });
    if (ctx.logger !== undefined) {
      ctx.logger.info(
        'llm-retry: scheduling retry %d/%d for provider "%s" (%s) in %d ms',
        retry, policy.maxRetries, provider, failure.code, delayMs,
      );
    }
    if (!await cancellableDelay(delayMs, fusedSignal)) return undefined;
    if (fusedSignal.aborted) return undefined;
    agent.session.append('llm/retry-started', { retryId, turn, step, retry });
    return RETRY_ACTION;
  }

  // Prepend: a listener registered earlier would wrap this one and could spend
  // the attempt itself, so this policy must be the outermost.
  ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined);
    return track((async () => {
      try {
        return await recover(payload, next);
      } catch (error) {
        // Delegating after a partial schedule would schedule the same failure
        // twice, so a failure here ends the recovery path instead.
        if (ctx.logger !== undefined) {
          ctx.logger.warn('llm-retry: retry scheduling failed: %o', error);
        }
        return undefined;
      }
    })());
  }, { prepend: true });

  ctx.effect(() => async () => {
    lifetime.abort(new Error('llm-retry settings plugin disposed'));
    await Promise.allSettled([...active]);
  }, 'llm-retry-settings: abort and drain active recovery');
}
