/*
 * DSH 手机控制台前端。
 *
 * 设计要点：
 *   1. 服务端每次变更推一份**完整快照**（SSE `state` 事件），前端只做整体渲染。
 *      数据量很小（会话 + 待办 + 最近动态），这样不会出现增量同步的状态 bug。
 *   2. 动态内容一律用 textContent / createElement 构建，绝不拼 innerHTML —— 会话标题
 *      和模型输出都是不可信文本。
 *   3. 正在输入时推迟重渲染，避免服务器推送把用户没发出去的字冲掉。
 */
(function () {
  'use strict'

  var $ = function (id) {
    return document.getElementById(id)
  }

  /** 最近一次服务端快照。 */
  var snapshot = null
  /** 当前视图名。 */
  var view = 'pending'
  /** 已展开的会话 id。 */
  var expanded = Object.create(null)
  /** 每个会话未发送的草稿。 */
  var drafts = Object.create(null)
  /** 提问的本地选择状态：`requestId -> questionId -> {selected:[], custom:''}`。 */
  var choices = Object.create(null)
  /** 上一轮待办数量，用来判断「有新请求」。 */
  var lastPendingCount = 0
  var firstSnapshot = true
  var pendingRender = false
  var toastTimer = null
  var audioCtx = null

  // ---------------------------------------------------------------- 工具

  function api(path, body) {
    var options = { credentials: 'same-origin', headers: {} }
    if (body !== undefined) {
      options.method = 'POST'
      options.headers['Content-Type'] = 'application/json'
      options.body = JSON.stringify(body)
    }
    return fetch(path, options).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {}
        })
        .then(function (data) {
          if (!response.ok) throw new Error(data && data.error ? data.error : 'HTTP ' + response.status)
          return data
        })
    })
  }

  function toast(message) {
    var node = $('toast')
    node.textContent = message
    node.hidden = false
    if (toastTimer !== null) clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      node.hidden = true
      toastTimer = null
    }, 2600)
  }

  function relative(ts) {
    if (typeof ts !== 'number' || ts <= 0) return ''
    var seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
    if (seconds < 5) return '刚刚'
    if (seconds < 60) return seconds + ' 秒前'
    var minutes = Math.floor(seconds / 60)
    if (minutes < 60) return minutes + ' 分钟前'
    var hours = Math.floor(minutes / 60)
    if (hours < 24) return hours + ' 小时前'
    return Math.floor(hours / 24) + ' 天前'
  }

  function countdown(expiresAt) {
    if (typeof expiresAt !== 'number' || expiresAt <= 0) return ''
    var seconds = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
    return '剩余 ' + seconds + ' 秒'
  }

  function clock(ts) {
    var date = new Date(ts)
    var pad = function (value) {
      return value < 10 ? '0' + value : String(value)
    }
    return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
  }

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function button(label, className, onClick) {
    var node = el('button', className || 'btn', label)
    node.type = 'button'
    node.addEventListener('click', onClick)
    return node
  }

  // ------------------------------------------------- 提醒（震动 + 提示音）

  function armAudio() {
    if (audioCtx !== null) {
      if (audioCtx.state === 'suspended') audioCtx.resume()
      return
    }
    var Ctor = window.AudioContext || window.webkitAudioContext
    if (!Ctor) return
    try {
      audioCtx = new Ctor()
      audioCtx.resume()
    } catch (error) {
      audioCtx = null
    }
  }

  function beep() {
    if (audioCtx === null) return
    try {
      var now = audioCtx.currentTime
      var osc = audioCtx.createOscillator()
      var gain = audioCtx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(880, now)
      osc.frequency.setValueAtTime(1180, now + 0.14)
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.exponentialRampToValueAtTime(0.22, now + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34)
      osc.connect(gain)
      gain.connect(audioCtx.destination)
      osc.start(now)
      osc.stop(now + 0.36)
    } catch (error) {
      /* 音频不可用时静默降级 */
    }
  }

  function alertNewPending(count) {
    try {
      if (navigator.vibrate) navigator.vibrate([0, 120, 80, 120])
    } catch (error) {
      /* 部分浏览器不支持震动 */
    }
    beep()
    document.title = '（' + count + ' 待处理）DSH 手机控制台'
  }

  // ---------------------------------------------------------------- 渲染

  function scheduleRender() {
    // 用户正在输入时不打断：等失焦后再画。
    var active = document.activeElement
    if (active && active.tagName === 'TEXTAREA') {
      pendingRender = true
      return
    }
    pendingRender = false
    render()
  }

  function render() {
    if (snapshot === null) return
    var list = snapshot.pending || []
    var count = list.length

    if (!firstSnapshot && count > lastPendingCount) alertNewPending(count)
    if (count === 0) document.title = 'DSH 手机控制台'
    lastPendingCount = count
    firstSnapshot = false

    renderPending(list)
    renderSessions(snapshot.sessions || [])
    renderFeed(snapshot.feed || [])
    renderSettings(snapshot)
    updateBadge(count)
  }

  function updateBadge(count) {
    var node = $('badge-pending')
    node.textContent = String(count)
    node.hidden = count === 0
  }

  function renderPending(list) {
    var host = $('pending-list')
    host.textContent = ''
    $('pending-empty').hidden = list.length > 0
    list.forEach(function (item) {
      host.appendChild(item.kind === 'question' ? renderQuestionCard(item) : renderApprovalCard(item))
    })
  }

  function headFor(item, pillClass, pillText) {
    var head = el('div', 'card-head')
    head.appendChild(el('span', 'pill ' + pillClass, pillText))
    head.appendChild(el('span', 'card-title grow', item.sessionTitle || item.sessionId))
    if (typeof item.expiresAt === 'number') {
      var left = el('span', 'pill', countdown(item.expiresAt))
      left.dataset.expires = String(item.expiresAt)
      head.appendChild(left)
    }
    return head
  }

  function renderApprovalCard(item) {
    var card = el('div', 'card is-pending')
    card.appendChild(headFor(item, 'pill-approval', '待审批'))
    card.appendChild(el('div', 'muted', '模型想要执行：' + (item.toolName || '未知操作')))
    var reason = item.displayReason || item.reason
    if (reason) card.appendChild(el('pre', 'text', reason))

    var actions = el('div', 'actions')
    actions.appendChild(button('允许一次', 'btn btn-ok', function () { answerApproval(card, item, 'allow') }))
    actions.appendChild(button('拒绝', 'btn btn-danger', function () { answerApproval(card, item, 'deny') }))
    card.appendChild(actions)
    return card
  }

  function renderQuestionCard(item) {
    var card = el('div', 'card is-pending')
    card.appendChild(headFor(item, 'pill-question', '待回答'))

    var state = choices[item.id]
    if (!state) {
      state = {}
      ;(item.questions || []).forEach(function (question) {
        state[question.id] = { selected: [], custom: '' }
      })
      choices[item.id] = state
    }

    ;(item.questions || []).forEach(function (question) {
      var box = el('div', 'question')
      if (question.header) box.appendChild(el('div', 'q-head', question.header))
      box.appendChild(el('p', 'q-text', question.question))
      if (question.detail) box.appendChild(el('p', 'q-detail', question.detail))

      var entry = state[question.id]
      ;(question.options || []).forEach(function (option) {
        var selected = entry.selected.indexOf(option.label) >= 0
        var node = el('button', 'option' + (selected ? ' selected' : ''))
        node.type = 'button'
        node.appendChild(el('div', 'option-label', option.label))
        if (option.description) node.appendChild(el('div', 'option-desc', option.description))
        node.addEventListener('click', function () {
          if (question.multiSelect) {
            var index = entry.selected.indexOf(option.label)
            if (index >= 0) entry.selected.splice(index, 1)
            else entry.selected.push(option.label)
          } else {
            entry.selected = [option.label]
          }
          scheduleRender()
        })
        box.appendChild(node)
      })

      var input = el('textarea')
      input.rows = 2
      input.placeholder = question.options && question.options.length ? '其它（可直接填写）' : '在此输入回答'
      input.value = entry.custom
      input.dataset.sessionId = item.id
      input.dataset.questionId = question.id
      input.addEventListener('input', function () {
        entry.custom = input.value
      })
      input.addEventListener('blur', function () {
        if (pendingRender) scheduleRender()
      })
      box.appendChild(input)
      card.appendChild(box)
    })

    var actions = el('div', 'actions')
    actions.appendChild(button('提交回答', 'btn btn-primary', function () { answerQuestion(card, item) }))
    card.appendChild(actions)
    return card
  }

  function renderSessions(sessions) {
    var host = $('session-list')
    host.textContent = ''
    $('sessions-empty').hidden = sessions.length > 0
    sessions.forEach(function (session) {
      host.appendChild(renderSessionCard(session))
    })
  }

  function renderSessionCard(session) {
    var card = el('div', 'card')
    var head = el('div', 'card-head')
    var running = session.status === 'running'
    head.appendChild(el('span', 'pill ' + (running ? 'pill-running' : 'pill-idle'), running ? '运行中' : '空闲'))
    if (session.pending > 0) head.appendChild(el('span', 'pill pill-approval', session.pending + ' 待办'))
    head.appendChild(el('span', 'card-title grow', session.title || session.id))
    var when = el('span', 'pill', relative(session.lastActivityAt))
    when.dataset.ts = String(session.lastActivityAt || 0)
    head.appendChild(when)
    card.appendChild(head)
    card.appendChild(el('div', 'muted mono', session.id))
    if (session.cwd) card.appendChild(el('div', 'muted', session.cwd))
    if (session.lastText) card.appendChild(el('pre', 'text', session.lastText))

    var actions = el('div', 'actions')
    actions.appendChild(
      button(session.armed ? '已武装 · 点此取消' : '武装（手机接管审批/提问）', session.armed ? 'btn btn-sm btn-ok' : 'btn btn-sm', function () {
        setArmed(session.id, !session.armed)
      }),
    )
    actions.appendChild(button(expanded[session.id] ? '收起' : '回复', 'btn btn-sm btn-primary', function () {
      expanded[session.id] = !expanded[session.id]
      scheduleRender()
    }))
    if (running) {
      actions.appendChild(button('停止本回合', 'btn btn-sm btn-danger', function () { stopSession(session.id) }))
    }
    card.appendChild(actions)

    if (expanded[session.id]) {
      var box = el('div')
      var input = el('textarea')
      input.rows = 3
      input.placeholder = '给这个会话发消息…'
      input.value = drafts[session.id] || ''
      input.addEventListener('input', function () {
        drafts[session.id] = input.value
      })
      input.addEventListener('blur', function () {
        if (pendingRender) scheduleRender()
      })
      var row = el('div', 'send-row')
      row.appendChild(input)
      row.appendChild(
        button('发送', 'btn btn-primary', function () {
          var text = drafts[session.id] || ''
          if (text.trim() === '') {
            toast('内容为空')
            return
          }
          sendMessage(session.id, text)
        }),
      )
      box.appendChild(row)

      var recent = (snapshot.feed || []).filter(function (item) {
        return item.sessionId === session.id
      })
      if (recent.length > 0) {
        var feed = el('div', 'feed')
        recent.slice(0, 5).forEach(function (item) {
          feed.appendChild(renderFeedItem(item))
        })
        box.appendChild(feed)
      }
      card.appendChild(box)
    }
    return card
  }

  function renderFeed(items) {
    var host = $('feed-list')
    host.textContent = ''
    $('feed-empty').hidden = items.length > 0
    items.forEach(function (item) {
      host.appendChild(renderFeedItem(item))
    })
  }

  function renderFeedItem(item) {
    var node = el('div', 'feed-item kind-' + (item.kind || 'info'))
    var meta = el('div', 'feed-meta')
    meta.appendChild(el('span', null, (item.sessionTitle || item.sessionId) + ' · ' + (item.kind === 'reply' ? '回复' : item.kind === 'sent' ? '已发送' : item.kind === 'error' ? '错误' : '动态')))
    meta.appendChild(el('span', null, clock(item.ts)))
    node.appendChild(meta)
    node.appendChild(el('div', 'feed-body', item.text))
    return node
  }

  function renderSettings(data) {
    var server = data.server || {}
    var box = $('pair-box')
    box.textContent = (server.urls && server.urls[0]) || '（未启动）'
    $('link-qr').href = '/qr.svg'

    var prefs = data.prefs || {}
    if (document.activeElement !== $('pref-timeout')) $('pref-timeout').value = String(prefs.relayTimeoutSec || 120)
    $('pref-autoarm').checked = prefs.autoArm === true

    var kv = $('conn-info')
    kv.textContent = ''
    var rows = [
      ['监听端口', String(server.port || '?')],
      ['本机地址', (server.hosts || []).join(' , ') || '（无局域网地址）'],
      ['在线手机', String(server.clients || 0)],
      ['令牌', server.tokenTail ? '…' + server.tokenTail : '?'],
    ]
    rows.forEach(function (row) {
      kv.appendChild(el('dt', null, row[0]))
      kv.appendChild(el('dd', null, row[1]))
    })
  }

  // ---------------------------------------------------------------- 交互

  function answerApproval(card, item, decision) {
    disable(card)
    api('/api/answer', { requestId: item.id, decision: decision })
      .then(function () {
        toast(decision === 'allow' ? '已允许' : '已拒绝')
      })
      .catch(function (error) {
        enable(card)
        toast('提交失败：' + error.message)
      })
  }

  function answerQuestion(card, item) {
    var state = choices[item.id] || {}
    var answers = (item.questions || []).map(function (question) {
      var entry = state[question.id] || { selected: [], custom: '' }
      var custom = (entry.custom || '').trim()
      var answer = { id: question.id, selected: entry.selected.slice() }
      if (custom !== '') answer.custom = custom
      return answer
    })
    var empty = answers.every(function (answer) {
      return answer.selected.length === 0 && !answer.custom
    })
    if (empty) {
      toast('请先选择或填写')
      return
    }
    disable(card)
    api('/api/answer', { requestId: item.id, answers: answers })
      .then(function () {
        toast('已提交')
      })
      .catch(function (error) {
        enable(card)
        toast('提交失败：' + error.message)
      })
  }

  function disable(card) {
    Array.prototype.forEach.call(card.querySelectorAll('button'), function (node) {
      node.disabled = true
    })
  }

  function enable(card) {
    Array.prototype.forEach.call(card.querySelectorAll('button'), function (node) {
      node.disabled = false
    })
  }

  function setArmed(sessionId, armed) {
    api('/api/arm', { sessionId: sessionId, armed: armed })
      .then(function () {
        toast(armed ? '已武装：手机将接管它的审批与提问' : '已取消武装')
      })
      .catch(function (error) {
        toast('操作失败：' + error.message)
      })
  }

  function stopSession(sessionId) {
    if (!window.confirm('确定要中止这个会话当前的回合吗？')) return
    api('/api/stop', { sessionId: sessionId })
      .then(function () {
        toast('已请求中止')
      })
      .catch(function (error) {
        toast('操作失败：' + error.message)
      })
  }

  function sendMessage(sessionId, text) {
    api('/api/send', { sessionId: sessionId, text: text })
      .then(function () {
        drafts[sessionId] = ''
        toast('已发送')
        scheduleRender()
      })
      .catch(function (error) {
        toast('发送失败：' + error.message)
      })
  }

  function savePrefs() {
    var timeout = parseInt($('pref-timeout').value, 10)
    api('/api/prefs', { autoArm: $('pref-autoarm').checked, relayTimeoutSec: timeout }).then(
      function () {
        toast('已保存')
      },
      function (error) {
        toast('保存失败：' + error.message)
      },
    )
  }

  function switchView(next) {
    view = next
    try {
      localStorage.setItem('mc.view', next)
    } catch (error) {
      /* 隐私模式下 localStorage 可能不可用 */
    }
    ;['pending', 'sessions', 'feed', 'settings'].forEach(function (name) {
      $('view-' + name).hidden = name !== next
    })
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
      tab.classList.toggle('active', tab.dataset.view === next)
    })
  }

  function setConn(state) {
    var dot = $('conn-dot')
    dot.className = 'dot ' + (state === 'live' ? 'dot-live' : state === 'connecting' ? 'dot-connecting' : 'dot-offline')
  }

  // ---------------------------------------------------------------- 数据流

  function connect() {
    setConn('connecting')
    var source = new EventSource('/api/events')
    source.addEventListener('open', function () {
      setConn('live')
    })
    source.addEventListener('state', function (event) {
      try {
        snapshot = JSON.parse(event.data)
      } catch (error) {
        return
      }
      setConn('live')
      scheduleRender()
    })
    source.addEventListener('error', function () {
      setConn('offline')
    })
    // EventSource 自己会重连；同时补一个兜底轮询，防止某些代理下静默卡死。
    setInterval(function () {
      if (source.readyState === EventSource.OPEN) return
      api('/api/state').then(
        function (data) {
          snapshot = data
          setConn('live')
          scheduleRender()
        },
        function () {
          setConn('offline')
        },
      )
    }, 8000)
  }

  function tick() {
    // 只更新相对时间与倒计时，不整体重渲染。
    Array.prototype.forEach.call(document.querySelectorAll('[data-ts]'), function (node) {
      node.textContent = relative(Number(node.dataset.ts))
    })
    Array.prototype.forEach.call(document.querySelectorAll('[data-expires]'), function (node) {
      node.textContent = countdown(Number(node.dataset.expires))
    })
  }

  /**
   * 应用内才显示「返回应用」按钮。
   *
   * 判断依据是地址里的 `mcapp=1` —— 那是 Android 应用打开控制台时加的标记。
   * 普通手机浏览器直接打开配对地址时没有它，也就没有"应用主页面"可回，
   * 那个按钮只会让人困惑，所以不显示。
   */
  function wireHomeButton() {
    var button = $('btn-home')
    if (!button) return
    if (location.search.indexOf('mcapp=1') < 0) return
    button.hidden = false
    button.addEventListener('click', function () {
      armAudio()
      var bridge = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Pairing
      if (bridge && typeof bridge.home === 'function') {
        bridge.home().catch(function () {
          toast('返回失败，请按系统返回键')
        })
      } else {
        toast('返回失败，请按系统返回键')
      }
    })
  }

  /**
   * 通知动作带来的位置提示：`#stop` / `#compose`。
   *
   * 通知上的「停止」「发消息」都只是把人送到控制台——停止一个正在跑的回合不可逆，
   * 值得在这里看清楚再点。这个函数负责把界面切到能看到那两个操作的地方。
   */
  function applyHashHint() {
    var hint = (location.hash || '').replace('#', '')
    if (hint === 'stop') {
      switchView('sessions')
      toast('在会话卡片上点「停止本回合」')
    } else if (hint === 'compose') {
      switchView('sessions')
      toast('点会话卡片里的输入框给智能体发消息')
    }
  }

  function boot() {
    try {
      var saved = localStorage.getItem('mc.view')
      if (saved) view = saved
    } catch (error) {
      /* 忽略 */
    }
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
      tab.addEventListener('click', function () {
        armAudio()
        switchView(tab.dataset.view)
      })
    })
    $('btn-settings').addEventListener('click', function () {
      armAudio()
      switchView(view === 'settings' ? 'pending' : 'settings')
    })
    $('btn-save-prefs').addEventListener('click', savePrefs)
    // 只有跑在 Android 应用里时才显示「返回应用」——普通手机浏览器里打开时，
    // 没有"应用主页面"可回，那个按钮只会让人困惑。
    wireHomeButton()
    applyHashHint()
    window.addEventListener('hashchange', applyHashHint)
    $('btn-reload').addEventListener('click', function () {
      location.reload()
    })
    $('btn-copy-url').addEventListener('click', function () {
      var url = ($('pair-box').textContent || '').trim()
      var done = function () {
        toast('已复制')
      }
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, function () { toast(url) })
      else toast(url)
    })
    document.addEventListener('blur', function () {
      if (pendingRender) scheduleRender()
    })
    document.addEventListener(
      'focusout',
      function () {
        if (pendingRender) scheduleRender()
      },
      true,
    )
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) scheduleRender()
    })
    switchView(view)
    setInterval(tick, 1000)
    api('/api/state').then(
      function (data) {
        snapshot = data
        render()
      },
      function () {
        setConn('offline')
      },
    )
    connect()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
