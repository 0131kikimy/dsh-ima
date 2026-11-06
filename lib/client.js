// dsh-ima · 浏览器半边：左侧边栏「ima」图标 + 设置面板
//
// 契约来自宿主客户端模块系统（lazy-CJS）：
//   window.__ModuleLoader__.load({ id: <包名>, factory: (require) => 插件对象 })
//   插件对象 = { apply(ctx) }，在 apply 里用 ctx.inject(['slots'], scope => scope.slots.register(...))
// 与 lunheng-article-pipeline 的 client.js 同款写法（手写、零构建、零第三方依赖）。
//
// 面板本体复用宿主已有的设置页（/dsh-ima/settings），用 iframe 嵌进来：
// 这样"可视化填 API"只有一份实现，不会出现两套表单各说各话。
// 面板地址从本机接口 /dsh-ima/panel 拿（只回 {url}，仅接受 localhost 请求）。

window.__ModuleLoader__.load({
  id: 'dsh-ima',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const react = require('react');
    const h = react.createElement;

    const PANEL_ID = 'dsh-ima';
    const BOOT_URL = '/dsh-ima/panel';

    /** 侧边栏图标：与包内 icon.svg 同构的简化版。 */
    function PanelIcon(props) {
      const size = (props && props.size) || 18;
      const active = !!(props && props.active);
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          style: { opacity: active ? 1 : 0.75 },
        },
        h('rect', { x: 2, y: 2, width: 20, height: 20, rx: 5, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('rect', { x: 6, y: 6.5, width: 7, height: 8, rx: 1.2, fill: 'currentColor', opacity: 0.85 }),
        h('path', { d: 'M15.5 12h2.2', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('circle', { cx: 18.2, cy: 12, r: 1.7, fill: 'currentColor' }),
        h('rect', { x: 6, y: 16.6, width: 11, height: 2.2, rx: 1.1, fill: 'currentColor', opacity: 0.45 }),
      );
    }

    /** 设置面板：嵌入宿主自带的设置页。 */
    function Panel() {
      const [state, setState] = react.useState({ status: 'loading', url: '', error: '' });
      const [reloadKey, setReloadKey] = react.useState(0);

      react.useEffect(() => {
        let alive = true;
        fetch(BOOT_URL, { cache: 'no-store' })
          .then((res) => res.json())
          .then((data) => {
            if (!alive) return;
            if (data && data.ok && data.url) setState({ status: 'ready', url: data.url, error: '' });
            else setState({ status: 'error', url: '', error: (data && data.error) || '拿不到设置页地址' });
          })
          .catch((error) => {
            if (!alive) return;
            setState({ status: 'error', url: '', error: String((error && error.message) || error) });
          });
        return () => { alive = false; };
      }, [reloadKey]);

      const header = h(
        'div',
        {
          style: {
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px',
            borderBottom: '1px solid var(--dsw-alias-border-l1, #e5e7eb)', flex: '0 0 auto',
          },
        },
        h('strong', { style: { fontSize: 14 } }, 'ima 设置'),
        h('span', { style: { fontSize: 12, opacity: 0.65 } }, '填好 Client ID 与 API Key 后点“保存”，立即生效'),
        h('span', { style: { flex: 1 } }),
        state.status === 'ready'
          ? h('a', {
              href: state.url, target: '_blank', rel: 'noreferrer',
              style: { fontSize: 12, color: 'var(--dsw-alias-brand-primary, #2b6ef6)' },
            }, '在新标签打开')
          : null,
        h('button', {
          onClick: () => setReloadKey((k) => k + 1),
          style: { fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)', background: 'transparent', color: 'inherit' },
        }, '刷新'),
      );

      let body;
      if (state.status === 'loading') {
        body = h('div', { style: { padding: 24, opacity: 0.7 } }, '正在读取设置…');
      } else if (state.status === 'error') {
        body = h('div', { style: { padding: 24, color: 'var(--dsw-alias-label-danger, #d93025)' } },
          '打不开设置页：' + state.error,
          h('div', { style: { marginTop: 8, fontSize: 12, opacity: 0.7 } },
            '如果宿主没有 Web UI 或插件刚重装过，点右上角“刷新”再试。'));
      } else {
        body = h('iframe', {
          key: state.url + '#' + reloadKey,
          src: state.url,
          title: 'dsh-ima settings',
          style: { border: 'none', width: '100%', height: '100%', flex: '1 1 auto', background: 'transparent' },
        });
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } }, header, body);
    }

    function apply(ctx) {
      try {
        ctx.inject(['slots'], (scope) => {
          scope.slots.inject('sidebar.panellist', () => scope.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 55, label: () => 'ima' },
            (props) => h(PanelIcon, props),
          ));
          scope.slots.inject('main', () => scope.slots.register(
            { name: 'main', key: PANEL_ID },
            () => h(Panel),
          ));
        });
      } catch (error) {
        console.error('[dsh-ima] 侧边栏面板注册失败：', error);
      }
    }

    exports.name = 'dsh-ima';
    exports.apply = apply;
    return module.exports;
  },
});
