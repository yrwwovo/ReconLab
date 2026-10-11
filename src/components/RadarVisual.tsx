/**
 * 纯 SVG 绘制的侦察雷达可视化（登录页主视觉）
 * 不依赖任何外部图片资源，加载即渲染，永不裂图
 */
export function RadarVisual() {
  const nodes: Array<[number, number, number, boolean]> = [
    [210, 250, 3, false], [330, 190, 2.5, false], [400, 300, 3.5, true],
    [250, 380, 2.5, false], [170, 470, 3, false], [360, 460, 2.5, false],
    [290, 540, 3.5, true], [430, 560, 2.5, false], [200, 620, 3, false],
    [340, 680, 2.5, false], [470, 430, 3, false], [150, 340, 2.5, false],
  ];
  const links: Array<[number, number]> = [
    [0, 1], [1, 2], [0, 3], [3, 4], [3, 5], [2, 5], [5, 6], [4, 6],
    [6, 8], [8, 9], [5, 7], [7, 10], [2, 10], [0, 11], [11, 4],
  ];

  return (
    <svg
      viewBox="0 0 600 800"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 w-full h-full"
      style={{ opacity: 0.85 }}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="rl-bg" cx="50%" cy="50%" r="70%">
          <stop offset="0%" stopColor="#0b2a22" stopOpacity="0.95" />
          <stop offset="60%" stopColor="#070d12" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#04070a" stopOpacity="1" />
        </radialGradient>
        <linearGradient id="rl-sweep" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#22e3a0" stopOpacity="0.34" />
          <stop offset="100%" stopColor="#22e3a0" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="rl-core" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#22e3a0" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#22e3a0" stopOpacity="0" />
        </radialGradient>
        <filter id="rl-soft" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>

      <rect width="600" height="800" fill="url(#rl-bg)" />

      {/* 细网格 */}
      <g stroke="#22e3a0" strokeOpacity="0.06" strokeWidth="1">
        {Array.from({ length: 15 }, (_, i) => <line key={`v${i}`} x1={i * 43} y1="0" x2={i * 43} y2="800" />)}
        {Array.from({ length: 20 }, (_, i) => <line key={`h${i}`} x1="0" y1={i * 43} x2="600" y2={i * 43} />)}
      </g>

      {/* 雷达同心圆 */}
      <g transform="translate(300 400)" fill="none" stroke="#22e3a0" strokeOpacity="0.22" strokeWidth="1">
        {[90, 170, 250, 330].map((r) => <circle key={r} r={r} />)}
        <circle r="40" strokeOpacity="0.14" />
        <line x1="-360" y1="0" x2="360" y2="0" strokeOpacity="0.1" />
        <line x1="0" y1="-360" x2="0" y2="360" strokeOpacity="0.1" />

        {/* 旋转扫描扇区 */}
        <g className="animate-radar" style={{ transformOrigin: '0px 0px' }}>
          <path d="M 0 0 L 330 0 A 330 330 0 0 0 233 -233 Z" fill="url(#rl-sweep)" stroke="none" />
          <line x1="0" y1="0" x2="330" y2="0" stroke="#22e3a0" strokeOpacity="0.5" strokeWidth="1.2" />
        </g>
        <circle r="60" fill="url(#rl-core)" stroke="none" />
      </g>

      {/* 网络拓扑连线 */}
      <g stroke="#22e3a0" strokeOpacity="0.24" strokeWidth="1">
        {links.map(([a, b], i) => (
          <line key={i} x1={nodes[a][0]} y1={nodes[a][1]} x2={nodes[b][0]} y2={nodes[b][1]} />
        ))}
      </g>

      {/* 节点 */}
      <g>
        {nodes.map(([x, y, r, warn], i) => (
          <g key={i}>
            <circle cx={x} cy={y} r={r * 3.2} fill={warn ? '#ffb020' : '#22e3a0'} opacity="0.12" filter="url(#rl-soft)" />
            <circle cx={x} cy={y} r={r} fill={warn ? '#ffb020' : '#22e3a0'}>
              <animate attributeName="opacity" values="1;0.45;1" dur={`${2.4 + (i % 5) * 0.5}s`} repeatCount="indefinite" />
            </circle>
            {warn && (
              <circle cx={x} cy={y} r={r} fill="none" stroke="#ffb020" strokeWidth="1">
                <animate attributeName="r" values={`${r};${r * 4}`} dur="2.2s" repeatCount="indefinite" />
                <animate attributeName="stroke-opacity" values="0.7;0" dur="2.2s" repeatCount="indefinite" />
              </circle>
            )}
          </g>
        ))}
      </g>

      {/* HUD 角标 */}
      <g stroke="#22e3a0" strokeOpacity="0.4" strokeWidth="1.4" fill="none">
        <path d="M 40 40 L 40 82 M 40 40 L 82 40" />
        <path d="M 560 40 L 560 82 M 560 40 L 518 40" />
        <path d="M 40 760 L 40 718 M 40 760 L 82 760" />
        <path d="M 560 760 L 560 718 M 560 760 L 518 760" />
      </g>
      <g fontFamily="'JetBrains Mono', monospace" fontSize="11" fill="#22e3a0" fillOpacity="0.5">
        <text x="46" y="120">RECON · ACTIVE</text>
        <text x="46" y="136">SCOPE · AUTHORIZED</text>
        <text x="470" y="700">NODES 12</text>
        <text x="470" y="716">ALERTS 2</text>
      </g>
    </svg>
  );
}
