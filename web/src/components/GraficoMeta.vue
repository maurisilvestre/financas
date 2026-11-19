<script setup lang="ts">
// Acompanhamento diário da meta do cartão à vista (SVG puro): gasto acumulado do mês,
// o mesmo acumulado do mês anterior, o ritmo ideal (meta distribuída pelos dias) e a meta.
// No celular, o desenho tem a largura real da tela, para o texto não encolher.
import { computed, ref } from 'vue';
import { type Area, caminhoAcumulado, escalaMax, larguraGrafico, marcas } from '../lib/charts.ts';
import { brl, brlCompacto, mesCurto, toNumber } from '../lib/format.ts';
import { useLargura } from '../largura.ts';
import type { AcompanhamentoMeta } from '../types.ts';

const props = defineProps<{ dados: AcompanhamentoMeta }>();

const caixa = ref<HTMLElement | null>(null);
const espaco = useLargura(caixa);
const W = computed(() => larguraGrafico(espaco.value));
const H = 250;
const area = computed<Area>(() => ({ x0: 70, x1: W.value - 12, y0: 12, y1: H - 28 }));

const dias = computed(() => props.dados.dias_no_mes);
const meta = computed(() => toNumber(props.dados.meta));
const atual = computed(() => props.dados.por_dia.map((d) => toNumber(d.acumulado) ?? 0));
const anterior = computed(() => props.dados.mes_anterior.por_dia.slice(0, dias.value).map((d) => toNumber(d.acumulado) ?? 0));
const max = computed(() => escalaMax([meta.value ?? 0, ...atual.value, ...anterior.value, toNumber(props.dados.projecao) ?? 0]));
const ticks = computed(() => marcas(max.value, 4));

const x = (dia: number) => area.value.x0 + ((dia - 1) / Math.max(dias.value - 1, 1)) * (area.value.x1 - area.value.x0);
const y = (v: number) => area.value.y1 - (Math.max(v, 0) / max.value) * (area.value.y1 - area.value.y0);

const linhaAtual = computed(() => caminhoAcumulado(atual.value, dias.value, max.value, area.value));
const linhaAnterior = computed(() => caminhoAcumulado(anterior.value, dias.value, max.value, area.value));
const ultimo = computed(() => {
  const n = atual.value.length;
  return n ? { cx: x(n), cy: y(atual.value[n - 1]!) } : null;
});
const rotulosDias = computed(() => [1, 5, 10, 15, 20, 25, dias.value].filter((d, i, a) => d <= dias.value && a.indexOf(d) === i));
const descricao = computed(() =>
  `Gasto à vista no cartão até o dia ${props.dados.dia_atual}: ${brl(props.dados.gasto)}`
  + (props.dados.meta ? `, meta de ${brl(props.dados.meta)}` : ''));
</script>

<template>
  <div ref="caixa">
    <div class="legenda">
      <span><i class="traco" :class="`traco-${dados.status}`"></i> {{ mesCurto(dados.mes) }}</span>
      <span><i class="traco traco-anterior"></i> {{ mesCurto(dados.mes_anterior.mes) }}</span>
      <span v-if="meta"><i class="traco traco-ritmo"></i> Ritmo da meta</span>
      <span v-if="meta"><i class="traco traco-meta"></i> Meta</span>
    </div>
    <svg class="grafico grafico-meta" :viewBox="`0 0 ${W} ${H}`" role="img" :aria-label="descricao">
      <g aria-hidden="true">
        <g v-for="t in ticks" :key="t">
          <line class="grade-linha" :x1="area.x0" :x2="area.x1" :y1="y(t)" :y2="y(t)" />
          <text :x="area.x0 - 8" :y="y(t) + 4" text-anchor="end">{{ brlCompacto(t) }}</text>
        </g>
        <text v-for="d in rotulosDias" :key="d" :x="x(d)" :y="H - 8" text-anchor="middle">{{ d }}</text>
      </g>
      <line v-if="meta" class="linha-meta" :x1="area.x0" :x2="area.x1" :y1="y(meta)" :y2="y(meta)" />
      <line v-if="meta" class="linha-ritmo" :x1="x(1)" :y1="y(meta / dias)" :x2="x(dias)" :y2="y(meta)" />
      <path class="linha-anterior" :d="linhaAnterior" />
      <path class="linha-atual" :class="`linha-${dados.status}`" :d="linhaAtual" />
      <circle v-if="ultimo" class="ponto-atual" :class="`linha-${dados.status}`" :cx="ultimo.cx" :cy="ultimo.cy" r="4" />
    </svg>
  </div>
</template>
