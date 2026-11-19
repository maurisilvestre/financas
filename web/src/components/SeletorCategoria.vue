<script setup lang="ts">
import { computed } from 'vue';
import { categorias } from '../store.ts';

const props = withDefaults(defineProps<{
  modelValue: string | null;
  /** Texto da opção vazia. */
  vazio?: string;
  /** false: a opção vazia só aparece enquanto não há categoria, e não pode ser escolhida. */
  permitirVazio?: boolean;
  compacto?: boolean;
  desabilitado?: boolean;
  rotulo?: string;
}>(), { vazio: 'Sem categoria', permitirVazio: true, rotulo: 'Categoria' });
const emit = defineEmits<{ 'update:modelValue': [valor: string | null] }>();

const grupos = computed(() => [
  { rotulo: 'Gastos', itens: categorias.value.filter((c) => c.tipo === 'expense') },
  { rotulo: 'Receitas', itens: categorias.value.filter((c) => c.tipo === 'income') },
  { rotulo: 'Movimentações (não contam como gasto)', itens: categorias.value.filter((c) => c.tipo === 'transfer') },
]);

function mudar(e: Event): void {
  const valor = (e.target as HTMLSelectElement).value;
  emit('update:modelValue', valor === '' ? null : valor);
}
</script>

<template>
  <select
    class="campo"
    :class="{ compacto }"
    :value="props.modelValue ?? ''"
    :disabled="desabilitado"
    :aria-label="rotulo"
    @change="mudar"
  >
    <option v-if="permitirVazio || !props.modelValue" value="" :disabled="!permitirVazio">{{ vazio }}</option>
    <optgroup v-for="g in grupos" :key="g.rotulo" :label="g.rotulo">
      <option v-for="c in g.itens" :key="c.nome" :value="c.nome">{{ c.nome }}</option>
    </optgroup>
  </select>
</template>
