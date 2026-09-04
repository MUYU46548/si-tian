/**
 * 示例世界观数据 — 用于首次启动时展示 SiTian 完整能力
 * 独立于 ROSA 正典，可随时删除
 */
export function createSampleWorld() {
  const now = Date.now();
  const id = (suffix) => `sample_${suffix}_${now}`;
  
  return {
    version: '0.1.0',
    extractedAt: new Date().toISOString(),
    vaultPath: '',
    nodeCount: 14,
    nodes: [
      // 世界
      { id: id('aether'), name: '幻境', layer: 'world', layerLabel: '世界', parentId: null, tags: ['世界', '幻境'], sourcePath: '', wikilinks: [], coordinate: { x: 600, y: 400 } },
      
      // 星域
      { id: id('north_reach'), name: '北境星域', layer: 'star_domain', layerLabel: '星域', parentId: id('aether'), tags: ['星域', '北境'], sourcePath: '', wikilinks: [], coordinate: { x: 400, y: 250 } },
      { id: id('south_expanse'), name: '南荒星域', layer: 'star_domain', layerLabel: '星域', parentId: id('aether'), tags: ['星域', '南荒'], sourcePath: '', wikilinks: [], coordinate: { x: 800, y: 550 } },
      
      // 星系
      { id: id('frost_system'), name: '霜寒系', layer: 'galaxy', layerLabel: '星系', parentId: id('north_reach'), tags: ['星系', '霜寒'], sourcePath: '', wikilinks: [], coordinate: { x: 300, y: 150 } },
      { id: id('crystal_system'), name: '晶体系', layer: 'galaxy', layerLabel: '星系', parentId: id('north_reach'), tags: ['星系', '晶体'], sourcePath: '', wikilinks: [], coordinate: { x: 500, y: 300 } },
      { id: id('ember_system'), name: '余烬系', layer: 'galaxy', layerLabel: '星系', parentId: id('south_expanse'), tags: ['星系', '余烬'], sourcePath: '', wikilinks: [], coordinate: { x: 700, y: 500 } },
      
      // 行星
      { id: id('frost_prime'), name: '霜寒主星', layer: 'planet', layerLabel: '行星', parentId: id('frost_system'), tags: ['行星', '寒冷'], sourcePath: '', wikilinks: [], coordinate: { x: 220, y: 100 } },
      { id: id('crystal_moon'), name: '晶卫一', layer: 'planet', layerLabel: '行星', parentId: id('crystal_system'), tags: ['卫星', '晶体'], sourcePath: '', wikilinks: [], coordinate: { x: 580, y: 220 } },
      { id: id('ember_world'), name: '余烬星', layer: 'planet', layerLabel: '行星', parentId: id('ember_system'), tags: ['行星', '炎热'], sourcePath: '', wikilinks: [], coordinate: { x: 780, y: 480 } },
      
      // 聚落/地点
      { id: id('frost_hold'), name: '霜寒城', layer: 'city', layerLabel: '城市', parentId: id('frost_prime'), tags: ['城市', '首都'], sourcePath: '', wikilinks: [], coordinate: { x: 180, y: 60 } },
      { id: id('crystal_mine'), name: '晶矿镇', layer: 'town', layerLabel: '城镇', parentId: id('crystal_moon'), tags: ['城镇', '矿业'], sourcePath: '', wikilinks: [], coordinate: { x: 620, y: 180 } },
      { id: id('ember_village'), name: '余烬村', layer: 'village', layerLabel: '村庄', parentId: id('ember_world'), tags: ['村庄', '农业'], sourcePath: '', wikilinks: [], coordinate: { x: 820, y: 520 } },
      { id: id('frost_ruins'), name: '霜寒遗迹', layer: 'location', layerLabel: '地点', parentId: id('frost_prime'), tags: ['地点', '遗迹'], sourcePath: '', wikilinks: [], coordinate: { x: 260, y: 140 } },
      { id: id('ember_pass'), name: '余烬关隘', layer: 'location', layerLabel: '地点', parentId: id('ember_world'), tags: ['地点', '关隘'], sourcePath: '', wikilinks: [], coordinate: { x: 740, y: 560 } },
    ],
    hyperlanes: [
      { id: `auto_${id('frost_system')}_${id('crystal_system')}`, fromId: id('frost_system'), toId: id('crystal_system'), type: 'local', auto: true, controlPoints: [] },
      { id: `auto_${id('crystal_system')}_${id('ember_system')}`, fromId: id('crystal_system'), toId: id('ember_system'), type: 'cross_domain', auto: true, controlPoints: [] },
    ],
  };
}
