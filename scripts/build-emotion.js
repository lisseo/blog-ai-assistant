/**
 * 把表情引擎的多个源文件按依赖顺序合并成单个脚本。
 *
 * 原因：embed.js 在第三方页面上动态注入脚本，8 个串行请求会累加 8 个 RTT；
 * 合并后一次请求、可被 CDN 长缓存，且不阻塞宿主页面的 HTML 解析。
 *
 * 两套引擎共用 window.EMOTION_SEED / EMOTION_GROUPS，绝不能同时加载，
 * 所以分别产出一个 bundle，由 embed.js 按 data-character 二选一。
 *
 * 源文件来自 Emotion Ball / Mood Mates（见 public/emotion/NOTICE.md）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// 源码放在项目根的 emotion-src/，不随 public/ 一起发布到线上
const SRC = path.join(ROOT, 'emotion-src');

const BUNDLES = [
  {
    name: 'MoodMates（云宝 / 亮亮）',
    out: path.join(ROOT, 'public', 'emotion', 'mm.js'),
    dir: 'mm',
    files: [
      'geometry.js', 'render.js', 'features.js', 'fx.js',
      'emotions.js', 'engine.js', 'nimbo.js', 'twinkle.js',
    ],
  },
  {
    name: 'EmotionBall（球球）',
    out: path.join(ROOT, 'public', 'emotion', 'eb.js'),
    dir: 'eb',
    files: ['rings.js', 'emotions.js', 'ball.js', 'engine.js'],
  },
];

let total = 0;
for (const b of BUNDLES) {
  const parts = [
    '/* Emotion engine bundle — ' + b.name,
    ' * 由 scripts/build-emotion.js 自动生成，请勿手工编辑。',
    ' * 源：' + b.dir + '/' + b.files.join(', '),
    ' * 授权见 /emotion/NOTICE.md',
    ' */',
  ];
  for (const f of b.files) {
    const p = path.join(SRC, b.dir, f);
    if (!fs.existsSync(p)) throw new Error('缺少源文件: ' + p);
    parts.push('\n/* ==== ' + b.dir + '/' + f + ' ==== */\n');
    parts.push(fs.readFileSync(p, 'utf8'));
  }
  const out = parts.join('\n') + '\n';
  fs.writeFileSync(b.out, out, 'utf8');
  total += Buffer.byteLength(out);
  console.log(`[emotion] ${path.relative(ROOT, b.out)} ← ${b.files.length} 文件 / ${(Buffer.byteLength(out) / 1024).toFixed(1)} KB`);
}
console.log(`[emotion] 合计 ${(total / 1024).toFixed(1)} KB（未压缩）`);
