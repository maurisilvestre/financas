<script setup lang="ts">
// Saldo acumulado previsto mês a mês (SVG puro), sem e com a compra simulada; o zero em destaque.
// Horizonte longo: o gráfico cresce para o lado e rola quando não cabe; a faixa marca os meses
// que estão na tabela, e clicar num mês leva a tabela até ele.
import { computed, ref, watch } from 'vue';
import { type Area, caminhoLinha, escalaFaixa, larguraGrafico, marcasFaixa, rotulosMeses } from '../lib/charts.ts';
import { brl, brlCompacto, mesCurto, toNumber } from '../lib/format.ts';
import type { Pagina } from '../lib/previsao.ts';
import { useLargura } from '../largura.ts';
import type { MesPrevisao } from '../types.ts';

const props = defineProps<{ meses: MesPrevisao[]; pagina?: Pagina | null }>();
const emit = defineEmits<{ mes: [indice: number] }>();

const rolagem = ref<HTMLDivElement | null>(null);
const espaco = useLargura(rolagem);
// A largura de sempre (no celular, a da tela, para o texto não encolher); com mais de 1 ano,
// pelo menos 18 por mês, para os pontos não se amontoarem.
const POR_MES = 18;
const H = 240;
const n = computed(() => props.meses.length);
const base = computed(() => larguraGrafico(espaco.value));
const W = computed(() => (n.value > 12 ? Math.max(base.value, 82 + n.value * POR_MES) : base.value));
const area = computed<Area>(() => ({ x0: 70, x1: W.value - 12, y0: 12, y1: H - 28 }));
// Mais largo que o espaço: não encolhe, rola para o lado.
const estilo = computed(() => (W.value > base.value ? { minWidth: `${W.value}px` } : {}));

const saldo = computed(() => props.meses.map((m) => toNumber(m.saldo) ?? 0));
const comCompra = computed(() => (props.meses[0]?.saldo_com_compra === undefined
  ? null : props.meses.map((m) => toNumber(m.saldo_com_compra) ?? 0)));
// Guardado: o que está nos investimentos mais a sobra acumulada (só se a Pluggy trouxe investimentos).
const guardado = computed(() => (props.meses[0]?.guardado === undefined ? null : props.meses.map((m) => toNumber(m.guardado) ?? 0)));
const guardadoCompra = computed(() => (props.meses[0]?.guardado_com_compra === undefined
  ? null : props.meses.map((m) => toNumber(m.guardado_com_compra) ?? 0)));
const faixa = computed(() => escalaFaixa([...saldo.value, ...(comCompra.value ?? []), ...(guardado.value ?? []), ...(guardadoCompra.value ?? [])]));
const ticks = computed(() => marcasFaixa(faixa.value.min, faixa.value.max));

const passo = computed(() => (area.value.x1 - area.value.x0) / Math.max(n.value - 1, 1));
const x = (i: number) => area.value.x0 + i * passo.value;
const y = (v: number) => area.value.y1 - ((v - faixa.value.min) / ((faixa.value.max - faixa.value.min) || 1)) * (area.value.y1 - area.value.y0);

const linhaSaldo = computed(() => caminhoLinha(saldo.value, faixa.value.min, faixa.value.max, area.value));
const linhaCompra = computed(() => (comCompra.value ? caminhoLinha(comCompra.value, faixa.value.min, faixa.value.max, area.value) : ''));
const linhaGuardado = computed(() => (guardado.value ? caminhoLinha(guardado.value, faixa.value.min, faixa.value.max, area.value) : ''));
const linhaGuardadoCompra = computed(() => (guardadoCompra.value ? caminhoLinha(guardadoCompra.value, faixa.value.min, faixa.value.max, area.value) : ''));
// Um rótulo a cada ~44 de largura, alinhado ao calendário (de 3 em 3 meses: jan, abr, jul, out).
const rotulos = computed(() => rotulosMeses(props.meses.map((m) => m.mes), Math.floor((area.value.x1 - area.value.x0) / 44))
  .map((i) => ({ i, texto: mesCurto(props.meses[i]!.mes), ancora: x(i) > area.value.x1 - 18 ? 'end' : 'middle' })));

