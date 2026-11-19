<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from '../api.ts';
import BarrasCategorias from '../components/BarrasCategorias.vue';
import BarrasMensais from '../components/BarrasMensais.vue';
import CartaoConta from '../components/CartaoConta.vue';
import KpiCard from '../components/KpiCard.vue';
import MetaCartao from '../components/MetaCartao.vue';
import Segmentos from '../components/Segmentos.vue';
import SeletorMes from '../components/SeletorMes.vue';
import { brl, dataCurta, deltaPct, mesAtual, mesCurto, mesLongo, toNumber, ultimoDia } from '../lib/format.ts';
import { go, link, route, sugestoesPendentes, versao } from '../store.ts';
import type { APagar, Origem, Resumo, Serie, Visao } from '../types.ts';

type Filtro = Origem | 'todas';
type Grafico = 'origem' | 'entradas';

const atual = mesAtual();
const mes = computed(() => {
  const m = route.query.mes;
  return m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m) && m <= atual ? m : atual;
});
// Quase todo gasto é no cartão: por padrão, as categorias mostram só os cartões
// e o gráfico compara cartão × conta.
const origem = computed<Filtro>(() => (['cartao', 'conta', 'todas'].includes(route.query.origem ?? '') ? route.query.origem as Filtro : 'cartao'));
const grafico = computed<Grafico>(() => (route.query.grafico === 'entradas' ? 'entradas' : 'origem'));
const titulo = computed(() => mesLongo(mes.value).replace(/^./, (c) => c.toUpperCase()));

const visao = ref<Visao | null>(null);
// No mês corrente, o "Sobrou" (entrou − saiu até hoje) engana: as contas do resto do mês e as
// faturas ainda vão sair. No lugar dele, o que vai sobrar ou faltar até o próximo salário.
const aPagar = ref<APagar | null>(null);
const resumo = ref<Resumo | null>(null);
const erro = ref<string | null>(null);

async function carregar(): Promise<void> {
  erro.value = null;
  try {
    const [v, r] = await Promise.all([
      api.visao(mes.value, origem.value === 'todas' ? undefined : origem.value),
      api.resumo(12),
    ]);
    visao.value = v;
    resumo.value = r;
    aPagar.value = v.em_andamento ? await api.aPagar().catch(() => null) : null;
  } catch (e) {
    erro.value = (e as Error).message;
  }
}
watch([mes, origem, versao], carregar, { immediate: true });

function navegar(mudanca: { mes?: string; origem?: Filtro; grafico?: Grafico }): void {
  const proximo = { mes: mes.value, origem: origem.value, grafico: grafico.value, ...mudanca };
  go('visao', {
    mes: proximo.mes === atual ? undefined : proximo.mes,
    origem: proximo.origem === 'cartao' ? undefined : proximo.origem,
    grafico: proximo.grafico === 'origem' ? undefined : proximo.grafico,
  });
}

const SERIES: Record<Grafico, Serie[]> = {
  origem: [
    { campo: 'gastos_cartao', rotulo: 'Cartões', classe: 'cartao' },
    { campo: 'gastos_conta', rotulo: 'Conta', classe: 'conta' },
  ],
  entradas: [
    { campo: 'receitas', rotulo: 'Entrou', classe: 'receita' },
    { campo: 'gastos', rotulo: 'Saiu', classe: 'gasto' },
  ],
};
const serie = computed(() => [...(resumo.value?.meses ?? [])].reverse());

const doMes = computed(() => ({ de: `${mes.value}-01`, ate: ultimoDia(mes.value) }));
const origemDoFiltro = computed(() => (origem.value === 'todas' ? undefined : origem.value));
const linkCategoria = (categoria: string) => link('transacoes', {
  ...(categoria === 'Sem categoria' ? { sem_categoria: 'true' } : { categoria }),
  origem: origemDoFiltro.value,
  fluxo: 'expense',
  ...doMes.value,
});
const linkOrigem = (o: Origem) => link('transacoes', { origem: o, fluxo: 'expense', ...doMes.value });
const linkConta = (conta: string) => link('transacoes', { conta, fluxo: 'expense', ...doMes.value });

const media = computed(() => visao.value?.media_3m ?? null);
// Mês em andamento não se compara com a média de meses inteiros: daria "−90%" no dia 6.
const comparar = computed(() => !!media.value && !visao.value?.em_andamento);
const referencia = computed(() => (media.value ? `vs. média de ${media.value.meses} ${media.value.meses === 1 ? 'mês' : 'meses'}` : ''));
const saldoNegativo = computed(() => (toNumber(visao.value?.resumo.saldo) ?? 0) < 0);
const vaiFaltar = computed(() => (toNumber(aPagar.value?.sobra) ?? 0) < 0);
const parcelas = computed(() => visao.value?.parcelas_proximos_meses ?? []);
const detalheSaiu = computed(() => {
  const o = visao.value?.por_origem;
  return o ? `Cartões ${brl(o.cartao.gastos)} · conta ${brl(o.conta.gastos)}` : '';
});

const OPCOES_ORIGEM: Array<{ valor: Filtro; rotulo: string }> = [
  { valor: 'cartao', rotulo: 'Cartões' },
  { valor: 'conta', rotulo: 'Conta' },
  { valor: 'todas', rotulo: 'Tudo' },
];
const OPCOES_GRAFICO: Array<{ valor: Grafico; rotulo: string }> = [
  { valor: 'origem', rotulo: 'Cartão × conta' },
  { valor: 'entradas', rotulo: 'Entrou × saiu' },
];
const subtituloCategorias = computed(() => {
  const onde = { cartao: 'Só os gastos nos cartões.', conta: 'Só os gastos na conta.', todas: 'Cartões e conta.' }[origem.value];
  if (visao.value?.em_andamento) return `${onde} Até hoje; a comparação com a média aparece quando o mês fechar.`;
  if (media.value) return `${onde} O traço marca a média de ${media.value.meses} ${media.value.meses === 1 ? 'mês anterior' : 'meses anteriores'}.`;
  return onde;
});
</script>

