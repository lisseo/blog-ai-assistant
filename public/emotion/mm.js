/* Emotion engine bundle — MoodMates（云宝 / 亮亮）
 * 由 scripts/build-emotion.js 自动生成，请勿手工编辑。
 * 源：mm/geometry.js, render.js, features.js, fx.js, emotions.js, engine.js, nimbo.js, twinkle.js
 * 授权见 /emotion/NOTICE.md
 */

/* ==== mm/geometry.js ==== */

/* ============================================================
 * geometry.js —— 参数化轮廓生成库（Mood Mates 原创几何基座）
 *
 * 所有身体剪影与眼形轮廓均由本文件的参数化函数实时生成，
 * 仓库中不存在任何手绘 / 描摹的坐标数据。生成参数即设计语言，
 * 记录于 docs/DESIGN-PROVENANCE.md 作为原创证据。
 *
 * 坐标系：viewBox 0 0 240 240，头部中心 C = 120，基准半径 104
 *
 * 两类轮廓：
 *   身体环 BODY：96 点闭合折线，由径向函数 r(θ) 或参数曲线生成
 *   眼环   EYE ：48 点闭合折线，统一 lens（双缘包络）拓扑 ——
 *               中轴线 mid(u) + 厚度包络 halfThick(u) 上下缘各 24 点，
 *               所有眼形槽位共享同一拓扑，逐点插值形变天然连贯
 * ============================================================ */
(function () {
  'use strict';

  var MM = (window.MoodMates = window.MoodMates || {});
  var TAU = Math.PI * 2;

  var C = 120;          /* 头部中心 */
  var R = 104;          /* 身体基准半径 */
  var BODY_N = 96;      /* 身体环点数 */
  var EYE_N = 48;       /* 眼环点数（上下缘各 24） */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function r2(v) { return Math.round(v * 100) / 100; }

  /* ---------------- 身体环：径向函数采样 ----------------
   * radialFn(theta) 返回该方向上的半径（θ = 0 朝右，顺时针，屏幕坐标系）*/
  function sampleRadial(radialFn, opts) {
    opts = opts || {};
    var cx = opts.cx != null ? opts.cx : C;
    var cy = opts.cy != null ? opts.cy : C;
    var rot = opts.rot || 0;
    var ring = [];
    for (var i = 0; i < BODY_N; i++) {
      var th = TAU * i / BODY_N - Math.PI / 2 + rot;   /* 从正上方起步 */
      var r = radialFn(th);
      ring.push([r2(cx + r * Math.cos(th)), r2(cy + r * Math.sin(th))]);
    }
    return ring;
  }

  /* 平滑周期凸起：在 center 角附近宽 width 的钟形隆起（0~1） */
  function bump(th, center, width) {
    var d = Math.atan2(Math.sin(th - center), Math.cos(th - center));
    var x = clamp(1 - Math.abs(d) / width, 0, 1);
    return x * x * (3 - 2 * x);
  }

  var BODY_GEN = {
    /** 云朵：波浪扇贝边（lobes 花瓣数，amp 波幅） */
    cloud: function (p) {
      p = p || {};
      var base = (p.r || 0.98) * R;
      var lobes = p.lobes || 7;
      var amp = p.amp != null ? p.amp : 0.075;
      var flat = p.flat != null ? p.flat : 0.10;
      return sampleRadial(function (th) {
        var scallop = Math.pow(Math.abs(Math.sin(lobes * th / 2)), 1.4);
        /* 底部收平一点，像坐在地上的云 */
        var seat = 1 - flat * Math.pow(Math.max(0, Math.sin(th)), 3);
        return base * seat * (1 + amp * scallop);
      }, p);
    },

    /** 圆角星：points 角数，sharp 尖锐度（0 圆 ~ 1 尖），inner 内径比 */
    star: function (p) {
      p = p || {};
      var outer = (p.r || 1.04) * R;
      var inner = outer * (p.inner != null ? p.inner : 0.72);
      var pts = p.points || 5;
      var k = 1 + 3 * (p.sharp != null ? p.sharp : 0.55);
      return sampleRadial(function (th) {
        var w = Math.pow(0.5 + 0.5 * Math.cos(pts * (th + Math.PI / 2)), k);
        return inner + (outer - inner) * w;
      }, p);
    },

    /** 通用鼓包圆（备用 / 二次开发起点）：谐波扰动圆 */
    puff: function (p) {
      p = p || {};
      var base = (p.r || 1) * R;
      var waves = p.waves || [];
      return sampleRadial(function (th) {
        var v = 1;
        for (var i = 0; i < waves.length; i++) {
          var w = waves[i];
          v += (w.amp || 0) * Math.sin((w.k || 2) * th + (w.phase || 0));
        }
        return base * v;
      }, p);
    }
  };

  /** 生成身体环：desc = { type, ...params } */
  function buildBody(desc) {
    var gen = BODY_GEN[desc.type];
    if (!gen) throw new Error('[MoodMates] 未知身体生成器：' + desc.type);
    return gen(desc);
  }

  /* ---------------- 眼环：lens 双缘包络拓扑 ----------------
   * 参数（均为相对眼睛盒子的比例）：
   *   w, h      眼宽 / 眼高（绝对 px）
   *   bend      中轴弯曲：>0 上拱（笑眼 ∩），<0 下垂
   *   slope     中轴斜率：>0 外高内低（配合 mirror 表达怒 / 哀）
   *   taper     厚度端部收尖指数（0.3 圆角矩形感 ~ 2.5 两端极尖）
   *   shift     厚度重心偏移：>0 下缘更鼓，<0 上缘更鼓
   *   tilt      整体旋转（度）
   * mirror = -1 时水平镜像（右眼），slope / tilt 自动反向 */
  function lens(cx, cy, o, mirror) {
    mirror = mirror || 1;
    var w = o.w, h = o.h;
    var bend = (o.bend || 0) * h;
    var slope = (o.slope || 0) * h * mirror;
    var taper = o.taper != null ? o.taper : 0.55;
    var shift = o.shift || 0;
    var tiltRad = (o.tilt || 0) * Math.PI / 180 * mirror;

    /* 闭合曲线参数化采样：φ 绕行一周，u = (1-cosφ)/2 令采样点自然向两端加密；
     * 上下缘在端点汇合为「单点」——过点样条不经过重复点、不会折出尖角，
     * 端部密采样 + 无重复点 → 端帽圆润，与解析胶囊同级的干净边缘 */
    var ring = [];
    var cs = Math.cos(tiltRad), sn = Math.sin(tiltRad);
    for (var k = 0; k < EYE_N; k++) {
      var phi = TAU * k / EYE_N;
      var u = (1 - Math.cos(phi)) / 2;           /* 0 左端 → 1 右端 → 折回 */
      var x = (u - 0.5) * w * mirror;
      var arch = Math.sin(Math.PI * u);          /* 端点 0，中间 1 */
      var mid = -bend * arch + slope * (u - 0.5);
      var th = (h / 2) * Math.pow(arch, taper);
      /* φ ∈ (0,π) 走上缘，(π,2π) 走下缘 */
      var y = Math.sin(phi) >= 0 ? mid - th * (1 - shift) : mid + th * (1 + shift);
      ring.push([r2(cx + x * cs - y * sn), r2(cy + x * sn + y * cs)]);
    }
    return ring;
  }

  /* ---------------- 眼形语义槽位 ----------------
   * 每个槽位是 style（角色眼型基调）→ lens 参数的映射。
   * style: { w, h, taper, tilt, bend } 角色级默认值 */
  var EYE_SLOTS = {
    /* 平静注视 */
    calm:    function (s) { return { w: s.w, h: s.h, bend: s.bend, taper: s.taper, tilt: s.tilt }; },
    calm2:   function (s) { return { w: s.w * 0.96, h: s.h * 1.05, bend: s.bend + 0.04, taper: s.taper, tilt: s.tilt }; },
    /* 笑眼（∩ 拱） */
    happy:   function (s) { return { w: s.w * 1.05, h: s.h * 0.5, bend: 0.62, taper: 1.15, tilt: s.tilt }; },
    happy2:  function (s) { return { w: s.w * 1.1, h: s.h * 0.42, bend: 0.5, taper: 0.9, tilt: s.tilt + 2 }; },
    /* 圆睁 */
    wide:    function (s) { return { w: s.w * 1.12, h: s.h * 1.3, bend: 0, taper: Math.max(s.taper * 0.8, 0.3), tilt: 0 }; },
    wide2:   function (s) { return { w: s.w * 1.05, h: s.h * 1.42, bend: 0.05, taper: Math.max(s.taper * 0.7, 0.3), tilt: 0 }; },
    /* 闭合 / 困倦 */
    closed:  function (s) { return { w: s.w * 0.95, h: s.h * 0.12, bend: -0.25, taper: 0.9, tilt: s.tilt }; },
    closed2: function (s) { return { w: s.w * 0.9, h: s.h * 0.1, bend: 0.2, taper: 0.9, tilt: s.tilt }; },
    sleepy:  function (s) { return { w: s.w, h: s.h * 0.34, bend: -0.3, taper: 0.7, shift: 0.35, tilt: s.tilt }; },
    /* 斜眼 / 无奈 */
    squint:  function (s) { return { w: s.w * 1.02, h: s.h * 0.5, bend: 0.05, slope: 0.35, taper: 0.7, tilt: s.tilt }; },
    squint2: function (s) { return { w: s.w * 0.96, h: s.h * 0.44, bend: -0.1, slope: 0.3, taper: 0.8, tilt: s.tilt + 3 }; },
    /* 怒目：内低外高 + 上缘压平 */
    angry:   function (s) { return { w: s.w * 1.02, h: s.h * 0.72, bend: 0.1, slope: -0.5, taper: 0.6, shift: 0.3, tilt: s.tilt }; },
    angry2:  function (s) { return { w: s.w * 0.98, h: s.h * 0.62, bend: 0.05, slope: -0.62, taper: 0.65, shift: 0.35, tilt: s.tilt }; },
    /* 扫读：宽扁横条 */
    scan:    function (s) { return { w: s.w * 1.3, h: s.h * 0.46, bend: 0, taper: 0.45, tilt: 0 }; },
    scan2:   function (s) { return { w: s.w * 1.18, h: s.h * 0.56, bend: 0.08, taper: 0.5, tilt: 0 }; },
    scan3:   function (s) { return { w: s.w * 1.36, h: s.h * 0.38, bend: -0.06, taper: 0.42, tilt: 0 }; },
    /* 聆听：窄高竖圆 */
    listen:  function (s) { return { w: s.w * 0.78, h: s.h * 1.18, bend: 0, taper: Math.max(s.taper * 0.85, 0.35), tilt: 0 }; },
    listen2: function (s) { return { w: s.w * 0.72, h: s.h * 1.08, bend: 0.08, taper: Math.max(s.taper * 0.85, 0.35), tilt: s.tilt }; },
    /* 羞怯：下垂微闭，外角向下 */
    shy:     function (s) { return { w: s.w * 0.92, h: s.h * 0.6, bend: -0.18, slope: 0.22, taper: 0.85, tilt: s.tilt + 4 }; },
    /* 哀伤：外低内高 */
    sad:     function (s) { return { w: s.w * 0.95, h: s.h * 0.62, bend: -0.1, slope: 0.45, taper: 0.75, tilt: s.tilt }; }
  };

  /** 生成一对眼环（含左右镜像）
   *  style: { dx, cy, w, h, taper, tilt, bend } —— dx 为眼心到面部中线的距离 */
  function buildEyePair(slotName, style) {
    var slotFn = EYE_SLOTS[slotName];
    if (!slotFn) throw new Error('[MoodMates] 未知眼形槽位：' + slotName);
    var o = slotFn(style);
    var L = lens(C - style.dx, style.cy, o, 1);
    var Rr = lens(C + style.dx, style.cy, o, -1);
    return [L, Rr];
  }

  /** 生成一套完整眼环族：slotName → [左, 右] */
  function buildEyeFamily(style) {
    var fam = {};
    for (var name in EYE_SLOTS) fam[name] = buildEyePair(name, style);
    return fam;
  }

  /* ---------------- 嘴巴：同 lens 拓扑（24 点小环） ----------------
   * 槽位含闭合线形嘴与张开圆嘴，共享拓扑可自由形变 */
  var MOUTH_N = 24;

  function mouthLens(o) {
    var w = o.w, h = o.h;
    var bend = (o.bend || 0) * Math.max(h, 4);
    var taper = o.taper != null ? o.taper : 0.8;
    /* 与 lens 同款闭合参数化：端点单点汇合 + 端部密采样，嘴角圆润 */
    var ring = [];
    for (var k = 0; k < MOUTH_N; k++) {
      var phi = TAU * k / MOUTH_N;
      var u = (1 - Math.cos(phi)) / 2;
      var x = (u - 0.5) * w;
      var arch = Math.sin(Math.PI * u);
      var mid = -bend * arch;
      var th = (h / 2) * Math.pow(arch, taper);
      var y = Math.sin(phi) >= 0 ? mid - th : mid + th;
      ring.push([r2(x), r2(y)]);
    }
    return ring;
  }

  /* base: { w } —— 角色嘴宽基准；槽位内高度 / 弯曲写死为语义 */
  var MOUTH_SLOTS = {
    smile:  function (b) { return mouthLens({ w: b.w, h: 3.2, bend: -0.9, taper: 0.9 }); },
    grin:   function (b) { return mouthLens({ w: b.w * 1.25, h: 11, bend: -0.55, taper: 0.6 }); },
    o:      function (b) { return mouthLens({ w: b.w * 0.5, h: b.w * 0.52, bend: 0, taper: 0.4 }); },
    flat:   function (b) { return mouthLens({ w: b.w * 0.8, h: 2.6, bend: 0, taper: 0.9 }); },
    frown:  function (b) { return mouthLens({ w: b.w * 0.85, h: 3, bend: 0.85, taper: 0.9 }); },
    wavy:   function (b) { return mouthLens({ w: b.w, h: 3, bend: -0.15, taper: 0.5 }); },
    pout:   function (b) { return mouthLens({ w: b.w * 0.42, h: 3.4, bend: 0.5, taper: 0.5 }); },
    open:   function (b) { return mouthLens({ w: b.w * 0.72, h: b.w * 0.5, bend: -0.25, taper: 0.45 }); },
    dot:    function (b) { return mouthLens({ w: b.w * 0.2, h: b.w * 0.18, bend: 0, taper: 0.4 }); }
  };

  function buildMouth(slotName, base) {
    var fn = MOUTH_SLOTS[slotName] || MOUTH_SLOTS.flat;
    return fn(base);
  }

  /* ---------------- 自定义轮廓（每表情专属轮廓组入口） ----------------
   * 角色可在 eyeShapes / mouthShapes 里用原始 lens 参数定义专属轮廓，
   * 表情覆盖的 pool / mouth 即可引用这些自定义名字 */

  /** 自定义眼形对：o 为原始 lens 参数（w/h/bend/slope/taper/shift/tilt），
   *  位置沿用角色 style 的 dx / cy */
  function buildCustomEyePair(o, style) {
    var merged = Object.assign({ w: style.w, h: style.h, taper: style.taper, tilt: style.tilt, bend: style.bend }, o);
    return [lens(C - style.dx, style.cy, merged, 1), lens(C + style.dx, style.cy, merged, -1)];
  }

  /** 自定义嘴形：o 为原始 mouthLens 参数（w/h/bend/taper） */
  function buildCustomMouth(o) {
    return mouthLens(Object.assign({ w: 24, h: 3, bend: 0, taper: 0.8 }, o));
  }

  MM.geo = {
    C: C,
    R: R,
    BODY_N: BODY_N,
    EYE_N: EYE_N,
    MOUTH_N: MOUTH_N,
    buildBody: buildBody,
    buildEyePair: buildEyePair,
    buildEyeFamily: buildEyeFamily,
    buildMouth: buildMouth,
    buildCustomEyePair: buildCustomEyePair,
    buildCustomMouth: buildCustomMouth,
    eyeSlots: Object.keys(EYE_SLOTS),
    mouthSlots: Object.keys(MOUTH_SLOTS),
    bodyTypes: Object.keys(BODY_GEN),
    lens: lens,
    sampleRadial: sampleRadial
  };
})();


/* ==== mm/render.js ==== */

/* ============================================================
 * render.js —— 渲染层（纯渲染，不含业务逻辑）
 *
 *   坐标系：viewBox 0 0 240 240，头部中心 C = 120
 *
 *   身体（高端质感）：
 *     4 停靠径向渐变（顶光→本色→边缘收深）+ 釉面高光斑 + 地面软投影，
 *     投影随弹跳升离地面自动收缩变淡
 *
 *   眼睛（两种模式，物理正确）：
 *     bean  豆眼：整个 lens 环即眼睑剪影，闭眼 = 剪影压扁（原有模式）
 *     iris  瞳孔眼：lens 环作为眼睑开口 clipPath，内部依次渲染
 *           眼白 → 虹膜（径向渐变）→ 瞳孔 → 定光源高光。
 *           闭眼 = 眼睑闭合裁掉整个眼球，瞳孔绝不会悬浮在闭眼之外；
 *           小眼（眯/扫读）藏白色高光、瞳孔按比例缩小；注视时瞳孔钳制在眼环 bbox 内。
 *           高光保持光源方位不动 —— 符合真实眼球转动的观感
 *
 *   五官 / 配饰：见 features.js（配饰联动系统）
 *   特效：见 fx.js（发射器 + 签名动作）
 *   球面投影：按眼睛当前高度采样身体轮廓局部半宽，经度换算 + 余弦压缩，
 *            自旋偏航绕到背面自动隐藏（cos <= 0.02 判定）
 *   zzz：睡眠状态右上角循环漂浮的字母粒子
 * ============================================================ */
