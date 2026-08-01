<template>
  <div class="world-selector">
    <h1>选择世界</h1>
    <p class="subtitle">选择一个世界观作为起点</p>
    <div class="world-grid">
      <div 
        v-for="world in worlds" 
        :key="world.id" 
        class="world-card"
        @click="$emit('select', world)"
      >
        <div class="world-icon">{{ world.name.charAt(0) }}</div>
        <h3>{{ world.name }}</h3>
        <p class="world-desc">{{ world.tags?.filter(t => !['世界', '地理系统'].includes(t)).slice(0, 3).join(' · ') || '暂无描述' }}</p>
        <div class="world-meta">
          <span>{{ getDomainCount(world.id) }} 个星域</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  worlds: { type: Array, default: () => [] },
  domains: { type: Array, default: () => [] }
});

defineEmits(['select']);

function getDomainCount(worldId) {
  return props.domains.filter(d => d.parentId === worldId).length;
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

.world-selector h1 {
  font-size: 28px;
  color: #f0f6fc;
  margin-bottom: 8px;
}

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
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 24px;
  cursor: pointer;
  transition: all 0.2s;
  text-align: center;
}

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
}
</style>
