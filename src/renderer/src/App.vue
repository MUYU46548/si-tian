<template>
  <div class="app-layout">
    <header class="toolbar">
      <h1>Canjuguan</h1>
      <div class="toolbar-center">
        <nav class="level-indicator">
          <button 
            :class="{ active: store.viewLevel === 'world' }" 
            @click="store.backToWorld()"
          >世界</button>
          <span v-if="store.currentWorld" class="separator">›</span>
          <button 
            v-if="store.currentWorld" 
            :class="{ active: store.viewLevel === 'domain' }"
            @click="store.backToDomain()"
          >{{ store.currentWorld?.name }}</button>
          <span v-if="store.currentDomain" class="separator">›</span>
          <button 
            v-if="store.currentDomain" 
            :class="{ active: store.viewLevel === 'system' }"
          >{{ store.currentDomain?.name }}</button>
        </nav>
      </div>
      <div class="toolbar-actions">
        <button @click="reextract">↻ 重新提取</button>
        <button @click="saveData" :disabled="!dirty">💾 保存</button>
        <span class="status">{{ statusText }}</span>
      </div>
    </header>
    
    <main class="main-content">
      <world-selector
        v-if="store.viewLevel === 'world'"
        :worlds="store.worlds"
        :domains="store.starDomains"
        @select="store.selectWorld"
      />
      
      <galaxy-map
        v-if="store.viewLevel === 'domain'"
        :world="store.currentWorld"
        :domains="store.currentWorldDomains"
        :galaxies="store.galaxies"
        @select="store.selectDomain"
        @back="store.backToWorld"
      />
      
      <system-view
        v-if="store.viewLevel === 'system'"
        :domain="store.currentDomain"
        :systems="store.currentDomainGalaxies"
        :planets="store.planets"
        :locations="store.locations"
        @back="store.backToDomain"
      />
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useGeodataStore } from './store/geodata';
import WorldSelector from './components/WorldSelector.vue';
import GalaxyMap from './components/GalaxyMap.vue';
import SystemView from './components/SystemView.vue';

const store = useGeodataStore();
const dirty = ref(false);
const statusText = ref('');

onMounted(async () => {
  statusText.value = '正在加载数据...';
  await store.loadGeodata();
  statusText.value = `已加载 ${store.nodes.length} 个节点 | ${store.worlds.length} 世界 | ${store.starDomains.length} 星域 | ${store.galaxies.length} 星系 | ${store.planets.length} 行星`;
});

async function reextract() {
  statusText.value = '正在重新提取...';
  await store.reextract();
  dirty.value = false;
  statusText.value = `已更新 ${store.nodes.length} 个节点`;
}

async function saveData() {
  await store.saveGeodata();
  dirty.value = false;
  statusText.value = '已保存';
}
</script>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #0d1117;
  color: #e2e8f0;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: #161b22;
  border-bottom: 1px solid #30363d;
}

.toolbar h1 {
  font-size: 16px;
  color: #58a6ff;
  min-width: 100px;
}

.toolbar-center {
  flex: 1;
  display: flex;
  justify-content: center;
}

.level-indicator {
  display: flex;
  gap: 6px;
  align-items: center;
}

.level-indicator button {
  background: none;
  border: none;
  color: #8b949e;
  font-size: 13px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}

.level-indicator button:hover {
  color: #58a6ff;
  background: #21262d;
}

.level-indicator button.active {
  color: #58a6ff;
  background: #388bfd22;
}

.separator {
  color: #484f58;
  font-size: 14px;
}

.toolbar-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  min-width: 200px;
  justify-content: flex-end;
}

.toolbar-actions button {
  padding: 5px 12px;
  border: 1px solid #30363d;
  border-radius: 4px;
  background: #21262d;
  color: #c9d1d9;
  cursor: pointer;
  font-size: 12px;
}

.toolbar-actions button:hover {
  background: #30363d;
}

.toolbar-actions button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.status {
  font-size: 11px;
  color: #8b949e;
}

.main-content {
  flex: 1;
  overflow: hidden;
}
</style>
