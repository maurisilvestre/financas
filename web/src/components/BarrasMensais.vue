<script setup lang="ts">
// Barras por mês, uma por série, lado a lado (SVG puro). Clicar num mês o seleciona.
// Séries: "entrou × saiu" ou "cartão × conta", escolhidas pela página.
// No celular, o desenho tem a largura real da tela (o texto não encolhe) e só parte dos meses ganha rótulo.
import { computed, ref } from 'vue';
import { escalaMax, larguraGrafico, marcas, rotulosMeses } from '../lib/charts.ts';
import { brl, brlCompacto, mesCurto, toNumber } from '../lib/format.ts';
import { useLargura } from '../largura.ts';
import type { Serie } from '../types.ts';

const props = defineProps<{
  meses: Array<{ mes: string } & Record<string, string | number | boolean>>;
  series: Serie[];
  selecionado?: string;
}>();
const emit = defineEmits<{ selecionar: [mes: string] }>();

const caixa = ref<HTMLElement | null>(null);
const espaco = useLargura(caixa);
const W = computed(() => larguraGrafico(espaco.value));
const H = 240;
const ESQ = 70;
const DIR = 6;
const TOPO = 10;
const BASE = 26;
const GAP = 3;
const plotW = computed(() => W.value - ESQ - DIR);
const plotH = H - TOPO - BASE;

const valor = (m: Record<string, unknown>, campo: string) => toNumber(m[campo] as string) ?? 0;
const max = computed(() => escalaMax(props.meses.flatMap((m) => props.series.map((s) => valor(m, s.campo)))));
const ticks = computed(() => marcas(max.value, 4));
const y = (v: number) => TOPO + plotH - (Math.max(v, 0) / max.value) * plotH;
const banda = computed(() => plotW.value / Math.max(props.meses.length, 1));
// Um rótulo a cada ~40 de largura, alinhado ao calendário; na tela larga, todos.
const comRotulo = computed(() => new Set(rotulosMeses(props.meses.map((m) => m.mes), Math.floor(plotW.value / 40))));

const grupos = computed(() => props.meses.map((m, i) => {
  const x0 = ESQ + i * banda.value;
  const centro = x0 + banda.value / 2;
  const n = props.series.length;
  const bw = Math.min(16, (banda.value * 0.62) / n);
  const largura = n * bw + (n - 1) * GAP;
  const barras = props.series.map((s, j) => {
    const v = valor(m, s.campo);
    return { classe: s.classe, x: centro - largura / 2 + j * (bw + GAP), y: y(v), h: TOPO + plotH - y(v) };
  });
  const titulo = `${mesCurto(m.mes)}: ${props.series.map((s) => `${s.rotulo.toLowerCase()} ${brl(m[s.campo] as string)}`).join(', ')}`;
  // Rótulo que passaria da borda direita fica alinhado ao fim do gráfico.
  const noFim = centro + 18 > W.value;
  return {
    mes: m.mes, x0, centro, bw, barras, titulo, rotulo: comRotulo.value.has(i),
    rotuloX: noFim ? W.value - 1 : centro, ancora: noFim ? 'end' : 'middle',
  };
}));
</script>

<template>
  <div ref="caixa">
    <div class="legenda">
      <span v-for="s in series" :key="s.campo"><i class="ponto" :class="`ponto-${s.classe}`"></i> {{ s.rotulo }}</span>
    </div>
    <svg class="grafico" :viewBox="`0 0 ${W} ${H}`" role="group" :aria-label="`${series.map((s) => s.rotulo).join(' e ')} por mês`">
      <g aria-hidden="true">
        <g v-for="t in ticks" :key="t">
          <line class="grade-linha" :x1="ESQ" :x2="W - DIR" :y1="y(t)" :y2="y(t)" />
          <text :x="ESQ - 8" :y="y(t) + 4" text-anchor="end">{{ brlCompacto(t) }}</text>
        </g>
      </g>
      <g
        v-for="g in grupos"
        :key="g.mes"
        class="grupo"
        :class="{ selecionado: g.mes === selecionado }"
        tabindex="0"
        role="button"
        :aria-label="g.titulo"
        :aria-pressed="g.mes === selecionado"
        @click="emit('selecionar', g.mes)"
        @keydown.enter.prevent="emit('selecionar', g.mes)"
        @keydown.space.prevent="emit('selecionar', g.mes)"
      >
        <title>{{ g.titulo }}</title>
        <rect class="fundo" :x="g.x0 + 2" :y="TOPO - 4" :width="Math.max(banda - 4, 1)" :height="plotH + 4 + BASE - 2" rx="6" />
        <rect v-for="b in g.barras" :key="b.classe" :class="`barra-${b.classe}`" :x="b.x" :y="b.y" :width="g.bw" :height="b.h" rx="2" />
        <text v-if="g.rotulo" :x="g.rotuloX" :y="H - 8" :text-anchor="g.ancora">{{ mesCurto(g.mes) }}</text>
      </g>
    </svg>
  </div>
</template>
