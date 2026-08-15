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
        :style="{ background: getWorldGradient(world.name), '--card-accent': getWorldAccent(world.name) }"
        @click="$emit('select', world)"
      >
        <button
          class="delete-btn"
          title="删除世界（其下星域/星系将失去上级关联，可撤销）"
          @click.stop="$emit('delete-world', world)"
        >🗑</button>
        <div class="world-icon" :style="{ background: getWorldIconGradient(world.name) }">{{ (world.displayName || world.name).charAt(0) }}</div>
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

// ===== 世界主题色（名称哈希 → 确定性渐变，与星图风格统一） =====
function hashName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return Math.abs(hash);
}

function getWorldGradient(name) {
  const hue = hashName(name) % 360;
  return `linear-gradient(160deg, hsl(${hue}, 38%, 20%) 0%, hsl(${(hue + 35) % 360}, 42%, 12%) 60%, #0c101c 100%)`;
}

function getWorldIconGradient(name) {
  const hue = hashName(name) % 360;
  return `linear-gradient(135deg, hsl(${hue}, 68%, 58%) 0%, hsl(${(hue + 45) % 360}, 72%, 42%) 100%)`;
}

function getWorldAccent(name) {
  const hue = hashName(name) % 360;
  return `hsl(${hue}, 70%, 60%)`;
}

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
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 40px;
  overflow-y: auto;
  background:
    radial-gradient(ellipse at 25% 15%, rgba(58, 80, 140, 0.22) 0%, transparent 55%),
    radial-gradient(ellipse at 75% 85%, rgba(100, 60, 140, 0.18) 0%, transparent 55%),
    radial-gradient(ellipse at 60% 40%, rgba(40, 90, 100, 0.12) 0%, transparent 50%),
    #0a0e18;
}

/* 星尘（确定性伪元素，与星图背景一致） */
.world-selector::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    radial-gradient(1px 1px at 20px 30px, rgba(255, 255, 255, 0.35), transparent),
    radial-gradient(1px 1px at 40px 70px, rgba(255, 255, 255, 0.25), transparent),
    radial-gradient(1.5px 1.5px at 50px 160px, rgba(255, 255, 255, 0.3), transparent),
    radial-gradient(1px 1px at 90px 40px, rgba(255, 255, 255, 0.2), transparent),
    radial-gradient(1px 1px at 130px 120px, rgba(255, 255, 255, 0.28), transparent),
    radial-gradient(1.2px 1.2px at 160px 60px, rgba(255, 255, 255, 0.22), transparent);
  background-size: 200px 200px;
  opacity: 0.7;
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
  border: 1px solid rgba(88, 166, 255, 0.25);
  border-radius: 10px;
  padding: 24px;
  cursor: pointer;
  transition: all 0.25s;
  text-align: center;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.world-card:hover {
  border-color: var(--card-accent);
  transform: translateY(-4px);
  box-shadow:
    0 0 22px color-mix(in srgb, var(--card-accent) 30%, transparent),
    0 10px 30px rgba(0, 0, 0, 0.5),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
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

.world-icon {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  color: #fff;
  font-size: 24px;
  font-weight: bold;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 16px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4), 0 0 14px color-mix(in srgb, var(--card-accent) 45%, transparent);
  border: 1px solid rgba(255, 255, 255, 0.18);
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
