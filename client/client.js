/**
 * dsh-plugin-llm-retry — settings half: the 模型重试 card.
 *
 * Reachable from 设置 → 插件 → 模型重试 (a `settings.plugins.tab`) and from the
 * sidebar 插件 panel (a `plugins.item` card); both render the same form over the
 * `llm-retry-settings` settings namespace.
 *
 * Hand-written against the host's module loader (no build step): reads ride the
 * shared describe mirror; writes go through the form's set/unset, so the Host
 * stays the only authority on what was accepted.
 *
 * 0.1.7-rc.2 把插件配置页从 Settings 的 `settings.plugin.item` 迁到了
 * `settings.plugins.tab` / `plugins.item`，并用 `configForms` 取代了
 * `settingsScope`；同时命名空间改成 profile 入口 id（本插件即 `llm-retry-settings`），
 * 配置存在 profile 的 cordis.patch.yml 而不是 settings.yaml。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-llm-retry/client',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    // 宿主为该 profile 入口（cordis.patch.yml 的 id）描述的设置命名空间；必须与
    // src/index.js 的 name / SETTINGS_NS 相同。
    const NS = 'llm-retry-settings';
    const name = 'dsh-plugin-llm-retry-client';
    /** 卡片在列表页显示的一行说明。 */
    const SUMMARY = '模型请求失败（限流、超时、服务端错误…）后自动重试：初次等待、每次增长、等待上限、重试次数、抖动与可重试失败码都在这里改。';
    // cordis 服务名（fiber inject）；包级加载依赖声明在 package.json 的 dsh.client.inject。
    const inject = ['slots', 'configForms'];

    /** Inline styles only: the card is hand-written and ships no stylesheet. */
    const styles = {
      card: {
        border: '0.5px solid var(--dsw-alias-border-l2, #d0d0d0)',
        borderRadius: '12px',
        padding: '14px 16px',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: '13px',
        lineHeight: '1.6',
      },
      head: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' },
      title: { fontWeight: 600, fontSize: '14px' },
      badge: { fontSize: '11px', opacity: 0.65 },
      grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: '18px' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '8px 0', borderTop: '0.5px solid var(--dsw-alias-border-l2, #e0e0e0)' },
      fieldHead: { display: 'flex', alignItems: 'center', gap: '8px' },
      label: { flex: 1, fontWeight: 500 },
      overridden: { fontSize: '11px', opacity: 0.6 },
      input: {
        height: '32px', font: 'inherit', fontSize: '13px', padding: '0 10px',
        borderRadius: '8px', border: '0.5px solid var(--dsw-alias-border-l4, #c0c0c0)',
        background: 'var(--dsw-alias-bg-layer-3, transparent)', color: 'inherit', width: '100%', boxSizing: 'border-box',
      },
      textarea: {
        font: 'inherit', fontSize: '13px', padding: '8px 10px', minHeight: '60px', resize: 'vertical',
        borderRadius: '8px', border: '0.5px solid var(--dsw-alias-border-l4, #c0c0c0)',
        background: 'var(--dsw-alias-bg-layer-3, transparent)', color: 'inherit', width: '100%', boxSizing: 'border-box',
      },
      hint: { margin: 0, fontSize: '12px', opacity: 0.55 },
      note: { margin: '4px 0 0', fontSize: '12px', opacity: 0.55 },
      footer: { marginTop: '10px', fontSize: '12px', opacity: 0.6 },
      checkRow: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 0', borderTop: '0.5px solid var(--dsw-alias-border-l2, #e0e0e0)' },
      preview: {
        marginTop: '6px', padding: '8px 10px', borderRadius: '8px', fontSize: '12px',
        border: '0.5px solid var(--dsw-alias-border-l2, #e0e0e0)',
        background: 'var(--dsw-alias-bg-layer-3, transparent)', whiteSpace: 'pre-wrap', opacity: 0.85,
      },
    };

    /** One editable text/number row; commits on blur or Enter. */
    function TextField(props) {
      const [text, setText] = React.useState(props.value === undefined || props.value === null ? '' : String(props.value));
      const [invalid, setInvalid] = React.useState(false);
      React.useEffect(() => {
        setText(props.value === undefined || props.value === null ? '' : String(props.value));
        setInvalid(false);
      }, [props.value, props.revision]);
      const commit = () => {
        const raw = text.trim();
        if (props.numeric) {
          if (raw === '') { props.onUnset(); setInvalid(false); return; }
          const num = Number(raw);
          if (!Number.isFinite(num)) { setInvalid(true); return; }
          setInvalid(false);
          props.onSet(num);
          return;
        }
        if (raw === '') props.onUnset();
        else props.onSet(raw);
      };
      return h('div', { style: { ...styles.field, ...(props.full ? { gridColumn: '1 / -1' } : {}) } },
        h('div', { style: styles.fieldHead },
          h('span', { style: styles.label }, props.label),
          props.overridden ? h('span', { style: styles.overridden }, '已覆盖') : null,
          props.overridden ? h('button', {
            style: { font: 'inherit', fontSize: '12px', border: 'none', background: 'none', cursor: 'pointer', color: 'inherit', opacity: 0.7, padding: 0 },
            onClick: () => props.onUnset(),
          }, '重置') : null,
        ),
        h('input', {
          style: { ...styles.input, ...(invalid ? { borderColor: '#d33' } : {}) },
          value: text,
          disabled: props.disabled,
          placeholder: props.placeholder ?? '',
          onChange: (event) => setText(event.target.value),
          onBlur: commit,
          onKeyDown: (event) => { if (event.key === 'Enter') event.target.blur(); },
        }),
        props.hint ? h('p', { style: styles.hint }, props.hint) : null,
      );
    }

    /** One multi-line row (the retryable-code list); commits on blur. */
    function TextAreaField(props) {
      const [text, setText] = React.useState(String(props.value ?? ''));
      React.useEffect(() => { setText(String(props.value ?? '')); }, [props.value, props.revision]);
      return h('div', { style: { ...styles.field, gridColumn: '1 / -1' } },
        h('div', { style: styles.fieldHead },
          h('span', { style: styles.label }, props.label),
          props.overridden ? h('span', { style: styles.overridden }, '已覆盖') : null,
          props.overridden ? h('button', {
            style: { font: 'inherit', fontSize: '12px', border: 'none', background: 'none', cursor: 'pointer', color: 'inherit', opacity: 0.7, padding: 0 },
            onClick: () => props.onUnset(),
          }, '重置') : null,
        ),
        h('textarea', {
          style: styles.textarea,
          value: text,
          disabled: props.disabled,
          placeholder: props.placeholder ?? '',
          onChange: (event) => setText(event.target.value),
          onBlur: () => {
            const raw = text.trim();
            if (raw === '') props.onUnset();
            else props.onSet(raw);
          },
        }),
        props.hint ? h('p', { style: styles.hint }, props.hint) : null,
      );
    }

    /** One checkbox row; commits immediately. */
    function CheckField(props) {
      return h('div', { style: styles.checkRow },
        h('input', {
          id: `lrt-${props.field}`,
          type: 'checkbox',
          checked: props.value === true,
          disabled: props.disabled,
          onChange: (event) => props.onSet(event.target.checked),
        }),
        h('label', { htmlFor: `lrt-${props.field}`, style: styles.label }, props.label),
        props.hint ? h('span', { style: styles.hint }, props.hint) : null,
      );
    }

    /** Read one numeric field, falling back when it is absent or unusable. */
    function numberOr(value, fallback) {
      const num = Number(value);
      return Number.isFinite(num) ? num : fallback;
    }

    /** The effective schedule, rendered so the numbers are checkable at a glance. */
    function SchedulePreview(props) {
      const maxRetries = Math.max(0, Math.round(numberOr(props.value.maxRetries, 5)));
      const initial = Math.max(0.05, numberOr(props.value.initialDelaySeconds, 1));
      const step = Math.max(0, numberOr(props.value.stepSeconds, 0));
      const cap = Math.max(initial, numberOr(props.value.maxDelaySeconds, 60));
      const exponential = props.value.exponentialBackoff === true;
      const waits = [];
      for (let retry = 1; retry <= Math.min(maxRetries, 8); retry += 1) {
        const grown = exponential ? initial * 2 ** (retry - 1) : initial + step * (retry - 1);
        waits.push(Math.min(grown, cap));
      }
      if (waits.length === 0) {
        return h('div', { style: styles.preview }, '最多重试 0 次：失败的请求不再重试，直接报错。');
      }
      const rendered = waits.map((seconds) => `${seconds.toFixed(2).replace(/\.?0+$/, '')}s`).join(' → ');
      const more = maxRetries > waits.length ? ` → …（共 ${maxRetries} 次）` : '';
      return h('div', { style: styles.preview },
        `等待序列：${rendered}${more}`,
        '\n',
        `模式：${exponential ? '指数增长（每次翻倍）' : (step === 0 ? '固定等待（不增长）' : `线性增长（每次 +${step}s）`)}　上限：${cap}s`,
      );
    }

    /* ------------------------------ The card -------------------------------- */

    function RetryCard(props) {
      // Plugins 面板先渲染 summary（卡片里的一行说明），再在打开后的页面里渲染 page。
      if (props.view === 'summary') return SUMMARY;

      const scope = props.settingsForm;
      const [snap, setSnap] = React.useState(() => scope.getSnapshot());
      React.useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);

      if (snap.status === 'loading') {
        return h('div', { style: styles.card }, '模型重试设置加载中…');
      }
      if (snap.status === 'unavailable') {
        return h('div', { style: styles.card },
          h('div', { style: styles.head }, h('span', { style: styles.title }, '模型重试')),
          h('p', { style: styles.hint }, '宿主未暴露 llm-retry 设置命名空间（插件未加载？）。'));
      }
      const value = snap.value ?? {};
      const user = (snap.user && typeof snap.user === 'object') ? snap.user : {};
      const disabled = !snap.writable;
      const set = (field) => (next) => { void scope.set(field, next); };
      const unset = (field) => () => { void scope.unset(field); };
      const fieldProps = (field) => ({
        field,
        value: value[field],
        overridden: Object.prototype.hasOwnProperty.call(user, field),
        disabled,
        revision: snap.revision,
        onSet: set(field),
        onUnset: unset(field),
      });
      const enabled = value.enabled !== false;

      return h('div', { style: styles.card },
        h('div', { style: styles.head },
          h('span', { style: styles.title }, '模型重试'),
          h('span', { style: styles.badge }, 'agent/request-error'),
        ),
        h('p', { style: styles.hint },
          '模型请求失败（限流、超时、服务端错误…）后自动重试。这里可以关掉「越等越久」，改成本次增加多少秒；初次等待、上限与重试次数都可自定。改动立即生效，无需重启。'),

        h(CheckField, {
          ...fieldProps('enabled'), value: enabled, onSet: set('enabled'),
          label: '启用插件重试策略 (enabled)',
          hint: enabled ? '' : '已关闭：交回 DSH 自带的 llm-retry（指数退避，默认 5 次）',
        }),

        h('div', { style: { ...styles.grid, opacity: enabled ? 1 : 0.5 } },
          h(CheckField, {
            ...fieldProps('exponentialBackoff'), value: value.exponentialBackoff === true, onSet: set('exponentialBackoff'),
            label: '逐步等待越来越长（指数退避）',
            hint: '关 = 用下面的「每次增加」控制',
          }),
          h(TextField, {
            ...fieldProps('initialDelaySeconds'), numeric: true, label: '初次等待（秒）', placeholder: '1',
            hint: '第一次重试前等待多久',
          }),
          h(TextField, {
            ...fieldProps('stepSeconds'), numeric: true, label: '每次增加（秒）', placeholder: '0',
            hint: value.exponentialBackoff === true ? '指数模式下忽略此项' : '0 = 每次都等同样长；2 = 1s→3s→5s→…',
          }),
          h(TextField, {
            ...fieldProps('maxDelaySeconds'), numeric: true, label: '单次等待上限（秒）', placeholder: '60',
            hint: '自动放大的天花板',
          }),
          h(TextField, {
            ...fieldProps('maxRetries'), numeric: true, label: '最多重试次数', placeholder: '5',
            hint: '不含最初的第一次请求',
          }),
          h(TextField, {
            ...fieldProps('jitterRatio'), numeric: true, label: '抖动比例 0–1', placeholder: '0',
            hint: '0 = 严格按设置秒数等待（默认）；0.1 = 每次 ±10%',
          }),
          h(CheckField, {
            ...fieldProps('respectProviderRetryAfter'), value: value.respectProviderRetryAfter !== false, onSet: set('respectProviderRetryAfter'),
            label: '采纳服务端 Retry-After',
            hint: '服务端给出建议等待且不超过上限时用它',
          }),
        ),

        h('div', { style: { ...styles.grid, opacity: enabled ? 1 : 0.5 } },
          h(TextAreaField, {
            ...fieldProps('retryableCodes'), label: '可重试的失败码（逗号或空格分隔）',
            placeholder: 'EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT',
            hint: '只有这些失败码会被重试；例如 CONTEXT_WINDOW_EXCEEDED 由压缩策略处理，不应写在这里',
          }),
        ),

        h(SchedulePreview, { value }),

        h('p', { style: styles.footer }, snap.writable
          ? '保存于 profile 的 cordis.patch.yml 里 llm-retry-settings 一节的 config；每次重试都会写入会话日志（llm/retry），可在对话里看到排定时间。'
          : '当前连接为只读（memory 模式），改动不会持久化。'),
      );
    }

    /* ------------------------------ Registration --------------------------- */

    function apply(ctx) {
      const settingsForm = ctx.configForms.get(NS);
      // inject 面把宿主配置表单交给卡片；prop 不能叫 form —— renderSlot 自带的
      // form prop 会覆盖同名项。
      const injectFace = () => ({ settingsForm });
      // 设置 → 插件 → 模型重试 标签页。
      // whileServed：宿主真的提供 llm-retry 命名空间时才挂上配置页，插件没启用时
      // 设置里连这个标签都不会出现。
      ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: NS,
        order: 20,
        label: () => '模型重试',
        inject: injectFace,
      }, RetryCard))), 'dsh-plugin-llm-retry: 设置页');
      // 同一张卡片也挂在侧栏「插件」面板的官方分组（宿主为宿主侧命名空间预留的
      // plugins.item 席位），两处都能改同一份配置。
      ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
        name: 'plugins.item',
        id: NS,
        order: 55,
        label: () => '模型重试',
        inject: injectFace,
      }, RetryCard))), 'dsh-plugin-llm-retry: 插件页');
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  },
});
