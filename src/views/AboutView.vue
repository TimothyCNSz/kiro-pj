<template>
  <div class="about">
    <h1>关于</h1>
    <p>这是一个使用以下技术栈构建的项目：</p>
    <ul>
      <li>Vue 3 (Composition API)</li>
      <li>TypeScript</li>
      <li>Vite</li>
      <li>Vue Router 4</li>
      <li>Pinia</li>
      <li>Axios</li>
    </ul>
    <RouterLink to="/">← 返回首页</RouterLink>
  </div>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>

<style scoped>
.about {
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

ul {
  list-style: none;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

li::before {
  content: '✓ ';
  color: #42b983;
  font-weight: bold;
}

a {
  color: #42b983;
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}
</style>