(function () {
  'use strict';

  var MM = (window.MoodMates = window.MoodMates || {});
  var SVGNS = 'http://www.w3.org/2000/svg';
  var uid = 0;

  var C = 120;   /* 与 geometry.js 保持一致 */

  function el(tag, attrs) {
    var node = document.createElementNS(SVGNS, tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }
  function r2(v) { return Math.round(v * 100) / 100; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function shade(hex, amt) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var target = amt < 0 ? 0 : 255;
    var a = Math.abs(amt);
    r = Math.round(r + (target - r) * a);
    g = Math.round(g + (target - g) * a);
    b = Math.round(b + (target - b) * a);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  /* 轮廓环 → 平滑闭合曲线 path
   * Catmull-Rom → 三次贝塞尔：折线顶点在放大后会露出多边形棱角（锯齿感），
   * 用过点样条把每段换成 C 曲线，任意采样密度下边缘都圆润 */
  function ringPath(ring) {
    var n = ring.length;
    if (n < 3) return 'M0 0Z';
    var s = 'M' + ring[0][0].toFixed(2) + ' ' + ring[0][1].toFixed(2);
    for (var i = 0; i < n; i++) {
      var p0 = ring[(i - 1 + n) % n];
      var p1 = ring[i];
      var p2 = ring[(i + 1) % n];
      var p3 = ring[(i + 2) % n];
      s += 'C' + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(2) + ' ' + (p1[1] + (p2[1] - p0[1]) / 6).toFixed(2) +
           ' ' + (p2[0] - (p3[0] - p1[0]) / 6).toFixed(2) + ' ' + (p2[1] - (p3[1] - p1[1]) / 6).toFixed(2) +
           ' ' + p2[0].toFixed(2) + ' ' + p2[1].toFixed(2);
    }
    return s + 'Z';
  }
  function centroid(ring) {
    var x = 0, y = 0;
    for (var i = 0; i < ring.length; i++) { x += ring[i][0]; y += ring[i][1]; }
    return [x / ring.length, y / ring.length];
  }
  /** 轮廓实际厚度 = 鞋带面积 / 包围盒宽度。
   *  拱形笑眼（∩）包围盒虽高但实际很薄，用厚度才能正确判定闭合感 */
  function ringThickness(ring) {
    var area = 0, minX = 1e9, maxX = -1e9;
    for (var i = 0; i < ring.length; i++) {
      var a = ring[i], b = ring[(i + 1) % ring.length];
      area += a[0] * b[1] - b[0] * a[1];
      if (a[0] < minX) minX = a[0];
      if (a[0] > maxX) maxX = a[0];
    }
    var w = Math.max(maxX - minX, 1);
    return Math.abs(area) / 2 / w;
  }
  function ringBBox(ring) {
    var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (var i = 0; i < ring.length; i++) {
      var p = ring[i];
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    return { minX: minX, maxX: maxX, minY: minY, maxY: maxY, w: maxX - minX, h: maxY - minY };
  }
  /* 盒子过窄时取中点，避免 inset 后 lo > hi */
  function clampIn(v, lo, hi) {
    if (lo > hi) return (lo + hi) / 2;
    return clamp(v, lo, hi);
  }
  var BEAN_HL_MIN_H = 10;   /* 豆眼高光：有效可见高度低于此才隐藏（真正闭眼/笑成弧线） */
  var BEAN_HL_FULL_H = 26;  /* 高光点满尺寸的可见高度；更小的眼形按比例缩小高光点 */
  var IRIS_LASH = 0.26;     /* 睫线：effOpen 低于此隐藏虹膜/瞳孔/高光 */
  var IRIS_SMALL = 0.45;    /* 小眼：介于睫线与此之间只留虹膜 */

  /**
   * createBall(container, opts)
   *   opts.character —— 已解析的角色定义（引擎负责解析），包含：
   *     bodyRing / face / palette / eyeStyle / features / fxSkin / defaultEyeRing
   */
  function createBall(container, opts) {
    opts = opts || {};
    var id = 'mm' + (uid++);
    var lite = !!opts.lite;
    var ch = opts.character;
    var face = ch.face;
    var headRing = ch.bodyRing;
    var palette = ch.palette;
    var feats = ch.features || {};
    var pupilCfg = ch.eyeStyle.pupil || null;

    /* ---- 形状轮廓采样：每 2px 一行的 [minX, maxX]，供五官贴合任意剪影 ---- */
    var silMinY = 1e9, silMaxY = -1e9, silMaxW = 0;
    var i;
    for (i = 0; i < headRing.length; i++) {
      if (headRing[i][1] < silMinY) silMinY = headRing[i][1];
      if (headRing[i][1] > silMaxY) silMaxY = headRing[i][1];
    }
    var SIL_STEP = 2;
    var silRows = [];
    (function buildSil() {
      var rows = Math.ceil((silMaxY - silMinY) / SIL_STEP) + 1;
      for (var r = 0; r < rows; r++) {
        var y = silMinY + r * SIL_STEP;
        var lo = 1e9, hi = -1e9;
        for (var e = 0; e < headRing.length; e++) {
          var a = headRing[e], b = headRing[(e + 1) % headRing.length];
          var y0 = a[1], y1 = b[1];
          if ((y0 <= y && y1 >= y) || (y1 <= y && y0 >= y)) {
            var t = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
            var x = a[0] + (b[0] - a[0]) * t;
            if (x < lo) lo = x;
            if (x > hi) hi = x;
          }
        }
        if (lo > hi) { lo = C - 4; hi = C + 4; }
        silRows.push([lo, hi]);
        if (hi - lo > silMaxW) silMaxW = hi - lo;
      }
    })();
    function silAt(y) {
      var r = Math.round((clamp(y, silMinY, silMaxY) - silMinY) / SIL_STEP);
      return silRows[clamp(r, 0, silRows.length - 1)];
    }

    /* ---- SVG 骨架 ---- */
    var svg = el('svg', {
      viewBox: '0 0 240 240',
      width: '100%',
      height: '100%',
      role: 'img',
      'aria-label': opts.label || ch.name || 'Mood Mates 角色'
    });
    svg.style.display = 'block';
    svg.style.overflow = 'visible';

    var defs = el('defs', {});
    svg.appendChild(defs);

    /* 身体渐变：顶光 → 提亮 → 本色 → 边缘收深（伪 3D 体积） */
    var grad = el('radialGradient', { id: id + 'g', cx: '36%', cy: '26%', r: '86%' });
    var stops = [
      el('stop', { offset: '0%' }),
      el('stop', { offset: '38%' }),
      el('stop', { offset: '78%' }),
      el('stop', { offset: '100%' })
    ];
    stops.forEach(function (s) { grad.appendChild(s); });
    defs.appendChild(grad);

    /* 釉面高光渐变（白 → 透明） */
    var glossGrad = el('radialGradient', { id: id + 'gl', cx: '50%', cy: '42%', r: '58%' });
    glossGrad.appendChild(el('stop', { offset: '0%', 'stop-color': '#FFFFFF', 'stop-opacity': '0.9' }));
    glossGrad.appendChild(el('stop', { offset: '68%', 'stop-color': '#FFFFFF', 'stop-opacity': '0.22' }));
    glossGrad.appendChild(el('stop', { offset: '100%', 'stop-color': '#FFFFFF', 'stop-opacity': '0' }));
    defs.appendChild(glossGrad);

    /* 地面投影渐变（黑 → 透明） */
    var shGrad = el('radialGradient', { id: id + 'sh', cx: '50%', cy: '50%', r: '50%' });
    shGrad.appendChild(el('stop', { offset: '0%', 'stop-color': '#000000', 'stop-opacity': '0.9' }));
    shGrad.appendChild(el('stop', { offset: '72%', 'stop-color': '#000000', 'stop-opacity': '0.32' }));
    shGrad.appendChild(el('stop', { offset: '100%', 'stop-color': '#000000', 'stop-opacity': '0' }));
    defs.appendChild(shGrad);

    /* 虹膜渐变（瞳孔眼用）：上深下亮，模拟入射光在虹膜下缘的散射 */
    var irisGrad = null;
    if (pupilCfg) {
      var irisColor = pupilCfg.irisColor || palette.eye;
      irisGrad = el('radialGradient', { id: id + 'ir', cx: '50%', cy: '38%', r: '72%' });
      irisGrad.appendChild(el('stop', { offset: '0%', 'stop-color': shade(irisColor, -0.25) }));
      irisGrad.appendChild(el('stop', { offset: '62%', 'stop-color': irisColor }));
      irisGrad.appendChild(el('stop', { offset: '100%', 'stop-color': shade(irisColor, 0.28) }));
      defs.appendChild(irisGrad);
    }

    /* ---- 地面软投影（不随身体旋转，只跟位移 / 起跳收缩） ---- */
    var shadowRy = 7;
    var shadowCy = Math.min(silMaxY + 6, 234);
    var shadow = el('ellipse', {
      cx: C, cy: shadowCy,
      rx: r2(silMaxW * 0.36), ry: shadowRy,
      fill: 'url(#' + id + 'sh)', opacity: '0.16',
      'pointer-events': 'none'
    });
    svg.appendChild(shadow);

    var fxBack = el('g', { 'pointer-events': 'none' });
    svg.appendChild(fxBack);

    var bodyG = el('g', {});

    /* 背层配饰（帽子 / 提手等从身体后面探出的部分） */
    var featureCtx = {
      el: el, ringPath: ringPath, r2: r2, clamp: clamp, shade: shade,
      C: C, face: face, palette: palette, eyeStyle: ch.eyeStyle, silAt: silAt,
      silMinY: silMinY, silMaxY: silMaxY, defs: defs, uid: id
    };
    var featureLayer = MM.createFeatures
      ? MM.createFeatures(bodyG, feats, featureCtx)
      : null;
    if (featureLayer && featureLayer.back) bodyG.appendChild(featureLayer.back);

    var head = el('path', { d: ringPath(headRing), fill: 'url(#' + id + 'g)', stroke: 'none', 'stroke-width': '2' });
    bodyG.appendChild(head);

    /* 釉面高光斑：贴着剪影左上方，跟随身体一切变换；
     * 用身体剪影 clipPath 裁剪，避免在星形 / 云朵等凹形轮廓上溢出体外 */
    var glossAmt = palette.gloss != null ? palette.gloss : 0.3;
    var gloss = null;
    if (glossAmt > 0) {
      var glossClip = el('clipPath', { id: id + 'bc', clipPathUnits: 'userSpaceOnUse' });
      glossClip.appendChild(el('path', { d: ringPath(headRing) }));
      defs.appendChild(glossClip);
      /* 裁剪组不带 transform，确保 clip 与静态身体环精确对齐 */
      var glossWrap = el('g', { 'clip-path': 'url(#' + id + 'bc)', 'pointer-events': 'none' });
      gloss = el('ellipse', {
        cx: r2(C - silMaxW * 0.17),
        cy: r2(silMinY + (silMaxY - silMinY) * 0.2),
        rx: r2(silMaxW * 0.15),
        ry: r2((silMaxY - silMinY) * 0.1),
        fill: 'url(#' + id + 'gl)',
        opacity: String(glossAmt),
        transform: 'rotate(-24 ' + r2(C - silMaxW * 0.17) + ' ' + r2(silMinY + (silMaxY - silMinY) * 0.2) + ')'
      });
      glossWrap.appendChild(gloss);
      bodyG.appendChild(glossWrap);
    }

    /* 底部环境光遮蔽（AO）：身体下缘轻微压暗，增强体积贴地感 */
    var aoGrad = el('linearGradient', { id: id + 'ao', x1: '0%', y1: '0%', x2: '0%', y2: '100%' });
    aoGrad.appendChild(el('stop', { offset: '58%', 'stop-color': '#000000', 'stop-opacity': '0' }));
    aoGrad.appendChild(el('stop', { offset: '100%', 'stop-color': '#000000', 'stop-opacity': '0.14' }));
    defs.appendChild(aoGrad);
    var ao = el('path', { d: ringPath(headRing), fill: 'url(#' + id + 'ao)', 'pointer-events': 'none' });
    bodyG.appendChild(ao);

    /* 腮红在眼睛之下、身体之上 */
    if (featureLayer && featureLayer.mid) bodyG.appendChild(featureLayer.mid);

    var EYE_HALF = ch.eyeStyle.h / 2;

    /* ============ 眼睛构建 ============
     * bean：单 path（原有模式）
     * iris：g[clip] > 眼白 path + 虹膜 + 瞳孔 + 高光（clipPath 引用眼睑环） */
    function buildEye(k) {
      var ring0 = ch.defaultEyeRing[k];
      var base = centroid(ring0);
      var eye = { ring: ring0, c: base, base: base, k: k,
        defBBox: ringBBox(ring0), bbox: ringBBox(ring0), thick: ringThickness(ring0) };

      if (!pupilCfg) {
        /* ---- bean 豆眼 ---- */
        eye.mode = 'bean';
        eye.node = el('path', { fill: palette.eye, stroke: 'none', 'stroke-width': '1.6', d: ringPath(ring0) });
        if (ch.eyeStyle.highlight) {
          var hls = ch.eyeStyle.highlight;
          eye.hls = (Array.isArray(hls) ? hls : [hls]).map(function (h) {
            return {
              cfg: h,
              node: el('circle', {
                r: h.r || 3, fill: h.color || palette.eyeHighlight || '#FFFFFF',
                opacity: h.opacity != null ? h.opacity : 0.92, 'pointer-events': 'none'
              })
            };
          });
        }
        return eye;
      }

      /* ---- iris 瞳孔眼 ---- */
      eye.mode = 'iris';
      eye.thick = ringThickness(ring0);
      var clipId = id + 'ec' + k;
      var cp = el('clipPath', { id: clipId, clipPathUnits: 'userSpaceOnUse' });
      eye.lidClip = el('path', { d: ringPath(ring0) });
      cp.appendChild(eye.lidClip);
      defs.appendChild(cp);

      eye.node = el('g', {});
      var inner = el('g', { 'clip-path': 'url(#' + clipId + ')' });
      eye.inner = inner;

      /* 眼白（与眼睑开口同形同步缩放） */
      eye.socket = el('path', {
        d: ringPath(ring0),
        fill: pupilCfg.socket || '#FFFFFF'
      });
      inner.appendChild(eye.socket);

      /* 虹膜 + 瞳孔（正圆，不随眼睑压扁，闭眼时被裁剪） */
      var irisR = pupilCfg.irisR || EYE_HALF * 0.86;
      var pupilR = pupilCfg.pupilR || irisR * 0.52;
      eye.irisR = irisR;
      eye.pupilR = pupilR;
      eye.iris = el('circle', { r: irisR, fill: 'url(#' + id + 'ir)' });
      eye.pupil = el('circle', { r: pupilR, fill: pupilCfg.pupilColor || shade(pupilCfg.irisColor || palette.eye, -0.72) });
      inner.appendChild(eye.iris);
      inner.appendChild(eye.pupil);

      /* 定光源高光：主高光 + 副光点，不随眼球转动（光源方位不变） */
      var hlList = pupilCfg.highlights || [
        { dx: -irisR * 0.34, dy: -irisR * 0.4, r: irisR * 0.3 },
        { dx: irisR * 0.36, dy: irisR * 0.22, r: irisR * 0.13, opacity: 0.6 }
      ];
      eye.hlNodes = hlList.map(function (h) {
        var n = el('circle', {
          r: h.r, fill: h.color || '#FFFFFF',
          opacity: h.opacity != null ? h.opacity : 0.95,
          'pointer-events': 'none'
        });
        inner.appendChild(n);
        return { cfg: h, node: n };
      });

      eye.node.appendChild(inner);
      return eye;
    }

    var eyeL = buildEye(0);
    var eyeR = buildEye(1);
    bodyG.appendChild(eyeL.node);
    bodyG.appendChild(eyeR.node);
    if (eyeL.hls) eyeL.hls.forEach(function (h) { bodyG.appendChild(h.node); });
    if (eyeR.hls) eyeR.hls.forEach(function (h) { bodyG.appendChild(h.node); });

    /* 眉毛 / 嘴巴 / 前层配饰（眼镜领结等）在眼睛之上 */
    if (featureLayer && featureLayer.front) bodyG.appendChild(featureLayer.front);

    svg.appendChild(bodyG);

    var fxFront = el('g', { 'pointer-events': 'none' });
    svg.appendChild(fxFront);

    var BASE_C = [centroid(ch.defaultEyeRing[0]), centroid(ch.defaultEyeRing[1])];

    /* ---- zzz 睡眠粒子 ---- */
    var zzzNodes = null;
    if (!lite) {
      zzzNodes = [];
      for (var zi = 0; zi < 3; zi++) {
        var zn = el('text', {
          x: 0, y: 0, fill: palette.zzz || '#A8A296', opacity: '0',
          'font-family': "'Space Grotesk', 'Noto Sans SC', sans-serif",
          'font-weight': '700', 'font-style': 'italic', 'text-anchor': 'middle'
        });
        zn.textContent = 'z';
        fxFront.appendChild(zn);
        zzzNodes.push(zn);
      }
    }

    container.appendChild(svg);

    /* ---- 特效实例（fx.js：发射器 + 签名动作） ----
     * anchors：嘴 / 头顶 / 底部锚点与身体半宽，供签名动作发射器定位 */
    var mouthAnchorY = C + face.y + (((feats.mouth && feats.mouth.dy) || 36)) * face.sy;
    var fx = (!lite && MM.createFx)
      ? MM.createFx({
          defs: defs, back: fxBack, front: fxFront, C: C,
          skin: ch.fxSkin, palette: palette, el: el, r2: r2,
          anchors: {
            mouth: { x: C, y: mouthAnchorY },
            top: { x: C, y: silMinY },
            bottom: { x: C, y: silMaxY },
            halfW: silMaxW / 2
          }
        })
      : null;

    /* ---- 状态缓存 ---- */
    var curBodyColor = null;
    var curSketch = -1;
    var prevYaw = 0, prevNow = 0;

    function setBodyColor(color) {
      if (color === curBodyColor) return;
      curBodyColor = color;
      stops[0].setAttribute('stop-color', shade(color, 0.42));
      stops[1].setAttribute('stop-color', shade(color, 0.14));
      stops[2].setAttribute('stop-color', color);
      stops[3].setAttribute('stop-color', shade(color, -0.22));
      if (curSketch > 0.5) head.setAttribute('stroke', shade(color, -0.6));
    }

    /* ---- 眼睛：轮廓环形变 + 球面投影 + 分层眼球 ---- */
    function setEye(eye, pose, k, sketch, yaw) {
      var ring = pose.ring;
      if (ring && ring !== eye.ring) {
        eye.ring = ring;
        var d = ringPath(ring);
        if (eye.mode === 'bean') {
          eye.node.setAttribute('d', d);
        } else {
          eye.lidClip.setAttribute('d', d);
          eye.socket.setAttribute('d', d);
        }
        eye.c = centroid(ring);
        eye.bbox = ringBBox(ring);
        eye.thick = ringThickness(ring);
      }

      var base = eye.c || BASE_C[k];
      var open = clamp(pose.open, 0.02, 2.4);
      var syEye = clamp(pose.scaleY * face.eye, 0.02, 2.4);
      var sxBase = pose.scaleX * face.eye;

      /* bean 模式垂直缩放包含开合度；iris 模式开合度只压眼睑 */
      var syAll = eye.mode === 'bean' ? clamp(syEye * open, 0.02, 2.4) : syEye;

      var halfH = EYE_HALF * clamp(syEye * open, 0.02, 2.4) + 2;
      var ey0 = C + face.y + (base[1] - C) * face.sy + pose.y + pose.lookY;
      ey0 = clamp(ey0, silMinY + halfH, silMaxY - halfH);

      var sil = silAt(ey0);
      var cx0 = (sil[0] + sil[1]) / 2;
      var hw = Math.max((sil[1] - sil[0]) / 2, 12);

      var ox = face.x + (base[0] - C) * face.sx + pose.x + pose.lookX;
      var theta = clamp(ox / hw, -1.15, 1.15);
      var total = theta + (yaw || 0);
      var cn = Math.cos(total);
      if (cn <= 0.02) {
        eye.node.style.display = 'none';
        if (eye.hls) eye.hls.forEach(function (h) { h.node.style.display = 'none'; });
        return;
      }
      eye.node.style.display = '';
      var ex = cx0 + hw * Math.sin(total) * 0.985;
      var dyN = (ey0 - C) / 130;
      var fy = Math.sqrt(1 - dyN * dyN * 0.22);

      var tf =
        'translate(' + r2(ex) + ' ' + r2(ey0) + ')' +
        (pose.rotate ? ' rotate(' + r2(pose.rotate) + ')' : '') +
        ' scale(' + r2(sxBase * cn) + ' ' + r2(syAll * fy) + ')';
      var tfFull = tf + ' translate(' + r2(-base[0]) + ' ' + r2(-base[1]) + ')';
      eye.node.setAttribute('transform', tfFull);

      if (eye.mode === 'bean') {
        /* ---- bean：高光点贴同一变换；有效高度过低（眯/困/扫读）隐藏 ---- */
        if (eye.hls) {
          var boxH = eye.bbox ? eye.bbox.h : EYE_HALF * 2;
          var thickH = (eye.thick != null ? eye.thick : boxH) * 1.65;
          var visH = Math.min(boxH, thickH) * Math.abs(syAll * fy);
          var hideHl = visH <= BEAN_HL_MIN_H || sketch > 0.5;
          var defB = eye.defBBox || eye.bbox;
          var curB = eye.bbox || defB;
          var sxOff = defB && defB.w > 0.5 ? curB.w / defB.w : 1;
          var syOff = defB && defB.h > 0.5 ? curB.h / defB.h : 1;
          var c0 = eye.c || base;
          for (var hi = 0; hi < eye.hls.length; hi++) {
            var hl = eye.hls[hi];
            if (hideHl) {
              hl.node.style.display = 'none';
            } else {
              hl.node.style.display = '';
              /* 小眼形保留按比例缩小的瞳点，眼神不丢 */
              var hlScale = clamp(visH / BEAN_HL_FULL_H, 0.55, 1);
              var hlR = (hl.cfg.r || 3) * hlScale;
              if (hlR !== hl.lastR) {
                hl.node.setAttribute('r', r2(hlR));
                hl.lastR = hlR;
              }
              var hdx = (hl.cfg.dx || 0) * (k === 0 ? 1 : -1) * sxOff;
              var hdy = (hl.cfg.dy || 0) * syOff;
              /* 按当前眼环比例缩放偏移，并保证点心距 bbox 边缘 ≥ 半径 */
              if (curB) {
                hdx = clampIn(hdx, (curB.minX - c0[0]) + hlR, (curB.maxX - c0[0]) - hlR);
                hdy = clampIn(hdy, (curB.minY - c0[1]) + hlR, (curB.maxY - c0[1]) - hlR);
              }
              hl.node.setAttribute('transform', tf +
                ' translate(' + r2(hdx) + ' ' + r2(hdy) + ')');
            }
          }
        }
        var fill = sketch > 0.5 ? 'none' : pose.color;
        /* 线稿眼描边走主题墨色，深色瞳色在暗色页面上也保持可见 */
        var stroke = sketch > 0.5 ? 'var(--sketch-ink, ' + pose.color + ')' : '';
        if (fill !== eye.lastFill) { eye.node.setAttribute('fill', fill); eye.lastFill = fill; }
        if (stroke !== eye.lastStroke) { eye.node.style.stroke = stroke; eye.lastStroke = stroke; }
        return;
      }

      /* ---- iris：眼睑闭合裁剪 + 眼球滑动 ---- */

      /* 实际闭合判定：轮廓厚度 × 开合度。
       * 睫线模式（effOpen < 0.26）：深色睫线，藏起虹膜/瞳孔/高光；
       * 小眼模式（0.26~0.45）：保留虹膜与「按比例缩小的瞳孔」，只藏白色高光 ——
       * 深色瞳点在眯眼 / 扫读等小眼表情里不再整颗消失，眼神不丢 */
      var thick = eye.thick != null ? eye.thick : EYE_HALF * 2 * 0.7;
      var effOpen = open * thick / (EYE_HALF * 2);
      var lash = effOpen < IRIS_LASH;
      var small = !lash && effOpen < IRIS_SMALL;
      if (lash !== eye.lastLash || small !== eye.lastSmall) {
        eye.lastLash = lash;
        eye.lastSmall = small;
        eye.iris.style.display = lash ? 'none' : '';
        eye.pupil.style.display = lash ? 'none' : '';
        for (var lh = 0; lh < eye.hlNodes.length; lh++) {
          eye.hlNodes[lh].node.style.display = (lash || small) ? 'none' : '';
        }
      }
      /* 小眼档瞳孔按开合度缩放（最小 0.6 倍），全表情瞳点观感一致 */
      var pupilScl = lash ? 1 : clamp(effOpen / IRIS_SMALL, 0.6, 1);
      var pupilRNow = eye.pupilR * pupilScl;
      if (pupilRNow !== eye.lastPupilR) {
        eye.pupil.setAttribute('r', r2(pupilRNow));
        eye.lastPupilR = pupilRNow;
      }
      var socketFill = lash ? pose.color : (pupilCfg.socket || '#FFFFFF');
      if (socketFill !== eye.lastSocketFill) {
        eye.socket.setAttribute('fill', socketFill);
        eye.lastSocketFill = socketFill;
      }

      var lidTf = open >= 0.995 && open <= 1.005
        ? ''
        : 'translate(' + r2(base[0]) + ' ' + r2(base[1]) + ') scale(1 ' + r2(open) + ') translate(' + r2(-base[0]) + ' ' + r2(-base[1]) + ')';
      if (lidTf !== eye.lastLidTf) {
        if (lidTf) {
          eye.lidClip.setAttribute('transform', lidTf);
          eye.socket.setAttribute('transform', lidTf);
        } else {
          eye.lidClip.removeAttribute('transform');
          eye.socket.removeAttribute('transform');
        }
        eye.lastLidTf = lidTf;
      }

      /* 瞳孔额外滑动：比眼睑多走 50%，再按当前眼环 bbox 钳制，避免被眼睑裁成月牙 */
      var travel = eye.irisR * 0.5;
      var px = base[0] + clamp(pose.lookX * 0.5, -travel, travel);
      var py = base[1] + clamp(pose.lookY * 0.55, -travel, travel);
      var bb = eye.bbox;
      if (bb) {
        var pR = eye.pupilR || eye.irisR * 0.5;
        var iPad = (eye.irisR || pR) * 0.32;   /* 虹膜约束更松 */
        var padX = Math.max(pR, iPad);
        var visMinY = base[1] + (bb.minY - base[1]) * open;
        var visMaxY = base[1] + (bb.maxY - base[1]) * open;
        px = clampIn(px, bb.minX + padX, bb.maxX - padX);
        py = clampIn(py, visMinY + pR, visMaxY - pR);
      }
      var ballTf = 'translate(' + r2(px - base[0]) + ' ' + r2(py - base[1]) + ')';
      if (ballTf !== eye.lastBallTf) {
        eye.iris.setAttribute('transform', ballTf);
        eye.pupil.setAttribute('transform', ballTf);
        eye.lastBallTf = ballTf;
      }
      eye.iris.setAttribute('cx', r2(base[0]));
      eye.iris.setAttribute('cy', r2(base[1]));
      eye.pupil.setAttribute('cx', r2(base[0]));
      eye.pupil.setAttribute('cy', r2(base[1]));

      /* 定光源高光：位置相对眼心固定（镜像），不跟随眼球滑动 */
      for (var hj = 0; hj < eye.hlNodes.length; hj++) {
        var hn = eye.hlNodes[hj];
        hn.node.setAttribute('cx', r2(base[0] + (hn.cfg.dx || 0) * (k === 0 ? 1 : -1)));
        hn.node.setAttribute('cy', r2(base[1] + (hn.cfg.dy || 0)));
      }

      /* 眼睑着色：iris 模式下 pose.color 用作眼睑线色（sketch 模式描边） */
      var showInner = sketch <= 0.5;
      if (showInner !== eye.lastShowInner) {
        eye.inner.style.display = showInner ? '' : 'none';
        eye.lastShowInner = showInner;
      }
      if (sketch > 0.5) {
        if (!eye.sketchNode) {
          eye.sketchNode = el('path', { fill: 'none', 'stroke-width': '1.6' });
          eye.node.appendChild(eye.sketchNode);
        }
        eye.sketchNode.style.display = '';
        eye.sketchNode.setAttribute('d', ringPath(eye.ring));
        eye.sketchNode.style.stroke = 'var(--sketch-ink, ' + pose.color + ')';
        if (lidTf) eye.sketchNode.setAttribute('transform', lidTf);
        else eye.sketchNode.removeAttribute('transform');
      } else if (eye.sketchNode) {
        eye.sketchNode.style.display = 'none';
      }
    }

    /* ---- 每帧 ---- */
    function applyPose(pose) {
      var b = pose.body;
      var now = performance.now();
      var sketch = b.sketch || 0;

      /* 自旋表现：角度翻转优于折叠 —— 身体随偏航轻微倾斜 + 横向弹性压缩，
       * 像硬币旋转的透视感；避免只有五官滑动、身体纹丝不动的"纸片折叠"观感 */
      var yaw0 = b.yaw || 0;
      var spinTilt = 0, spinSqX = 1;
      if (yaw0 > 0.001 || yaw0 < -0.001) {
        spinTilt = 5 * Math.sin(yaw0);
        spinSqX = 0.88 + 0.12 * Math.abs(Math.cos(yaw0));
      }

      bodyG.setAttribute('transform',
        'translate(' + r2(C + b.x) + ' ' + r2(C + b.y) + ')' +
        ' rotate(' + r2((b.rotate || 0) + spinTilt) + ')' +
        ' scale(' + r2(b.scale * spinSqX) + ' ' + r2(b.scale) + ')' +
        ' translate(' + r2(-C) + ' ' + r2(-C) + ')');
      setBodyColor(b.color);

      /* 地面投影：跟随水平位移，升离地面（弹跳）时收缩变淡 */
      var lift = clamp(-b.y / 52, 0, 1);
      var shOp = sketch > 0.5 ? 0 : 0.16 * (1 - 0.55 * lift);
      shadow.setAttribute('opacity', shOp.toFixed(3));
      if (shOp > 0.001) {
        shadow.setAttribute('transform',
          'translate(' + r2(C + b.x * 0.7) + ' ' + shadowCy + ')' +
          ' scale(' + r2((1 - 0.3 * lift) * b.scale) + ' ' + r2(1 - 0.35 * lift) + ')' +
          ' translate(' + (-C) + ' ' + (-shadowCy) + ')');
      }

      if (sketch !== curSketch) {
        curSketch = sketch;
        if (sketch > 0.5) {
          /* 线稿描边优先取页面主题墨色 --sketch-ink（暗色页浅墨、亮色页深墨），
           * 无主题变量时回退体色加深 */
          head.setAttribute('fill', 'none');
          head.style.stroke = 'var(--sketch-ink, ' + shade(b.color, -0.6) + ')';
          head.setAttribute('stroke-opacity', '0.85');
          if (gloss) gloss.style.display = 'none';
          ao.style.display = 'none';
        } else {
          head.setAttribute('fill', 'url(#' + id + 'g)');
          head.style.stroke = '';
          if (gloss) gloss.style.display = '';
          ao.style.display = '';
        }
      }

      var yaw = b.yaw || 0;
      setEye(eyeL, pose.left, 0, sketch, yaw);
      setEye(eyeR, pose.right, 1, sketch, yaw);

      if (featureLayer) featureLayer.apply(pose, sketch, yaw, now);

      if (lite) return;

      var dt = prevNow ? clamp((now - prevNow) / 1000, 0.001, 0.05) : 1 / 60;
      prevNow = now;

      /* ---- zzz 睡眠粒子 ---- */
      if (zzzNodes) {
        var zOn = (b.zzz || 0) > 0;
        for (var z = 0; z < zzzNodes.length; z++) {
          var znode = zzzNodes[z];
          if (!zOn) {
            if (znode.getAttribute('opacity') !== '0') znode.setAttribute('opacity', '0');
            continue;
          }
          var zp = (now * 0.00033 + z / 3) % 1;
          var zo = (zp < 0.18 ? zp / 0.18 : 1 - (zp - 0.18) / 0.82) * 0.8 * b.zzz;
          znode.setAttribute('opacity', zo.toFixed(3));
          znode.setAttribute('font-size', (12 + zp * 11).toFixed(1));
          znode.setAttribute('transform',
            'translate(' + r2(186 + zp * 34 + 4 * Math.sin(zp * 9)) + ' ' + r2(52 - zp * 42) + ')' +
            ' rotate(' + r2(-10 + zp * 14) + ')');
        }
      }

      /* ---- 自旋角速度（特效触发源） ---- */
      var dYaw = yaw - prevYaw;
      if (!isFinite(dYaw) || Math.abs(dYaw) > 1.2) dYaw = 0;
      prevYaw = yaw;
      var vel = dYaw / dt;

      if (fx) {
        fx.update(dt, now, {
          yaw: yaw, dYaw: dYaw, vel: vel,
          orbitWant: (b.orbit || 0) > 0,
          bodyX: b.x, bodyY: b.y
        });
      }
    }

    function burst(count) {
      if (fx) fx.burst(count);
    }
    /* 签名动作（云絮绽放 / 星星爆闪），返回 false 表示该皮肤无签名 */
    function signature(strength) {
      return fx && fx.signature ? fx.signature(strength) : false;
    }

    function destroy() {
      if (fx) fx.destroy();
      if (svg.parentNode) svg.parentNode.removeChild(svg);
    }

    return { svg: svg, applyPose: applyPose, burst: burst, signature: signature, destroy: destroy,
      signatureMouth: fx && fx.signatureMouth, signatureMouthMs: fx && fx.signatureMouthMs };
  }

  MM.createBall = createBall;
  MM.util = { shade: shade, ringPath: ringPath, centroid: centroid };
})();


/* ==== mm/features.js ==== */

/* ============================================================
 * features.js —— 五官与配饰联动层
 *
 * 五官：
 *   嘴巴：24 点 lens 环，engine 逐点插值后传入（pose.face.mouthRing），
 *        本层负责贴合剪影的横向经度换算与背面隐藏（与眼睛同一套投影）
 *   腮红：两枚椭圆，透明度由 pose.face.blush（0~1）驱动，害羞时拉满
 *   眉毛：两条 lens 短条，角度 / 抬升由 pose.face.browTilt / browRaise 驱动
 *
 * 配饰联动系统：配饰不是写死的静态 path，而是带绑定的组件 ——
 *   kind: 'glasses'  眼镜：镜框由角色实际眼位 / 眼形自动求出（autoFit），
 *                    追随目光 75%（眼睛在镜片内滑动，有视差层次），
 *                    眨眼时镜框轻微下滑回弹，镜片周期性扫过高光（glint）
 *   kind: 'path'     自定义 path：anchor（'face' 投影贴脸 / 'abs' 身体坐标）
 *                    + micro 微动效（float 漂浮 / swing 摇摆）
 *
 * 由 render.js 调用：
 *   var layer = MM.createFeatures(bodyG, feats, ctx)
 *   layer.back / layer.mid / layer.front —— 三个挂载点（可为 null）
 *   layer.apply(pose, sketch, yaw, now)  —— 每帧更新
 * ============================================================ */
(function () {
  'use strict';

  var MM = (window.MoodMates = window.MoodMates || {});
  var TAU = Math.PI * 2;

  function createFeatures(bodyG, feats, ctx) {
    var el = ctx.el, ringPath = ctx.ringPath, r2 = ctx.r2, clamp = ctx.clamp, shade = ctx.shade;
    var C = ctx.C, face = ctx.face, palette = ctx.palette, eyeStyle = ctx.eyeStyle;

    var back = null, mid = null, front = el('g', { 'pointer-events': 'none' });
    var updaters = [];   /* 每帧回调集合（配饰联动） */

    function ensureBack() {
      if (!back) back = el('g', { 'pointer-events': 'none' });
      return back;
    }

    /* 横向经度换算（与眼睛同一套投影），返回 null 表示已绕到背面 */
    function project(ox, oy, yaw) {
      var sil = ctx.silAt(oy);
      var cx0 = (sil[0] + sil[1]) / 2;
      var hw = Math.max((sil[1] - sil[0]) / 2, 12);
      var theta = clamp(ox / hw, -1.15, 1.15);
      var total = theta + (yaw || 0);
      var cn = Math.cos(total);
      if (cn <= 0.02) return null;
      return { x: cx0 + hw * Math.sin(total) * 0.985, cn: cn };
    }

    /* 眼睛在板面坐标上的静态锚点（配饰 autoFit 的基准） */
    function eyeAnchor(side) {   /* side: -1 左 / 1 右 */
      return {
        ox: face.x + side * eyeStyle.dx * face.sx,             /* 相对中线偏移 */
        y: C + face.y + (eyeStyle.cy - C) * face.sy            /* 板面纵坐标 */
      };
    }

    /* micro 微动效求值：返回 { dy, rot } */
    function microVal(micro, now, seed) {
      if (!micro) return { dy: 0, rot: 0 };
      var ph = TAU * now / (micro.period || 3000) + (seed || 0);
      if (micro.type === 'float') return { dy: (micro.amp != null ? micro.amp : 1.6) * Math.sin(ph), rot: 0 };
      if (micro.type === 'swing') return { dy: 0, rot: (micro.amp != null ? micro.amp : 4) * Math.sin(ph) };
      return { dy: 0, rot: 0 };
    }

    /* ================= 配饰构建器 ================= */

    var ACC_BUILDERS = {

      /* ---- 眼镜：autoFit 双镜框 + 鼻梁 + 外侧短脚 + 扫光 ---- */
      glasses: function (acc) {
        var aL = eyeAnchor(-1), aR = eyeAnchor(1);
        var rr = (Math.max(eyeStyle.w, eyeStyle.h) / 2) * face.eye * (acc.fit != null ? acc.fit : 1.22) + 2;
        var color = acc.color || '#C9A24B';
        var sw = acc.strokeWidth != null ? acc.strokeWidth : 2.6;

        var g = el('g', { 'pointer-events': 'none' });
        var lensG = [null, null];
        var glintNodes = [];

        [aL, aR].forEach(function (a, idx) {
          var lg = el('g', {});
          /* 镜片玻璃感：极淡白填充 */
          lg.appendChild(el('circle', { r: r2(rr), fill: '#FFFFFF', 'fill-opacity': 0.07 }));
          /* 镜框 */
          lg.appendChild(el('circle', {
            r: r2(rr), fill: 'none', stroke: color, 'stroke-width': sw
          }));
          /* 扫光：细亮条，clip 在镜片内 */
          var clipId = ctx.uid + 'gls' + idx;
          var cp = el('clipPath', { id: clipId, clipPathUnits: 'userSpaceOnUse' });
          cp.appendChild(el('circle', { cx: 0, cy: 0, r: r2(rr - sw / 2) }));
          ctx.defs.appendChild(cp);
          var glintWrap = el('g', { 'clip-path': 'url(#' + clipId + ')' });
          var glint = el('rect', {
            x: r2(-rr * 0.22), y: r2(-rr * 1.6), width: r2(rr * 0.34), height: r2(rr * 3.2),
            fill: '#FFFFFF', opacity: 0.55, transform: 'rotate(24)'
          });
          glintWrap.appendChild(glint);
          lg.appendChild(glintWrap);
          glintNodes.push(glint);
          lensG[idx] = lg;
          g.appendChild(lg);
        });

        /* 鼻梁弧 + 外侧短镜脚（静态形状，随组变换） */
        var bridge = el('path', { fill: 'none', stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round' });
        var armL = el('path', { fill: 'none', stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round' });
        var armR = el('path', { fill: 'none', stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round' });
        g.appendChild(bridge);
        g.appendChild(armL);
        g.appendChild(armR);

        var slide = 0;   /* 眨眼下滑的弹性状态 */

        return {
          node: g,
          layer: 'front',
          update: function (pose, sketch, yaw, now) {
            var f = pose.face || {};
            var openMin = Math.min(pose.left.open != null ? pose.left.open : 1,
                                   pose.right.open != null ? pose.right.open : 1);
            /* 眨眼下滑：闭眼程度驱动目标位移，指数平滑回弹 */
            var slideT = clamp(1 - openMin, 0, 1) * 1.8;
            slide += (slideT - slide) * 0.25;

            /* 追随目光 75% + 微漂浮 */
            var mv = microVal(acc.micro || { type: 'float', amp: 0.7, period: 3400 }, now, 1.3);
            var lookX = (pose.left.lookX || 0) * 0.75;
            var lookY = (pose.left.lookY || 0) * 0.75;
            var byv = (aL.y + aR.y) / 2 + lookY + slide + mv.dy;

            var pL = project(aL.ox + lookX, byv, yaw);
            var pR = project(aR.ox + lookX, byv, yaw);
            if (!pL && !pR) { g.style.display = 'none'; return; }
            g.style.display = '';
            g.setAttribute('opacity', sketch > 0.5 ? '0.55' : '1');

            var scl = face.eye;
            [pL, pR].forEach(function (p, idx) {
              var lg = lensG[idx];
              if (!p) { lg.style.display = 'none'; return; }
              lg.style.display = '';
              lg.setAttribute('transform',
                'translate(' + r2(p.x) + ' ' + r2(byv) + ') scale(' + r2(p.cn * scl) + ' ' + r2(scl) + ')');
            });

            /* 扫光：每 glintPeriod 一次，0.5s 内从左扫到右 */
            var per = acc.glintPeriod || 5200;
            var gp = (now % per) / per;
            var sweep = gp < 0.1 ? gp / 0.1 : -1;
            for (var gi = 0; gi < glintNodes.length; gi++) {
              if (sweep < 0) { glintNodes[gi].setAttribute('opacity', '0'); continue; }
              glintNodes[gi].setAttribute('opacity', (0.5 * Math.sin(Math.PI * sweep)).toFixed(3));
              glintNodes[gi].setAttribute('transform',
                'translate(' + r2((sweep * 2 - 1) * rr * 1.3) + ' 0) rotate(24)');
            }

            /* 鼻梁：两镜片内缘之间的上拱弧；镜脚：外缘向外上方短线 */
            if (pL && pR) {
              var x1 = pL.x + rr * pL.cn * scl, x2 = pR.x - rr * pR.cn * scl;
              bridge.style.display = '';
              bridge.setAttribute('d',
                'M' + r2(x1) + ' ' + r2(byv) +
                ' Q' + r2((x1 + x2) / 2) + ' ' + r2(byv - rr * 0.55) + ' ' + r2(x2) + ' ' + r2(byv));
            } else {
              bridge.style.display = 'none';
            }
            if (pL) {
              var xa = pL.x - rr * pL.cn * scl;
              armL.style.display = '';
              armL.setAttribute('d', 'M' + r2(xa) + ' ' + r2(byv) + ' L' + r2(xa - 7 * pL.cn) + ' ' + r2(byv - 3));
            } else armL.style.display = 'none';
            if (pR) {
              var xb = pR.x + rr * pR.cn * scl;
              armR.style.display = '';
              armR.setAttribute('d', 'M' + r2(xb) + ' ' + r2(byv) + ' L' + r2(xb + 7 * pR.cn) + ' ' + r2(byv - 3));
            } else armR.style.display = 'none';
          }
        };
      },

      /* ---- 自定义 path：anchor 'abs'（身体坐标，默认）/ 'face'（贴脸投影） ---- */
      path: function (acc) {
        var node = el('path', {
          d: acc.d,
          fill: acc.fill || 'none',
          stroke: acc.stroke || 'none',
          'stroke-width': acc.strokeWidth != null ? acc.strokeWidth : 0,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          opacity: acc.opacity != null ? acc.opacity : 1
        });
        var seed = acc.seed != null ? acc.seed : Math.random() * TAU;

        return {
          node: node,
          layer: acc.layer || 'front',
          update: function (pose, sketch, yaw, now) {
            var mv = microVal(acc.micro, now, seed);
            if (acc.anchor === 'face') {
              var byv = C + face.y + (acc.dy || 0) * face.sy + mv.dy;
              var p = project((acc.dx || 0) * face.sx, byv, yaw);
              if (!p) { node.style.display = 'none'; return; }
              node.style.display = '';
              node.setAttribute('transform',
                'translate(' + r2(p.x) + ' ' + r2(byv) + ')' +
                (mv.rot ? ' rotate(' + r2(mv.rot) + ')' : '') +
                ' scale(' + r2(p.cn) + ' 1)');
            } else if (acc.micro) {
              node.setAttribute('transform',
                'translate(' + r2(acc.dx || 0) + ' ' + r2((acc.dy || 0) + mv.dy) + ')' +
                (mv.rot ? ' rotate(' + r2(mv.rot) + ' ' + r2(acc.pivotX || C) + ' ' + r2(acc.pivotY || C) + ')' : ''));
            } else if (acc.transform) {
              node.setAttribute('transform', acc.transform);
            }
          }
        };
      }
    };

    (feats.accessories || []).forEach(function (acc) {
      var kind = acc.kind || 'path';
      var builder = ACC_BUILDERS[kind];
      if (!builder) { console.warn('[MoodMates] 未知配饰类型：' + kind); return; }
      var built = builder(acc);
      var target = (acc.layer || built.layer) === 'back' ? ensureBack() : front;
      target.appendChild(built.node);
      if (built.update) updaters.push(built.update);
    });

    /* ---------------- 腮红 ---------------- */
    var blushL = null, blushR = null, blushCfg = null;
    if (feats.blush !== false) {
      blushCfg = Object.assign(
        { dx: 34, dy: 26, rx: 11, ry: 6.5, color: palette.blush || '#F2A9A0', max: 0.85 },
        feats.blush === true ? {} : (feats.blush || {})
      );
      mid = el('g', { 'pointer-events': 'none' });
      blushL = el('ellipse', { rx: blushCfg.rx, ry: blushCfg.ry, fill: blushCfg.color, opacity: '0' });
      blushR = el('ellipse', { rx: blushCfg.rx, ry: blushCfg.ry, fill: blushCfg.color, opacity: '0' });
      mid.appendChild(blushL);
      mid.appendChild(blushR);
    }

    /* ---------------- 眉毛 ---------------- */
    var browL = null, browR = null, browCfg = null, browRing = null;
    if (feats.brows) {
      browCfg = Object.assign(
        { w: 16, h: 3.4, gap: 10, color: palette.eye, always: false, bend: 0.35 },
        feats.brows === true ? {} : feats.brows
      );
      browRing = MM.geo.lens(0, 0, { w: browCfg.w, h: browCfg.h, bend: browCfg.bend, taper: 0.7 });
      browL = el('path', { d: ringPath(browRing), fill: browCfg.color });
      browR = el('path', { d: ringPath(browRing), fill: browCfg.color });
      front.appendChild(browL);
      front.appendChild(browR);
    }

    /* ---------------- 嘴巴 ---------------- */
    var mouthNode = null, mouthCfg = null, lastMouthRing = null;
    if (feats.mouth) {
      mouthCfg = Object.assign(
        { dy: 36, color: palette.mouth || palette.eye },
        feats.mouth === true ? {} : feats.mouth
      );
      mouthNode = el('path', { fill: mouthCfg.color, stroke: 'none' });
      front.appendChild(mouthNode);
    }

    /* ---------------- 每帧 ---------------- */
    function apply(pose, sketch, yaw, now) {
      var f = pose.face || {};

      /* 腮红：跟随眼位左右对称，透明度 = blush 值 × 上限 */
      if (blushL) {
        var bv = clamp(f.blush || 0, 0, 1) * blushCfg.max * (sketch > 0.5 ? 0.4 : 1);
        if (bv < 0.01) {
          blushL.setAttribute('opacity', '0');
          blushR.setAttribute('opacity', '0');
        } else {
          /* 腮红贴在脸颊上，跟随目光 25%（比眼睛弱，形成层次） */
          var blshX = (pose.left.lookX || 0) * 0.25;
          var by = C + face.y + blushCfg.dy * face.sy + (pose.left.lookY || 0) * 0.25;
          var pL = project(-blushCfg.dx * face.sx + blshX, by, yaw);
          var pR = project(blushCfg.dx * face.sx + blshX, by, yaw);
          blushL.setAttribute('opacity', pL ? bv.toFixed(3) : '0');
          blushR.setAttribute('opacity', pR ? bv.toFixed(3) : '0');
          if (pL) blushL.setAttribute('transform', 'translate(' + r2(pL.x) + ' ' + r2(by) + ') scale(' + r2(pL.cn) + ' 1)');
          if (pR) blushR.setAttribute('transform', 'translate(' + r2(pR.x) + ' ' + r2(by) + ') scale(' + r2(pR.cn) + ' 1)');
        }
      }

      /* 眉毛：位于双眼上方，tilt 内外反向（怒），raise 抬升（惊）；
       * 联动：跟随目光 80%（与眼球同向微移），闭眼时随眼睑放松下垂 */
      if (browL) {
        var vis = clamp(Math.max(f.browVis || 0, browCfg.always ? 1 : 0), 0, 1);
        if (vis < 0.02) {
          browL.setAttribute('opacity', '0');
          browR.setAttribute('opacity', '0');
        } else {
          var bx = browCfg.dx != null ? browCfg.dx : 26;
          var openB = Math.min(pose.left.open != null ? pose.left.open : 1,
                               pose.right.open != null ? pose.right.open : 1);
          var relax = clamp(1 - openB, 0, 1) * 2.6;   /* 闭眼放松下垂 */
          var blkX = (pose.left.lookX || 0) * 0.8;
          var blkY = (pose.left.lookY || 0) * 0.8;
          var byv = C + face.y + ((browCfg.dyTop != null ? browCfg.dyTop : -30) - (f.browRaise || 0)) * face.sy + blkY + relax;
          var tilt = f.browTilt || 0;
          var qL = project(-bx * face.sx + blkX, byv, yaw);
          var qR = project(bx * face.sx + blkX, byv, yaw);
          browL.setAttribute('opacity', qL ? vis.toFixed(3) : '0');
          browR.setAttribute('opacity', qR ? vis.toFixed(3) : '0');
          if (qL) browL.setAttribute('transform',
            'translate(' + r2(qL.x) + ' ' + r2(byv) + ') rotate(' + r2(-tilt) + ') scale(' + r2(qL.cn * face.eye) + ' ' + r2(face.eye) + ')');
          if (qR) browR.setAttribute('transform',
            'translate(' + r2(qR.x) + ' ' + r2(byv) + ') rotate(' + r2(tilt) + ') scale(' + r2(qR.cn * face.eye) + ' ' + r2(face.eye) + ')');
        }
      }

      /* 嘴巴：engine 传入形变后的 mouthRing（局部坐标，中心 0,0）。
       * 线稿模式不画嘴 —— 只留轮廓与眼睑线，画面更接近手绘草稿 */
      if (mouthNode) {
        var ring = f.mouthRing;
        if (ring && ring !== lastMouthRing) {
          lastMouthRing = ring;
          mouthNode.setAttribute('d', ringPath(ring));
        }
        var my = C + face.y + (mouthCfg.dy + (f.mouthY || 0)) * face.sy;
        var pm = project((f.mouthX || 0) * face.sx, my, yaw);
        if (!pm || sketch > 0.5) {
          mouthNode.style.display = 'none';
        } else {
          mouthNode.style.display = '';
          mouthNode.setAttribute('transform',
            'translate(' + r2(pm.x) + ' ' + r2(my) + ')' +
            ' scale(' + r2((f.mouthSX || 1) * pm.cn * face.eye) + ' ' + r2((f.mouthSY || 1) * face.eye) + ')');
        }
      }

      /* 配饰联动更新 */
      for (var ui = 0; ui < updaters.length; ui++) {
        updaters[ui](pose, sketch, yaw, now);
      }
    }

    return { back: back, mid: mid, front: front, apply: apply };
  }

  MM.createFeatures = createFeatures;
})();


/* ==== mm/fx.js ==== */

/* ============================================================
 * fx.js —— 特效层（发射器 + 签名动作 + 轨道粒子）
 *
 * 三类粒子：
 *   轨道粒子 orbit：低倾角轨道匀速环绕（"思考中"常驻）+ 自旋甩尾
 *   爆发粒子 burst：一次性物理粒子（速度衰减 + 微重力，"撒花"）
 *   发射粒子 emit ：签名动作专属 —— 每种皮肤有自己的发射锚点与行为脚本
 *
 * 签名动作（signature，替代千篇一律的"转圈甩粒子"）：
 *   cloudpuff 云絮绽放：身体四周噗噗冒出一圈蓬松小云朵，摇曳上飘后消散
 *   stardust 星星爆闪：环身星芒逐个弹出闪烁；思考轨道混入旋转铅笔
 *
 * 深度处理：轨道粒子按 z 值在 front / back 两层切换，
 * 绕到身体背面自动被身体遮挡，保留 3D 环绕感。
 * ============================================================ */
(function () {
  'use strict';

  var MM = (window.MoodMates = window.MoodMates || {});
  var SVGNS = 'http://www.w3.org/2000/svg';
  var TAU = Math.PI * 2;

  function rand(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function el(tag, attrs) {
    var node = document.createElementNS(SVGNS, tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  /* ---------------- 通用小形状 ---------------- */

  /* 四芒星 */
  var SPARK_PATH = 'M0 -1 C0.12 -0.22 0.22 -0.12 1 0 C0.22 0.12 0.12 0.22 0 1 C-0.12 0.22 -0.22 0.12 -1 0 C-0.22 -0.12 -0.12 -0.22 0 -1 Z';
  /* 五角星 */
  var STAR_PATH = (function () {
    var pts = [];
    for (var e = 0; e < 10; e++) {
      var a = -Math.PI / 2 + e * Math.PI / 5;
      var r = e % 2 === 0 ? 1 : 0.42;
      pts.push((Math.cos(a) * r).toFixed(3) + ' ' + (Math.sin(a) * r).toFixed(3));
    }
    return 'M' + pts.join('L') + 'Z';
  })();
  /* 铅笔（朝右） */
  var PENCIL_PATH = 'M-1 -0.16 L0.5 -0.16 L1 0 L0.5 0.16 L-1 0.16 Z M-1 -0.16 L-0.78 -0.16 L-0.78 0.16 L-1 0.16 Z';

  /* ---------------- 皮肤定义 ----------------
   * colors        默认配色（palette.fx 可覆盖）
   * makeOrbitNode 轨道粒子节点（单位尺寸，transform 缩放）
   * makeBurstNode 撒花粒子节点
   * orbitSpecial  可选：思考轨道中混入的特殊粒子（如铅笔），几率 chance
   * signature(api, strength)  签名动作：用 api.emit 发射行为粒子 */
  var SKINS = {

    /* ===== 云絮（云宝 · 通用）===== */
    cloudpuff: {
      colors: ['#C3D4F2', '#9FB3D6', '#F5D889', '#9A8AE8'],
      orbitSize: [2.8, 4.4],
      burstSize: [3, 5.4],
      makeOrbitNode: function (c) { return el('circle', { r: 1, fill: c, opacity: 0.9 }); },
      makeBurstNode: function (c) {
        return Math.random() < 0.3
          ? el('path', { d: SPARK_PATH, fill: c })
          : el('circle', { r: 1, fill: c, opacity: 0.9 });
      },
      /* 云絮绽放：身体四周噗噗冒出一圈蓬松小云朵——带过冲的弹性弹出、
       * 摇曳上飘、末段收缩淡出；每朵出生时伴一圈"噗"的空气涟漪，
       * 云朵之间点缀微光四芒星。小云朵为多圆拼合的迷你云剪影
       * （组透明度整体淡入淡出，拼接处无叠色缝），左上叠受光提亮，
       * 与主体"左上光源"一致。全部锚定身体中心 + 实时身体位移 */
      signature: function (api, strength) {
        var n = Math.round(6 + 4 * strength);
        var halfW = (api.anchors && api.anchors.halfW) || 104;

        /* 迷你云剪影：底部扁圆 + 三团圆弧，单位尺寸，transform 缩放 */
        function puffNode(base) {
          var g = el('g', {});
          g.appendChild(el('ellipse', { cx: 0, cy: 0.32, rx: 1.02, ry: 0.5, fill: base }));
          g.appendChild(el('circle', { cx: -0.58, cy: 0.06, r: 0.56, fill: base }));
          g.appendChild(el('circle', { cx: 0.04, cy: -0.26, r: 0.64, fill: base }));
          g.appendChild(el('circle', { cx: 0.62, cy: 0.1, r: 0.5, fill: base }));
          g.appendChild(el('circle', { cx: -0.2, cy: -0.34, r: 0.34, fill: '#FFFFFF', opacity: 0.55 }));
          g.appendChild(el('circle', { cx: 0.3, cy: -0.12, r: 0.22, fill: '#FFFFFF', opacity: 0.35 }));
          return g;
        }

        for (var i = 0; i < n; i++) {
          (function (i) {
            var ang = TAU * i / n + rand(-0.25, 0.25);
            var rr = halfW * rand(0.98, 1.24);
            var x0 = api.C + Math.cos(ang) * rr;
            var y0 = api.C + Math.sin(ang) * rr * 0.9;
            var size = rand(7, 12);
            var sway = rand(2.5, 5) * (Math.random() < 0.5 ? -1 : 1);
            var phase = rand(0, TAU);
            var rise = rand(26, 46);
            var tilt = rand(4, 10) * (Math.random() < 0.5 ? -1 : 1);
            /* 云絮底色取比本体略深的雾蓝，深浅主题下都可辨 */
            var base = Math.random() < 0.55 ? '#CBD9F4' : '#AFC4EC';
            var delay = i * 70;

            /* "噗"——出生点的空气涟漪，快速扩散淡出 */
            api.emit(el('circle', { fill: 'none', stroke: '#9FB3D6', 'stroke-width': 1.2 }), {
              delay: delay, x: x0, y: y0,
              max: 0.42,
              step: function (p, dt, u) {
                var x = x0 + api.state.bodyX, y = y0 + api.state.bodyY;
                p.node.setAttribute('cx', x.toFixed(2));
                p.node.setAttribute('cy', y.toFixed(2));
                p.node.setAttribute('r', (size * (0.4 + 1.5 * u)).toFixed(2));
                p.node.setAttribute('opacity', (0.45 * (1 - u)).toFixed(3));
              }
            });

            /* 小云朵本体：过冲弹出 → 缓升摇曳 → 收缩淡出 */
            api.emit(puffNode(base), {
              delay: delay, x: x0, y: y0,
              max: rand(1.1, 1.5),
              step: function (p, dt, u) {
                var s;
                if (u < 0.18) { var k = u / 0.18; s = 1.18 * (1 - Math.pow(1 - k, 3)); }
                else if (u < 0.34) { s = 1.18 - 0.18 * (u - 0.18) / 0.16; }
                else { s = 1; }
                if (u > 0.72) { s *= 1 - 0.5 * (u - 0.72) / 0.28; }
                var x = x0 + api.state.bodyX + Math.sin(phase + u * 5.2) * sway;
                var y = y0 + api.state.bodyY - rise * u;
                var rot = tilt * Math.sin(phase + u * 3.4);
                var op = u > 0.72 ? (1 - u) / 0.28 : 1;
                p.node.setAttribute('opacity', (op * 0.95).toFixed(3));
                p.node.setAttribute('transform',
                  'translate(' + x.toFixed(2) + ' ' + y.toFixed(2) + ') rotate(' + rot.toFixed(1) + ') scale(' + (size * s).toFixed(3) + ')');
              }
            });
          })(i);
        }

        /* 云隙微光：少量四芒星在云朵间隙弹入闪烁 */
        var nSpark = Math.round(3 + 2 * strength);
        for (var k = 0; k < nSpark; k++) {
          (function (k) {
            var ang = TAU * (k + 0.5) / nSpark + rand(-0.3, 0.3);
            var rr = halfW * rand(1.05, 1.35);
            var x0 = api.C + Math.cos(ang) * rr;
            var y0 = api.C + Math.sin(ang) * rr * 0.9;
            var size = rand(2, 3.6);
            var spin = rand(-140, 140);
            api.emit(el('path', { d: SPARK_PATH, fill: k % 2 ? '#9A8AE8' : '#F5D889' }), {
              delay: 240 + k * 130,
              x: x0, y: y0,
              max: rand(0.5, 0.85),
              step: function (p, dt, u) {
                var x = x0 + api.state.bodyX;
                var y = y0 + api.state.bodyY - 16 * u;
                var s = u < 0.25 ? size * (u / 0.25) : size * (1 - 0.3 * (u - 0.25) / 0.75);
                var tw = 0.7 + 0.3 * Math.sin(u * 24 + k);
                p.node.setAttribute('opacity', ((1 - Math.pow(u, 2.2)) * tw).toFixed(3));
                p.node.setAttribute('transform',
                  'translate(' + x.toFixed(2) + ' ' + y.toFixed(2) + ') rotate(' + (spin * u).toFixed(1) + ') scale(' + s.toFixed(3) + ')');
              }
            });
          })(k);
        }
        return true;
      }
    },

    /* ===== 星尘（亮亮 · 教育）===== */
    stardust: {
      colors: ['#F5B840', '#F7D07A', '#F09A4E', '#FBE3A8'],
      orbitSize: [3.4, 5.6],
      burstSize: [3, 6.4],
      makeOrbitNode: function (c) { return el('path', { d: SPARK_PATH, fill: c }); },
      makeBurstNode: function (c) {
        return Math.random() < 0.4
          ? el('path', { d: STAR_PATH, fill: c })
          : el('path', { d: SPARK_PATH, fill: c });
      },
      /* 思考轨道里偶尔混入一支旋转铅笔 */
      orbitSpecial: {
        chance: 0.3,
        make: function (c) {
          var g = el('g', {});
          g.appendChild(el('path', { d: PENCIL_PATH, fill: '#E8A64C' }));
          g.appendChild(el('path', { d: 'M0.5 -0.16 L1 0 L0.5 0.16 Z', fill: '#5C4632' }));
          return g;
        },
        size: [5, 6.5]
      },
      signature: function (api, strength) {
        var n = Math.round(10 * strength);
        for (var i = 0; i < n; i++) {
          (function (i) {
            var ang = TAU * i / n + rand(-0.2, 0.2);
            var rr = rand(96, 126);
            var x0 = api.C + api.state.bodyX + Math.cos(ang) * rr;
            var y0 = api.C + api.state.bodyY + Math.sin(ang) * rr * 0.92;
            var size = rand(3.4, 6.2);
            var spin = rand(-140, 140);
            var big = Math.random() < 0.45;
            api.emit(el('path', { d: big ? STAR_PATH : SPARK_PATH, fill: api.pick() }), {
              delay: i * 55,
              x: x0, y: y0,
              max: rand(0.75, 1.15),
              step: function (p, dt, u) {
                p.y -= 14 * dt;
                /* 弹入过冲 → 闪烁 → 收缩消失 */
                var s = u < 0.22 ? size * (u / 0.22) * 1.25 : size * (1 - 0.35 * (u - 0.22) / 0.78);
                var tw = 0.75 + 0.25 * Math.sin(u * 26 + i);
                p.node.setAttribute('opacity', ((1 - Math.pow(u, 2.2)) * tw).toFixed(3));
                p.node.setAttribute('transform',
                  'translate(' + p.x.toFixed(2) + ' ' + p.y.toFixed(2) + ') rotate(' + (spin * u).toFixed(1) + ') scale(' + s.toFixed(3) + ')');
              }
            });
          })(i);
        }
        return true;
      }
    }
  };


  function createFx(ctx) {
    var C = ctx.C;
    var skin = SKINS[ctx.skin] || SKINS.cloudpuff;
    var colors = (ctx.palette && ctx.palette.fx) || skin.colors;
    var back = ctx.back, front = ctx.front;
    var anchors = ctx.anchors || {
      mouth: { x: C, y: C + 36 }, top: { x: C, y: C - 104 },
      bottom: { x: C, y: C + 104 }, halfW: 104
    };

    var orbiters = [];    /* 环绕 / 自旋粒子 */
    var pieces = [];      /* 撒花粒子 */
    var emits = [];       /* 签名动作发射粒子 */
    var wasFast = false;
    var spawnAt = [];
    var spinPlane = null;
    var orbitNextAt = 0;
    var lastState = { yaw: 0, dYaw: 0, vel: 0, orbitWant: false, bodyX: 0, bodyY: 0 };

    function pick(arr) { return (arr || colors)[(Math.random() * (arr || colors).length) | 0]; }

    function orbitPoint(o, lam) {
      var hx = o.rad * Math.sin(lam);
      var hy = -o.rad * Math.cos(lam) * Math.sin(o.tilt);
      var ca = Math.cos(o.roll), sa = Math.sin(o.roll);
      return {
        x: C + hx * ca - hy * sa,
        y: C + hx * sa + hy * ca,
        z: Math.cos(lam) * Math.cos(o.tilt)
      };
    }

    /** mode: 'spin'（一次性甩出）| 'orbit'（常驻环绕） */
    function spawnOrbiter(mode, cfg) {
      if (orbiters.length > 26) return;
      var special = mode === 'orbit' && skin.orbitSpecial && Math.random() < skin.orbitSpecial.chance;
      var node = special ? skin.orbitSpecial.make(pick()) : skin.makeOrbitNode(pick());
      front.appendChild(node);
      var sz = special ? skin.orbitSpecial.size : skin.orbitSize;
      orbiters.push(Object.assign({
        node: node, inFront: true, mode: mode,
        life: 0, max: mode === 'spin' ? rand(1.1, 2) : Infinity,
        ret: 0,
        size: rand(sz[0], sz[1]),
        rotSpd: special ? rand(40, 80) : rand(-160, 160),
        rot: rand(0, 360)
      }, cfg));
    }

    function spawnSpinGroup(yaw, dir) {
      spinPlane = {
        tilt: rand(0.18, 0.5),
        roll: rand(-0.7, 0.7)
      };
      var n = Math.round(rand(5, 8));
      spawnAt = [];
      for (var q = 0; q < n; q++) spawnAt.push({ at: performance.now() + q * rand(45, 90), dir: dir, yaw: yaw });
    }

    function releaseSpinOne(item, yaw) {
      spawnOrbiter('spin', {
        o: {
          lam: yaw - rand(0, 0.2) * item.dir,
          lamVel: item.dir * rand(2.2, 4.2),
          tilt: spinPlane.tilt + rand(-0.06, 0.06),
          roll: spinPlane.roll + rand(-0.08, 0.08),
          rad: rand(118, 142),
          radVel: rand(14, 40)
        }
      });
    }

    function removeOrbiter(idx) {
      orbiters[idx].node.remove();
      orbiters.splice(idx, 1);
    }

    /* ---- 撒花 ---- */
    function burst(count) {
      count = count || 20;
      for (var i = 0; i < count && pieces.length < 56; i++) {
        var ang = (i / count) * TAU + rand(-0.35, 0.35);
        var spd = rand(170, 360);
        var node = skin.makeBurstNode(pick());
        front.appendChild(node);
        pieces.push({
          x: C + Math.cos(ang) * rand(96, 118),
          y: C + Math.sin(ang) * rand(96, 118),
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd - rand(20, 75),
          life: 0, max: rand(0.45, 0.9),
          r: rand(skin.burstSize[0], skin.burstSize[1]),
          rot: rand(0, 360), vr: rand(-260, 260),
          el: node
        });
      }
    }

    /* ---- 签名动作发射 ---- */
    var emitApi = {
      C: C,
      anchors: anchors,
      state: lastState,
      pick: function () { return pick(); },
      emit: function (node, cfg) {
        if (emits.length > 44) { return; }
        node.setAttribute('opacity', '0');
        front.appendChild(node);
        emits.push({
          node: node,
          x: cfg.x, y: cfg.y,
          born: performance.now() + (cfg.delay || 0),
          life: 0, max: cfg.max || 1,
          step: cfg.step
        });
      }
    };

    function signature(strength) {
      if (!skin.signature) return false;
      return skin.signature(emitApi, strength || 1) === true;
    }

    /* ---- 每帧 ---- */
    function update(dt, now, state) {
      lastState.yaw = state.yaw;
      lastState.dYaw = state.dYaw;
      lastState.vel = state.vel;
      lastState.orbitWant = state.orbitWant;
      lastState.bodyX = state.bodyX || 0;
      lastState.bodyY = state.bodyY || 0;

      var vel = state.vel;
      var fast = Math.abs(vel) >= 0.9;
      var dir = vel >= 0 ? 1 : -1;

      /* 自旋达速：起一组错峰粒子 */
      if (fast && !wasFast) spawnSpinGroup(state.yaw, dir);
      if (!fast) spawnAt.length = 0;
      wasFast = fast;
      if (Math.abs(vel) >= 5) {
        while (spawnAt.length && now >= spawnAt[0].at) {
          releaseSpinOne(spawnAt.shift(), state.yaw);
        }
      }

      /* 常驻环绕补给：错峰起 5 枚 */
      if (state.orbitWant && now >= orbitNextAt) {
        var orbitCount = 0;
        for (var oc = 0; oc < orbiters.length; oc++) if (orbiters[oc].mode === 'orbit') orbitCount++;
        if (orbitCount < 5) {
          spawnOrbiter('orbit', {
            o: {
              lam: rand(0, TAU),
              lamVel: (Math.random() < 0.5 ? -1 : 1) * rand(1.5, 2.2),
              tilt: rand(0.1, 0.24),
              roll: rand(-0.12, 0.12),
              rad: rand(122, 146),
              radVel: 0
            }
          });
        }
        orbitNextAt = now + 420;
      }

      /* 轨道粒子推进 */
      for (var ti = orbiters.length - 1; ti >= 0; ti--) {
        var ob = orbiters[ti];
        ob.life += dt;
        var retreat = ob.mode === 'orbit' ? !state.orbitWant : ob.life > ob.max;
        ob.ret = clamp(ob.ret + (retreat ? dt / 0.4 : -dt / 0.3), 0, 1);
        if (retreat && ob.ret >= 1) { removeOrbiter(ti); continue; }

        var o = ob.o;
        o.lam += o.lamVel * dt + (ob.mode === 'spin' ? state.dYaw * 0.55 : state.dYaw * 0.2);
        if (ob.mode === 'spin') {
          o.lamVel *= Math.exp(-1.1 * dt);
          o.rad += o.radVel * dt;
          o.radVel *= Math.exp(-1.6 * dt);
        }
        ob.rot += ob.rotSpd * dt;

        var p = orbitPoint(o, o.lam);
        /* 深度换层：z < 0 转入背层被身体遮挡 */
        var wantFront = p.z >= 0;
        if (wantFront !== ob.inFront) {
          (wantFront ? front : back).appendChild(ob.node);
          ob.inFront = wantFront;
        }
        var grow = Math.min(ob.life / 0.3, 1);
        grow = grow * grow * (3 - 2 * grow);
        var depth = 0.68 + 0.32 * clamp(p.z, 0, 1);
        var s = ob.size * depth * grow * (1 - 0.8 * ob.ret * ob.ret);
        if (s < 0.25) { ob.node.setAttribute('opacity', '0'); continue; }
        ob.node.setAttribute('opacity', ((1 - ob.ret) * (0.55 + 0.45 * depth)).toFixed(3));
        ob.node.setAttribute('transform',
          'translate(' + p.x.toFixed(2) + ' ' + p.y.toFixed(2) + ')' +
          ' rotate(' + ob.rot.toFixed(1) + ')' +
          ' scale(' + s.toFixed(3) + ')');
      }

      /* 撒花推进：速度衰减 + 微重力 */
      for (var ci = pieces.length - 1; ci >= 0; ci--) {
        var pc = pieces[ci];
        pc.life += dt;
        if (pc.life >= pc.max) {
          pc.el.remove();
          pieces.splice(ci, 1);
          continue;
        }
        pc.x += pc.vx * dt;
        pc.y += pc.vy * dt;
        var drag = Math.pow(0.94, 60 * dt);
        pc.vx *= drag;
        pc.vy = pc.vy * drag + 40 * dt;
        pc.rot += pc.vr * dt;
        var u = pc.life / pc.max;
        var fd = u < 0.1 ? u / 0.1 : Math.pow(1 - (u - 0.1) / 0.9, 1.7);
        var sz = Math.max(pc.r * (1 - 0.4 * u), 0.4);
        pc.el.setAttribute('opacity', fd.toFixed(3));
        pc.el.setAttribute('transform',
          'translate(' + pc.x.toFixed(2) + ' ' + pc.y.toFixed(2) + ') rotate(' + pc.rot.toFixed(1) + ') scale(' + sz.toFixed(3) + ')');
      }

      /* 签名发射粒子推进 */
      for (var ei = emits.length - 1; ei >= 0; ei--) {
        var em = emits[ei];
        if (now < em.born) continue;
        em.life += dt;
        if (em.life >= em.max) {
          em.node.remove();
          emits.splice(ei, 1);
          continue;
        }
        em.step(em, dt, em.life / em.max, em.life);
      }
    }

    function destroy() {
      orbiters.forEach(function (o) { o.node.remove(); });
      pieces.forEach(function (p) { p.el.remove(); });
      emits.forEach(function (e) { e.node.remove(); });
      orbiters.length = 0;
      pieces.length = 0;
      emits.length = 0;
    }

    return { update: update, burst: burst, signature: signature, destroy: destroy,
      signatureMouth: skin.signatureMouth || null,
      signatureMouthMs: skin.signatureMouthMs || 0 };
  }

  createFx.registerSkin = function (name, def) { SKINS[name] = def; };
  createFx.skins = function () { return Object.keys(SKINS); };

  MM.createFx = createFx;
})();


/* ==== mm/emotions.js ==== */

/* ============================================================
 * emotions.js —— 表情数据基座（纯数据，不含任何 DOM / 逻辑代码）
 *
 * 全角色共享的 32 套表情编排。与具体角色解耦的三个语义层：
 *   pool   眼形槽位名（geometry.js EYE_SLOTS），角色用自己的眼环族实现
 *   mouth  嘴形槽位名（smile/grin/o/flat/frown/wavy/pout/open/dot）
 *   颜色   '@token' 查角色色板：@base 常态 @dim 低落 @soft 柔和
 *          @blush 泛红 @angry 涨红 @alert 警示 @off 关机
 *
 * ID 分段规则（十位 = 分组前缀，组间空号为扩展预留，编号即对外契约）：
 *   00-09 生命周期 · 10-29 情绪反应 · 30-49 代理工作状态 · 50+ 自定义
 *
 * 配置字段：
 *   pool / poolMs / poolSpeed   眼形池与轮换节奏
 *   blinkMs                     眨眼间隔（null = 不眨）
 *   openness                    常驻开合度（睡眠 0.08、疲惫 0.55）
 *   antics                      待机随机小动作（自旋 / 弹跳）
 *   mouth                       嘴形槽位
 *   face                        { blush 0~1, browVis, browTilt, browRaise,
 *                                 mouthX/Y/SX/SY } 五官姿态
 *   body.spinFx / confetti      进入表情的一次性事件：自旋甩粒子 / 撒花
 *   body.zzz / orbit            睡眠字母粒子 / 常驻环绕粒子
 *   sequence                    关键帧序列，settle: 'base'|'hold'|{ next }
 *   en                          英文文案 { name, desc }
 * ============================================================ */

window.EMOTION_GROUPS = [
  { key: 'life',    name: '生命周期',     en: 'Lifecycle' },
  { key: 'emotion', name: '情绪反应',     en: 'Emotions' },
  { key: 'agent',   name: '代理工作状态', en: 'Agent States' },
  { key: 'custom',  name: '自定义',       en: 'Custom' }
];

window.EMOTION_SEED = [

  /* ==================== 1）生命周期（8 个） ==================== */

  {
    id: '00', name: '睡眠', group: 'life',
    desc: '闭眼成细线，右上角 zzz 缓缓飘起，头微垂，只剩缓慢呼吸',
    en: { name: 'Sleeping', desc: 'Eyes closed to thin lines, zzz drifting up at the top right, only a slow breath remains' },
    transition: 900,
    gaze: false,
    pool: ['closed', 'closed2', 'sleepy'], poolMs: [6000, 10000], blinkMs: null, openness: 0.08,
    mouth: 'flat',
    body: { y: 4, rotate: -2, breathe: 0.018, color: '@dim', zzz: 1 },
    eyes: { both: { y: 4, lookY: 2 } },
    anims: [
      { target: 'eyes', prop: 'y', type: 'sine', amp: 1.2, period: 3600 }
    ]
  },
  {
    id: '01', name: '唤醒', group: 'life',
    desc: '从闭合眼缓缓睁开，先揉眼似的眨两下，随后进入待机',
    en: { name: 'Waking', desc: 'Eyes slowly crack open with a couple of groggy blinks, then settles into idle' },
    transition: 320,
    pool: ['closed'], poolMs: [800, 800], blinkMs: null,
    mouth: 'o',
    sequence: {
      settle: { next: '02' },
      frames: [
        { at: 0,    eyes: { both: { open: 0.1, y: 4 } } },
        { at: 420,  eyes: { left: { open: 0.55, y: 2 }, right: { open: 0.12, y: 4 } } },
        { at: 820,  eyes: { both: { open: 0.3, y: 3 } } },
        { at: 1400, eyes: { both: { open: 1, scaleX: 1.12, scaleY: 1.12, y: -2 } } },
        { at: 2100, eyes: { both: { open: 1, y: 0 } } }
      ]
    }
  },
  {
    id: '02', name: '待机放空', group: 'life',
    desc: '左看看、右看看，目光在两侧各停留片刻，偶尔自旋甩粒子 / 弹跳',
    en: { name: 'Idle', desc: 'Glances left, glances right, lingering on each side; an occasional spin or bounce' },
    transition: 700,
    pool: ['calm', 'calm2'], poolMs: [9000, 16000], blinkMs: [6000, 14000], antics: true,
    mouth: 'smile',
    body: { breathe: 0.012 },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'glance', amp: 10, period: 4800 },
      { target: 'eyes', prop: 'lookY', type: 'sine', amp: 2, period: 4100, phase: 1.1 }
    ]
  },
  {
    id: '03', name: '好奇', group: 'life',
    desc: '圆睁 / 平静 / 扫视眼形快速轮换，头微倾，嘴巴张成小 o',
    en: { name: 'Curious', desc: 'Wide, calm and scanning eye shapes rotate quickly, head tilted, mouth a small o' },
    transition: 420,
    pool: ['wide', 'wide2', 'calm', 'scan'], poolMs: [1800, 3200], blinkMs: [2500, 5500],
    mouth: 'o',
    body: { rotate: 4, breathe: 0.01 },
    eyes: { both: { lookY: -1 } },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'sine', amp: 2.4, period: 2800 }
    ]
  },
  {
    id: '04', name: '发呆', group: 'life',
    desc: '半闭眼慢轮换，双眼各望各的，嘴巴缩成小点，偶尔弹跳提神',
    en: { name: 'Spacing Out', desc: 'Half-closed eyes rotate slowly, each wandering its own way, mouth a tiny dot; a bounce now and then' },
    transition: 800,
    pool: ['sleepy', 'closed2', 'calm'], poolMs: [3500, 6000], blinkMs: [4000, 8000], antics: true,
    mouth: 'dot',
    body: { rotate: -3, breathe: 0.008 },
    eyes: {
      left:  { lookX: -4, lookY: 2 },
      right: { lookX: 5,  lookY: -1 }
    },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'sine', amp: 3, period: 6800 }
    ]
  },
  {
    id: '05', name: '加载苏醒', group: 'life',
    desc: '双眼缓慢交替亮起，像系统正在逐项初始化',
    en: { name: 'Booting', desc: 'Eyes light up in slow alternation, like a system initializing step by step' },
    transition: 480,
    pool: ['calm', 'calm2'], poolMs: [6000, 10000], blinkMs: null,
    mouth: 'flat',
    anims: [
      { target: 'left',  prop: 'open', type: 'blink', interval: 1600, dur: 700 },
      { target: 'right', prop: 'open', type: 'blink', interval: 1600, dur: 700, phaseMs: 800 },
      { target: 'eyes',  prop: 'scale', type: 'pulse', amp: 0.04, period: 1600 }
    ]
  },
  {
    id: '06', name: '休眠', group: 'life',
    desc: '困倦眼形 + 半开合，几乎静止，只剩极弱的呼吸起伏',
    en: { name: 'Dormant', desc: 'Drowsy eyes at half openness, nearly still, only the faintest breathing' },
    transition: 1200,
    gaze: false,
    pool: ['sleepy', 'closed2', 'closed'], poolMs: [4000, 8000], blinkMs: null, openness: 0.4,
    mouth: 'flat',
    body: { y: 6, scale: 0.98, rotate: -1, breathe: 0.005, color: '@dim' },
    eyes: { both: { y: 5 } }
  },
  {
    id: '07', name: '抖动唤醒', group: 'life',
    desc: '整体轻颤，闭合的眼交错睁开，随后进入待机',
    en: { name: 'Shake Awake', desc: 'The whole body trembles as the eyes stagger open, then settles into idle' },
    transition: 220,
    pool: ['closed'], poolMs: [800, 800], blinkMs: null,
    mouth: 'o',
    body: { breathe: 0.004 },
    anims: [
      { target: 'body', prop: 'x', type: 'jitter', amp: 4.5, speed: 10, decay: 1600 },
      { target: 'body', prop: 'rotate', type: 'jitter', amp: 3, speed: 8, decay: 1600 }
    ],
    sequence: {
      settle: { next: '02' },
      frames: [
        { at: 0,    eyes: { both: { open: 0.1 } } },
        { at: 380,  eyes: { left: { open: 0.4 }, right: { open: 0.12 } } },
        { at: 900,  eyes: { both: { open: 0.7, y: 1 } } },
        { at: 1600, eyes: { both: { open: 1, scaleX: 1.08, scaleY: 1.08, y: -1 } } }
      ]
    }
  },

  /* ==================== 2）情绪反应（12 个） ==================== */

  {
    id: '10', name: '开心', group: 'emotion',
    desc: '笑眼轮换 + 咧嘴笑，身体轻快起伏，偶尔自旋甩出一圈闪光粒子',
    en: { name: 'Happy', desc: 'Smiling eyes with a wide grin, body bouncing lightly; an occasional sparkling spin' },
    transition: 380,
    pool: ['happy', 'happy2'], poolMs: [2500, 4500], blinkMs: [2500, 5000], antics: true,
    mouth: 'grin',
    body: { y: -3, breathe: 0.014, color: '@soft' },
    eyes: { both: { y: -3 } },
    anims: [
      { target: 'eyes', prop: 'lookY', type: 'glance', amp: 6, period: 3000 },
      { target: 'body', prop: 'y', type: 'sine', amp: 2.2, period: 1400 }
    ]
  },
  {
    id: '11', name: '疑惑', group: 'emotion',
    desc: '斜眼轮换，头微倾，一眼放大一眼收小，嘴角歪成波浪',
    en: { name: 'Puzzled', desc: 'Skeptical eyes, head atilt, one eye enlarged and the other shrunk, mouth a wobbly wave' },
    transition: 420,
    pool: ['squint', 'squint2', 'calm'], poolMs: [2200, 3800], blinkMs: [2800, 5500],
    mouth: 'wavy',
    body: { rotate: -8, breathe: 0.008 },
    eyes: {
      left:  { y: -4, scaleX: 1.1, scaleY: 1.1 },
      right: { y: 3,  scaleX: 0.9, scaleY: 0.9, lookX: 3 }
    },
    anims: [
      { target: 'body', prop: 'rotate', type: 'sine', amp: 1.4, period: 3200 }
    ]
  },
  {
    id: '12', name: '失落', group: 'emotion',
    desc: '困倦眼形慢轮换，眼睛下沉目光低垂，嘴角向下撇',
    en: { name: 'Down', desc: 'Drowsy eyes rotate slowly, sinking with a downcast gaze, mouth turned down' },
    transition: 820,
    pool: ['sad', 'sleepy', 'closed2'], poolMs: [4000, 7000], blinkMs: [4000, 8000],
    mouth: 'frown',
    body: { y: 5, rotate: -4, breathe: 0.007, color: '@dim' },
    eyes: { both: { y: 8, scaleX: 0.88, scaleY: 0.88, lookY: 4 } },
    face: { browVis: 1, browTilt: 10, browRaise: 2 },
    anims: [
      { target: 'eyes', prop: 'y', type: 'sine', amp: 1.6, period: 3600 }
    ]
  },
  {
    id: '13', name: '惊讶', group: 'emotion',
    desc: '双眼瞬间放大再回稳，眉毛高高挑起，嘴巴张成 O 形',
    en: { name: 'Surprised', desc: 'Eyes pop wide in an instant then steady, brows shooting up, mouth an open O' },
    transition: 180,
    pool: ['wide', 'wide2'], poolMs: [2500, 4000], blinkMs: [1800, 3500],
    mouth: 'open',
    body: { y: -4, scale: 1.03, breathe: 0.006 },
    eyes: { both: { scaleX: 1.14, scaleY: 1.14, y: -2, lookY: -2 } },
    face: { browVis: 1, browRaise: 7 },
    sequence: {
      settle: 'base',
      frames: [
        { at: 0,   eyes: { both: { scaleX: 0.92, scaleY: 0.92 } }, face: { browVis: 0 } },
        { at: 150, eyes: { both: { scaleX: 1.45, scaleY: 1.45, y: -4 } }, body: { y: -7, scale: 1.05 }, face: { browVis: 1, browRaise: 10, mouthSY: 1.3 } },
        { at: 420, eyes: { both: { scaleX: 1.22, scaleY: 1.22, y: -3 } }, face: { browVis: 1, browRaise: 7 } }
      ]
    }
  },
  {
    id: '14', name: '害羞', group: 'emotion',
    desc: '目光躲向一侧，腮红在一秒多里慢慢浮现，嘴巴抿成小嘟',
    en: { name: 'Shy', desc: 'Gaze slips off to one side as the cheeks slowly blush over a second, lips in a tiny pout' },
    transition: 560,
    pool: ['shy', 'calm', 'closed2'], poolMs: [3000, 5500], blinkMs: [3000, 6000],
    mouth: 'pout',
    /* base = 序列终态，保证静态缩略图与最终观感一致 */
    body: { rotate: 6, breathe: 0.012, color: '@blush' },
    eyes: { both: { y: 4, lookX: 8, lookY: 3 } },
    face: { blush: 1 },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'sine', amp: 2, period: 2600 }
    ],
    sequence: {
      settle: 'hold',
      frames: [
        { at: 0,    body: { color: '@base' }, face: { blush: 0 } },
        { at: 1500, body: { color: '@blush' }, face: { blush: 1 } }
      ]
    }
  },
  {
    id: '15', name: '疲惫', group: 'emotion',
    desc: '眼皮沉重半睁（低开合度 + 困倦眼形），目光下沉',
    en: { name: 'Tired', desc: 'Heavy eyelids at half openness with drowsy eyes, gaze sinking low' },
    transition: 900,
    pool: ['sleepy', 'closed2', 'closed'], poolMs: [4000, 8000], blinkMs: null, openness: 0.55,
    mouth: 'flat',
    body: { y: 4, rotate: -3, breathe: 0.016, color: '@dim' },
    eyes: { both: { y: 5, lookY: 3 } },
    anims: [
      { target: 'eyes', prop: 'open', type: 'sine', amp: 0.06, period: 3400 }
    ]
  },
  {
    id: '16', name: '专注', group: 'emotion',
    desc: '专注眼形轮换，双眼微微内聚，身体几乎不动',
    en: { name: 'Focused', desc: 'Focused eye shapes rotate, eyes converge slightly, body almost motionless' },
    transition: 320,
    pool: ['angry2', 'squint', 'listen'], poolMs: [1800, 3200], blinkMs: [2800, 5500],
    mouth: 'flat',
    body: { breathe: 0.004 },
    eyes: {
      left:  { x: 4 },
      right: { x: -4 }
    }
  },
  {
    id: '17', name: '慌张', group: 'emotion',
    desc: '圆睁眼形高频轮换，目光乱晃，嘴巴扭成波浪，整体细颤',
    en: { name: 'Panicked', desc: 'Wide eyes rotate at high frequency, gaze darting about, mouth a wobble, the whole body quivering' },
    transition: 200,
    pool: ['wide', 'wide2'], poolMs: [900, 1800], blinkMs: [1200, 3000],
    mouth: 'wavy',
    body: { breathe: 0.006 },
    face: { browVis: 1, browRaise: 5, browTilt: 8 },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'jitter', amp: 6, speed: 11 },
      { target: 'eyes', prop: 'lookY', type: 'jitter', amp: 4, speed: 9 },
      { target: 'body', prop: 'x', type: 'jitter', amp: 1.6, speed: 8 }
    ]
  },
  {
    id: '18', name: '无奈', group: 'emotion',
    desc: '斜眼轮换，头一歪，双眼翻向斜上方，嘴角一条平线',
    en: { name: 'Resigned', desc: 'Sidelong eyes, head cocked, both eyes rolling up and away, mouth a flat line' },
    transition: 560,
    pool: ['squint', 'squint2', 'sad'], poolMs: [2600, 4500], blinkMs: [4500, 8000],
    mouth: 'flat',
    body: { rotate: 10, y: 2, breathe: 0.01 },
    eyes: { both: { lookX: 7, lookY: -8 } },
    anims: [
      { target: 'eyes', prop: 'lookY', type: 'sine', amp: 1.6, period: 3000 },
      { target: 'body', prop: 'y', type: 'sine', amp: 1.2, period: 3000 }
    ]
  },
  {
    id: '19', name: '满意', group: 'emotion',
    desc: '目光正视前方，双眼有节奏地上下点动，如同点头认可',
    en: { name: 'Satisfied', desc: 'Gazing straight ahead while the eyes nod up and down in steady approval' },
    transition: 580,
    pool: ['scan', 'calm', 'happy'], poolMs: [3500, 6000], blinkMs: [3500, 7000], antics: true,
    mouth: 'smile',
    body: { breathe: 0.012, color: '@soft' },
    anims: [
      { target: 'eyes', prop: 'y', type: 'sine', amp: 5, period: 1050 },
      { target: 'body', prop: 'y', type: 'sine', amp: 1.6, period: 1050, phase: 0.6 }
    ]
  },
  {
    id: '20', name: '困惑', group: 'emotion',
    desc: '两眼大小不一，斜眼轮换，注视方向对不齐',
    en: { name: 'Confused', desc: 'Mismatched eye sizes and sidelong shapes, the two gazes never quite aligning' },
    transition: 480,
    pool: ['squint', 'squint2', 'calm'], poolMs: [2200, 3800], blinkMs: [2800, 5500],
    mouth: 'wavy',
    body: { rotate: -5, breathe: 0.008 },
    eyes: {
      left:  { scaleX: 1.16, scaleY: 1.16, y: -3, lookX: -3 },
      right: { scaleX: 0.8,  scaleY: 0.8,  y: 4,  lookX: 5 }
    },
    anims: [
      { target: 'left',  prop: 'lookX', type: 'sine', amp: 2.5, period: 3200 },
      { target: 'right', prop: 'lookX', type: 'sine', amp: 2.5, period: 3200, phase: 1.6 }
    ]
  },
  {
    id: '21', name: '生气', group: 'emotion',
    desc: '怒目圆睁眉毛倒竖，脸色在 0.25s 内迅速涨红并保持，身体细微发抖',
    en: { name: 'Angry', desc: 'Glaring eyes under knitted brows; the face flushes within a quarter second and stays, body trembling' },
    transition: 260,
    pool: ['angry', 'angry2'], poolMs: [2200, 3800], blinkMs: [3500, 7000],
    mouth: 'frown',
    /* base = 序列终态红 */
    body: { y: 1, breathe: 0.004, color: '@angry' },
    face: { browVis: 1, browTilt: -14, browRaise: -2 },
    anims: [
      { target: 'body', prop: 'x', type: 'jitter', amp: 1.1, speed: 7 }
    ],
    sequence: {
      settle: 'hold',
      frames: [
        { at: 0,   body: { color: '@base' }, face: { browVis: 0.4, browTilt: -6 } },
        { at: 250, body: { color: '@angry' }, face: { browVis: 1, browTilt: -14 } }
      ]
    }
  },

  /* ==================== 3）代理工作状态（12 个） ==================== */

  {
    id: '30', name: '思考中', group: 'agent',
    desc: '思考眼形轮换，目光在上方巡回，一群光点在头顶缓缓环绕',
    en: { name: 'Thinking', desc: 'Thinking eyes rotate, gaze patrolling upward, a ring of glow motes orbiting the head' },
    transition: 480,
    pool: ['calm2', 'squint', 'listen', 'scan2'], poolMs: [2000, 3600], blinkMs: [3500, 7000],
    mouth: 'dot',
    body: { rotate: -3, breathe: 0.01, orbit: 1 },
    eyes: { both: { lookY: -6, y: -2 } },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'sine', amp: 9, period: 2600 }
    ]
  },
  {
    id: '31', name: '接收任务', group: 'agent',
    desc: '轻轻眨一下并放大，像点头确认收到',
    en: { name: 'Receiving', desc: 'A quick blink and slight enlargement, like a nod of acknowledgement' },
    transition: 220,
    pool: ['happy', 'calm', 'calm2'], poolMs: [4000, 8000], blinkMs: null,
    mouth: 'smile',
    body: { breathe: 0.008 },
    sequence: {
      settle: 'base',
      frames: [
        { at: 0 },
        { at: 100, eyes: { both: { open: 0.1 } } },
        { at: 280, eyes: { both: { open: 1, scaleX: 1.12, scaleY: 1.12, y: -2 } }, body: { y: -3 } },
        { at: 700, eyes: { both: { open: 1 } } }
      ]
    }
  },
  {
    id: '32', name: '处理中忙碌', group: 'agent',
    desc: '专注眼形轮换，目光小幅循环往复',
    en: { name: 'Busy', desc: 'Focused eyes rotate while the gaze loops in tight little circuits' },
    transition: 360,
    pool: ['angry2', 'squint', 'listen'], poolMs: [1800, 3200], blinkMs: [2800, 5500],
    mouth: 'flat',
    body: { breathe: 0.008 },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'sine', amp: 6, period: 1200 },
      { target: 'eyes', prop: 'lookY', type: 'sine', amp: 4, period: 900, phase: 0.8 }
    ]
  },
  {
    id: '33', name: '任务完成', group: 'agent',
    desc: '笑眼咧嘴 + 自旋甩出一圈粒子 + 撒花庆祝',
    en: { name: 'Done', desc: 'Smiling eyes and a grin, a celebratory particle spin and a burst of confetti' },
    transition: 240,
    pool: ['happy', 'happy2', 'calm'], poolMs: [1400, 2600], blinkMs: [2200, 4500],
    mouth: 'grin',
    body: { spinFx: 1, confetti: 0.95 },
    eyes: { both: { y: -3 } },
    sequence: {
      settle: 'base',
      frames: [
        { at: 0,   body: { y: 0 } },
        { at: 300, eyes: { both: { scaleX: 1.1, scaleY: 1.1, y: -5 } }, body: { y: -6 } },
        { at: 700, eyes: { both: { scaleX: 1.05, scaleY: 1.05, y: -4 } }, body: { y: -2 } },
        { at: 1100, body: { y: 0 } }
      ]
    }
  },
  {
    id: '34', name: '出错', group: 'agent',
    desc: '圆睁双眼，脸色急促闪动两轮后定格在警示色，眉毛拧紧',
    en: { name: 'Error', desc: 'Wide eyes as the face flashes twice and settles on alarm color, brows knotted' },
    transition: 220,
    pool: ['wide', 'wide2'], poolMs: [2000, 3600], blinkMs: null,
    mouth: 'wavy',
    body: { rotate: -6, color: '@alert' },
    face: { browVis: 1, browTilt: -10 },
    eyes: {
      left:  { y: -3, rotate: -6 },
      right: { y: 4,  rotate: 8 }
    },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'jitter', amp: 1.4, speed: 8, decay: 800 }
    ],
    sequence: {
      settle: 'hold',
      frames: [
        { at: 0,   body: { color: '@alert', rotate: -6 } },
        { at: 170, body: { color: '@base', rotate: -4 } },
        { at: 340, body: { color: '@alert', rotate: -7 } },
        { at: 510, body: { color: '@base', rotate: -5 } },
        { at: 700, body: { color: '@alert', rotate: -6 } }
      ]
    }
  },
  {
    id: '35', name: '等待输入', group: 'agent',
    desc: '聆听眼形轮换，目光轻轻上下扫读',
    en: { name: 'Listening', desc: 'Listening eyes rotate while the gaze sweeps gently up and down' },
    transition: 480,
    pool: ['listen', 'listen2', 'happy'], poolMs: [2800, 5000], blinkMs: [3000, 7000],
    mouth: 'smile',
    body: { breathe: 0.01 },
    anims: [
      { target: 'eyes', prop: 'lookY', type: 'sine', amp: 6, period: 2200 }
    ]
  },
  {
    id: '36', name: '联网加载', group: 'agent',
    desc: '左右眼轮流眨，像信号在两端来回跳',
    en: { name: 'Loading', desc: 'Eyes blink in alternation, like a signal hopping between two endpoints' },
    transition: 380,
    pool: ['calm', 'calm2'], poolMs: [6000, 10000], blinkMs: null,
    mouth: 'dot',
    anims: [
      { target: 'left',  prop: 'open', type: 'blink', interval: 1200, dur: 380 },
      { target: 'right', prop: 'open', type: 'blink', interval: 1200, dur: 380, phaseMs: 600 },
      { target: 'eyes',  prop: 'lookX', type: 'sine', amp: 2, period: 2400 }
    ]
  },
  {
    id: '37', name: '复述回忆', group: 'agent',
    desc: '聆听眼形慢轮换，目光飘向上方翻检记忆',
    en: { name: 'Recalling', desc: 'Listening eyes rotate slowly as the gaze drifts upward, leafing through memory' },
    transition: 780,
    pool: ['listen', 'listen2', 'calm2'], poolMs: [4000, 8000], blinkMs: null,
    mouth: 'dot',
    body: { rotate: -2, breathe: 0.009 },
    eyes: { both: { lookY: -9, lookX: 3, y: -3 } },
    anims: [
      { target: 'eyes', prop: 'lookY', type: 'sine', amp: 2.4, period: 4000 }
    ]
  },
  {
    id: '38', name: '拒绝/受限', group: 'agent',
    desc: '斜眼下压嘴角向下，进入时连续摇头，明确表示不行',
    en: { name: 'Refusing', desc: 'A lowered sidelong gaze and a downturned mouth, with a firm head-shake on entry: the answer is no' },
    transition: 380,
    pool: ['squint', 'squint2', 'sad'], poolMs: [2600, 4500], blinkMs: [4500, 8000], openness: 0.6,
    mouth: 'frown',
    body: { y: 2, rotate: -2, color: '@dim' },
    eyes: { both: { lookY: 3, y: 2 } },
    sequence: {
      settle: 'base',
      frames: [
        { at: 0,   body: { x: 0 } },
        { at: 130, body: { x: -9, rotate: -6 } },
        { at: 300, body: { x: 8,  rotate: 2 } },
        { at: 470, body: { x: -6, rotate: -5 } },
        { at: 630, body: { x: 4,  rotate: 0 } },
        { at: 800, body: { x: 0,  rotate: -2 } }
      ]
    }
  },
  {
    id: '39', name: '输出回复', group: 'agent',
    desc: '扫读眼形轮换，嘴巴随输出节奏一张一合',
    en: { name: 'Replying', desc: 'Reading eyes rotate while the mouth opens and closes in time with the output' },
    transition: 360,
    pool: ['scan', 'scan2'], poolMs: [4000, 8000], blinkMs: null,
    mouth: 'open',
    body: { breathe: 0.008 },
    eyes: { both: { y: -2 } },
    anims: [
      { target: 'face', prop: 'mouthSY', type: 'pulse', amp: 0.55, period: 340 },
      { target: 'body', prop: 'y', type: 'sine', amp: 1.2, period: 680 }
    ]
  },
  {
    id: '40', name: '检索资料', group: 'agent',
    desc: '扫读眼形高速轮换（弹簧加速），目光左右快扫',
    en: { name: 'Searching', desc: 'Reading eye shapes rotate at high speed while the gaze sweeps rapidly side to side' },
    transition: 320,
    pool: ['scan', 'scan2', 'scan3', 'wide', 'squint'], poolMs: [1000, 1800], poolSpeed: 10, blinkMs: [1600, 4000],
    mouth: 'flat',
    body: { breathe: 0.006 },
    anims: [
      { target: 'eyes', prop: 'lookX', type: 'scan', amp: 11, period: 700 }
    ]
  },
  {
    id: '41', name: '停止终止', group: 'agent',
    desc: '闭合眼形，慢慢收小半闭后定格',
    en: { name: 'Powering Off', desc: 'Closing eyes shrink to half-closed and quietly freeze' },
    transition: 280,
    gaze: false,
    pool: ['closed', 'closed2'], poolMs: [6000, 9000], blinkMs: null,
    mouth: 'flat',
    body: { y: 3, breathe: 0.004, color: '@off' },
    sequence: {
      settle: 'hold',
      frames: [
        { at: 0 },
        { at: 1500, eyes: { both: { scaleX: 0.6, scaleY: 0.6, open: 0.35, y: 3 } }, body: { y: 4, scale: 0.97 } }
      ]
    }
  }
];


