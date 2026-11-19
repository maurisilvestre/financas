<script setup lang="ts">
// Uma série de barras verticais (SVG puro), com eixo em reais.
// No celular, o desenho tem a largura real da tela (o texto não encolhe) e só parte das barras ganha rótulo.
import { computed, ref } from 'vue';
import { escalaMax, larguraGrafico, marcas, rotulosEspacados } from '../lib/charts.ts';
import { brlCompacto } from '../lib/format.ts';
import { useLargura } from '../largura.ts';

const props = defineProps<{ itens: Array<{ rotulo: string; valor: number; titulo: string }>; descricao: string }>();

const caixa = ref<HTMLElement | null>(null);
const espaco = useLargura(caixa);
const W = computed(() => larguraGrafico(espaco.value));
const H = 220;
const ESQ = 70;
const DIR = 6;
const TOPO = 10;
const BASE = 26;
const plotW = computed(() => W.value - ESQ - DIR);
const plotH = H - TOPO - BASE;

const max = computed(() => escalaMax(props.itens.map((i) => i.valor)));
const ticks = computed(() => marcas(max.value, 4));
const y = (v: number) => TOPO + plotH - (Math.max(v, 0) / max.value) * plotH;
const banda = computed(() => plotW.value / Math.max(props.itens.length, 1));
const comRotulo = computed(() => new Set(rotulosEspacados(props.itens.length, plotW.value)));
const barras = computed(() => props.itens.map((item, i) => {
  const bw = Math.min(28, banda.value * 0.55);
  const centro = ESQ + i * banda.value + banda.value / 2;
  return { item, centro, x: centro - bw / 2, bw, y: y(item.valor), h: TOPO + plotH - y(item.valor), rotulo: comRotulo.value.has(i) };
}));
</script>

<template>
  <div ref="caixa">
    <svg class="grafico" :viewBox="`0 0 ${W} ${H}`" role="img" :aria-label="descricao">
      <g aria-hidden="true">
        <g v-for="t in ticks" :key="t">
          <line class="grade-linha" :x1="ESQ" :x2="W - DIR" :y1="y(t)" :y2="y(t)" />
          <text :x="ESQ - 8" :y="y(t) + 4" text-anchor="end">{{ brlCompacto(t) }}</text>
        </g>
      </g>
      <g v-for="b in barras" :key="b.item.rotulo">
        <title>{{ b.item.titulo }}</title>
        <rect class="barra" :x="b.x" :y="b.y" :width="b.bw" :height="b.h" rx="3" />
        <text v-if="b.rotulo" :x="b.centro" :y="H - 8" text-anchor="middle">{{ b.item.rotulo }}</text>
      </g>
    </svg>
  </div>
</template>
