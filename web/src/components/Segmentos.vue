<script setup lang="ts" generic="T extends string">
// Botões de escolha única (ex.: Cartões | Conta | Tudo).
defineProps<{ opcoes: Array<{ valor: T; rotulo: string }>; modelValue: T; rotulo: string }>();
const emit = defineEmits<{ 'update:modelValue': [valor: T] }>();
</script>

<template>
  <div class="segmentos" role="radiogroup" :aria-label="rotulo">
    <button
      v-for="o in opcoes"
      :key="o.valor"
      type="button"
      role="radio"
      :aria-checked="o.valor === modelValue"
      :class="{ ativo: o.valor === modelValue }"
      @click="emit('update:modelValue', o.valor)"
    >{{ o.rotulo }}</button>
  </div>
</template>
