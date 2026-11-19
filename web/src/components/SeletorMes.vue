<script setup lang="ts">
import { computed } from 'vue';
import { mesCurto, shiftMes } from '../lib/format.ts';

const props = defineProps<{ mes: string; max: string }>();
const emit = defineEmits<{ 'update:mes': [mes: string] }>();

const anterior = computed(() => shiftMes(props.mes, -1));
const proximo = computed(() => shiftMes(props.mes, 1));
</script>

<template>
  <div class="seletor-mes" role="group" aria-label="Escolher mês">
    <button class="botao" type="button" :aria-label="`Mês anterior (${mesCurto(anterior)})`" @click="emit('update:mes', anterior)">‹</button>
    <span class="seletor-mes-rotulo">{{ mesCurto(mes) }}</span>
    <button class="botao" type="button" :disabled="mes >= max" :aria-label="`Próximo mês (${mesCurto(proximo)})`" @click="emit('update:mes', proximo)">›</button>
    <button v-if="mes !== max" class="botao discreto" type="button" @click="emit('update:mes', max)">Mês atual</button>
  </div>
</template>
