// 离线自测：不需要运行中的 DSH。校验「等待时间表」「策略键」和
// 「agent/request-error 监听器状态机」三部分行为。
//   node tests/retry-settings.test.mjs
import assert from 'node:assert/strict';
import * as plugin from '../src/index.js';

const { Config, apply, parseCodes, resolveSettings, policyKeyOf, scheduleDelay, applyJitter, delayForRetry, priorRetryOf } = plugin;

/* ------------------------------------------------------------------ */
/* 测试替身                                                            */
/* ------------------------------------------------------------------ */

let uuidCounter = 0;

function fakeSession(id = 'session-1') {
  const events = [];
  return {
    id,
    events,
    snapshotEvents: () => events,
    append(type, data) {
      const event = { type, seq: events.length, time: Date.now(), data: JSON.parse(JSON.stringify(data)) };
      events.push(event);
      return event;
    },
    ofType: (type) => events.filter((event) => event.type === type),
  };
}

function fakeAgent(session) {
  return { session };
}

function fakeContext({ settings } = {}) {
  const hooks = [];
  const effects = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    on(event, listener) {
      hooks.push({ event, listener });
      return () => {};
    },
    inject(deps, callback) {
      // The injected fiber is a context too: it carries the service and effects.
      if (deps.includes('settings') && settings !== undefined) callback({ settings, effect: ctx.effect });
    },
    effect(factory) {
      const dispose = factory();
      effects.push(dispose);
      return dispose;
    },
    /** Dispatch the waterfall exactly like cordis: outermost listener first. */
    dispatch(payload, inner) {
      let nextCalls = 0;
      const chain = [...hooks.filter((hook) => hook.event === 'agent/request-error')];
      const next = () => {
        const hook = chain.shift();
        if (hook === undefined) { nextCalls += 1; return Promise.resolve(inner?.()); }
        return Promise.resolve(hook.listener(payload, next));
      };
      return { result: next(), nextCalls: () => nextCalls };
    },
    dispose() { for (const dispose of effects.splice(0)) void dispose?.(); },
  };
  return ctx;
}

/** cosmokit's volatile-reference write, reached by the shared registry symbol. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/**
 * The config DSH 0.1.7-rc.2 hands a plugin: `Config(...)` with every field
 * volatile, so the plugin reads it directly and a settings write rewrites the
 * running references in place — what the Loader's `_commitVolatile` does.
 * `set()` below is exactly that write, so "live 生效，不重启" stays under test.
 */
function fakeSettings(overrides = {}) {
  let config = Config({ ...overrides });
  const configured = [];
  return {
    configured,
    get config() { return config; },
    set(next) {
      const candidate = Config({ ...next });
      for (const [key, ref] of Object.entries(config)) {
        ref[VOLATILE_WRITE](candidate[key].get());
      }
      config = candidate;
    },
    service: {
      configure(policy, owner) {
        configured.push({ policy, owner });
        return () => {};
      },
    },
  };
}

const FAILURE = { message: 'rate limited', code: 'RATE_LIMIT', status: 429 };