/* ==== mm/engine.js ==== */

/* ============================================================
 * engine.js —— 驱动层（依赖 geometry / render / features / fx；消费 emotions.js 纯数据）
 *
 * 职责：
 *   1. 角色注册中心 MoodMates.characters：角色数据包 → 解析出几何 / 眼环族 / 嘴形族
 *   2. 表情注册中心 MoodMates.config：校验 / 语义槽位 / 导入导出（全角色共享基座）
 *   3. EmotionEngine：rAF 状态机 + 动画原语 + 弹簧插值 + 兜底 + 待机策略
 *   4. 对外 SDK：MoodMates.create(el, opts) → engine 实例
 *
 * 对外 API（宿主只依赖这一层）：
 *   const mate = MoodMates.create(el, { character:'nimbo', emotion:'02', idle:true });
 *   mate.setEmotion('30');
 *   mate.handleAIMessage({ emotionId:'30', tips:'正在思考' });   // 或 JSON 字符串
 *   mate.on('change'|'tips'|'error', cb);
 *   mate.startTour(ids, interval) / mate.stopTour();
 *   mate.registerEmotion(config); mate.destroy();
 *   MoodMates.characters.register(def) / list();
 *   MoodMates.config.exportConfig() / importConfig(json);
 *
 * 表情配置中的语义化设计（与具体角色解耦）：
 *   pool  用眼形槽位名（'calm'/'happy'/…），每个角色用自己的眼环族实现
 *   mouth 用嘴形槽位名（'smile'/'o'/…），随表情切换弹性形变
 *   颜色  用 '@token'（'@base'/'@blush'/'@angry'/…）查角色色板 states 表
 * ============================================================ */
