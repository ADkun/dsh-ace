// dsh-ace 的浏览器半边：在 DSH 设置面板里注册一个独立的「ACE 手册」配置页。
//
// 挂载点：settings.section（ui-settings-general 声明的 list slot；注册选项 id/order/label，
// 占位组件收到 { close }。契约出处：DSH checkout ~\@deepseek-ai\dsh-client-ui-settings\
// lib\types\client\contract\slots.d.ts:73-77,147-157）。
//
// 数据源：宿主侧的 /api/dsh-ace/settings（lib/index.js 末尾的 ctx.inject(['webServer'])）。
// 这里**不**依赖 configForms：宿主并不服务 dsh-ace 命名空间，把 configForms 写进 fiber
// inject 会让 apply 永远等不到服务、页面永不注册（这是本页第一版不出现的真正原因）。
// 客户端只 inject ['slots', 'locale']，读写走 fetch —— 范式同 dsh-insert-context/client.js:19-30。
//
// 视觉：应用户要求本页固定 VCP 暗色 + JetBrains Maple Mono，不走宿主主题 token。
window.__ModuleLoader__.load({
  id: 'dsh-ace',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'settings.dshAce';
    const ROUTE = '/api/dsh-ace/settings';
    // 模型目录（宿主 lib/index.js 的 GET /catalog）：两个下拉的数据源。
    const CATALOG_ROUTE = '/api/dsh-ace/catalog';
    const inject = ['slots', 'locale'];

    const zh = {
      'meta.title': 'ACE 手册',
      'meta.description': '可进化的操作手册（playbook）：任务前查阅既往经验，任务后复盘沉淀新经验。在这里配置手册路径、复盘提醒、Reflector/Curator 的模型覆盖与手册容量。',
      nav: 'ACE 手册',
      title: 'ACE 手册',
      subtitle: '可进化的操作手册（playbook）：复盘沉淀经验，任务前查阅',
      sectionTag: 'ACE PLAYBOOK',
      fieldPlaybookPath: '手册路径',
      fieldPlaybookPathDesc: 'playbook.md 的位置；相对路径相对会话工作目录解析',
      fieldAutoReflect: '任务完成后提醒复盘',
      fieldAutoReflectDesc: '在系统提示里提醒 agent 主动调用 ace_reflect 复盘',
      fieldProvider: '复盘 provider 覆盖',
      fieldProviderDesc: 'Reflector/Curator 使用的 provider；留空跟随会话模型',
      fieldModel: '复盘 model 覆盖',
      fieldModelDesc: 'Reflector/Curator 使用的 model；留空跟随会话模型',
      pickProviderPlaceholder: '跟随会话模型',
      pickModelPlaceholder: '跟随会话模型',
      pickProviderSearch: '搜索 provider…',
      pickModelSearch: '搜索 model…',
      pickNoMatchProvider: '没有匹配的 provider',
      pickNoMatchModel: '没有匹配的模型',
      pickClear: '跟随会话模型（清空）',
      catalogLoading: '正在读取模型目录…',
      catalogFailed: '模型目录读取失败：宿主可能还没重启（其余字段照常可用）',
      warnPair: '只有 provider 与 model 两项都填才生效；只填一项会静默回落到会话模型。',
      fieldMaxEntries: '手册容量上限',
      fieldMaxEntriesDesc: '超出后 ace_curate 整批拒绝，并提示先合并旧条目',
      on: '开',
      off: '关',
      saved: '已保存',
      reset: '已恢复为插件默认值',
      loading: '正在读取 ACE 配置…',
      failed: '读取失败：宿主没有响应设置接口（插件可能未启用）',
      editableHint: '手册是纯 Markdown，随时可以直接编辑文件。',
      fromStored: '当前值来自设置页保存的配置',
      fromConfigured: '当前值来自插件行 Config（设置页尚未保存过）',
      resetBtn: '恢复默认值',
    };
    const en = {
      'meta.title': 'ACE Playbook',
      'meta.description': 'An evolvable playbook: consult past experience before a task, distil new experience after one. Configure the playbook path, the reflect reminder, Reflector/Curator model overrides and the playbook capacity here.',
      nav: 'ACE Playbook',
      title: 'ACE Playbook',
      subtitle: 'An evolvable playbook: distil experience after tasks, consult before tasks',
      sectionTag: 'ACE PLAYBOOK',
      fieldPlaybookPath: 'Playbook path',
      fieldPlaybookPathDesc: 'Where playbook.md lives; relative paths resolve against the session working directory',
      fieldAutoReflect: 'Remind to reflect after tasks',
      fieldAutoReflectDesc: 'Nudge the agent in the system prompt to call ace_reflect after real work',
      fieldProvider: 'Reflect provider override',
      fieldProviderDesc: 'Provider for Reflector/Curator; empty follows the session model',
      fieldModel: 'Reflect model override',
      fieldModelDesc: 'Model for Reflector/Curator; empty follows the session model',
      pickProviderPlaceholder: 'Follow session model',
      pickModelPlaceholder: 'Follow session model',
      pickProviderSearch: 'Search providers…',
      pickModelSearch: 'Search models…',
      pickNoMatchProvider: 'No matching provider',
      pickNoMatchModel: 'No matching model',
      pickClear: 'Follow session model (clear)',
      catalogLoading: 'Loading the model catalog…',
      catalogFailed: 'Could not load the model catalog: the host may not have restarted yet (other fields still work)',
      warnPair: 'The override only applies when both provider and model are set; with just one set it silently falls back to the session model.',
      fieldMaxEntries: 'Playbook capacity',
      fieldMaxEntriesDesc: 'ace_curate rejects whole batches beyond this and asks to merge old entries first',
      on: 'On',
      off: 'Off',
      saved: 'Saved',
      reset: 'Back to the plugin defaults',
      loading: 'Loading ACE configuration…',
      failed: 'Could not load: the host did not answer the settings endpoint (plugin may be disabled)',
      editableHint: 'The playbook is plain Markdown and can be edited directly at any time.',
      fromStored: 'These values come from what the settings page saved',
      fromConfigured: 'These values come from the plugin row Config (the settings page never saved)',
      resetBtn: 'Restore defaults',
    };

    // VCP 暗色（应用户指定：本页固定暗色，不随宿主主题切换）。
    const CSS = [
      '.ace-set{font-family:\'JetBrains Maple Mono\',\'Maple Mono\',\'JetBrains Mono\',ui-monospace,\'Cascadia Code\',Consolas,monospace;color:#dce6f1;background:#0c1117;border:1px solid #223041;border-radius:12px;padding:20px 22px 16px;box-sizing:border-box;max-width:640px;line-height:1.55}',
      '.ace-set *{box-sizing:border-box;font-family:inherit}',
      '.ace-set-tag{display:inline-block;font-size:10px;letter-spacing:.18em;color:#2dd4bf;border:1px solid #1d3a38;border-radius:4px;padding:2px 8px;margin-bottom:10px;background:#0f1a1a}',
      '.ace-set-title{font-size:16px;font-weight:700;color:#eaf2fb;margin:0 0 4px}',
      '.ace-set-sub{font-size:12px;color:#8fa1b3;margin:0 0 18px}',
      '.ace-set-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid #1a2430}',
      '.ace-set-label{font-size:13px;font-weight:600;color:#dce6f1;margin:0 0 3px}',
      '.ace-set-desc{font-size:11px;color:#7d8fa1;margin:0;max-width:380px}',
      '.ace-set-input{background:#131a22;border:1px solid #263140;border-radius:6px;color:#e6edf3;font-size:12px;padding:7px 10px;width:220px;outline:none;transition:border-color .15s}',
      '.ace-set-input:focus{border-color:#2dd4bf}',
      '.ace-set-input::placeholder{color:#55677a}',
      '.ace-set-switch{flex:none;width:38px;height:21px;border-radius:11px;background:#263140;border:1px solid #33465c;position:relative;cursor:pointer;transition:background .15s,border-color .15s}',
      '.ace-set-switch[aria-checked="true"]{background:#134e4a;border-color:#2dd4bf}',
      '.ace-set-knob{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#e6edf3;transition:left .15s}',
      '.ace-set-switch[aria-checked="true"] .ace-set-knob{left:19px;background:#5eead4}',
      '.ace-set-status{font-size:11px;margin-top:12px;min-height:16px}',
      '.ace-set-status-ok{color:#2dd4bf}',
      '.ace-set-status-err{color:#f87171}',
      '.ace-set-hint{font-size:10px;color:#5d6f82;margin-top:10px;border-top:1px dashed #1a2430;padding-top:8px}',
      '.ace-set-note{font-size:12px;color:#8fa1b3;padding:12px 0}',
      '.ace-set-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px}',
      '.ace-set-btn{background:#131a22;border:1px solid #2a3746;border-radius:6px;color:#9fb2c5;font-size:11px;padding:5px 10px;cursor:pointer;font-family:inherit}',
      '.ace-set-btn:hover{border-color:#3d4d60;color:#dce6f1}',
      // —— 模型下拉（provider / model 两行共用）——
      '.ace-pick{position:relative;width:220px;flex:none}',
      '.ace-pick-trigger{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;background:#131a22;border:1px solid #263140;border-radius:6px;color:#e6edf3;font-size:12px;padding:7px 10px;cursor:pointer;text-align:left;font-family:inherit;transition:border-color .15s}',
      '.ace-pick-trigger:hover{border-color:#3d4d60}',
      '.ace-pick-trigger[aria-expanded="true"]{border-color:#2dd4bf}',
      '.ace-pick-value{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ace-pick-value.is-empty{color:#55677a}',
      '.ace-pick-caret{flex:none;color:#7d8fa1;font-size:10px}',
      '.ace-pick-panel{position:absolute;top:calc(100% + 6px);right:0;width:320px;max-width:calc(100vw - 32px);background:#131a22;border:1px solid #263140;border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.55);z-index:200;overflow:hidden;padding:6px;display:flex;flex-direction:column;gap:6px}',
      '.ace-pick-search{width:100%;background:#0c1117;border:1px solid #263140;border-radius:6px;color:#e6edf3;font-size:12px;padding:6px 9px;outline:none;font-family:inherit}',
      '.ace-pick-search:focus{border-color:#2dd4bf}',
      '.ace-pick-search::placeholder{color:#55677a}',
      '.ace-pick-list{max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:1px}',
      '.ace-pick-group{font-size:10px;letter-spacing:.12em;color:#7d8fa1;padding:6px 8px 3px;text-transform:uppercase}',
      '.ace-pick-item{display:flex;flex-direction:column;gap:2px;width:100%;background:transparent;border:none;border-radius:5px;color:#dce6f1;font-size:12px;padding:6px 8px;cursor:pointer;text-align:left;font-family:inherit}',
      '.ace-pick-item:hover{background:#1a2430}',
      '.ace-pick-item.is-active{background:#16302e}',
      '.ace-pick-item[aria-selected="true"]{color:#5eead4}',
      '.ace-pick-item-id{font-size:10px;color:#7d8fa1}',
      '.ace-pick-item-desc{font-size:10px;color:#5d6f82}',
      '.ace-pick-empty{font-size:11px;color:#7d8fa1;padding:8px}',
      '.ace-pick-err{font-size:11px;color:#f87171;padding:8px}',
      '.ace-pick-foot{border-top:1px solid #263140;padding-top:6px}',
      '.ace-pick-clear{color:#9fb2c5}',
      '.ace-set-warn{font-size:11px;line-height:1.6;color:#f0b429;padding:0 0 10px}',
    ].join('\n');

    function Switch(props) {
      const { checked, onChange, onText, offText } = props;
      return h('div', {
        className: 'ace-set-switch',
        role: 'switch',
        tabIndex: 0,
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': checked ? onText : offText,
        title: checked ? onText : offText,
        onClick: () => onChange(!checked),
        onKeyDown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(!checked); }
        },
      }, h('span', { className: 'ace-set-knob' }));
    }

    function FieldRow(props) {
      const { label, desc, control } = props;
      return h('div', { className: 'ace-set-row' },
        h('div', null,
          h('div', { className: 'ace-set-label' }, label),
          h('div', { className: 'ace-set-desc' }, desc)),
        control);
    }

    /**
     * 模型下拉：可搜索、可分组、可清空。
     * 交互照 DSH 官方模型选择器的键盘模型（~\dsh-client-ui-model-selection\lib\client.js:1362-1414：
     * Esc 关闭、ArrowUp/Down 循环移动高亮、Enter 选中），但不引入它的任何依赖——
     * 这里只有 React.createElement 和本文件内的 CSS。
     * props：
     *   value              当前值（空串表示跟随会话模型）
     *   groups             [{ key, title, items: [{ id, name, description? }] }]；title 为空则不画组标题
     *   placeholder        空值占位文案
     *   searchPlaceholder  搜索框 placeholder
     *   noMatchText        无匹配时的提示
     *   clearText          「跟随会话模型（清空）」项文案
     *   errorText          目录读取失败时的错误行（有则不画列表）
     *   loading            目录读取中的提示
     *   onPick(item) / onClear()
     */
    function ModelPicker(props) {
      const {
        value, groups, placeholder, searchPlaceholder, noMatchText, clearText, errorText, loading,
        onPick, onClear,
      } = props;
      const [open, setOpen] = React.useState(false);
      const [query, setQuery] = React.useState('');
      const [active, setActive] = React.useState(0);
      const rootRef = React.useRef(null);
      const searchRef = React.useRef(null);
      const itemRefs = React.useRef([]);

      // 展开时清空搜索、重置高亮，并把焦点交给搜索框（自动聚焦）。
      React.useEffect(() => {
        if (!open) return undefined;
        setQuery('');
        setActive(0);
        const timer = window.setTimeout(() => { searchRef.current?.focus(); }, 0);
        return () => window.clearTimeout(timer);
      }, [open]);

      // 点击面板外部关闭。
      React.useEffect(() => {
        if (!open) return undefined;
        const onDocDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener('mousedown', onDocDown);
        return () => document.removeEventListener('mousedown', onDocDown);
      }, [open]);

      const needle = query.trim().toLowerCase();
      const hit = (item) => {
        if (needle === '') return true;
        const hay = [item.name, item.id, item.description]
          .filter((part) => typeof part === 'string')
          .join('\n')
          .toLowerCase();
        return hay.includes(needle);
      };
      const visible = [];
      for (const group of groups || []) {
        const items = (group.items || []).filter(hit);
        if (items.length) visible.push({ key: group.key, title: group.title, items });
      }
      // flat 与列表项的渲染顺序一一对应：高亮索引直接用下标，回车取 flat[activeIndex]。
      const flat = [];
      for (const group of visible) for (const item of group.items) flat.push({ item, groupKey: group.key });
      const activeIndex = flat.length ? Math.min(active, flat.length - 1) : -1;

      // 高亮项滚进可视区。
      React.useEffect(() => {
        if (!open || activeIndex < 0) return;
        itemRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
      }, [open, activeIndex]);

      const pick = (entry) => {
        setOpen(false);
        onPick(entry.item, entry.groupKey);
      };
      const clear = () => {
        setOpen(false);
        onClear();
      };

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          if (open) { event.preventDefault(); setOpen(false); }
          return;
        }
        if (!open) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (!flat.length) return;
          event.preventDefault();
          setActive((current) => {
            const base = Math.min(current, flat.length - 1);
            return (base + (event.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length;
          });
          return;
        }
        if (event.key === 'Enter' && activeIndex >= 0) {
          event.preventDefault();
          pick(flat[activeIndex]);
        }
      };

      // 渲染时的下标游标：与上面 flat 的构造顺序严格一致。
      let rendered = -1;
      return h('div', { className: 'ace-pick', ref: rootRef, onKeyDown },
        h('button', {
          type: 'button',
          className: 'ace-pick-trigger',
          'aria-haspopup': 'listbox',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((wasOpen) => !wasOpen),
        },
          h('span', { className: 'ace-pick-value' + (value ? '' : ' is-empty') }, value || placeholder),
          h('span', { className: 'ace-pick-caret' }, '▾')),
        open ? h('div', { className: 'ace-pick-panel' },
          h('input', {
            ref: searchRef,
            className: 'ace-pick-search',
            type: 'text',
            value: query,
            placeholder: searchPlaceholder,
            onChange: (event) => { setQuery(event.target.value); setActive(0); },
          }),
          errorText ? h('div', { className: 'ace-pick-err' }, errorText) : null,
          loading ? h('div', { className: 'ace-pick-empty' }, loading) : null,
          h('div', { className: 'ace-pick-list', role: 'listbox' },
            flat.length === 0
              ? (errorText || loading ? null : h('div', { className: 'ace-pick-empty' }, noMatchText))
              : visible.map((group) => h('div', { key: 'group:' + group.key },
                group.title ? h('div', { className: 'ace-pick-group' }, group.title) : null,
                group.items.map((item) => {
                  rendered += 1;
                  const index = rendered;
                  return h('button', {
                    key: 'item:' + group.key + ':' + item.id,
                    type: 'button',
                    role: 'option',
                    ref: (node) => { itemRefs.current[index] = node; },
                    className: 'ace-pick-item' + (index === activeIndex ? ' is-active' : ''),
                    'aria-selected': item.id === value ? 'true' : 'false',
                    onClick: () => pick(flat[index]),
                  },
                    h('span', null, item.name || item.id),
                    h('span', { className: 'ace-pick-item-id' }, item.id),
                    item.description ? h('span', { className: 'ace-pick-item-desc' }, item.description) : null);
                })))),
          h('div', { className: 'ace-pick-foot' },
            h('button', { type: 'button', className: 'ace-pick-item ace-pick-clear', onClick: clear },
              h('span', null, clearText))))
        : null);
    }

    /** 本地语言标签：shell 把当前语言镜像到 <html lang>，渲染时读一次即可。 */
    function localeTag(ctx) {
      try {
        const snapshot = typeof ctx.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx.locale?.getSnapshot?.();
        const value = snapshot?.active ?? ctx.locale?.locale;
        return typeof value === 'string' ? value : document.documentElement.lang || 'en';
      } catch {
        return 'en';
      }
    }

    function AceSection(props) {
      const { t } = props;
      const [state, setState] = React.useState({ status: 'loading' });
      const [draft, setDraft] = React.useState({});
      const [status, setStatus] = React.useState(null);
      // 模型目录：status 取 'loading' | 'ready' | 'failed'。
      // failed 只影响两个下拉（面板里显示错误行），其余字段照常可用——
      // 宿主还没重启时 /catalog 会 404，这是正常状态。
      const [catalog, setCatalog] = React.useState({ status: 'loading', providers: [] });

      const adopt = (payload) => {
        const value = payload && typeof payload.value === 'object' && payload.value ? payload.value : {};
        setState({ status: 'ready', value, stored: payload?.stored ?? {}, configured: payload?.configured ?? {}, file: payload?.file });
        setDraft({});
      };

      React.useEffect(() => {
        let alive = true;
        fetch(ROUTE, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((payload) => { if (alive) adopt(payload); })
          .catch(() => { if (alive) setState({ status: 'failed' }); });
        return () => { alive = false; };
      }, []);

      React.useEffect(() => {
        let alive = true;
        fetch(CATALOG_ROUTE, { headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then((payload) => {
            if (!alive) return;
            if (!payload || payload.ok !== true || !Array.isArray(payload.providers)) {
              setCatalog({ status: 'failed', providers: [] });
              return;
            }
            setCatalog({ status: 'ready', providers: payload.providers });
          })
          .catch(() => { if (alive) setCatalog({ status: 'failed', providers: [] }); });
        return () => { alive = false; };
      }, []);

      const send = (method, body, doneText) => {
        setStatus(null);
        fetch(ROUTE, {
          method,
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
          .then((response) => response.json().then((payload) => {
            if (!response.ok) throw new Error(payload?.error ?? ('HTTP ' + response.status));
            return payload;
          }))
          .then((payload) => { adopt(payload); setStatus({ kind: 'ok', text: doneText }); })
          .catch((error) => setStatus({ kind: 'err', text: String(error?.message ?? error) }));
      };

      const commit = (field, value) => {
        const body = {};
        body[field] = value;
        send('POST', body, t('saved'));
      };

      if (state.status === 'loading') {
        return h('div', { className: 'ace-set' }, h('style', null, CSS), h('div', { className: 'ace-set-note' }, t('loading')));
      }
      if (state.status !== 'ready') {
        return h('div', { className: 'ace-set' }, h('style', null, CSS), h('div', { className: 'ace-set-note' }, t('failed')));
      }

      const value = (field) => (Object.prototype.hasOwnProperty.call(draft, field) ? draft[field] : state.value[field]);
      const setDraftField = (field, v) => setDraft((d) => ({ ...d, [field]: v }));

      const textProps = (field, ph) => ({
        className: 'ace-set-input',
        type: 'text',
        value: String(value(field) == null ? '' : value(field)),
        placeholder: ph || '',
        onChange: (e) => setDraftField(field, e.target.value),
        onBlur: () => {
          if (!Object.prototype.hasOwnProperty.call(draft, field)) return;
          const v = draft[field];
          if (String(v) === String(state.value[field] == null ? '' : state.value[field])) return;
          commit(field, v);
        },
        onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur(); },
      });

      const numProps = (field) => ({
        className: 'ace-set-input',
        type: 'number',
        min: 1,
        step: 1,
        value: String(value(field) == null ? '' : value(field)),
        onChange: (e) => setDraftField(field, e.target.value),
        onBlur: () => {
          if (!Object.prototype.hasOwnProperty.call(draft, field)) return;
          const n = Math.max(1, Math.floor(Number(draft[field])));
          if (!Number.isFinite(n) || n === Number(state.value[field])) return;
          commit(field, n);
        },
        onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur(); },
      });

      const fromStored = Object.keys(state.stored ?? {}).length > 0;

      // —— 两个下拉的数据与提交 ——
      const catalogError = catalog.status === 'failed' ? t('catalogFailed') : undefined;
      const catalogLoading = catalog.status === 'loading' ? t('catalogLoading') : undefined;
      const currentProvider = String(value('reflectProvider') || '');
      const currentModel = String(value('reflectModel') || '');

      const providerGroups = [{
        key: 'providers',
        title: '',
        items: catalog.providers.map((entry) => ({
          id: entry.id,
          name: entry.name || entry.id,
          description: entry.error ? '⚠ ' + entry.error : undefined,
        })),
      }];
      // model 下拉按 provider 分组：reflectProvider 非空时只显示这一组，否则显示所有组。
      const modelGroups = catalog.providers
        .filter((entry) => currentProvider === '' || entry.id === currentProvider)
        .map((entry) => ({
          key: entry.id,
          title: entry.name && entry.name !== entry.id ? entry.name + ' · ' + entry.id : entry.id,
          items: (entry.models || []).map((model) => ({
            id: model.id,
            name: model.name || model.id,
            description: model.description,
          })),
        }));

      const pickProvider = (item) => commit('reflectProvider', String(item?.id ?? ''));
      const pickModel = (item, providerKey) => {
        const modelId = String(item?.id ?? '');
        // provider 为空时一次 POST 同时提交两项（宿主 POST 已支持多字段），
        // 否则只改 model —— 避免把用户已选好的 provider 悄悄改掉。
        if (currentProvider === '') send('POST', { reflectProvider: String(providerKey ?? ''), reflectModel: modelId }, t('saved'));
        else commit('reflectModel', modelId);
      };

      // 语义红线（lib/llm.js:17-30 resolveRoute）：两项都非空才用覆盖值，只填一项会静默回落。
      const pairIncomplete = (currentProvider !== '') !== (currentModel !== '');

      return h('div', { className: 'ace-set' },
        h('style', null, CSS),
        h('span', { className: 'ace-set-tag' }, t('sectionTag')),
        h('div', { className: 'ace-set-title' }, t('title')),
        h('div', { className: 'ace-set-sub' }, t('subtitle')),
        h(FieldRow, { label: t('fieldPlaybookPath'), desc: t('fieldPlaybookPathDesc'), control: h('input', textProps('playbookPath', '.ace/playbook.md')) }),
        h(FieldRow, {
          label: t('fieldAutoReflect'), desc: t('fieldAutoReflectDesc'),
          control: h(Switch, {
            checked: state.value.autoReflect !== false,
            onChange: (next) => commit('autoReflect', next),
            onText: t('on'), offText: t('off'),
          }),
        }),
        h(FieldRow, {
          label: t('fieldProvider'), desc: t('fieldProviderDesc'),
          control: h(ModelPicker, {
            value: currentProvider,
            groups: providerGroups,
            placeholder: t('pickProviderPlaceholder'),
            searchPlaceholder: t('pickProviderSearch'),
            noMatchText: t('pickNoMatchProvider'),
            clearText: t('pickClear'),
            errorText: catalogError,
            loading: catalogLoading,
            onPick: pickProvider,
            onClear: () => commit('reflectProvider', ''),
          }),
        }),
        h(FieldRow, {
          label: t('fieldModel'), desc: t('fieldModelDesc'),
          control: h(ModelPicker, {
            value: currentModel,
            groups: modelGroups,
            placeholder: t('pickModelPlaceholder'),
            searchPlaceholder: t('pickModelSearch'),
            noMatchText: t('pickNoMatchModel'),
            clearText: t('pickClear'),
            errorText: catalogError,
            loading: catalogLoading,
            onPick: pickModel,
            onClear: () => commit('reflectModel', ''),
          }),
        }),
        // 只填一项时的显式警告：两项恰好只有一个非空才出现（见 lib/llm.js:17-30 的 && 语义）。
        pairIncomplete ? h('div', { className: 'ace-set-warn' }, t('warnPair')) : null,
        h(FieldRow, { label: t('fieldMaxEntries'), desc: t('fieldMaxEntriesDesc'), control: h('input', numProps('maxEntries')) }),
        h('div', {
          className: status ? ('ace-set-status ace-set-status-' + (status.kind === 'ok' ? 'ok' : 'err')) : 'ace-set-status',
        }, status ? status.text : ''),
        h('div', { className: 'ace-set-foot' },
          h('span', { className: 'ace-set-hint', style: { borderTop: 'none', marginTop: 0, paddingTop: 0 } },
            fromStored ? t('fromStored') : t('fromConfigured')),
          h('button', { className: 'ace-set-btn', type: 'button', onClick: () => send('DELETE', undefined, t('reset')) }, t('resetBtn'))),
        h('div', { className: 'ace-set-hint' }, t('editableHint')));
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-ace: dictionaries');
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-ace',
        order: 900,
        label: () => t('nav'),
        locale: NS,
      }, (props) => h(AceSection, {
        ...props,
        t: Object.assign((key) => t(key), { locale: localeTag(ctx) }),
      })));
    }

    return { inject, apply, name: 'dsh-ace' };
  },
});
