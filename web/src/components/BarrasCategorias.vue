<script setup lang="ts">
// Gastos do mês por categoria, com um traço na média dos meses anteriores.
// "Sem categoria" fica à parte: costuma ser grande e achataria a escala das outras.
// Mês em andamento (parcial): sem comparação com a média, que seria de meses inteiros.
import { computed } from 'vue';
import { brl, deltaPct, fmtDelta, toNumber } from '../lib/format.ts';
import type { CategoriaMes } from '../types.ts';

const props = defineProps<{ categorias: CategoriaMes[]; link: (categoria: string) => string; parcial?: boolean }>();

const SEM = 'Sem categoria';
const semCategoria = computed(() => props.categorias.find((c) => c.categoria === SEM && (toNumber(c.total) ?? 0) > 0) ?? null);

const linhas = computed(() => {
  const visiveis = props.categorias.filter((c) => c.categoria !== SEM
    && ((toNumber(c.total) ?? 0) > 0 || (!props.parcial && (toNumber(c.media_3m) ?? 0) > 0)));
  const max = Math.max(1, ...visiveis.flatMap((c) => [toNumber(c.total) ?? 0, props.parcial ? 0 : toNumber(c.media_3m) ?? 0]));
  return visiveis.map((c) => {
    const media = props.parcial ? null : toNumber(c.media_3m);
    const delta = props.parcial ? null : deltaPct(c.total, c.media_3m);
    return {
      ...c,
      largura: `${((toNumber(c.total) ?? 0) / max) * 100}%`,
      posMedia: media ? `${(media / max) * 100}%` : null,
      delta,
      classeDelta: delta === null || Math.round(delta) === 0 ? '' : delta > 0 ? 'ruim' : 'bom',
    };
  });
});
</script>

<template>
  <a v-if="semCategoria" class="cat-sem" :href="link(SEM)">
    <span><strong>{{ brl(semCategoria.total) }}</strong> sem categoria</span>
    <span class="sub">Categorizar →</span>
  </a>
  <p v-if="linhas.length === 0" class="vazio">Nenhum gasto categorizado neste mês.</p>
  <div v-else class="cats">
    <a v-for="c in linhas" :key="c.categoria" class="cat" :href="link(c.categoria)" :title="`Ver as transações de ${c.categoria}`">
      <span class="cat-nome"><i class="ponto" :style="{ backgroundColor: c.cor }"></i>{{ c.categoria }}</span>
      <span class="cat-barra">
        <span class="cat-preench" :style="{ width: c.largura, backgroundColor: c.cor }"></span>
        <span v-if="c.posMedia" class="cat-media" :style="{ left: c.posMedia }" :title="`Média: ${brl(c.media_3m)}`"></span>
      </span>
      <span class="cat-valor">{{ brl(c.total) }}</span>
      <span class="cat-delta" :class="c.classeDelta" :title="c.media_3m ? `Média: ${brl(c.media_3m)}` : undefined">{{ c.delta === null ? '' : fmtDelta(c.delta) }}</span>
    </a>
  </div>
</template>