function payloadOf(agent, overrides = {}) {
  return {
    agent,
    turn: 1,
    step: 1,
    provider: 'sensenova',
    failure: FAILURE,
    retryPolicy: undefined,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* 1. 等待时间表                                                       */
/* ------------------------------------------------------------------ */

{
  const fixed = resolveSettings({ initialDelaySeconds: 1, stepSeconds: 2, maxRetries: 4 });
  assert.equal(fixed.exponentialBackoff, false);
  assert.equal(fixed.stepMs, 2000);
  assert.deepEqual(
    [1, 2, 3, 4].map((retry) => scheduleDelay(fixed, retry)),
    [1000, 3000, 5000, 7000],
    '线性模式：初次 1s，每次 +2s',
  );

  const constant = resolveSettings({ initialDelaySeconds: 2, stepSeconds: 0 });
  assert.deepEqual(
    [1, 2, 3].map((retry) => scheduleDelay(constant, retry)),
    [2000, 2000, 2000],
    '每次增加 0 秒 = 每次等待一样长（用户要的「关闭逐次等待越来越长」）',
  );

  const exponential = resolveSettings({ initialDelaySeconds: 1, exponentialBackoff: true });
  assert.deepEqual(
    [1, 2, 3, 4].map((retry) => scheduleDelay(exponential, retry)),
    [1000, 2000, 4000, 8000],
    '指数模式：每次翻倍',
  );

  const capped = resolveSettings({ initialDelaySeconds: 1, exponentialBackoff: true, maxDelaySeconds: 5 });
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((retry) => scheduleDelay(capped, retry)),
    [1000, 2000, 4000, 5000, 5000],
    '上限封顶',
  );

  const big = resolveSettings({ initialDelaySeconds: 60, exponentialBackoff: true, maxDelaySeconds: 60 });
  assert.equal(scheduleDelay(big, 40), 60_000, '指数表不会溢出成 Infinity');

  // 抖动：0 = 严格；0.5 时用固定采样可预测
  assert.equal(applyJitter(1000, resolveSettings({ jitterRatio: 0 }), () => 0.999), 1000);
  assert.equal(applyJitter(1000, resolveSettings({ jitterRatio: 0.5 }), () => 0), 500);
  assert.equal(applyJitter(1000, resolveSettings({ jitterRatio: 0.5 }), () => 1), 1500);
  assert.equal(applyJitter(10_000, resolveSettings({ jitterRatio: 1, maxDelaySeconds: 10 }), () => 1), 10_000, '抖动不会超过上限');
}

/* ------------------------------------------------------------------ */
/* 2. Retry-After 与失败码解析                                          */
/* ------------------------------------------------------------------ */

{
  const policy = resolveSettings({ initialDelaySeconds: 1, maxDelaySeconds: 10 });
  assert.equal(delayForRetry(policy, { providerRetryAfterMs: 4000 }, 1, () => 0.5), 4000, '采纳服务端建议');
  assert.equal(delayForRetry(policy, { providerRetryAfterMs: 60_000 }, 1, () => 0.5), 1000, '超出上限则用本地等待');
  assert.equal(delayForRetry(policy, {}, 1, () => 0.5), 1000, '没有建议则用本地等待');

  const ignoring = resolveSettings({ respectProviderRetryAfter: false, initialDelaySeconds: 1 });
  assert.equal(delayForRetry(ignoring, { providerRetryAfterMs: 4000 }, 1, () => 0.5), 1000, '关掉后忽略建议');

  assert.deepEqual(parseCodes('A, B\nC  B'), ['A', 'B', 'C'], '去重 + 多种分隔符');
  assert.deepEqual(parseCodes('限流，超时 限流'), ['限流', '超时'], '中文分隔符');
  assert.deepEqual(parseCodes('   '), [], '空列表');
}

/* ------------------------------------------------------------------ */
/* 3. 策略键                                                            */
/* ------------------------------------------------------------------ */

{
  const base = resolveSettings({});
  assert.equal(policyKeyOf(base, 'normal'), policyKeyOf(resolveSettings({}), 'normal'), '同样设置 → 同样键');
  assert.notEqual(policyKeyOf(base, 'normal'), policyKeyOf(resolveSettings({ maxRetries: 6 }), 'normal'), '改次数 → 新链');
  assert.notEqual(policyKeyOf(base, 'normal'), policyKeyOf(resolveSettings({ stepSeconds: 1 }), 'normal'), '改增量 → 新链');
  assert.notEqual(policyKeyOf(base, 'normal'), policyKeyOf(resolveSettings({ retryableCodes: 'SERVER' }), 'normal'), '改失败码 → 新链');
  assert.ok(policyKeyOf(base, 'normal').length > 0 && !policyKeyOf(base, 'normal').includes('{'), '键是普通字符串');
  assert.equal(
    policyKeyOf(resolveSettings({ retryableCodes: 'SERVER, TIMEOUT' }), 'normal'),
    policyKeyOf(resolveSettings({ retryableCodes: 'TIMEOUT,SERVER' }), 'normal'),
    '失败码顺序不影响身份',
  );
}

/* ------------------------------------------------------------------ */
/* 4. 监听器状态机                                                      */
/* ------------------------------------------------------------------ */

{
  const settings = fakeSettings({ initialDelaySeconds: 0.05, stepSeconds: 0, maxRetries: 2, jitterRatio: 0 });
  const session = fakeSession();
  const agent = fakeAgent(session);
  const ctx = fakeContext({ settings: settings.service });
  apply(ctx, settings.config, { random: () => 0.5 });

  // 非可重试失败码 → 交给下游
  let dispatch = ctx.dispatch(payloadOf(agent, { failure: { message: 'overflow', code: 'CONTEXT_WINDOW_EXCEEDED' } }), () => 'downstream');
  assert.equal(await dispatch.result, 'downstream');
  assert.equal(dispatch.nextCalls(), 1, '不认识的失败码必须调用 next()');
  assert.equal(session.ofType('llm/retry').length, 0, '非可重试失败码不排定');

  // 第 1 次：排定重试
  dispatch = ctx.dispatch(payloadOf(agent), () => 'downstream');
  assert.deepEqual(await dispatch.result, { kind: 'retry' });
  assert.equal(dispatch.nextCalls(), 0, '自己处理时不越过下游（避免重复排定）');
  const scheduled = session.ofType('llm/retry');
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].data.retry, 1);
  assert.equal(scheduled[0].data.mode, 'normal');
  assert.equal(scheduled[0].data.maxRetries, 2);
  assert.equal(scheduled[0].data.delayMs, 50, '50ms = 初次等待 0.05s');
  assert.equal(scheduled[0].data.provider, 'sensenova');
  assert.equal(scheduled[0].data.failure.code, 'RATE_LIMIT');
  assert.equal(scheduled[0].data.turn, 1);
  assert.equal(scheduled[0].data.step, 1);
  assert.match(scheduled[0].data.policyKey, /^normal;/);
  assert.equal(session.ofType('llm/retry-started').length, 1, '等待结束后追加 started');

  // 第 2 次：沿用同一 retryId，编号递增
  await ctx.dispatch(payloadOf(agent), () => 'downstream').result;
  const retries = session.ofType('llm/retry');
  assert.equal(retries.length, 2);
  assert.equal(retries[1].data.retry, 2);
  assert.equal(retries[1].data.retryId, retries[0].data.retryId, '同一策略链沿用 retryId');
  assert.equal(retries[1].data.delayMs, 50, '每次增加 0 秒 → 等待不变');
  assert.equal(session.ofType('llm/retry-started').length, 2);

  // 第 3 次：额度用尽 → 交给下游（内置 llm-retry 自己也会判定额度用尽）
  dispatch = ctx.dispatch(payloadOf(agent), () => 'downstream');
  assert.equal(await dispatch.result, 'downstream');
  assert.equal(dispatch.nextCalls(), 1, '超过上限必须调用 next()');
  assert.equal(session.ofType('llm/retry').length, 2, '不再排定');

  // 换一步 → 重新计数
  await ctx.dispatch(payloadOf(agent, { step: 2 }), () => 'downstream').result;
  const stepTwo = session.ofType('llm/retry').filter((event) => event.data.step === 2);
  assert.equal(stepTwo.length, 1);
  assert.equal(stepTwo[0].data.retry, 1, '新步骤重新从 1 开始');
}

