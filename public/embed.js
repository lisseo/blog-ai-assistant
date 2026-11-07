/**
 * AI Chat Assistant — Embed Script
 *
 * Injects a floating character bubble + iframe widget into any webpage.
 * The iframe loads /widget from the same origin as this script,
 * so all API calls are same-origin (no CORS issues).
 *
 * The launcher is a live SVG character driven by the Emotion Ball /
 * Mood Mates engine: it blinks, follows the pointer, and switches
 * expression as the assistant thinks, searches, replies, finishes or fails.
 *
 * Usage:
 *   <script src="https://chat.example.com/embed.js" async></script>
 *
 * Options (data-* attributes):
 *   data-character — "twinkle" (default) | "nimbo" | "ball"
 *   data-position  — "bottom-right" (default) | "bottom-left"
 *   data-color     — fallback icon color (only used if the engine fails to load)
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.__aiAssistantLoaded) return;
  window.__aiAssistantLoaded = true;

  var script = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (scripts[i].src && scripts[i].src.indexOf('embed.js') !== -1) return scripts[i];
    }
    return null;
  })();

  var origin = '';
  if (script && script.src) {
    try { origin = new URL(script.src).origin; } catch (e) {}
  }
  if (!origin) return;

  var color = (script && script.getAttribute('data-color')) || '#6366f1';
  var position = (script && script.getAttribute('data-position')) || 'bottom-right';
  var character = (script && script.getAttribute('data-character')) || 'twinkle';
  if (['nimbo', 'twinkle', 'ball'].indexOf(character) === -1) character = 'nimbo';
  var isBall = character === 'ball';
  var isLeft = position === 'bottom-left';
  var side = isLeft ? 'left' : 'right';

  // ─── Extract page context ────────────────────────────────────────────────
  // anzhiyu 主题的正文容器是 <article id="article-container">，优先命中它，
  // 并剥掉脚本/样式/隐藏元素，避免把导航噪音塞进 6000 字的上下文预算。
  function getPageContext() {
    var el =
      document.querySelector('#article-container') ||
      document.querySelector('article.post-content') ||
      document.querySelector('article') ||
      document.querySelector('[role="main"]') ||
      document.querySelector('main') ||
      document.querySelector('.post-content') ||
      document.querySelector('.entry-content');

    var content = '';
    if (el) {
      var clone = el.cloneNode(true);
      var noise = clone.querySelectorAll(
        'script, style, noscript, iframe, nav, button, ' +
        '.post-copyright, .post-reward, .relatedPosts, .post-tools, ' +
        '.ai-btn-group, .ai-btn-item, .tag_share, .post-share, ' +
        '#qrcode, .qr-code, .pagination, .ads-wrap'
      );
      for (var i = 0; i < noise.length; i++) {
        if (noise[i].parentNode) noise[i].parentNode.removeChild(noise[i]);
      }
      content = clone.innerText || clone.textContent || '';
    } else {
      content = document.body.innerText || '';
    }

    return {
      title: document.title || '',
      url: location.href || '',
      content: (content || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000)
    };
  }

  // ─── Styles ──────────────────────────────────────────────────────────────
  var css = document.createElement('style');
  css.textContent =
    '#__aa-bubble{position:fixed;bottom:18px;' + side + ':18px;z-index:2147483647;' +
    '-webkit-tap-highlight-color:transparent;touch-action:manipulation;' +
    'width:80px;height:80px;padding:0;border:none;outline:none;background:transparent;' +
    '-webkit-appearance:none;appearance:none;cursor:pointer;display:block;' +
    'transition:transform .3s cubic-bezier(.4,0,.2,1),opacity .3s}' +
    /* 极淡柔光背板：让浅色角色在白底上也能浮起来，深底则像一圈微光 */
    '#__aa-bubble::before{content:"";position:absolute;inset:4%;border-radius:50%;' +
    'background:radial-gradient(circle at 50% 45%,rgba(255,255,255,.72),rgba(255,255,255,.18) 62%,rgba(255,255,255,0) 76%);' +
    'box-shadow:0 4px 18px rgba(40,50,90,.10);pointer-events:none;' +
    'transition:box-shadow .35s,background .35s}' +
    /* 球球是白色圆球，白底下会糊掉，单独给背板加一圈浅灰边缘 */
    '#__aa-bubble[data-engine="eb"]::before{background:radial-gradient(circle at 50% 45%,' +
    'rgba(255,255,255,.95),rgba(226,232,246,.75) 68%,rgba(198,208,232,.35) 80%);' +
    'box-shadow:0 4px 18px rgba(40,50,90,.16),inset 0 0 0 1px rgba(120,134,170,.14)}' +
    '#__aa-bubble:hover{transform:scale(1.09) translateY(-2px)}' +
    '#__aa-bubble:active{transform:scale(.93)}' +
    '#__aa-mate{position:absolute;inset:-10%;display:block;pointer-events:none;' +
    'filter:drop-shadow(0 5px 8px rgba(22,28,54,.22));' +
    'transition:filter .35s,transform .35s}' +
    '#__aa-mate svg{display:block;width:100%;height:100%}' +
    /* 对话状态给一点体感：思考偏蓝、检索偏紫、出错偏红、完成偏金 */
    '#__aa-bubble[data-state="thinking"] #__aa-mate{filter:drop-shadow(0 0 12px rgba(108,140,240,.65))}' +
    '#__aa-bubble[data-state="searching"] #__aa-mate{filter:drop-shadow(0 0 12px rgba(158,116,232,.65))}' +
    '#__aa-bubble[data-state="replying"] #__aa-mate{filter:drop-shadow(0 0 10px rgba(96,178,214,.55))}' +
    '#__aa-bubble[data-state="done"] #__aa-mate{filter:drop-shadow(0 0 14px rgba(240,186,88,.7))}' +
    '#__aa-bubble[data-state="error"] #__aa-mate,' +
    '#__aa-bubble[data-state="refused"] #__aa-mate{filter:drop-shadow(0 0 12px rgba(226,91,91,.6))}' +
    '#__aa-bubble .aa-fallback-icon{display:block;width:100%;height:100%;' +
    'padding:19px;box-sizing:border-box;fill:#fff;border-radius:50%;' +
    'background:linear-gradient(135deg,' + color + ',' + color + 'dd);' +
    'box-shadow:0 8px 24px ' + color + '44}' +
    '#__aa-close-badge{position:absolute;right:-1px;top:-1px;width:20px;height:20px;' +
    'border-radius:50%;background:#20263a;color:#fff;font:600 15px/19px system-ui,sans-serif;' +
    'text-align:center;box-shadow:0 2px 7px rgba(0,0,0,.28);' +
    'opacity:0;transform:scale(.55);transition:opacity .2s,transform .2s;pointer-events:none}' +
    'body.__aa-open #__aa-close-badge{opacity:1;transform:scale(1)}' +
    '#__aa-frame{position:fixed;bottom:104px;' + side + ':20px;z-index:2147483646;' +
    'width:420px;height:640px;max-height:calc(100vh - 120px);max-width:calc(100vw - 40px);' +
    'border:none;border-radius:20px;' +
    'box-shadow:0 24px 64px rgba(0,0,0,.12),0 8px 24px rgba(0,0,0,.08),0 0 0 1px rgba(0,0,0,.04);' +
    'opacity:0;transform:translateY(12px) scale(.97);' +
    'transition:opacity .3s cubic-bezier(.4,0,.2,1),transform .3s cubic-bezier(.4,0,.2,1);' +
    'pointer-events:none;background:#fff;overflow:hidden}' +
    '#__aa-frame.open{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}' +
    '@media(max-width:480px){#__aa-frame{width:100vw;max-width:100vw;height:100vh;max-height:100vh;' +
    'bottom:0;' + side + ':0;left:0;border-radius:0}' +
    /* 手机端 iframe 全屏时气泡必须留在最上层，否则用户关不掉面板 */
    'body.__aa-open #__aa-bubble{top:8px;bottom:auto;width:46px;height:46px;opacity:.97}' +
    'body.__aa-open #__aa-close-badge{width:18px;height:18px;font-size:14px;line-height:17px}}';
  document.head.appendChild(css);

  // ─── Bubble ──────────────────────────────────────────────────────────────
  var bubble = document.createElement('button');
  bubble.id = '__aa-bubble';
  bubble.setAttribute('aria-label', '打开站内问答');

  var mateHost = document.createElement('span');
  mateHost.id = '__aa-mate';
  bubble.appendChild(mateHost);

  var badge = document.createElement('span');
  badge.id = '__aa-close-badge';
  badge.textContent = '×';
  bubble.appendChild(badge);

  document.body.appendChild(bubble);

  // 引擎加载失败时的降级：保留一个普通聊天气泡图标，绝不白屏
  var fallbackOn = false;
  function useFallback() {
    if (fallbackOn) return;
    fallbackOn = true;
    mateHost.style.display = 'none';
    bubble.insertAdjacentHTML('afterbegin',
      '<svg class="aa-fallback-icon" viewBox="0 0 24 24">' +
      '<path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.2L4 17.2V4h16v12z"/></svg>');
  }

  // ─── Iframe ──────────────────────────────────────────────────────────────
  var frame = document.createElement('iframe');
  frame.id = '__aa-frame';
  frame.src = origin + '/widget';
  frame.setAttribute('allow', 'clipboard-write');
  document.body.appendChild(frame);

  var contextSent = false;

  function sendContext() {
    if (!frame.contentWindow) return;
    frame.contentWindow.postMessage({
      type: '__aa_page_context',
      payload: getPageContext()
    }, origin);
    contextSent = true;
  }

  frame.addEventListener('load', function () {
    if (!contextSent) sendContext();
  });

  // anzhiyu 开了 pjax：站内换页只替换正文，本脚本不会重新执行，必须重发上下文
  document.addEventListener('pjax:complete', function () {
    setTimeout(sendContext, 150);
  });

  // SPA / 其它路由方式的兜底
  var lastUrl = location.href;
  setInterval(function () {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(sendContext, 500);
    }
  }, 1000);

  // ─── Emotion engine ──────────────────────────────────────────────────────
  // 两套引擎共用 window.EMOTION_SEED / EMOTION_GROUPS，同时加载会互相覆盖，
  // 所以按 data-character 只加载其中一套。
  // 源文件由 scripts/build-emotion.js 按依赖顺序合并成单文件，一次请求即可。
  var LIB = [isBall ? '/emotion/eb.js' : '/emotion/mm.js'];

  var mate = null;
  var pendingState = 'idle';

  // 对话状态 → 表情编号（00-09 生命周期 / 10-29 情绪 / 30-49 代理状态）
  var EMOTION = {
    idle:      '02',  // 待机放空
    open:      '10',  // 开心
    thinking:  '30',  // 思考中
    searching: '40',  // 检索资料
    replying:  '39',  // 输出回复
    done:      '33',  // 任务完成（带撒花）
    error:     '34',  // 出错
    refused:   '38',  // 拒绝 / 受限
    close:     '02'
  };

  var idleTimer = null;

  function setState(state) {
    pendingState = state;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }

    var id = EMOTION[state] || EMOTION.idle;
    bubble.setAttribute('data-state', state);
    bubble.setAttribute('data-emotion', id);

    if (!mate) return;
    try {
      mate.handleAIMessage({ emotionId: id });
      if (state === 'done' && typeof mate.burst === 'function') mate.burst(20);
      if (state === 'open' && typeof mate.bounce === 'function') mate.bounce();
    } catch (e) {}

    // 一次性状态播完回到待机，避免角色永远定格在「出错」或「撒花」
    if (state === 'done' || state === 'error' || state === 'refused' || state === 'open') {
      idleTimer = setTimeout(function () { setState('idle'); }, 2800);
    }
  }

  function loadOne(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.async = false;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('failed to load ' + url)); };
      document.head.appendChild(s);
    });
  }

  (function boot() {
    var chain = Promise.resolve();
    LIB.forEach(function (path) {
      chain = chain.then(function () { return loadOne(origin + path); });
    });
    chain.then(function () {
      var Ctor = isBall ? window.EmotionBall : window.MoodMates;
      if (!Ctor || typeof Ctor.create !== 'function') throw new Error('engine not available');
      bubble.setAttribute('data-engine', isBall ? 'eb' : 'mm');

      mate = Ctor.create(mateHost, {
        character: isBall ? undefined : character,
        shape: 'blob',
        emotion: '02',
        idle: false,           // 状态由对话驱动，不让待机策略抢走表情
        eyeScale: 1.45,        // 72px 小尺寸下放大眼睛保证可读
        fallbackId: '02',
        label: '站内问答助手'
      });

      setState(pendingState);
    }).catch(function (err) {
      console.warn('[AI Assistant] 表情引擎加载失败，回退默认图标：', err && err.message);
      useFallback();
    });
  })();

  // iframe 把 SSE 阶段通过 postMessage 送上来
  window.addEventListener('message', function (e) {
    if (e.origin !== origin) return;
    var d = e.data;
    if (!d || d.type !== '__aa_emotion') return;
    setState(d.state);
  });

  // 鼠标注视：相对气泡中心的归一化方向，全部在本机计算，不发送任何数据
  document.addEventListener('pointermove', function (e) {
    if (!mate || typeof mate.setGaze !== 'function') return;
    var r = bubble.getBoundingClientRect();
    var nx = (e.clientX - (r.left + r.width / 2)) / (window.innerWidth / 2);
    var ny = (e.clientY - (r.top + r.height / 2)) / (window.innerHeight / 2);
    try {
      mate.setGaze(Math.max(-1, Math.min(1, nx)), Math.max(-1, Math.min(1, ny)));
    } catch (err) {}
  }, { passive: true });

  // 标签页切到后台时停帧省电
  document.addEventListener('visibilitychange', function () {
    if (!mate || typeof mate.setActive !== 'function') return;
    try { mate.setActive(!document.hidden); } catch (err) {}
  });

  // ─── Toggle ──────────────────────────────────────────────────────────────
  var isOpen = false;
  bubble.addEventListener('click', function () {
    isOpen = !isOpen;
    frame.classList.toggle('open', isOpen);
    document.body.classList.toggle('__aa-open', isOpen);
    bubble.setAttribute('aria-label', isOpen ? '关闭站内问答' : '打开站内问答');
    if (isOpen) {
      sendContext();
      setState('open');
      if (mate && typeof mate.setActive === 'function') {
        try { mate.setActive(true); } catch (err) {}
      }
    } else {
      setState('close');
    }
  });
})();