(function () {
  'use strict';

  var MM = (window.MoodMates = window.MoodMates || {});
  var GEO = MM.geo;
  var TAU = Math.PI * 2;
  var FALLBACK_ID = '02';

  /* ---------------- 基础工具 ---------------- */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /* 临界阻尼弹簧步进，子步 1/120 保证数值稳定 */
  function spring(v0) { return { x: v0, v: 0, t: v0 }; }
  function springStep(s, w, z, dt) {
    s.v += (-2 * z * w * s.v - w * w * (s.x - s.t)) * dt;
    s.x += s.v * dt;
    if (!isFinite(s.x) || !isFinite(s.v)) { s.x = s.t; s.v = 0; }
  }

  /* 两组轮廓环逐点插值 */
  function lerpRing(a, b, t) {
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i++) {
      out[i] = [a[i][0] + (b[i][0] - a[i][0]) * t, a[i][1] + (b[i][1] - a[i][1]) * t];
    }
    return out;
  }

  /* 弹跳：4 段递减抛物线 */
  var BOUNCE_SEGS = [{ h: 48, d: 0.5 }, { h: 28, d: 0.382 }, { h: 14, d: 0.27 }, { h: 6, d: 0.177 }];
  var BOUNCE_TOTAL = BOUNCE_SEGS.reduce(function (s, q) { return s + q.d; }, 0);

  function hexToRgb(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(function (v) {
      return clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
    }).join('');
  }
  function lerpColor(a, b, t) {
    if (a === b) return b;
    var A = hexToRgb(a), B = hexToRgb(b);
    return rgbToHex(lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t));
  }

  /* ---------------- 角色注册中心 ---------------- */

  var characters = new Map();
  var charOrder = [];

  /** 角色色板 states 缺省表：未提供的语义色一律回退主体色 */
  var STATE_KEYS = ['base', 'dim', 'soft', 'blush', 'angry', 'alert', 'off'];

  function resolveCharacter(raw) {
    if (raw._resolved) return raw._resolved;
    var eyeStyle = Object.assign(
      { dx: 30, cy: 96, w: 26, h: 34, taper: 0.5, tilt: 0, bend: 0, highlight: null, pupil: null },
      raw.eyeStyle || {}
    );
    var family = GEO.buildEyeFamily(eyeStyle);
    /* 角色自定义眼形轮廓（每表情专属轮廓组）：raw.eyeShapes = { 名字: lens 参数 } */
    if (raw.eyeShapes) {
      for (var esk in raw.eyeShapes) {
        family[esk] = GEO.buildCustomEyePair(raw.eyeShapes[esk], eyeStyle);
      }
    }
    var mouthBase = { w: (raw.features && raw.features.mouth && raw.features.mouth.w) || 26 };
    var mouthShapes = {};
    GEO.mouthSlots.forEach(function (slot) {
      mouthShapes[slot] = GEO.buildMouth(slot, mouthBase);
    });
    /* 角色自定义嘴形轮廓：raw.mouthShapes = { 名字: mouthLens 参数 } */
    if (raw.mouthShapes) {
      for (var msk in raw.mouthShapes) {
        mouthShapes[msk] = GEO.buildCustomMouth(Object.assign({ w: mouthBase.w }, raw.mouthShapes[msk]));
      }
    }
    var palette = Object.assign({ eye: '#233038', eyeHighlight: '#FFFFFF' }, raw.palette || {});
    palette.states = Object.assign({}, raw.palette && raw.palette.states);
    STATE_KEYS.forEach(function (k) {
      if (!palette.states[k]) palette.states[k] = palette.body;
    });

    var resolved = {
      id: raw.id,
      name: raw.name,
      en: raw.en || null,
      industry: raw.industry || 'general',
      desc: raw.desc || '',
      bodyRing: GEO.buildBody(raw.body),
      face: Object.assign({ x: 0, y: 0, sx: 1, sy: 1, eye: 1 }, raw.face || {}),
      palette: palette,
      eyeStyle: eyeStyle,
      eyeFamily: family,
      mouthShapes: mouthShapes,
      defaultEyeRing: family.calm,
      features: raw.features || {},
      fxSkin: raw.fxSkin || 'cloudpuff',
      emotions: raw.emotions || null,
      raw: raw
    };
    raw._resolved = resolved;
    return resolved;
  }

  /* 身体轮廓变体：raw.variants = { 变体id: { name, en, body } }。
   * 变体只替换 bodyRing（剪影），眼形 / 色板 / 表情编排全部共享 */
  function resolveVariant(raw, vid) {
    var base = resolveCharacter(raw);
    if (!vid || !raw.variants || !raw.variants[vid]) return base;
    raw._variantCache = raw._variantCache || {};
    if (!raw._variantCache[vid]) {
      var v = raw.variants[vid];
      raw._variantCache[vid] = Object.assign({}, base, {
        variant: vid,
        bodyRing: v.body ? GEO.buildBody(v.body) : base.bodyRing
      });
    }
    return raw._variantCache[vid];
  }

  MM.characters = {
    register: function (raw) {
      if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) {
        return { ok: false, errors: ['角色缺少合法 id'] };
      }
      if (!raw.body || !raw.body.type) {
        return { ok: false, id: raw.id, errors: ['角色缺少 body.type（身体生成器）'] };
      }
      try {
        resolveCharacter(raw);
        if (raw.variants) {
          for (var vk in raw.variants) resolveVariant(raw, vk);
        }
      } catch (e) {
        return { ok: false, id: raw.id, errors: [e.message] };
      }
      if (!characters.has(raw.id)) charOrder.push(raw.id);
      characters.set(raw.id, raw);
      return { ok: true, id: raw.id };
    },
    get: function (id, variant) {
      var raw = characters.get(id);
      return raw ? resolveVariant(raw, variant) : null;
    },
    /** 列出角色的身体轮廓变体（不含默认轮廓） */
    variants: function (id) {
      var raw = characters.get(id);
      if (!raw || !raw.variants) return [];
      return Object.keys(raw.variants).map(function (k) {
        var v = raw.variants[k];
        return { id: k, name: v.name || k, en: v.en || null };
      });
    },
    list: function () {
      return charOrder.map(function (id) { return resolveCharacter(characters.get(id)); });
    },
    defaultId: function () { return charOrder[0] || null; }
  };

  /* ---------------- Pose：默认值 / 合并 / 插值 ---------------- */

  var DEFAULT_BODY = {
    x: 0, y: 0, scale: 1, rotate: 0, color: '@base', breathe: 0.01,
    spinFx: 0, confetti: 0, sketch: 0,
    zzz: 0,      /* 睡眠字母粒子（0~1） */
    orbit: 0     /* 常驻环绕粒子（0~1） */
  };
  var DEFAULT_EYE = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0, open: 1, color: '@eye', lookX: 0, lookY: 0 };
  var DEFAULT_FACE = {
    blush: 0, browVis: 0, browTilt: 0, browRaise: 0,
    mouthX: 0, mouthY: 0, mouthSX: 1, mouthSY: 1
  };

  function defaultPose() {
    return {
      body: Object.assign({}, DEFAULT_BODY),
      left: Object.assign({}, DEFAULT_EYE),
      right: Object.assign({}, DEFAULT_EYE),
      face: Object.assign({}, DEFAULT_FACE)
    };
  }
  function clonePose(p) {
    return {
      body: Object.assign({}, p.body),
      left: Object.assign({}, p.left),
      right: Object.assign({}, p.right),
      face: Object.assign({}, p.face)
    };
  }

  /** 把配置片段（body / eyes.both|left|right / face）合并到 pose 上（原地修改） */
  function applySpec(pose, spec) {
    if (!spec) return pose;
    if (spec.body) Object.assign(pose.body, spec.body);
    if (spec.face) Object.assign(pose.face, spec.face);
    var e = spec.eyes;
    if (e) {
      if (e.both) { Object.assign(pose.left, e.both); Object.assign(pose.right, e.both); }
      if (e.left) Object.assign(pose.left, e.left);
      if (e.right) Object.assign(pose.right, e.right);
    }
    return pose;
  }

  var POSE_PARTS = ['body', 'left', 'right', 'face'];

  function lerpPose(a, b, t) {
    var out = defaultPose();
    POSE_PARTS.forEach(function (part) {
      var pa = a[part], pb = b[part], po = out[part];
      for (var k in pb) {
        var vb = pb[k];
        if (typeof vb === 'number') po[k] = lerp(pa[k] != null ? pa[k] : vb, vb, t);
        else if (k === 'color') po[k] = lerpColor(pa[k] || vb, vb, t);
        else po[k] = vb;
      }
    });
    return out;
  }

  /* ---------------- 动画原语 ---------------- */

  var ANIM_TYPES = {
    /** 正弦漂移 / 呼吸 / 扫视 */
    sine: function (a, t) {
      return a.amp * Math.sin(TAU * t / (a.period || 2000) + (a.phase || 0));
    },
    /** 节奏缩放：0 → amp 平滑往复 */
    pulse: function (a, t) {
      return a.amp * 0.5 * (1 - Math.cos(TAU * t / (a.period || 1000) + (a.phase || 0)));
    },
    /** 随机小抖动（多正弦伪噪声），decay 毫秒内衰减到 0 */
    jitter: function (a, t, eng) {
      var s = t / 1000 * (a.speed || 8);
      var v = (Math.sin(s * 3.1 + eng._seed) +
               Math.sin(s * 5.7 + eng._seed * 2.3) +
               Math.sin(s * 9.3 + eng._seed * 4.1)) / 3 * a.amp;
      if (a.decay) v *= clamp(1 - t / a.decay, 0, 1);
      return v;
    },
    /** 三角波快速来回扫动 */
    scan: function (a, t) {
      var per = a.period || 800;
      var p = ((t + (a.phaseMs || 0)) % per) / per;
      var tri = p < 0.5 ? p * 4 - 1 : 3 - p * 4;
      return a.amp * tri;
    },
    /** 张望：平滑方波，两端各停留片刻再换边 */
    glance: function (a, t) {
      var per = a.period || 3600;
      var ph = TAU * (((t + (a.phaseMs || 0)) % per) / per) + (a.phase || 0);
      return a.amp * Math.tanh(2.8 * Math.sin(ph));
    },
    /** 周期眨眼；相位叠加实例随机种子，多实例不同步 */
    blink: function (a, t, eng) {
      var interval = a.interval || 3800, dur = a.dur || 200;
      var p = (t + (a.phaseMs || 0) + (eng ? eng._seed * 97 : 0)) % interval;
      if (p >= dur) return 0;
      return -(a.depth == null ? 1 : a.depth) * Math.sin(Math.PI * (p / dur));
    }
  };

  function applyAnim(pose, a, t, eng) {
    var fn = ANIM_TYPES[a.type];
    if (!fn) return;
    var v = fn(a, t, eng);
    var targets =
      a.target === 'eyes' ? [pose.left, pose.right] :
      a.target === 'body' ? [pose.body] :
      a.target === 'face' ? [pose.face] :
      a.target === 'left' ? [pose.left] :
      a.target === 'right' ? [pose.right] : [];
    for (var i = 0; i < targets.length; i++) {
      var tg = targets[i];
      if (a.prop === 'scale') {
        if (tg === pose.body) tg.scale += v;
        else { tg.scaleX += v; tg.scaleY += v; }
      } else if (a.prop in tg) {
        tg[a.prop] += v;
      }
    }
  }

  /* ---------------- 表情注册中心（全角色共享的原始配置） ---------------- */

  var GROUPS = (window.EMOTION_GROUPS || [
    { key: 'life', name: '生命周期' },
    { key: 'emotion', name: '情绪反应' },
    { key: 'agent', name: '代理工作状态' },
    { key: 'custom', name: '自定义' }
  ]).slice();

  var registry = new Map();   /* id → raw */
  var order = [];
  var configVersion = 0;

  function knownGroup(g) {
    return GROUPS.some(function (x) { return x.key === g; });
  }

  function validate(raw) {
    var errs = [];
    if (!raw || typeof raw !== 'object') { errs.push('配置必须是对象'); return errs; }
    if (typeof raw.id !== 'string' || !raw.id.trim()) errs.push('缺少合法的字符串 id');
    if (typeof raw.name !== 'string' || !raw.name.trim()) errs.push('缺少 name');
    if (!knownGroup(raw.group)) errs.push('group 不合法：' + raw.group);
    if (raw.pool != null) {
      /* 槽位名允许角色自定义轮廓（eyeShapes），此处只做类型校验，
       * 未知名字在 normalizeFor 按角色眼环族过滤兜底 */
      if (!Array.isArray(raw.pool)) errs.push('pool 必须是眼形槽位名数组');
      else raw.pool.forEach(function (s, i) {
        if (typeof s !== 'string') errs.push('pool[' + i + '] 必须是眼形槽位名字符串');
      });
    }
    if (raw.mouth != null && typeof raw.mouth !== 'string') {
      errs.push('mouth 必须是嘴形槽位名字符串');
    }
    if (raw.anims != null) {
      if (!Array.isArray(raw.anims)) errs.push('anims 必须是数组');
      else raw.anims.forEach(function (a, i) {
        if (!a || !ANIM_TYPES[a.type]) errs.push('anims[' + i + '] 未知动画类型：' + (a && a.type));
      });
    }
    if (raw.sequence != null && !Array.isArray(raw.sequence.frames)) {
      errs.push('sequence.frames 必须是数组');
    }
    return errs;
  }

  function register(raw) {
    var errs = validate(raw);
    if (errs.length) return { ok: false, id: raw && raw.id, errors: errs };
    if (!registry.has(raw.id)) order.push(raw.id);
    registry.set(raw.id, raw);
    configVersion++;
    return { ok: true, id: raw.id };
  }

  /* ---- 角色覆盖合并：角色数据里的 emotions[id] 片段浅合并进原始配置 ---- */
  function mergeRaw(base, over) {
    if (!over) return base;
    var out = Object.assign({}, base, over);
    if (base.body || over.body) out.body = Object.assign({}, base.body, over.body);
    if (base.face || over.face) out.face = Object.assign({}, base.face, over.face);
    if (base.eyes || over.eyes) {
      out.eyes = {};
      ['both', 'left', 'right'].forEach(function (k) {
        if ((base.eyes && base.eyes[k]) || (over.eyes && over.eyes[k])) {
          out.eyes[k] = Object.assign({}, base.eyes && base.eyes[k], over.eyes && over.eyes[k]);
        }
      });
    }
    return out;
  }

  /* ---- 语义色解析：'@token' → 角色色板 states / 特殊键 ---- */
  function resolveColor(v, ch) {
    if (typeof v !== 'string' || v.charAt(0) !== '@') return v;
    var key = v.slice(1);
    if (key === 'eye') return ch.palette.eye;
    return ch.palette.states[key] || ch.palette.body;
  }
  function resolvePoseColors(pose, ch) {
    pose.body.color = resolveColor(pose.body.color, ch);
    pose.left.color = resolveColor(pose.left.color, ch);
    pose.right.color = resolveColor(pose.right.color, ch);
    return pose;
  }

  /** 按角色归一化一条表情配置：深合并默认姿态，预生成 sequence 每帧完整 pose */
  function normalizeFor(raw, ch) {
    raw = mergeRaw(raw, ch.emotions && ch.emotions[raw.id]);
    var base = resolvePoseColors(applySpec(defaultPose(), raw), ch);
    var pool = (raw.pool || ['calm', 'calm2']).filter(function (s) { return ch.eyeFamily[s]; });
    if (!pool.length) pool = ['calm'];
    var def = {
      id: raw.id, name: raw.name, group: raw.group,
      desc: raw.desc || '',
      en: raw.en || null,
      gaze: raw.gaze !== false,
      transition: raw.transition != null ? raw.transition : 500,
      pool: pool,
      poolMs: raw.poolMs || [9000, 16000],
      poolSpeed: raw.poolSpeed || 6,
      blinkMs: raw.blinkMs !== undefined ? raw.blinkMs : [6000, 14000],
      openness: raw.openness != null ? raw.openness : 1,
      antics: !!raw.antics,
      mouth: raw.mouth && ch.mouthShapes[raw.mouth] ? raw.mouth : 'flat',
      base: base,
      anims: (raw.anims || []).map(function (a) { return Object.assign({}, a); }),
      sequence: null,
      raw: raw
    };
    if (raw.sequence) {
      var frames = raw.sequence.frames.map(function (f) {
        return { at: f.at || 0, pose: resolvePoseColors(applySpec(clonePose(base), f), ch) };
      }).sort(function (x, y) { return x.at - y.at; });
      def.sequence = { frames: frames, settle: raw.sequence.settle || 'base' };
    }
    return def;
  }

  MM.config = {
    register: register,
    getRaw: function (id) { return registry.get(id) || null; },
    list: function (group) {
      return order.map(function (id) { return registry.get(id); })
        .filter(function (d) { return !group || d.group === group; });
    },
    groups: function () {
      return GROUPS.map(function (g) { return { key: g.key, name: g.name, en: g.en || g.name }; });
    },
    version: function () { return configVersion; },
    exportConfig: function () {
      return JSON.stringify(order.map(function (id) { return registry.get(id); }), null, 2);
    },
    importConfig: function (json) {
      var data;
      try {
        data = typeof json === 'string' ? JSON.parse(json) : json;
      } catch (e) {
        return { ok: false, added: 0, errors: ['JSON 解析失败：' + e.message] };
      }
      var arr = Array.isArray(data) ? data : [data];
      var added = 0, errors = [];
      arr.forEach(function (raw) {
        var r = register(raw);
        if (r.ok) added++;
        else errors.push('[' + ((raw && raw.id) || '?') + '] ' + r.errors.join('；'));
      });
      return { ok: errors.length === 0, added: added, errors: errors };
    }
  };

  /* ---------------- 全局共享 rAF 时钟（多实例单循环） ---------------- */

  var ticker = {
    set: new Set(),
    raf: 0,
    add: function (e) {
      this.set.add(e);
      if (!this.raf) this.raf = requestAnimationFrame(ticker.loop);
    },
    remove: function (e) { this.set.delete(e); },
    loop: function (now) {
      ticker.raf = 0;
      ticker.set.forEach(function (e) { e._tick(now); });
      if (ticker.set.size) ticker.raf = requestAnimationFrame(ticker.loop);
    }
  };

  /* ---------------- EmotionEngine ---------------- */

  function Engine(target, opts) {
    opts = opts || {};
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('MoodMates.create：找不到容器元素');

    var chId = opts.character || MM.characters.defaultId();
    var ch = MM.characters.get(chId, opts.variant);
    if (!ch) throw new Error('MoodMates.create：未注册任何角色（先加载 src/characters/*.js）');
    this.character = ch;

    this.ball = MM.createBall(el, Object.assign({}, opts, {
      character: ch,
      lite: opts.lite != null ? opts.lite : opts.autostart === false
    }));
    this._seed = Math.random() * 100;
    this._events = {};
    this._gaze = { x: 0, y: 0, tx: 0, ty: 0 };
    this._style = { sketch: 0 };
    this._theme = opts.color
      ? { body: opts.color, eyes: opts.eyeColor || '#FFFFFF' }
      : null;
    this._eyeScale = opts.eyeScale || 1;
    this._lastTick = 0;
    this._spin = null;

    /* ---- 按角色归一化的表情缓存 ---- */
    this._defs = new Map();
    this._defsVersion = -1;

    /* ---- 眼环形变系统（槽位驱动） ---- */
    var calm = ch.eyeFamily.calm;
    this._ringSrc = [calm[0], calm[1]];
    this._ringDst = [calm[0], calm[1]];
    this._ringCur = this._ringDst;
    this._ringSpring = spring(1);
    this._ringSpeed = 7;
    this._exprSlot = 'calm';
    this._poolPos = 0;
    this._poolNext = 0;

    /* ---- 嘴形形变系统 ---- */
    var flat = ch.mouthShapes.flat;
    this._mouthSrc = flat;
    this._mouthDst = flat;
    this._mouthCur = flat;
    this._mouthSpring = spring(1);
    this._mouthSlot = 'flat';
    this._mouthHoldUntil = 0;

    /* ---- 眨眼系统 ---- */
    this._open = spring(1);
    this._blinkQ = [];
    this._blinkNext = Infinity;
    /* ---- 待机小动作 ---- */
    this._anticNext = 0;
    this._bounceAt = -1;

    this._def = null;
    this._lastPose = null;
    this._prevPose = null;
    this._transStart = 0;
    this._transDur = 0;
    this._emoStart = 0;
    this._seq = null;
    this._active = false;
    this._touring = false;
    this._tourTimer = 0;
    this._fallbackId = opts.fallbackId || FALLBACK_ID;
    this._lastActivity = performance.now();

    if (opts.idle) {
      this._idle = Object.assign(
        { standbyAfter: 60000, sleepAfter: 180000, standbyId: '02', sleepId: '00' },
        opts.idle === true ? {} : opts.idle
      );
    } else {
      this._idle = null;
    }

    this.setEmotion(opts.emotion || this._fallbackId, { auto: true });
    if (opts.autostart !== false) this.setActive(true);
    else this.renderStatic();
  }

  Engine.prototype = {

    /* ---------- 事件 ---------- */
    on: function (evt, cb) {
      (this._events[evt] = this._events[evt] || []).push(cb);
      return this;
    },
    off: function (evt, cb) {
      var list = this._events[evt];
      if (list) {
        var i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
      }
      return this;
    },
    _emit: function (evt, payload) {
      (this._events[evt] || []).slice().forEach(function (cb) {
        try { cb(payload); } catch (e) { console.error(e); }
      });
    },

    get emotionId() { return this._def ? this._def.id : null; },
    get touring() { return this._touring; },

    /** 取按本角色归一化的表情定义（带版本失效缓存） */
    _getDef: function (id) {
      if (this._defsVersion !== MM.config.version()) {
        this._defs.clear();
        this._defsVersion = MM.config.version();
      }
      if (this._defs.has(id)) return this._defs.get(id);
      var raw = MM.config.getRaw(id);
      if (!raw) return null;
      var def = normalizeFor(raw, this.character);
      this._defs.set(id, def);
      return def;
    },

    /* ---------- 核心：切换表情（含兜底） ---------- */
    setEmotion: function (id, o) {
      o = o || {};
      var def = this._getDef(id);
      if (!def) {
        console.warn('[MoodMates] 未知表情 ID "' + id + '"，回退到待机 (' + this._fallbackId + ')');
        this._emit('error', { message: '未知表情 ID "' + id + '"，已回退待机', id: id });
        def = this._getDef(this._fallbackId);
        if (!def) return false;
      }
      var now = performance.now();
      var prevId = this._def ? this._def.id : null;
      this._prevPose = this._lastPose ? clonePose(this._lastPose) : null;
      this._def = def;
      this._emoStart = now;
      this._transStart = now;
      this._transDur = this._prevPose ? def.transition : 0;
      this._seq = def.sequence
        ? { frames: def.sequence.frames, settle: def.sequence.settle, done: false }
        : null;
      if (!o.auto) this._lastActivity = now;

      this._poolPos = 0;
      this._mouthHoldUntil = 0;
      this._setExpr(def.pool[0], def.poolSpeed >= 10 ? 10 : 8);
      this._setMouth(def.mouth, 8);
      this._poolNext = now + rand(def.poolMs[0], def.poolMs[1]);
      if (prevId !== null && prevId !== def.id && def.blinkMs) this._blinkNow(now);
      this._blinkNext = def.blinkMs ? now + rand(def.blinkMs[0], def.blinkMs[1]) : Infinity;
      this._anticNext = now + rand(2500, 5000);

      this._emit('change', { id: def.id, def: def, auto: !!o.auto });
      /* spinFx / confetti 是进入表情时的一次性事件；
       * 有签名动作的角色用自己的风格庆祝（云絮绽放 / 星星爆闪），
       * 没有签名动作的皮肤才回退到通用自旋 */
      if (this._active) {
        var fx = def.base.body;
        if (fx.spinFx > 0 && !this.signature(fx.spinFx >= 1 ? 1 : 0.7)) {
          this.spin(fx.spinFx >= 1 ? 2 : 1);
        }
        if (fx.confetti > 0) this.burst(20);
      }
      if (!this._active) this.renderStatic();
      return true;
    },

    /** AI 对接入口：接受对象或 JSON 字符串 { emotionId, tips } */
    handleAIMessage: function (msg) {
      var obj = msg;
      if (typeof msg === 'string') {
        try { obj = JSON.parse(msg); }
        catch (e) {
          this._emit('error', { message: 'AI 消息 JSON 解析失败，已回退待机', raw: msg });
          this.setEmotion(this._fallbackId);
          return false;
        }
      }
      if (!obj || typeof obj !== 'object' || typeof obj.emotionId !== 'string') {
        this._emit('error', { message: 'AI 消息缺少 emotionId 字段，已回退待机', raw: msg });
        this.setEmotion(this._fallbackId);
        return false;
      }
      var ok = this.setEmotion(obj.emotionId);
      if (obj.tips) this._emit('tips', { text: String(obj.tips) });
      return ok;
    },

    /* ---------- 自动巡演 ---------- */
    startTour: function (ids, interval) {
      this.stopTour();
      if (!ids || !ids.length) return;
      interval = interval || 2500;
      this._touring = true;
      var self = this, i = 0;
      this.setEmotion(ids[0], { auto: true });
      this._tourTimer = setInterval(function () {
        i = (i + 1) % ids.length;
        self.setEmotion(ids[i], { auto: true });
      }, interval);
    },
    stopTour: function () {
      if (this._tourTimer) { clearInterval(this._tourTimer); this._tourTimer = 0; }
      this._touring = false;
      this._lastActivity = performance.now();
    },

    resetIdle: function () { this._lastActivity = performance.now(); },

    /* 注视目标：横向 ±24、纵向 ±15（viewBox 坐标） */
    setGaze: function (nx, ny) {
      this._gaze.tx = clamp(nx, -1, 1) * 24;
      this._gaze.ty = clamp(ny, -1, 1) * 15;
      return this;
    },
    clearGaze: function () {
      this._gaze.tx = 0;
      this._gaze.ty = 0;
      return this;
    },
    setStyle: function (style) {
      Object.assign(this._style, style || {});
      if (!this._active) this.renderStatic();
      return this;
    },

    /* 自旋（点击交互）：弹簧追整数圈，达速后由特效层甩出粒子 */
    spin: function (turns, dir) {
      if (this._spin) return this;
      var d = dir || (Math.random() < 0.5 ? -1 : 1);
      this._spin = { x: 0, v: 0, t: Math.max(1, Math.round(turns || 1)) * TAU * d };
      return this;
    },
    /* 撒花：一次性物理粒子爆发 */
    burst: function (count) {
      if (this.ball.burst) this.ball.burst(count);
      return this;
    },
    /* 签名动作：角色专属交互（云絮绽放 / 星星爆闪）
     * 返回 false 表示该角色皮肤没有签名动作 */
    signature: function (strength) {
      var ok = this.ball.signature ? !!this.ball.signature(strength) : false;
      /* 皮肤可声明 signatureMouth：触发签名时嘴形临时覆盖，到期弹回当前表情嘴形 */
      if (ok && this.ball.signatureMouth) {
        this._mouthHoldUntil = performance.now() + (this.ball.signatureMouthMs || 1400);
        this._setMouth(this.ball.signatureMouth, 10);
      }
      return ok;
    },
    /* 庆祝组合（舞台点击交互）：签名动作 + 随机肢体动作 + 撒花，
     * 让点击反馈与球球的"甩带 + 烟花"同量级，而非只有单一签名动作 */
    celebrate: function (strength) {
      var s = strength == null ? 1 : strength;
      this.signature(s);
      var r = Math.random();
      if (r < 0.5) this.spin(1);
      else if (r < 0.85) this.bounce();
      this.burst(Math.round(10 + 8 * s));
      return this;
    },
    /* 弹跳（4 段递减抛物线） */
    bounce: function () {
      if (this._bounceAt < 0) this._bounceAt = performance.now();
      return this;
    },

    /* 切换眼环槽位：把当前插值冻结为新起点，弹簧从 0 重新弹向 1 */
    _setExpr: function (slot, speed) {
      if (slot === this._exprSlot && this._ringSpring.x >= 0.999) return;
      var pair = this.character.eyeFamily[slot];
      if (!pair) return;
      var s = clamp(this._ringSpring.x, 0, 1);
      this._ringSrc = [
        lerpRing(this._ringSrc[0], this._ringDst[0], s),
        lerpRing(this._ringSrc[1], this._ringDst[1], s)
      ];
      this._ringDst = [pair[0], pair[1]];
      this._ringSpring.x = 0;
      this._ringSpring.v = 0;
      this._ringSpring.t = 1;
      this._ringSpeed = speed || 7;
      this._exprSlot = slot;
    },

    /* 切换嘴形槽位（同眼环逻辑） */
    _setMouth: function (slot, speed) {
      if (slot === this._mouthSlot && this._mouthSpring.x >= 0.999) return;
      var ring = this.character.mouthShapes[slot];
      if (!ring) return;
      var s = clamp(this._mouthSpring.x, 0, 1);
      this._mouthSrc = lerpRing(this._mouthSrc, this._mouthDst, s);
      this._mouthDst = ring;
      this._mouthSpring.x = 0;
      this._mouthSpring.v = 0;
      this._mouthSpring.t = 1;
      this._mouthSlot = slot;
    },

    /* 眨眼关键帧：合上 → 停 70ms → 睁到 1.08 过冲 → 300ms 落回 1 */
    _blinkNow: function (t) {
      this._blinkQ.push(
        { at: t, v: 0.05 }, { at: t + 70, v: 0.05 },
        { at: t + 150, v: 1.08 }, { at: t + 300, v: 1 }
      );
      if (Math.random() < 0.14) {
        this._blinkQ.push({ at: t + 370, v: 0.05 }, { at: t + 480, v: 1 });
      }
    },

    registerEmotion: function (raw) { return MM.config.register(raw); },

    /* ---------- 生命周期 ---------- */
    setActive: function (on) {
      if (on === this._active) return;
      this._active = on;
      if (on) ticker.add(this);
      else ticker.remove(this);
    },
    replay: function () {
      if (this._def) this.setEmotion(this._def.id, { auto: true });
    },
    /** 静态渲染一帧 */
    renderStatic: function () {
      this._transDur = 0;
      this._ringSpring.x = 1;
      this._ringSpring.v = 0;
      this._mouthSpring.x = 1;
      this._mouthSpring.v = 0;
      this._open.x = this._def ? this._def.openness : 1;
      this._open.v = 0;
      var seq = this._seq;
      this._seq = null;
      this._tick(performance.now());
      this._seq = seq;
    },
    destroy: function () {
      this.stopTour();
      this.setActive(false);
      this._events = {};
      this.ball.destroy();
    },

    /* ---------- 每帧 ---------- */
    _tick: function (now) {
      this._dt = this._lastTick ? clamp((now - this._lastTick) / 1000, 0.001, 0.05) : 1 / 60;
      this._lastTick = now;
      if (this._idle && !this._touring) this._checkIdle(now);
      var pose = this._compose(now, 0);
      this.ball.applyPose(pose);
      this._lastPose = pose;
    },

    _checkIdle: function (now) {
      var idle = this._idle;
      var elapsed = now - this._lastActivity;
      var cur = this.emotionId;
      if (elapsed >= idle.sleepAfter) {
        if (cur !== idle.sleepId) this.setEmotion(idle.sleepId, { auto: true });
      } else if (elapsed >= idle.standbyAfter) {
        if (cur !== idle.standbyId && cur !== idle.sleepId) {
          this.setEmotion(idle.standbyId, { auto: true });
        }
      }
    },

    /** 合成当前帧姿态：base → sequence → animators → 过渡插值 */
    _compose: function (now, depth) {
      var def = this._def;
      var t = now - this._emoStart;
      var pose;

      if (this._seq) {
        var res = this._seqPose(t, now);
        if (res === 'switch') {
          return depth < 4 ? this._compose(now, depth + 1) : clonePose(this._def.base);
        }
        pose = res || clonePose(def.base);
      } else {
        pose = clonePose(def.base);
      }

      /* 内置呼吸（相位用绝对时间，切换表情不跳变） */
      var br = pose.body.breathe || 0;
      if (br) {
        var ph = TAU * now / 3600;
        pose.body.scale += br * Math.sin(ph);
        pose.body.y += br * 55 * Math.sin(ph + 0.6);
      }

      for (var i = 0; i < def.anims.length; i++) applyAnim(pose, def.anims[i], t, this);

      pose.body.sketch = Math.max(pose.body.sketch || 0, this._style.sketch || 0);

      var dt = this._dt || 1 / 60;

      /* ---- 表情池轮换 ---- */
      if (this._active && now >= this._poolNext) {
        if (def.pool.length > 1) {
          this._poolPos = (this._poolPos + 1 + Math.floor(rand(0, def.pool.length - 1))) % def.pool.length;
          this._setExpr(def.pool[this._poolPos], def.poolSpeed);
        }
        this._poolNext = now + rand(def.poolMs[0], def.poolMs[1]);
      }

      /* ---- 眨眼调度 ---- */
      if (this._active && def.blinkMs && now >= this._blinkNext) {
        this._blinkNow(now);
        this._blinkNext = now + rand(def.blinkMs[0], def.blinkMs[1]);
      }
      var openKey = null;
      while (this._blinkQ.length && now >= this._blinkQ[0].at) {
        openKey = this._blinkQ[0].v;
        this._blinkQ.shift();
      }
      this._open.t = openKey != null ? openKey : (this._blinkQ.length ? this._open.t : def.openness);

      /* ---- 待机小动作：优先角色签名动作（轻量版），无签名才通用自旋 ---- */
      if (this._active && def.antics && now >= this._anticNext) {
        if (!this._spin && this._bounceAt < 0) {
          var pick = Math.random();
          if (pick < 0.45) {
            if (!this.signature(0.55)) this.spin(1);
          }
          else if (pick < 0.8) this.bounce();
          else this._blinkNow(now);
        }
        this._anticNext = now + rand(9000, 18000);
      }

      /* 签名嘴形覆盖到期：弹回当前表情槽位（表情切换已清 hold，不会串嘴） */
      if (this._mouthHoldUntil && now >= this._mouthHoldUntil) {
        this._mouthHoldUntil = 0;
        this._setMouth(def.mouth, 8);
      }

      /* ---- 弹簧整步（子步 1/120）：眼形变 / 嘴形变 / 开合 / 自旋 ---- */
      var steps = Math.max(1, Math.ceil(dt / (1 / 120)));
      var j = dt / steps;
      for (var si = 0; si < steps; si++) {
        springStep(this._ringSpring, this._ringSpeed, 1, j);
        springStep(this._mouthSpring, 9, 1, j);
        springStep(this._open, 26, 1, j);
        if (this._spin) {
          springStep(this._spin, 6.2, 1, j);
          if (Math.abs(this._spin.t - this._spin.x) < 0.01 && Math.abs(this._spin.v) < 0.05) {
            this._spin = null;
          }
        }
      }
      pose.body.yaw = this._spin ? this._spin.x : 0;

      /* ---- 弹跳位移 ---- */
      if (this._bounceAt >= 0) {
        var be = (now - this._bounceAt) / 1000;
        if (be >= BOUNCE_TOTAL) {
          this._bounceAt = -1;
        } else {
          var acc = 0, bi = 0;
          while (bi < BOUNCE_SEGS.length && be >= acc + BOUNCE_SEGS[bi].d) { acc += BOUNCE_SEGS[bi].d; bi++; }
          var seg = BOUNCE_SEGS[Math.min(bi, BOUNCE_SEGS.length - 1)];
          var bn = (be - acc) / seg.d;
          pose.body.y += -4 * seg.h * bn * (1 - bn);
        }
      }

      /* ---- 当前眼环 / 嘴环：形变中逐点插值，静止后复用目标引用 ---- */
      if (this._ringSpring.x < 0.999 || this._ringSpring.v > 0.001 || this._ringSpring.v < -0.001) {
        var rs = clamp(this._ringSpring.x, 0, 1.35);
        this._ringCur = [
          lerpRing(this._ringSrc[0], this._ringDst[0], rs),
          lerpRing(this._ringSrc[1], this._ringDst[1], rs)
        ];
      } else if (this._ringCur !== this._ringDst) {
        this._ringCur = this._ringDst;
      }
      pose.left.ring = this._ringCur[0];
      pose.right.ring = this._ringCur[1];

      if (this._mouthSpring.x < 0.999 || Math.abs(this._mouthSpring.v) > 0.001) {
        var ms = clamp(this._mouthSpring.x, 0, 1.25);
        this._mouthCur = lerpRing(this._mouthSrc, this._mouthDst, ms);
      } else if (this._mouthCur !== this._mouthDst) {
        this._mouthCur = this._mouthDst;
      }
      pose.face.mouthRing = this._mouthCur;

      /* 鼠标注视：帧率无关的指数平滑 */
      var k = 1 - Math.exp(-5.66 * dt);
      var gx = def.gaze !== false ? this._gaze.tx : 0;
      var gy = def.gaze !== false ? this._gaze.ty : 0;
      this._gaze.x += (gx - this._gaze.x) * k;
      this._gaze.y += (gy - this._gaze.y) * k;
      pose.left.lookX += this._gaze.x;
      pose.right.lookX += this._gaze.x;
      pose.left.lookY += this._gaze.y;
      pose.right.lookY += this._gaze.y;
      pose.face.mouthX += this._gaze.x * 0.35;
      pose.face.mouthY += this._gaze.y * 0.28;

      /* 常驻眼神微漂移 */
      if (def.gaze !== false) {
        var w = now / 1000;
        pose.left.lookX += 1.4 * Math.sin(0.42 * w) + 0.5 * Math.sin(1.0 * w);
        pose.right.lookX += 1.4 * Math.sin(0.42 * w + 1) + 0.5 * Math.sin(1.0 * w + 2);
        pose.left.lookY += 0.9 * Math.sin(0.58 * w);
        pose.right.lookY += 0.9 * Math.sin(0.58 * w + 1);
      }

      /* 小尺寸实例放大眼睛占比 */
      if (this._eyeScale !== 1) {
        pose.left.scaleX *= this._eyeScale;
        pose.left.scaleY *= this._eyeScale;
        pose.right.scaleX *= this._eyeScale;
        pose.right.scaleY *= this._eyeScale;
        pose.face.mouthSX *= this._eyeScale;
        pose.face.mouthSY *= this._eyeScale;
      }

      /* 实例主题色（team mate）：体色恒为主题色，眼睛仅覆盖默认色 */
      if (this._theme) {
        pose.body.color = this._theme.body;
        var chEye = this.character.palette.eye;
        if (pose.left.color === chEye) pose.left.color = this._theme.eyes;
        if (pose.right.color === chEye) pose.right.color = this._theme.eyes;
      }

      /* 开合度 = 配置基础值 × 眨眼弹簧 */
      var openS = clamp(this._open.x, 0.02, 1.5);
      pose.left.open = clamp(pose.left.open, 0, 1.3) * openS;
      pose.right.open = clamp(pose.right.open, 0, 1.3) * openS;
      pose.left.scaleX = Math.max(pose.left.scaleX, 0.05);
      pose.left.scaleY = Math.max(pose.left.scaleY, 0.05);
      pose.right.scaleX = Math.max(pose.right.scaleX, 0.05);
      pose.right.scaleY = Math.max(pose.right.scaleY, 0.05);

      /* 表情切换过渡插值 */
      var tt = now - this._transStart;
      if (this._transDur > 0 && tt < this._transDur && this._prevPose) {
        var mouthRing = pose.face.mouthRing;
        pose = lerpPose(this._prevPose, pose, easeInOutCubic(tt / this._transDur));
        pose.face.mouthRing = mouthRing;   /* 环形变由弹簧负责，不参与姿态插值 */
        pose.left.ring = this._ringCur[0];
        pose.right.ring = this._ringCur[1];
      }
      return pose;
    },

    /** sequence 采样；播完按 settle 处理（hold / base / next） */
    _seqPose: function (t, now) {
      var seq = this._seq;
      var frames = seq.frames;
      var last = frames[frames.length - 1];

      if (t >= last.at) {
        if (!seq.done) {
          seq.done = true;
          var s = seq.settle;
          if (s === 'base') {
            this._prevPose = this._lastPose ? clonePose(this._lastPose) : clonePose(last.pose);
            this._transStart = now;
            this._transDur = this._def.transition || 500;
            this._seq = null;
            return null;
          }
          if (s && typeof s === 'object' && s.next) {
            this.setEmotion(s.next, { auto: true });
            return 'switch';
          }
        }
        return clonePose(last.pose);
      }

      if (t <= frames[0].at) return clonePose(frames[0].pose);
      for (var i = 0; i < frames.length - 1; i++) {
        var a = frames[i], b = frames[i + 1];
        if (t >= a.at && t < b.at) {
          var k = easeInOutCubic((t - a.at) / (b.at - a.at));
          return lerpPose(a.pose, b.pose, k);
        }
      }
      return clonePose(last.pose);
    }
  };

  /* ---------------- 对外入口 ---------------- */

  MM.create = function (target, opts) { return new Engine(target, opts); };
  MM.version = '1.0.0';

  /* 载入种子配置（emotions.js 在本脚本之前加载） */
  if (Array.isArray(window.EMOTION_SEED)) {
    window.EMOTION_SEED.forEach(function (raw) {
      var r = register(raw);
      if (!r.ok) console.warn('[MoodMates] 种子配置无效：', r.id, r.errors);
    });
  }
})();


