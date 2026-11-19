<script setup lang="ts">
// Meta mensal das compras à vista no cartão: quanto foi, ritmo, projeção e o gráfico do mês.
import { computed, ref, watch } from 'vue';
import { api } from '../api.ts';
import { brl, mesCurto, toNumber } from '../lib/format.ts';
import { avisar, dadosMudaram, versao } from '../store.ts';
import type { AcompanhamentoMeta } from '../types.ts';
import GraficoMeta from './GraficoMeta.vue';

const props = defineProps<{ mes: string }>();

const dados = ref<AcompanhamentoMeta | null>(null);
const erro = ref<string | null>(null);
const editando = ref(false);
const valor = ref('');
const salvando = ref(false);

async function carregar(): Promise<void> {
  erro.value = null;
  try {
    dados.value = await api.acompanhamento(props.mes);
  } catch (e) {
    erro.value = (e as Error).message;
  }
}
watch([() => props.mes, versao], carregar, { immediate: true });

const ROTULOS = {
  sem_meta: 'Sem meta definida',
  dentro: 'Dentro do ritmo',
  acima: 'Acima do ritmo',
  estourou: 'Meta estourada',
} as const;
const rotulo = computed(() => {
  const d = dados.value;
  if (!d) return '';
  if (!d.em_andamento && d.status === 'dentro') return 'Fechou dentro da meta';
  return ROTULOS[d.status];
});
const pct = computed(() => {
  const m = toNumber(dados.value?.meta);
  return m ? Math.round(((toNumber(dados.value?.gasto) ?? 0) / m) * 100) : null;
});
const largura = computed(() => `${Math.min(pct.value ?? 0, 100)}%`);
const posRitmo = computed(() => {
  const m = toNumber(dados.value?.meta);
  const r = toNumber(dados.value?.ritmo_ideal);
  return m && r !== null ? `${Math.min((r / m) * 100, 100)}%` : null;
});
// Quanto ainda dá para gastar por dia até o fim do mês (só para exibir).
const porDiaRestante = computed(() => {
  const d = dados.value;
  const m = toNumber(d?.meta);
  if (!d || !d.em_andamento || m === null) return null;
  const restantes = d.dias_no_mes - d.dia_atual;
  if (restantes <= 0) return null;
  return Math.max(m - (toNumber(d.gasto) ?? 0), 0) / restantes;
});

function editar(): void {
  valor.value = dados.value?.meta ? String(Math.round(Number(dados.value.meta))) : '7200';
  editando.value = true;
}

async function salvar(): Promise<void> {
  const n = Number(valor.value.replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) {
    avisar('Digite um valor em reais, por exemplo 7200.', 'erro');
    return;
  }
  salvando.value = true;
  try {
    const r = await api.definirMeta(n);
    avisar(`Meta do cartão à vista: ${brl(r.meta_cartao_avista)} por mês.`);
    editando.value = false;
    dadosMudaram();
  } catch (e) {
    avisar((e as Error).message, 'erro');
  } finally {
    salvando.value = false;
  }
}
</script>

<template>
  <div class="cartao meta-cartao espaco-topo">
    <div class="cartao-topo">
      <div>
        <h2>Meta do cartão à vista · {{ mesCurto(mes) }}</h2>
        <p class="sub">Compras no cartão sem parcela, pela data da compra. As parcelas já assumidas ficam de fora.</p>
      </div>
      <button v-if="!editando" class="botao pequeno" type="button" @click="editar">{{ dados?.meta ? 'Editar meta' : 'Definir meta' }}</button>
      <form v-else class="meta-form" @submit.prevent="salvar">
        <label class="sr" for="valor-meta">Meta mensal em reais</label>
        <span class="muted">R$</span>
        <input id="valor-meta" v-model="valor" class="campo" inputmode="decimal" autocomplete="off" />
        <button class="botao primario pequeno" type="submit" :disabled="salvando">Salvar</button>
        <button class="botao discreto pequeno" type="button" @click="editando = false">Cancelar</button>
      </form>
    </div>

    <p v-if="erro" class="erro-texto">Não foi possível carregar: {{ erro }}</p>
    <template v-else-if="dados">
      <div class="meta-resumo">
        <div>
          <div class="meta-valor"><span class="num">{{ brl(dados.gasto) }}</span>
            <span v-if="dados.meta" class="muted"> de {{ brl(dados.meta) }}<template v-if="pct !== null"> ({{ pct }}%)</template></span>
          </div>
          <span class="status-meta" :class="`status-${dados.status}`">{{ rotulo }}</span>
        </div>
        <ul class="meta-numeros">
          <li v-if="dados.em_andamento && dados.ritmo_ideal"><span>Ritmo ideal até o dia {{ dados.dia_atual }}</span><strong class="num">{{ brl(dados.ritmo_ideal) }}</strong></li>
          <li v-if="dados.em_andamento"><span>Projeção para o fim do mês</span><strong class="num">{{ brl(dados.projecao) }}</strong></li>
          <li v-if="porDiaRestante !== null"><span>Para fechar na meta: até por dia</span><strong class="num">{{ brl(porDiaRestante) }}</strong></li>
          <li><span>{{ mesCurto(dados.mes_anterior.mes) }} inteiro</span><strong class="num">{{ brl(dados.mes_anterior.total) }}</strong></li>
        </ul>
      </div>
      <div v-if="dados.meta" class="meta-barra" role="presentation">
        <span class="meta-preench" :class="`linha-${dados.status}`" :style="{ width: largura }"></span>
        <span v-if="posRitmo && dados.em_andamento" class="meta-marca" :style="{ left: posRitmo }" title="Ritmo ideal até hoje"></span>
      </div>
      <GraficoMeta :dados="dados" />
    </template>
    <p v-else class="carregando">Carregando…</p>
  </div>
</template>
