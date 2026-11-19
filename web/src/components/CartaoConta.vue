<script setup lang="ts">
// Onde os gastos do mês aconteceram: cartões de crédito × conta, e cada cartão.
// Mês em andamento (parcial): sem comparação com a média, que seria de meses inteiros.
import { computed } from 'vue';
import { brl, contaCurta, deltaPct, fmtDelta, toNumber } from '../lib/format.ts';
import type { GastoComMedia } from '../types.ts';

const props = defineProps<{
  porOrigem: { cartao: GastoComMedia; conta: GastoComMedia };
  cartoes: Array<GastoComMedia & { conta: string }>;
  parcial: boolean;
  linkOrigem: (origem: 'cartao' | 'conta') => string;
  linkConta: (conta: string) => string;
}>();

const cartao = computed(() => toNumber(props.porOrigem.cartao.gastos) ?? 0);
const conta = computed(() => toNumber(props.porOrigem.conta.gastos) ?? 0);
const pctCartao = computed(() => (cartao.value + conta.value > 0 ? (cartao.value / (cartao.value + conta.value)) * 100 : 0));

function comparacao(g: GastoComMedia) {
  if (props.parcial || g.media_3m === null) return null;
  const d = deltaPct(g.gastos, g.media_3m);
  if (d === null) return null;
  return { texto: fmtDelta(d), classe: Math.round(d) === 0 ? '' : d > 0 ? 'ruim' : 'bom' };
}

const lados = computed(() => [
  { origem: 'cartao' as const, rotulo: 'Cartões de crédito', g: props.porOrigem.cartao, pct: pctCartao.value },
  { origem: 'conta' as const, rotulo: 'Conta (débito, Pix, boletos)', g: props.porOrigem.conta, pct: 100 - pctCartao.value },
].map((l) => ({ ...l, comp: comparacao(l.g) })));

const linhasCartoes = computed(() => {
  const max = Math.max(1, ...props.cartoes.flatMap((c) => [toNumber(c.gastos) ?? 0, props.parcial ? 0 : toNumber(c.media_3m) ?? 0]));
  return props.cartoes.map((c) => {
    const media = props.parcial ? null : toNumber(c.media_3m);
    return {
      ...c,
      largura: `${((toNumber(c.gastos) ?? 0) / max) * 100}%`,
      posMedia: media ? `${(media / max) * 100}%` : null,
      comp: comparacao(c),
    };
  });
});
</script>

<template>
  <div class="cartao cc">
    <div class="cartao-topo">
      <div>
        <h2>Cartão × conta</h2>
        <p class="sub">Onde os gastos do mês aconteceram.<template v-if="!parcial"> As setas comparam com a média dos meses anteriores.</template></p>
      </div>
    </div>
    <div class="cc-grade">
      <div class="cc-lados">
        <a v-for="l in lados" :key="l.origem" class="cc-lado" :href="linkOrigem(l.origem)" :title="`Ver as transações: ${l.rotulo}`">
          <span class="cc-rotulo"><i class="ponto" :class="`ponto-${l.origem}`"></i>{{ l.rotulo }}</span>
          <span class="cc-valor">{{ brl(l.g.gastos) }}</span>
          <span class="cc-det">
            {{ Math.round(l.pct) }}% dos gastos
            <template v-if="l.comp"> · <span :class="l.comp.classe">{{ l.comp.texto }}</span> vs. média</template>
            <template v-else-if="!parcial && l.g.media_3m !== null"> · média {{ brl(l.g.media_3m) }}</template>
          </span>
        </a>
        <div class="cc-proporcao" role="img" :aria-label="`${Math.round(pctCartao)}% dos gastos no cartão`">
          <span class="cc-p-cartao" :style="{ width: `${pctCartao}%` }"></span>
        </div>
      </div>
      <div class="cc-cartoes">
        <h3>Por cartão</h3>
        <p v-if="linhasCartoes.length === 0" class="vazio">Nenhum gasto no cartão neste mês.</p>
        <div v-else class="cats">
          <a v-for="c in linhasCartoes" :key="c.conta" class="cat" :href="linkConta(c.conta)" :title="`Ver as transações de ${c.conta}`">
            <span class="cat-nome"><i class="ponto ponto-cartao"></i>{{ contaCurta(c.conta) }}</span>
            <span class="cat-barra">
              <span class="cat-preench barra-cartao-fundo" :style="{ width: c.largura }"></span>
              <span v-if="c.posMedia" class="cat-media" :style="{ left: c.posMedia }" :title="`Média: ${brl(c.media_3m)}`"></span>
            </span>
            <span class="cat-valor">{{ brl(c.gastos) }}</span>
            <span class="cat-delta" :class="c.comp?.classe">{{ c.comp?.texto ?? '' }}</span>
          </a>
        </div>
      </div>
    </div>
  </div>
</template>