/* ==== mm/nimbo.js ==== */

/* ============================================================
 * Nimbo 云宝（通用）—— 蓬松云朵
 *   概念定稿：assets/concepts/concept-nimbo.png 方案 A（雾蓝薰衣草）
 *   剪影：七瓣扇贝波浪边，底部收平像坐在地上的云
 *   气质：慢半拍的松弛系伙伴，适合陪伴 / 冥想 / 天气类场景
 *   签名动作：嘴巴收口吸进彩色光点，再吐出一道六色拱虹
 *   设计参数记录：docs/DESIGN-PROVENANCE.md
 * ============================================================ */
window.MoodMates.characters.register({
  id: 'nimbo',
  name: '云宝',
  en: { name: 'Nimbo', desc: 'A puffy scallop-edged cloud that drifts half a beat behind the world and blooms a ring of fluffy baby clouds when pleased' },
  industry: 'general',
  desc: '雾蓝薰衣草色的蓬松云朵，波浪扇贝边，高兴时身边会噗噗绽开一圈小云絮',

  body: { type: 'cloud', r: 0.94, lobes: 7, amp: 0.08, flat: 0.12 },
  face: { x: 0, y: 2, sx: 1, sy: 1, eye: 1 },

  palette: {
    body: '#B4C6EE',
    eye: '#2B3550',
    eyeHighlight: '#FFFFFF',
    blush: '#EFA9B8',
    zzz: '#9FB3D6',
    gloss: 0.2,
    states: {
      base: '#B4C6EE',
      dim: '#95A5CC',
      soft: '#C6D6F5',
      blush: '#E3B8D8',
      angry: '#D96B70',
      alert: '#E25B5B',
      off: '#9AA6C0'
    }
  },

  eyeStyle: {
    dx: 29, cy: 104, w: 26, h: 30,
    taper: 0.55, tilt: -2, bend: 0.1,
    highlight: { dx: 3.5, dy: -6, r: 3.2 }
  },

  features: {
    mouth: { w: 23, dy: 32 },
    blush: { dx: 41, dy: 20, rx: 12, ry: 7, max: 0.8 }
  },

  fxSkin: 'cloudpuff',

  /* 云朵的性子更慢：待机轮换与呼吸都放缓 */
  emotions: {
    '02': { poolMs: [12000, 20000], anims: [
      { target: 'eyes', prop: 'lookX', type: 'glance', amp: 8, period: 6400 },
      { target: 'eyes', prop: 'lookY', type: 'sine', amp: 2, period: 5200, phase: 1.1 }
    ] },
    '10': { anims: [
      { target: 'eyes', prop: 'lookY', type: 'glance', amp: 5, period: 3800 },
      { target: 'body', prop: 'y', type: 'sine', amp: 1.8, period: 2000 }
    ] }
  }
});


