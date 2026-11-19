<script setup lang="ts">
import { computed } from 'vue';
import { fmtDelta } from '../lib/format.ts';

const props = defineProps<{
  titulo: string;
  valor: string;
  tom?: 'positivo' | 'negativo';
  /** Variação em %, mostrada com cor de bom/ruim. */
  delta?: number | null;
  /** Para gastos: subir é ruim. */
  menorMelhor?: boolean;
  referencia?: string;
  detalhe?: string;
}>();

const classeDelta = computed(() => {
  if (props.delta === null || props.delta === undefined || Math.round(props.delta) === 0) return '';
  return (props.delta > 0) === !props.menorMelhor ? 'bom' : 'ruim';
});
</script>

<template>
  <div class="cartao kpi">
    <div class="rotulo">{{ titulo }}</div>
    <div class="valor" :class="tom ? `tom-${tom}` : ''">{{ valor }}</div>
    <div class="detalhe">
      <template v-if="delta !== null && delta !== undefined">
        <span :class="classeDelta">{{ fmtDelta(delta) }}</span> {{ referencia }}
      </template>
      <template v-else-if="detalhe">{{ detalhe }}</template>
      <slot />
    </div>
  </div>
</template>
