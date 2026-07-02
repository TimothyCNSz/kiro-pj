<template>
  <div class="not-found">
    <h1>404</h1>
    <p>页面不存在</p>
    <RouterLink to="/">← 返回首页</RouterLink>
  </div>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>

<style scoped>
.not-found {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  gap: 1rem;
}

h1 {
  font-size: 6rem;
  color: #e0e0e0;
}

p {
  color: #999;
  font-size: 1.2rem;
}

a {
  color: #42b983;
  text-decoration: none;
}
</style>
