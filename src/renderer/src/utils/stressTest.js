/**
 * 400 星压力测试脚本
 * 生成大量测试节点，验证渲染性能
 * 
 * 使用方式：在浏览器控制台中调用 window.runStressTest()
 */

export function generateTestNodes(count = 400) {
  const nodes = [];
  const hyperlanes = [];
  
  // 生成节点 - 使用确定性随机而非 Math.random()
  for (let i = 0; i < count; i++) {
    const layer = i < 5 ? 'world' : i < 20 ? 'star_domain' : 'galaxy';
    const parentId = layer === 'galaxy' ? `star_domain_${(i % 15) + 1}` : 
                     layer === 'star_domain' ? `world_${(i % 5) + 1}` : null;
    
    // 使用确定性坐标计算
    const x = (((i * 97 + 23) % 2000) - 1000);
    const y = (((i * 61 + 41) % 2000) - 1000);
    
    nodes.push({
      id: `test_node_${i}`,
      name: `测试节点 ${i}`,
      layer,
      parentId,
      tags: ['test'],
      sourcePath: '',
      coordinate: { x, y },
    });
  }
  
  // 生成航道（相邻节点之间，约30%概率连接）
  for (let i = 1; i < count; i++) {
    if (i % 3 === 0) {
      hyperlanes.push({
        id: `test_hyperlane_${i}`,
        fromId: `test_node_${i}`,
        toId: `test_node_${i - 1}`,
        type: 'local',
        controlPoints: [],
      });
    }
  }
  
  return { nodes, hyperlanes };
}

export function measurePerformance(store, count = 400) {
  console.log(`[压力测试] 生成 ${count} 个测试节点...`);
  
  const startTime = performance.now();
  const { nodes, hyperlanes } = generateTestNodes(count);
  
  // 使用 Vue 响应式方式更新数组
  store.nodes.push(...nodes);
  store.hyperlanes.push(...hyperlanes);
  
  const endTime = performance.now();
  console.log(`[压力测试] 生成耗时: ${(endTime - startTime).toFixed(2)}ms`);
  
  // 统计
  console.log(`[压力测试] 总节点数: ${store.nodes.length}`);
  console.log(`[压力测试] 总航道数: ${store.hyperlanes.length}`);
  
  // 触发保存
  store.scheduleAutoSave();
  
  return {
    nodeCount: store.nodes.length,
    hyperlaneCount: store.hyperlanes.length,
    generationTime: endTime - startTime,
  };
}

export function cleanupTestNodes(store) {
  if (!store.nodes._value) {
    // Vue reactive array
    const before = store.nodes.length;
    store.nodes = store.nodes.filter(n => !n.id.startsWith('test_node_'));
    store.hyperlanes = store.hyperlanes.filter(h => !h.id.startsWith('test_hyperlane_'));
    console.log(`[压力测试] 已清理 ${before - store.nodes.length} 个测试节点`);
  }
}