/* ------------------------------------------------------------------ */
/* 5. 取消                                                              */
/* ------------------------------------------------------------------ */

{
  const settings = fakeSettings({ maxRetries: 5, jitterRatio: 0 });
  const session = fakeSession();
  const agent = fakeAgent(session);
  const ctx = fakeContext({ settings: settings.service });
  apply(ctx, settings.config, { random: () => 0.5 });

  // 触发前已取消
  const pre = new AbortController();
  pre.abort();
  let dispatch = ctx.dispatch(payloadOf(agent, { signal: pre.signal }), () => 'downstream');
  assert.equal(await dispatch.result, undefined, '已取消则不排定');
  assert.equal(session.ofType('llm/retry').length, 0);

  // 等待途中取消：llm/retry 已落盘，llm/retry-started 不落盘，且不返回 retry
  const live = new AbortController();
  settings.set({ maxRetries: 5, initialDelaySeconds: 1000, jitterRatio: 0 });
  const pending = ctx.dispatch(payloadOf(agent, { signal: live.signal }), () => 'downstream');
  await new Promise((resolve) => setTimeout(resolve, 30));
  live.abort();
  assert.equal(await pending.result, undefined, '等待中被取消 → 不重试');
  assert.equal(session.ofType('llm/retry').length, 1, '排定先落盘');
  assert.equal(session.ofType('llm/retry-started').length, 0, '取消后不再追加 started');
}

/* ------------------------------------------------------------------ */
/* 6. 开关与实时改设置                                                  */
/* ------------------------------------------------------------------ */

