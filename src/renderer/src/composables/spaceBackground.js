/**
 * 深空背景绘制（批次 B4 从 SystemView 抽取为共享 composable）
 *
 * 全部使用确定性伪随机（i*97+23 等固定散列），禁止 Math.random——
 * 渲染循环中随机会导致拖拽/缩放时星空抖动（红线约束）。
 */

export function drawDeepSpaceBackground(ctx) {
  // 深空渐变背景（以原点为亮核，覆盖视图范围）
  const bg = ctx.createRadialGradient(0, 0, 0, 0, 0, 1800);
  bg.addColorStop(0, '#161d33');
  bg.addColorStop(0.5, '#101527');
  bg.addColorStop(1, '#0a0e1c');
  ctx.fillStyle = bg;
  ctx.fillRect(-3000, -3000, 6000, 6000);

  // 星云（2 个，确定性位置）
  const nebulae = [
    { x: -500, y: -300, r: 420, color: 'rgba(80, 110, 200, 0.07)' },
    { x: 400, y: 250, r: 380, color: 'rgba(130, 70, 160, 0.06)' },
  ];
  for (const neb of nebulae) {
    const g = ctx.createRadialGradient(neb.x, neb.y, 0, neb.x, neb.y, neb.r);
    g.addColorStop(0, neb.color);
    g.addColorStop(0.6, neb.color.replace('0.', '0.0'));
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.fillRect(neb.x - neb.r, neb.y - neb.r, neb.r * 2, neb.r * 2);
  }

  // 星尘 3 层（确定性散列，避免渲染抖动）
  for (let layer = 0; layer < 3; layer++) {
    const alpha = 0.1 + layer * 0.05;
    const count = 150 + layer * 60;
    const sizeBase = 0.4 + layer * 0.3;
    ctx.fillStyle = `rgba(220, 230, 245, ${alpha})`;
    for (let i = layer * 200; i < count; i++) {
      const x = ((i * 97 + 23) % 2500) - 1250;
      const y = ((i * 61 + 41) % 2500) - 1250;
      const size = sizeBase + (i % 4) * 0.25;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 导航星（少量明亮白星）
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  for (let i = 0; i < 10; i++) {
    const x = ((i * 137 + 53) % 2200) - 1100;
    const y = ((i * 89 + 67) % 2200) - 1100;
    ctx.beginPath();
    ctx.arc(x, y, 1.3, 0, Math.PI * 2);
    ctx.fill();
  }
}
