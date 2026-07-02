<template>
  <div class="home">
    <h1>欢迎使用 Kiro PJ</h1>
    <p>这是一个基于 Vue 3 + TypeScript + Vite 的项目模板。</p>
    <div class="counter">
      <p>计数器：{{ counter.count }}</p>
      <div class="buttons">
        <button @click="counter.decrement">-</button>
        <button @click="counter.reset">重置</button>
        <button @click="counter.increment">+</button>
      </div>
    </div>
    <RouterLink to="/about">关于页面 →</RouterLink>
  </div>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { useCounterStore } from '@/stores/counter'

const counter = useCounterStore()
</script>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  gap: 1.5rem;
  padding: 2rem;
}

h1 {
  font-size: 2rem;
  color: #2c3e50;
}

p {
  color: #666;
}

.counter {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  padding: 1.5rem 2.5rem;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  background: #f9f9f9;
}

.buttons {
  display: flex;
  gap: 0.75rem;
}

button {
  padding: 0.5rem 1.25rem;
  font-size: 1rem;
  border: none;
  border-radius: 6px;
  background: #42b983;
  color: white;
  cursor: pointer;
  transition: background 0.2s;
}

button:hover {
  background: #33a06f;
}

a {
  color: #42b983;
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}
</style>
User accepted creation of

AboutView.vue
60


