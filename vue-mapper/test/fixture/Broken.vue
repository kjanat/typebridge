<script setup lang="ts">
import { ref } from 'vue';
import Child from './Child.vue';

const total = ref(0);
const name: string = 42;
const unused = 1;
function onChange(value: string): void {
  void value;
}
</script>

<template>
  <Child :count="'x'" @change="onChange" />
  <Child :count="1" :missing="true" />
  <p>Grüße 👋 {{ total.nope }} {{ name }}</p>
  <!-- @vue-ignore -->
  <Child :count="'ignored'" />
  <!-- @vue-expect-error -->
  <Child :count="'expected'" />
  <!-- @vue-expect-error -->
  <p>{{ total }}</p>
</template>
