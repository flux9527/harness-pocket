/**
 * dsh-mobile-console — 浏览器半边（DSH Web 界面里的设置页）。
 *
 * 注册进 `settings.section` 插槽，也就是「设置 → 手机控制台」这一页，提供：
 *   1. 总开关：一键开启 / 关闭手机控制台；
 *   2. 配对信息：地址、二维码、在线手机数；
 *   3. 账户余额与待办数（和手机通知上显示的是同一份数据）；
 *   4. 逐会话的「接管」开关（等价于 `/mobile on` / `/mobile off`）。
 *
 * 数据走**同源**路由 `/api/mobile-console/*`（由宿主半边通过 `webServer` 注册）。
 * 不去调手机那个 8799 端口：那个地址在局域网网卡上，从这里访问是跨域，会被浏览器拦。
 *
 * 手写 ModuleLoader 包，没有构建步骤；除了 shell 已经提供的 `react` 不带任何依赖。
 * 颜色一律取 DSH 主题变量，亮 / 暗切换都不会变成一块突兀的白板。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mobile-console',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React

    const inject = ['slots']
    const BASE = '/api/mobile-console'
    /** 状态刷新间隔：只是为了让人看到"在线手机数"这类会变的东西。 */
    const POLL_MS = 5000

    /**
     * 调同源接口。
     *
     * @param {string} path 路径
     * @param {any} [options] fetch 选项
     * @returns {Promise<any>} 响应
     */
    async function request(path, options) {
      const response = await fetch(`${BASE}${path}`, {
        cache: 'no-store',
        ...options,
        headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        /* 没 body 也算失败 */
      }
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload
    }

    // ── 样式 ────────────────────────────────────────────────────────────────
    // 全部用主题变量：暗色 / 亮色切换时不需要任何额外处理。
    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '4px 0 24px', color: 'var(--dsw-alias-label-primary)' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: '10px',
        padding: '14px 16px',
      },
      rowBetween: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
      title: { fontSize: '15px', fontWeight: 600, margin: 0 },
      sub: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', margin: '4px 0 0' },
      sectionTitle: { fontSize: '13px', fontWeight: 600, margin: '0 0 10px' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px' },
      metric: { background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '8px', padding: '10px 12px' },
      metricLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      metricValue: { fontSize: '16px', fontWeight: 600, marginTop: '2px' },
      button: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '8px',
        padding: '6px 12px',
        fontSize: '13px',
        cursor: 'pointer',
      },
      buttonPrimary: {
        // 强调色只当「前景色」用，不要当背景。
        //
        // 原来这里是 background=brand-primary + color='#fff'，在深色主题下
        // brand-primary 本身就是浅色，白字压在浅底上等于隐形（用户实测反馈）。
        // 根因是 DSH 的主题变量里**没有**「品牌色之上的文字色」这一项
        // （查过 client Theme provider 的 listTokens：只有 bg/label/border/brand/state 几组，
        // 没有任何 on-brand / inverse 之类的 token），所以往品牌底上放文字时，
        // 前景色只能靠猜——那就一定会有一半主题是错的。
        //
        // 这里改成和 buttonDanger 一样的写法：强调色做文字与边框，底色用中性面。
        // 这样两个主题下都成立，也不需要知道 brand-primary 具体是什么颜色。
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-brand-primary)',
        borderRadius: '8px',
        padding: '6px 14px',
        fontSize: '13px',
        fontWeight: 600,
        cursor: 'pointer',
      },
      buttonDanger: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        borderRadius: '8px',
        padding: '6px 12px',
        fontSize: '13px',
        cursor: 'pointer',
      },
      url: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
        wordBreak: 'break-all',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        padding: '10px 12px',
        lineHeight: 1.5,
      },
      qr: { width: '168px', height: '168px', imageRendering: 'pixelated', borderRadius: '8px', background: '#fff', padding: '6px' },
      session: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        padding: '8px 0',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      dot: { width: '7px', height: '7px', borderRadius: '50%', display: 'inline-block', marginRight: '7px' },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
      note: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: 1.6 },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        background: 'var(--dsw-alias-bg-layer-2)',
        padding: '1px 5px',
        borderRadius: '4px',
      },
    }

    /** 会话状态 → 小圆点颜色。 */
    function statusColor(status) {
      if (status === 'running') return 'var(--dsw-alias-state-success-primary)'
      if (status === 'offline') return 'var(--dsw-alias-state-idle-primary)'
      return 'var(--dsw-alias-state-warn-primary)'
    }

    /** 会话状态 → 中文。 */
    function statusLabel(status) {
      if (status === 'running') return '运行中'
      if (status === 'offline') return '已离线'
      return '空闲'
    }

    /** 余额快照 → 一句话。必须和插件 `/mobile status` 的说法一致。 */
    function balanceLabel(balance) {
      if (!balance) return '—'
      switch (balance.status) {
        case 'ready': {
          const symbol = balance.currency === 'CNY' ? '¥' : balance.currency === 'USD' ? '$' : ''
          const amount = `${symbol}${balance.amount}`
          return balance.bonus ? `${amount}（赠 ${symbol}${balance.bonus}）` : amount
        }
        case 'signed-out':
          return '未登录账户'
        case 'unavailable':
          return '宿主未提供账户服务'
        case 'empty':
          return '没有钱包'
        case 'unknown':
          return '查询中'
        default:
          return '查询失败'
      }
    }

    /**
     * 设置页。
     *
     * @returns {any} 元素
     */
    function MobileConsolePage() {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [copied, setCopied] = useState(false)
      const [confirmRotate, setConfirmRotate] = useState(false)
      const alive = useRef(true)

      const refresh = useCallback(async () => {
        try {
          const next = await request('/status')
          if (alive.current) {
            setStatus(next)
            setError('')
          }
        } catch (failure) {
          if (alive.current) setError(failure?.message ?? String(failure))
        }
      }, [])

      useEffect(() => {
        alive.current = true
        refresh()
        const timer = setInterval(refresh, POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [refresh])

      /** 包一层：统一处理忙碌态、错误与刷新。 */
      const mutate = useCallback(
        async (path, body) => {
          setBusy(true)
          try {
            const next = await request(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
            if (alive.current) {
              setStatus(next)
              setError('')
            }
            return true
          } catch (failure) {
            if (alive.current) setError(failure?.message ?? String(failure))
            return false
          } finally {
            if (alive.current) setBusy(false)
          }
        },
        [],
      )

      const copy = useCallback(async () => {
        if (!status?.url) return
        try {
          await navigator.clipboard.writeText(status.url)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        } catch {
          setError('复制失败，请手动选中地址复制')
        }
      }, [status])

      if (status === null) {
        return h(
          'div',
          { style: S.wrap },
          h('p', { style: S.note }, error === '' ? '正在读取手机控制台状态…' : `读取失败：${error}`),
        )
      }

      const on = status.enabled === true
      const sessions = status.sessions ?? []

      return h(
        'div',
        { style: S.wrap },

        // 总开关
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.rowBetween },
            h(
              'div',
              null,
              h('p', { style: S.title }, '手机控制台'),
              h(
                'p',
                { style: S.sub },
                on
                  ? '手机可以连上来接管审批与提问'
                  : '已关闭：不监听端口，也不会接管任何审批 / 提问',
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                disabled: busy,
                style: on ? S.button : S.buttonPrimary,
                onClick: () => mutate('/enabled', { enabled: !on }),
              },
              on ? '关闭' : '开启',
            ),
          ),
        ),

        // 状态指标
        h(
          'div',
          { style: S.card },
          h('p', { style: S.sectionTitle }, '状态'),
          h(
            'div',
            { style: S.grid },
            h('div', { style: S.metric }, h('div', { style: S.metricLabel }, '监听端口'), h('div', { style: S.metricValue }, on ? String(status.port) : '未监听')),
            h('div', { style: S.metric }, h('div', { style: S.metricLabel }, '在线手机'), h('div', { style: S.metricValue }, String(status.clients ?? 0))),
            h('div', { style: S.metric }, h('div', { style: S.metricLabel }, '账户余额'), h('div', { style: { ...S.metricValue, fontSize: '14px' } }, balanceLabel(status.balance))),
            h('div', { style: S.metric }, h('div', { style: S.metricLabel }, '待办'), h('div', { style: S.metricValue }, String(status.pending ?? 0))),
          ),
        ),

        // 配对
        h(
          'div',
          { style: S.card },
          h('p', { style: S.sectionTitle }, '配对地址'),
          on
            ? h(
                'div',
                { style: { display: 'flex', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' } },
                h(
                  'div',
                  { style: { flex: '1 1 260px', minWidth: '240px' } },
                  h('div', { style: S.url }, status.url || '（没有可用的局域网地址）'),
                  h(
                    'div',
                    { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } },
                    h('button', { type: 'button', style: S.buttonPrimary, onClick: copy }, copied ? '已复制' : '复制地址'),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: S.button,
                        onClick: () => window.open(status.url, '_blank', 'noopener'),
                      },
                      '在本机打开',
                    ),
                  ),
                  h(
                    'p',
                    { style: { ...S.note, marginTop: '10px' } },
                    '在电脑上的会话里执行 ',
                    h('span', { style: S.code }, '/mobile on'),
                    ' 之后，这个会话的审批与提问才会转到手机上。',
                  ),
                ),
                status.qr
                  ? h('img', { src: status.qr, alt: '配对二维码', style: S.qr })
                  : h('div', { style: { ...S.note, width: '168px' } }, '二维码不可用'),
              )
            : h('p', { style: S.note }, '总开关关闭时不监听端口，因此没有配对地址。开启后会在这里显示地址与二维码。'),
        ),

        // 会话
        h(
          'div',
          { style: S.card },
          h('p', { style: S.sectionTitle }, `会话（${sessions.length}）`),
          sessions.length === 0
            ? h('p', { style: S.note }, '还没有活跃会话。')
            : sessions.map(session =>
                h(
                  'div',
                  { key: session.id, style: S.session },
                  h(
                    'div',
                    { style: { minWidth: 0 } },
                    h(
                      'div',
                      { style: { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      h('span', { style: { ...S.dot, background: statusColor(session.status) } }),
                      session.title || session.id,
                      session.subagent ? h('span', { style: { ...S.note, marginLeft: '6px' } }, '子会话') : null,
                    ),
                    h('div', { style: { ...S.note, marginTop: '2px' } }, `${statusLabel(session.status)} · ${session.id.slice(0, 18)}…`),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: busy,
                      style: session.armed ? S.button : S.buttonPrimary,
                      onClick: () => mutate('/arm', { sessionId: session.id, armed: !session.armed }),
                    },
                    session.armed ? '取消接管' : '接管',
                  ),
                ),
              ),
        ),

        // 令牌
        h(
          'div',
          { style: S.card },
          h('p', { style: S.sectionTitle }, '访问令牌'),
          h(
            'p',
            { style: S.note },
            '配对地址里的令牌就是唯一凭据（当前末尾 ',
            h('span', { style: S.code }, status.tokenTail || '----'),
            '）。重新生成会让**所有已配对的手机立刻失效**，包括已经装好的 App。',
          ),
          confirmRotate
            ? h(
                'div',
                { style: { display: 'flex', gap: '8px', marginTop: '10px' } },
                h('button', { type: 'button', style: S.buttonDanger, disabled: busy, onClick: async () => { await mutate('/rotate'); setConfirmRotate(false) } }, '确认重新生成'),
                h('button', { type: 'button', style: S.button, onClick: () => setConfirmRotate(false) }, '取消'),
              )
            : h('button', { type: 'button', style: { ...S.button, marginTop: '10px' }, onClick: () => setConfirmRotate(true) }, '重新生成令牌'),
        ),

        error !== '' ? h('p', { style: S.error }, `操作失败：${error}`) : null,
      )
    }

    /**
     * 挂载进设置面板。
     *
     * @param {any} ctx 客户端上下文
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-mobile-console',
            order: 40,
            label: () => '手机控制台',
          },
          () => h(MobileConsolePage),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-mobile-console'
    return module.exports
  },
})
