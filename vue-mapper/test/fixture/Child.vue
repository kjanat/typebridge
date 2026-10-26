<script setup lang="ts">
defineProps<{ count: number; label?: string }>();
defineEmits<{ change: [value: number] }>();
</script>

<template>
  <span>{{ label }}</span>
</template>