// Uma coluna clicável por mês, com o saldo no balão.
const meio = computed(() => passo.value / 2);
const colunas = computed(() => props.meses.map((m, i) => {
  const valor = comCompra.value ? m.saldo_com_compra : m.saldo;
  const g = comCompra.value ? m.guardado_com_compra : m.guardado;
  return {
    i,
    x: Math.max(area.value.x0 - meio.value, x(i) - meio.value),
    largura: n.value > 1 ? passo.value : area.value.x1 - area.value.x0,
    titulo: `${mesCurto(m.mes)}: saldo acumulado ${brl(valor)}${g === undefined ? '' : ` · guardado ${brl(g)}`}`,
  };
}));
const paginado = computed(() => !!props.pagina && (props.pagina.de > 0 || props.pagina.ate < n.value));
const destaque = computed(() => {
  const p = props.pagina;
  if (!p || !paginado.value) return null;
  const x0 = Math.max(area.value.x0, x(p.de) - meio.value);
  const x1 = Math.min(area.value.x1, x(p.ate - 1) + meio.value);
  return { x: x0, largura: x1 - x0 };
});

const descricao = computed(() => {
  const fim = props.meses.at(-1);
  return fim ? `Saldo acumulado previsto até ${mesCurto(fim.mes)}: ${brl(fim.saldo)}` : 'Sem previsão';
});

// Ao trocar a página da tabela, rola o gráfico até a faixa (só faz diferença em tela estreita).
watch(() => props.pagina?.de, () => {
  const el = rolagem.value;
  const d = destaque.value;
  if (!el || !d || el.scrollWidth <= el.clientWidth) return;
  const escala = el.scrollWidth / W.value;
  el.scrollTo({ left: Math.max(0, d.x * escala - 24), behavior: 'smooth' });
});
</script>

<template>
  <div>
    <div class="legenda">
      <span><i class="traco traco-saldo"></i> Saldo acumulado</span>
      <span v-if="comCompra"><i class="traco traco-compra"></i> Com a compra</span>
      <span v-if="guardado"><i class="traco traco-guardado"></i> Guardado</span>
      <span v-if="guardadoCompra"><i class="traco traco-guardado-compra"></i> Guardado com a compra</span>
      <span v-if="paginado"><i class="amostra-faixa"></i> Meses na tabela (clique num mês para ir até ele)</span>
    </div>
    <div ref="rolagem" class="grafico-rolagem">
      <svg class="grafico grafico-previsao" :style="estilo" :viewBox="`0 0 ${W} ${H}`" role="img" :aria-label="descricao">
        <rect v-if="destaque" class="faixa-pagina" :x="destaque.x" :y="area.y0" :width="destaque.largura" :height="area.y1 - area.y0" />
        <g aria-hidden="true">
          <g v-for="t in ticks" :key="t">
            <line :class="t === 0 ? 'linha-zero' : 'grade-linha'" :x1="area.x0" :x2="area.x1" :y1="y(t)" :y2="y(t)" />
            <text :x="area.x0 - 8" :y="y(t) + 4" text-anchor="end">{{ brlCompacto(t) }}</text>
          </g>
          <text v-for="r in rotulos" :key="r.i" :x="r.ancora === 'end' ? x(r.i) + 6 : x(r.i)" :y="H - 8" :text-anchor="r.ancora">{{ r.texto }}</text>
        </g>
        <g aria-hidden="true">
          <rect v-for="c in colunas" :key="c.i" class="coluna-mes" :class="{ clicavel: paginado }"
            :x="c.x" :y="area.y0" :width="c.largura" :height="area.y1 - area.y0" @click="emit('mes', c.i)">
            <title>{{ c.titulo }}</title>
          </rect>
        </g>
        <path class="linha-saldo" :d="linhaSaldo" />
        <path v-if="comCompra" class="linha-compra" :d="linhaCompra" />
        <path v-if="guardado" class="linha-guardado" :d="linhaGuardado" />
        <path v-if="guardadoCompra" class="linha-guardado-compra" :d="linhaGuardadoCompra" />
        <circle v-for="(v, i) in saldo" :key="i" class="ponto-saldo" :class="{ negativo: v < 0 }" :cx="x(i)" :cy="y(v)" :r="n > 24 ? 2.2 : 3" />
      </svg>
    </div>
  </div>
</template>
