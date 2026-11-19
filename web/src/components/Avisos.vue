<script setup lang="ts">
import { avisos, fecharAviso } from '../store.ts';

function agir(id: number, fazer: () => void): void {
  fazer();
  fecharAviso(id);
}
</script>

<template>
  <div class="avisos" role="status" aria-live="polite">
    <div v-for="a in avisos" :key="a.id" class="toast" :class="a.tipo">
      <span>{{ a.texto }}</span>
      <button v-if="a.acao" class="toast-acao" type="button" @click="agir(a.id, a.acao.fazer)">{{ a.acao.rotulo }}</button>
      <button class="toast-fechar" type="button" aria-label="Fechar aviso" @click="fecharAviso(a.id)">×</button>
    </div>
  </div>
</template>