{
  const settings = fakeSettings({ enabled: false });
  const session = fakeSession();
  const ctx = fakeContext({ settings: settings.service });
  apply(ctx, settings.config, { random: () => 0.5 });

  let dispatch = ctx.dispatch(payloadOf(fakeAgent(session)), () => 'downstream');
  assert.equal(await dispatch.result, 'downstream', 'enabled=false → 完全交回内置实现');
  assert.equal(session.ofType('llm/retry').length, 0);

  assert.equal(settings.configured.length, 1, '向宿主声明一次页面策略');
  assert.deepEqual(settings.configured[0].policy, { auto: false },
    'auto=false：本插件自带配置页，宿主不要再自动生成一个');

  settings.set({ enabled: true, maxRetries: 1, initialDelaySeconds: 0.05, jitterRatio: 0 });
  dispatch = ctx.dispatch(payloadOf(fakeAgent(session)), () => 'downstream');
  assert.deepEqual(await dispatch.result, { kind: 'retry' }, '打开后立即生效（live）');
  assert.equal(session.ofType('llm/retry').length, 1);
}

/* ------------------------------------------------------------------ */
/* 7. 内置实现仍可兜底（我们只处理自己认识的失败码）                      */
/* ------------------------------------------------------------------ */

{
  const settings = fakeSettings({ retryableCodes: 'SERVER', maxRetries: 5, jitterRatio: 0 });
  const session = fakeSession();
  const ctx = fakeContext({ settings: settings.service });
  apply(ctx, settings.config, { random: () => 0.5 });

  let downstream = 0;
  const dispatch = ctx.dispatch(payloadOf(fakeAgent(session)), () => { downstream += 1; return 'downstream'; });
  assert.equal(await dispatch.result, 'downstream');
  assert.equal(downstream, 1, 'RATE_LIMIT 不在自定义清单里 → 交回下游处理');
  assert.equal(session.ofType('llm/retry').length, 0);
}

/* ------------------------------------------------------------------ */
/* 8. 处置（dispose）后不再接管                                          */
/* ------------------------------------------------------------------ */

{
  const settings = fakeSettings({ maxRetries: 5, initialDelaySeconds: 1000, jitterRatio: 0 });
  const session = fakeSession();
  const ctx = fakeContext({ settings: settings.service });
  apply(ctx, settings.config, { random: () => 0.5 });

  const live = new AbortController();
  const pending = ctx.dispatch(payloadOf(fakeAgent(session), { signal: live.signal }), () => 'downstream');
  await new Promise((resolve) => setTimeout(resolve, 30));
  ctx.dispose();
  assert.equal(await pending.result, undefined, 'dispose 中断等待');
  const late = ctx.dispatch(payloadOf(fakeAgent(session)), () => 'downstream');
  assert.equal(await late.result, undefined, 'dispose 后不再排定');
}

/* ------------------------------------------------------------------ */
/* 9. 会话日志里没有 retry 事件时从 1 开始（priorRetryOf）                */
/* ------------------------------------------------------------------ */

{
  const session = fakeSession();
  assert.deepEqual(priorRetryOf(session, { turn: 1, step: 1, provider: 'p' }, 'k'), { retry: 0, retryId: undefined });
  session.append('llm/retry', { retryId: 'r1', turn: 1, step: 1, provider: 'p', policyKey: 'k', retry: 1, delayMs: 1, mode: 'normal', maxRetries: 5, failure: FAILURE });
  session.append('llm/retry', { retryId: 'r1', turn: 1, step: 1, provider: 'p', policyKey: 'k', retry: 2, delayMs: 1, mode: 'normal', maxRetries: 5, failure: FAILURE });
  session.append('llm/retry', { retryId: 'other', turn: 1, step: 1, provider: 'q', policyKey: 'k', retry: 9, delayMs: 1, mode: 'normal', maxRetries: 5, failure: FAILURE });
  assert.deepEqual(priorRetryOf(session, { turn: 1, step: 1, provider: 'p' }, 'k'), { retry: 2, retryId: 'r1' });
  assert.deepEqual(priorRetryOf(session, { turn: 1, step: 1, provider: 'q' }, 'k'), { retry: 9, retryId: 'other' });
  assert.deepEqual(priorRetryOf(session, { turn: 1, step: 1, provider: 'p' }, 'other-key'), { retry: 0, retryId: undefined });
}

console.log('dsh-plugin-llm-retry 离线自测全部通过 ✅');