<template>
  <section>
    <div class="pagina-topo">
      <div>
        <h1>{{ titulo }}</h1>
        <p class="sub">{{ visao?.em_andamento ? 'Mês em andamento: os números ainda vão mudar.' : 'Mês fechado.' }}</p>
      </div>
      <SeletorMes :mes="mes" :max="atual" @update:mes="(m) => navegar({ mes: m })" />
    </div>

    <div v-if="erro" class="erro">
      <span>Não foi possível carregar: {{ erro }}</span>
      <button class="botao" type="button" @click="carregar">Tentar de novo</button>
    </div>

    <template v-if="visao">
      <div v-if="sugestoesPendentes.transacoes > 0" class="aviso aviso-ia">
        <strong>A IA sugeriu categoria para {{ sugestoesPendentes.transacoes }} transações</strong> ({{ sugestoesPendentes.grupos }} estabelecimentos).
        <a :href="link('sugestoes')">Revisar sugestões →</a>
      </div>
      <div v-else-if="visao.resumo.sem_categoria > 0" class="aviso">
        <strong>{{ visao.resumo.sem_categoria }} transações sem categoria</strong> neste mês. Os totais por categoria ficam
        incompletos, e transferências entre suas próprias contas podem estar contando como gasto.
        <a :href="link('transacoes', { sem_categoria: 'true', ...doMes })">Categorizar →</a>
      </div>

      <div class="kpis">
        <KpiCard
          titulo="Entrou"
          :valor="brl(visao.resumo.receitas)"
          tom="positivo"
          :delta="comparar ? deltaPct(visao.resumo.receitas, media!.receitas) : null"
          :referencia="referencia"
          :detalhe="visao.em_andamento ? `Até hoje · média de ${brl(media?.receitas)}` : undefined"
        />
        <KpiCard
          titulo="Saiu"
          :valor="brl(visao.resumo.gastos)"
          tom="negativo"
          :delta="comparar ? deltaPct(visao.resumo.gastos, media!.gastos) : null"
          menor-melhor
          :referencia="referencia"
          :detalhe="visao.em_andamento ? `Até hoje · média de ${brl(media?.gastos)}` : undefined"
        >
          <div>{{ detalheSaiu }}</div>
        </KpiCard>
        <KpiCard
          v-if="visao.em_andamento && aPagar"
          :titulo="vaiFaltar ? 'Vai faltar até o salário' : 'Vai sobrar até o salário'"
          :valor="brl(aPagar.sobra.replace(/^-/, ''))"
          :tom="vaiFaltar ? 'negativo' : 'positivo'"
          :detalhe="`nas contas ${brl(aPagar.saldo)}, falta pagar ${brl(aPagar.a_pagar)} até ~${dataCurta(aPagar.proximo_salario)}`"
        >
          <div><a :href="link('apagar')">Ver o que falta pagar →</a></div>
        </KpiCard>
        <KpiCard
          v-else
          titulo="Sobrou"
          :valor="brl(visao.resumo.saldo)"
          :tom="saldoNegativo ? 'negativo' : 'positivo'"
          :detalhe="saldoNegativo ? 'Saiu mais do que entrou' : 'Entrou mais do que saiu'"
        />
        <KpiCard :titulo="parcelas[0] ? `Parcelas em ${mesCurto(parcelas[0].mes)}` : 'Parcelas'" :valor="brl(parcelas[0]?.comprometido)">
          <ul class="lista-parcelas">
            <li v-for="p in parcelas.slice(1)" :key="p.mes"><span>{{ mesCurto(p.mes) }}</span><span class="num">{{ brl(p.comprometido) }}</span></li>
          </ul>
          <a :href="link('parcelas')">Ver parcelas →</a>
        </KpiCard>
      </div>

      <MetaCartao :mes="mes" />

      <CartaoConta
        :por-origem="visao.por_origem"
        :cartoes="visao.cartoes"
        :parcial="visao.em_andamento"
        :link-origem="linkOrigem"
        :link-conta="linkConta"
      />

      <div class="grade espaco-topo">
        <div class="cartao">
          <div class="cartao-topo">
            <div>
              <h2>Últimos 12 meses</h2>
              <p class="sub">Clique num mês para ver os detalhes.</p>
            </div>
            <Segmentos :model-value="grafico" :opcoes="OPCOES_GRAFICO" rotulo="O que comparar" @update:model-value="(g) => navegar({ grafico: g })" />
          </div>
          <BarrasMensais :meses="serie" :series="SERIES[grafico]" :selecionado="mes" @selecionar="(m) => navegar({ mes: m })" />
        </div>
        <div class="cartao">
          <div class="cartao-topo">
            <div>
              <h2>Para onde foi o dinheiro</h2>
              <p class="sub">{{ subtituloCategorias }}</p>
            </div>
            <Segmentos :model-value="origem" :opcoes="OPCOES_ORIGEM" rotulo="Origem dos gastos" @update:model-value="(o) => navegar({ origem: o })" />
          </div>
          <BarrasCategorias :categorias="visao.categorias" :link="linkCategoria" :parcial="visao.em_andamento" />
        </div>
      </div>
    </template>
    <p v-else-if="!erro" class="carregando">Carregando…</p>
  </section>
</template>
