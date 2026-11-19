<script setup lang="ts">
// Botão "Sincronizar" do topo. O app não fala com a Pluggy: pede ao serviço de sync (que confere os
// pedidos a cada 10 s), acompanha até terminar e recarrega as telas. O sync só traz o que a Pluggy
// já buscou nos bancos, e ela busca uma vez por dia; a mensagem do fim diz quando foi.
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.ts';
import { mensagemSync, syncEsperado, terminou } from '../lib/sync.ts';
import { avisar, dadosMudaram } from '../store.ts';
import type { StatusSync } from '../types.ts';

const status = ref<StatusSync | null>(null);
const sincronizando = ref(false);

onMounted(async () => {
  status.value = await api.statusSync().catch(() => null);
});

const ultimo = computed(() => {
  const fim = status.value?.ultimo?.terminado_em;
  if (!fim) return '';
  const d = new Date(fim);
  const hoje = new Date().toDateString() === d.toDateString();
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return hoje ? `às ${hora}` : `em ${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${hora}`;
});
const titulo = computed(() => `Busca na Pluggy o que já chegou dos bancos${ultimo.value ? ` (último sync ${ultimo.value})` : ''}. A Pluggy atualiza cada banco uma vez por dia.`);

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sincronizar(): Promise<void> {
  if (sincronizando.value) return;
  sincronizando.value = true;
  try {
    const antes = await api.statusSync();
    const esperado = syncEsperado(antes);
    const pedido = await api.pedirSync();
    if (!pedido.pedido && pedido.motivo === 'recente') {
      status.value = antes;
      const m = mensagemSync(antes);
      avisar(`Acabou de sincronizar. ${m.texto}`, m.tipo);
      return;
    }
    const inicio = Date.now();
    for (;;) {
      await esperar(2000);
      const s = await api.statusSync();
      status.value = s;
      if (terminou(esperado, s)) {
        const m = mensagemSync(s);
        avisar(m.texto, m.tipo);
        dadosMudaram();
        return;
      }
      if (Date.now() - inicio > 120_000) {
        avisar('O serviço de sync não respondeu em 2 minutos. Ele está rodando? (docker compose up -d)', 'erro');
        return;
      }
    }
  } catch (e) {
    avisar((e as Error).message, 'erro');
  } finally {
    sincronizando.value = false;
  }
}
</script>

<template>
  <button class="botao pequeno botao-sync" type="button" :disabled="sincronizando" :title="titulo" @click="sincronizar">
    <svg class="icone-sync" :class="{ girando: sincronizando }" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v2.8h-2.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <span>{{ sincronizando ? 'Sincronizando…' : 'Sincronizar' }}</span>
  </button>
</template>
