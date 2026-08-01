import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export const useGeodataStore = defineStore('geodata', () => {
  const nodes = ref([]);
  const hyperlanes = ref([]);  // 用户自定义航道
  const currentWorld = ref(null);
  const currentDomain = ref(null);
  const currentSystem = ref(null);
  const viewLevel = ref('world'); // 'world' | 'domain' | 'system'
  
  // All nodes by layer
  const worlds = computed(() => nodes.value.filter(n => n.layer === 'world'));
  const starDomains = computed(() => nodes.value.filter(n => n.layer === 'star_domain'));
  const galaxies = computed(() => nodes.value.filter(n => n.layer === 'galaxy'));
  const planets = computed(() => nodes.value.filter(n => n.layer === 'planet'));
  const locations = computed(() => nodes.value.filter(n => n.layer === 'location' || n.layer === 'city' || n.layer === 'town'));
  
  // Current world's domains
  const currentWorldDomains = computed(() => {
    if (!currentWorld.value) return [];
    return starDomains.value.filter(d => d.parentId === currentWorld.value.id);
  });
  
  // Current domain's galaxies
  const currentDomainGalaxies = computed(() => {
    if (!currentDomain.value) return [];
    return galaxies.value.filter(g => g.parentId === currentDomain.value.id);
  });
  
  // Current system's planets (when viewing a specific galaxy)
  const currentSystemPlanets = computed(() => {
    if (!currentSystem.value) return [];
    return [...planets.value, ...locations.value].filter(p => p.parentId === currentSystem.value.id);
  });
  
  // Galaxies in current domain for the galaxy map view
  const currentDomainAllGalaxies = computed(() => {
    if (!currentDomain.value) return [];
    // Get all galaxies belonging to this domain
    const domainGalaxies = galaxies.value.filter(g => g.parentId === currentDomain.value.id);
    // Also include galaxies from other domains that might be nearby
    return domainGalaxies;
  });
  
  // 获取与指定节点相关的航道
  const getHyperlanesByNode = computed(() => {
    return (nodeId) => hyperlanes.value.filter(h => h.fromId === nodeId || h.toId === nodeId);
  });
  
  // 获取当前域的航道
  const currentDomainHyperlanes = computed(() => {
    if (!currentDomain.value) return [];
    const domainGalaxyIds = new Set(currentDomainGalaxies.value.map(g => g.id));
    return hyperlanes.value.filter(h => {
      // 两端都在本域内
      if (domainGalaxyIds.has(h.fromId) && domainGalaxyIds.has(h.toId)) return true;
      // 跨域航道：一端在本域
      return domainGalaxyIds.has(h.fromId) || domainGalaxyIds.has(h.toId);
    });
  });
  
  const tree = computed(() => {
    const map = new Map();
    nodes.value.forEach(n => map.set(n.id, { ...n, children: [] }));
    const roots = [];
    nodes.value.forEach(n => {
      if (n.parentId && map.has(n.parentId)) {
        map.get(n.parentId).children.push(map.get(n.id));
      } else if (!n.parentId) {
        roots.push(map.get(n.id));
      }
    });
    const layerOrder = ['world', 'star_domain', 'galaxy', 'planet', 'region', 'city', 'town', 'location', 'unknown'];
    const sortByLayer = (node) => {
      if (node.children) {
        node.children.sort((a, b) => 
          layerOrder.indexOf(a.layer) - layerOrder.indexOf(b.layer)
        );
        node.children.forEach(sortByLayer);
      }
    };
    roots.forEach(sortByLayer);
    return roots;
  });

  async function loadGeodata() {
    const result = await window.sitianAPI.getGeodata();
    if (result.success) {
      nodes.value = result.data.nodes || [];
      hyperlanes.value = result.data.hyperlanes || [];
    } else {
      console.error('Failed to load geodata:', result.error);
      nodes.value = [];
      hyperlanes.value = [];
    }
  }

  async function reextract() {
    const result = await window.sitianAPI.reextractGeodata();
    if (result.success) {
      nodes.value = result.data.nodes || [];
      // 保留用户创建的航道（不覆盖）
      // hyperlanes 从 result.data.hyperlanes 中提取自动生成的部分
      const autoHyperlanes = result.data.hyperlanes || [];
      // 保留用户创建的航道（id 不以 'auto_' 开头的）
      const userHyperlanes = hyperlanes.value.filter(h => !h.id.startsWith('auto_'));
      hyperlanes.value = [...autoHyperlanes, ...userHyperlanes];
    }
  }

  async function saveGeodata() {
    const data = { 
      nodes: nodes.value, 
      hyperlanes: hyperlanes.value,
      updatedAt: new Date().toISOString() 
    };
    await window.sitianAPI.saveGeodata(data);
  }

  function updateNodePosition(id, x, y) {
    const node = nodes.value.find(n => n.id === id);
    if (node) {
      node.coordinate.x = x;
      node.coordinate.y = y;
    }
  }

  function updateAllCoordinates(updatedNodes) {
    updatedNodes.forEach(updated => {
      const node = nodes.value.find(n => n.id === updated.id);
      if (node) {
        node.coordinate.x = updated.coordinate.x;
        node.coordinate.y = updated.coordinate.y;
      }
    });
  }
  
  // ===== 航道 CRUD =====
  
  function addHyperlane(fromId, toId, type = 'local') {
    // 检查是否已存在
    const exists = hyperlanes.value.some(h => 
      (h.fromId === fromId && h.toId === toId) || 
      (h.fromId === toId && h.toId === fromId)
    );
    if (exists) return null;
    
    const id = `hyperlane_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const hyperlane = {
      id,
      fromId,
      toId,
      type,  // 'local' | 'cross_domain' | 'hyperjump'
      controlPoints: []  // 可选的贝塞尔控制点
    };
    hyperlanes.value.push(hyperlane);
    return hyperlane;
  }
  
  function removeHyperlane(id) {
    const idx = hyperlanes.value.findIndex(h => h.id === id);
    if (idx !== -1) hyperlanes.value.splice(idx, 1);
  }
  
  function updateHyperlane(id, updates) {
    const h = hyperlanes.value.find(h => h.id === id);
    if (h) Object.assign(h, updates);
  }
  
  function getHyperlaneById(id) {
    return hyperlanes.value.find(h => h.id === id);
  }

  function selectWorld(world) {
    currentWorld.value = world;
    currentDomain.value = null;
    currentSystem.value = null;
    viewLevel.value = 'domain';
  }

  function selectDomain(domain) {
    currentDomain.value = domain;
    currentSystem.value = null;
    viewLevel.value = 'system';
  }

  function selectSystem(system) {
    currentSystem.value = system;
    // Could add a 'detail' view level later
  }

  function backToWorld() {
    currentWorld.value = null;
    currentDomain.value = null;
    currentSystem.value = null;
    viewLevel.value = 'world';
  }

  function backToDomain() {
    currentSystem.value = null;
    viewLevel.value = 'domain';
  }

  return { 
    nodes, hyperlanes, tree, currentWorld, currentDomain, currentSystem, viewLevel,
    worlds, starDomains, galaxies, planets, locations,
    currentWorldDomains, currentDomainGalaxies, currentSystemPlanets, currentDomainAllGalaxies,
    currentDomainHyperlanes, getHyperlanesByNode,
    loadGeodata, reextract, saveGeodata, 
    updateNodePosition, updateAllCoordinates,
    addHyperlane, removeHyperlane, updateHyperlane, getHyperlaneById,
    selectWorld, selectDomain, selectSystem, backToWorld, backToDomain
  };
});