/* ==== mm/twinkle.js ==== */

/* ============================================================
 * Twinkle 亮亮（教育）—— 圆角五角星
 *   概念定稿：assets/concepts/concept-twinkle.png 方案 A（蜂蜜金 + 金框眼镜）
 *   剪影：五角圆角星
 *   眼睛：瞳孔眼（白眼底 + 暖棕虹膜），配 autoFit 圆框眼镜 ——
 *        镜框按实际眼位自动求出，追随目光、眨眼下滑、镜片扫光
 *   签名动作：环身星星爆闪；思考轨道里混入一支旋转铅笔
 *   设计参数记录：docs/DESIGN-PROVENANCE.md
 * ============================================================ */
window.MoodMates.characters.register({
  id: 'twinkle',
  name: '亮亮',
  en: { name: 'Twinkle', desc: 'A honey-gold rounded star in tiny auto-fit glasses — the classroom cheerleader' },
  industry: 'general',
  desc: '蜂蜜金的圆角五角星，戴一副会追着眼睛走的小圆框眼镜，教育场景的元气小老师',

  body: { type: 'star', r: 1.02, points: 5, inner: 0.74, sharp: 0.5 },
  face: { x: 0, y: 6, sx: 0.82, sy: 0.82, eye: 0.85 },

  palette: {
    body: '#F5B93F',
    eye: '#4A3316',
    blush: '#F0966E',
    mouth: '#6B4A2E',
    zzz: '#D9A85F',
    gloss: 0.3,
    states: {
      base: '#F5B93F',
      dim: '#D6A139',
      soft: '#F8CC66',
      blush: '#F2AE7E',
      angry: '#E8734F',
      alert: '#E25B5B',
      off: '#C2A265'
    }
  },

  eyeStyle: {
    dx: 27, cy: 102, w: 26, h: 34,
    taper: 0.38, tilt: 0, bend: 0,
    pupil: {
      irisR: 10, pupilR: 4.8,
      irisColor: '#7A4E2A',
      socket: '#FFFFFF',
      highlights: [
        { dx: -3.2, dy: -3.8, r: 3 },
        { dx: 3.8, dy: 2.4, r: 1.3, opacity: 0.6 }
      ]
    }
  },

  features: {
    mouth: { w: 24, dy: 34 },
    blush: { dx: 40, dy: 24, rx: 10, ry: 6, max: 0.85 },
    /* 不配眉毛：瞳孔眼 + 眼镜的信息量已足，情绪由眼睑开合 / 视线 / 嘴形表达 */
    accessories: [
      /* autoFit 圆框眼镜：镜框位置 / 半径由角色眼位眼形自动求出 */
      { kind: 'glasses', color: '#C9973F', fit: 1.3, strokeWidth: 2.6, glintPeriod: 5200 }
    ]
  },

  fxSkin: 'stardust',

  /* 小老师看到你做对了会更兴奋 */
  emotions: {
    '33': { body: { spinFx: 1, confetti: 1 } }
  }
});

