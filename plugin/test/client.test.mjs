// 浏览器半边（client.js）的契约测试。
//
// 这一半没法在这个环境里跑真浏览器，但它有明确的**契约**可以钉住：
//   - 必须是 `window.__ModuleLoader__.load({ id, factory })` 的形式；
//   - factory(require) 要返回 { apply, inject, name }；
//   - apply(ctx) 必须往 `settings.section` 注册一项，且 id / order / label 齐全；
//   - 注册时给的那个渲染函数要能真的渲染出页面（这里用一个极简 React 桩浅渲染一遍）。
//
// 这些一旦写错，表现是"设置里干脆没有这一页"或者"打开就白屏"，而且没有任何报错——
// 所以值得用测试钉住。

import { eq, ok, group, report } from './harness.mjs'

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec
    },
  },
}

/** 记录 createElement 调用，用来做浅渲染。 */
let elementCalls = 0

/**
 * 极简 React 桩。
 *
 * `useState` 从一个预设队列里取值，这样组件会走"已经有数据"的分支，把整棵 JSX 都渲染一遍，
 * 而不是只停在"正在读取…"。
 */
function makeReactStub(stateQueue) {
  let index = 0
  return {
    createElement(type, props, ...children) {
      elementCalls += 1
      return { type, props: props ?? {}, children: children.flat().filter((child) => child !== null && child !== undefined) }
    },
    useState() {
      const value = stateQueue[Math.min(index, stateQueue.length - 1)]
      index += 1
      return [value, () => {}]
    },
    useEffect() {
      /* 浅渲染不跑副作用：fetch 之类的留给运行时 */
    },
    useCallback(fn) {
      return fn
    },
    useRef() {
      return { current: true }
    },
  }
}

/**
 * 把渲染出来的树压成字符串，方便断言"页面上确实有这段文字"。
 *
 * @param {any} node 元素
 * @returns {string} 全部文本
 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

await import('../client.js')

group('浏览器半边：ModuleLoader 契约')
{
  ok('加载时调用了 __ModuleLoader__.load', loaded !== null)
  eq('id 正确', loaded.id, 'dsh-mobile-console')
  eq('提供了 factory', typeof loaded.factory, 'function')

  const react = makeReactStub([])
  const module = loaded.factory((name) => {
    if (name === 'react') return react
    throw new Error(`没有打桩的依赖：${name}`)
  })

  eq('name 是包名', module.name, 'dsh-mobile-console')
  ok('声明了注入 slots', Array.isArray(module.inject) && module.inject.includes('slots'))
  eq('有 apply', typeof module.apply, 'function')
}

group('浏览器半边：注册进 settings.section')
{
  const react = makeReactStub([])
  const module = loaded.factory((name) => (name === 'react' ? react : undefined))

  let injectedSlot = ''
  let definition = null
  let render = null
  const ctx = {
    slots: {
      inject(slot, callback) {
        injectedSlot = slot
        callback()
      },
      register(def, fn) {
        definition = def
        render = fn
      },
    },
  }
  module.apply(ctx)

  eq('注册到 settings.section', injectedSlot, 'settings.section')
  ok('注册了定义', definition !== null)
  eq('id 正确', definition.id, 'dsh-mobile-console')
  eq('name 与插槽一致', definition.name, 'settings.section')
  eq('order 是数字', typeof definition.order, 'number')
  eq('label 是函数', typeof definition.label, 'function')
  ok('label 有可读文字', definition.label().length > 0)
  eq('渲染函数就位', typeof render, 'function')

  const element = render({})
  eq('渲染出一个元素', typeof element, 'object')
  ok('元素有类型', element.type !== undefined)
}

group('浏览器半边：拿到数据后能把整页渲染出来（浅渲染）')
{
  // 状态顺序：status、error、busy、copied、confirmRotate，最后是 useRef。
  const fixture = {
    enabled: true,
    port: 8799,
    clients: 2,
    url: 'http://192.168.1.5:8799/?k=deadbeefdeadbeefdeadbeefdeadbeef',
    urls: ['http://192.168.1.5:8799/?k=deadbeefdeadbeefdeadbeefdeadbeef'],
    qr: 'data:image/svg+xml;base64,PHN2Zy8+',
    tokenTail: 'beef',
    balance: { status: 'ready', currency: 'CNY', amount: '26.10', bonus: '2.74' },
    sessions: [
      { id: 'session-aaaaaaaaaaaaaaaa', title: '示例会话', status: 'running', armed: true, subagent: false, pending: 0 },
    ],
    pending: 1,
  }
  const react = makeReactStub([fixture, '', false, false, false, { current: true }])
  const module = loaded.factory((name) => (name === 'react' ? react : undefined))

  let render = null
  module.apply({
    slots: {
      inject: (_slot, callback) => callback(),
      register: (_def, fn) => {
        render = fn
      },
    },
  })

  const element = render({})
  const page = element.type() // 直接调用组件函数，拿到它的返回树
  const text = textOf(page)

  elementCalls = elementCalls // 保留计数，避免"没用上"的错觉
  ok('页面上出现配对地址', text.includes('http://192.168.1.5:8799/?k='))
  ok('页面上出现余额', text.includes('¥26.10'))
  ok('页面上出现会话标题', text.includes('示例会话'))
  ok('页面上有二维码图', JSON.stringify(page).includes('data:image/svg+xml;base64,'))
  ok('渲染确实产生了元素', elementCalls > 10)
}

group('浏览器半边：关闭状态下不给地址、而是给一句解释')
{
  const fixture = { enabled: false, port: 8799, clients: 0, url: '', urls: [], qr: '', tokenTail: 'beef', balance: { status: 'unknown' }, sessions: [], pending: 0 }
  const react = makeReactStub([fixture, '', false, false, false, { current: true }])
  const module = loaded.factory((name) => (name === 'react' ? react : undefined))

  let render = null
  module.apply({
    slots: {
      inject: (_slot, callback) => callback(),
      register: (_def, fn) => {
        render = fn
      },
    },
  })

  const text = textOf(render({}).type())
  ok('提示已关闭', text.includes('已关闭'))
  ok('解释了为什么没有地址', text.includes('不监听端口'))
  ok('没有伪造成一个地址', !text.includes('http://'))
}

report('浏览器半边')
