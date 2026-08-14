<template>
  <div class="world-selector">
    <div class="header-row">
      <div>
        <h1>选择世界</h1>
        <p class="subtitle">选择一个世界观作为起点</p>
      </div>
      <button class="create-btn" @click="$emit('create-world')">＋ 新建世界</button>
    </div>
    <div class="world-grid">
      <div 
        v-for="world in worlds" 
        :key="world.id" 
        class="world-card"
        @click="$emit('select', world)"
      >
        <button
          class="delete-btn"
          title="删除世界（其下星域/星系将失去上级关联，可撤销）"
          @click.stop="$emit('delete-world', world)"
        >🗑</button>
        <div class="world-icon">{{ (world.displayName || world.name).charAt(0) }}</div>
        <h3>{{ world.displayName || world.name }}</h3>
        <p class="world-desc">{{ world.tags?.filter(t => !['世界', '地理系统'].includes(t)).slice(0, 3).join(' · ') || '暂无描述' }}</p>
        <div class="world-meta">
          <span>{{ getDomainCount(world.id) }} 个星域</span>
          <span class="separator">·</span>
          <span>{{ getGalaxyCount(world.id) }} 个星系</span>
        </div>
        <div class="world-meta secondary">
          <span>{{ getPlanetCount(world.id) }} 个行星级</span>
          <span class="separator">·</span>
          <span>{{ getLocationCount(world.id) }} 个场景</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  worlds: { type: Array, default: () => [] },
  domains: { type: Array, default: () => [] },
  galaxies: { type: Array, default: () => [] },
  planets: { type: Array, default: () => [] },
  locations: { type: Array, default: () => [] },
});

defineEmits(['select', 'create-world', 'delete-world']);

function getDomainCount(worldId) {
  return props.domains.filter(d => d.parentId === worldId).length;
}

function getGalaxyCount(worldId) {
  const domainIds = new Set(props.domains.filter(d => d.parentId === worldId).map(d => d.id));
  return props.galaxies.filter(g => domainIds.has(g.parentId)).length;
}

function getPlanetCount(worldId) {
  const domainIds = new Set(props.domains.filter(d => d.parentId === worldId).map(d => d.id));
  const galaxyIds = new Set(props.galaxies.filter(g => domainIds.has(g.parentId)).map(g => g.id));
  return props.planets.filter(p => galaxyIds.has(p.parentId)).length;
}

function getLocationCount(worldId) {
  const domainIds = new Set(props.domains.filter(d => d.parentId === worldId).map(d => d.id));
  const galaxyIds = new Set(props.galaxies.filter(g => domainIds.has(g.parentId)).map(g => g.id));
  return props.locations.filter(l => galaxyIds.has(l.parentId)).length;
}
</script>

<style scoped>
.world-selector {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 40px;
  overflow-y: auto;
}

.header-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 24px;
  margin-bottom: 8px;
}

.header-row h1 {
  font-size: 28px;
  color: #f0f6fc;
  margin-bottom: 8px;
}

.create-btn {
  align-self: flex-start;
  margin-top: 6px;
  padding: 8px 18px;
  border: 1px solid #58a6ff;
  border-radius: 6px;
  background: rgba(88, 166, 255, 0.12);
  color: #58a6ff;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}
.create-btn:hover { background: rgba(88, 166, 255, 0.22); }

.subtitle {
  font-size: 14px;
  color: #8b949e;
  margin-bottom: 32px;
}

.world-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 20px;
  max-width: 800px;
  width: 100%;
}

.world-card {
  position: relative;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 24px;
  cursor: pointer;
  transition: all 0.2s;
  text-align: center;
}

.delete-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #8b949e;
  font-size: 13px;
  cursor: pointer;
  opacity: 0;
  transition: all 0.2s;
}
.world-card:hover .delete-btn { opacity: 1; }
.delete-btn:hover { background: rgba(255, 123, 114, 0.15); color: #ff7b72; }

.world-card:hover {
  border-color: #58a6ff;
  transform: translateY(-4px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.world-icon {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: #fff;
  font-size: 24px;
  font-weight: bold;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 16px;
}

.world-card h3 {
  font-size: 18px;
  color: #f0f6fc;
  margin-bottom: 8px;
}

.world-desc {
  font-size: 12px;
  color: #8b949e;
  margin-bottom: 16px;
  line-height: 1.4;
}

.world-meta {
  font-size: 11px;
  color: #58a6ff;
  padding-top: 12px;
  border-top: 1px solid #21262d;
  display: flex;
  gap: 4px;
  align-items: center;
}

.world-meta.secondary {
  color: #8b949e;
  border-top: none;
  padding-top: 4px;
}

.separator {
  color: #484f58;
  margin: 0 2px;
}
</style>
