<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import Avisos from './components/Avisos.vue';
import BotaoSync from './components/BotaoSync.vue';
import type { Page } from './lib/route.ts';
import PaginaAPagar from './pages/PaginaAPagar.vue';
import PaginaParcelas from './pages/PaginaParcelas.vue';
import PaginaPrevisao from './pages/PaginaPrevisao.vue';
import PaginaRecorrentes from './pages/PaginaRecorrentes.vue';
import PaginaSugestoes from './pages/PaginaSugestoes.vue';
import PaginaTransacoes from './pages/PaginaTransacoes.vue';
import PaginaVisao from './pages/PaginaVisao.vue';
import {
  atualizarParcelamentosNovos, atualizarSugestoesPendentes, carregarCategorias, link, parcelamentosNovos, route, sugestoesPendentes, versao,
} from './store.ts';

const paginas = { visao: PaginaVisao, apagar: PaginaAPagar, transacoes: PaginaTransacoes, sugestoes: PaginaSugestoes, recorrentes: PaginaRecorrentes, parcelas: PaginaParcelas, previsao: PaginaPrevisao };
const abas: Array<{ page: Page; rotulo: string }> = [
  { page: 'visao', rotulo: 'Visão geral' },
  { page: 'apagar', rotulo: 'A pagar' },
  { page: 'transacoes', rotulo: 'Transações' },
  { page: 'sugestoes', rotulo: 'Sugestões' },
  { page: 'recorrentes', rotulo: 'Recorrentes' },
  { page: 'parcelas', rotulo: 'Parcelas' },
  { page: 'previsao', rotulo: 'Posso comprar?' },
];
const pagina = computed(() => paginas[route.page]);

// No celular, as abas rolam para o lado: a da página aberta fica à vista.
const nav = ref<HTMLElement | null>(null);
watch(() => route.page, async () => {
  await nextTick();
  const el = nav.value;
  const ativa = el?.querySelector<HTMLElement>('a.ativa');
  if (!el || !ativa || el.scrollWidth <= el.clientWidth) return;
  el.scrollTo({ left: Math.max(0, ativa.offsetLeft - (el.clientWidth - ativa.offsetWidth) / 2) });
}, { immediate: true });

carregarCategorias().catch(() => {});
watch(versao, () => { void atualizarSugestoesPendentes(); void atualizarParcelamentosNovos(); }, { immediate: true });
</script>

<template>
  <header class="topo">
    <div class="topo-interno">
      <a class="marca" :href="link('visao')">
        <span class="marca-icone" aria-hidden="true">
          <svg viewBox="0 0 16 16"><path d="M3 12V7m3.3 5V4m3.4 8V8.5M13 12V6" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none" /></svg>
        </span>
        Finanças
      </a>
      <nav ref="nav" class="abas" aria-label="Seções">
        <a
          v-for="a in abas"
          :key="a.page"
          :href="link(a.page)"
          :class="{ ativa: route.page === a.page }"
          :aria-current="route.page === a.page ? 'page' : undefined"
        >{{ a.rotulo }}<span v-if="a.page === 'sugestoes' && sugestoesPendentes.grupos > 0" class="contador" :aria-label="`${sugestoesPendentes.grupos} pendentes`">{{ sugestoesPendentes.grupos }}</span><span v-if="a.page === 'parcelas' && parcelamentosNovos.length > 0" class="contador alerta" :aria-label="`${parcelamentosNovos.length} parcelamentos novos`">{{ parcelamentosNovos.length }}</span></a>
      </nav>
      <BotaoSync />
    </div>
  </header>
  <main class="conteudo">
    <component :is="pagina" :key="route.page" />
  </main>
  <Avisos />
</template>
