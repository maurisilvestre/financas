<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from '../api.ts';
import AlertaParcelamentos from '../components/AlertaParcelamentos.vue';
import BarrasSimples from '../components/BarrasSimples.vue';
import KpiCard from '../components/KpiCard.vue';
import { brl, contaCurta, mesCurto, somaReais, toNumber } from '../lib/format.ts';
import { parcelamentosNovos, versao } from '../store.ts';
import type { Compromissos } from '../types.ts';

const dados = ref<Compromissos | null>(null);
const erro = ref<string | null>(null);

async function carregar(): Promise<void> {
  erro.value = null;
  try {
    dados.value = await api.compromissos();
  } catch (e) {
    erro.value = (e as Error).message;
  }
}
watch(versao, carregar, { immediate: true });

// A API dá o valor por mês e por conta; o gráfico soma as contas de cada mês.
const porMes = computed(() => {
  const grupos = new Map<string, string[]>();
  for (const linha of dados.value?.por_mes ?? []) {
    grupos.set(linha.mes, [...(grupos.get(linha.mes) ?? []), linha.comprometido]);
  }
  return [...grupos.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([mes, valores]) => ({ mes, total: somaReais(valores) }));
});
const barras = computed(() => porMes.value.slice(0, 12).map((m) => ({
  rotulo: mesCurto(m.mes), valor: toNumber(m.total) ?? 0, titulo: `${mesCurto(m.mes)}: ${brl(m.total)}`,
})));
const parcelamentos = computed(() => dados.value?.parcelamentos ?? []);
const faltaPagar = computed(() => somaReais(parcelamentos.value.map((p) => p.restante)));
const pagas = (p: { parcelas_total: number; parcelas_restantes: number }) => p.parcelas_total - p.parcelas_restantes;
const larguraProgresso = (p: { parcelas_total: number; parcelas_restantes: number }) => `${(pagas(p) / p.parcelas_total) * 100}%`;
</script>

<template>
  <section>
    <div class="pagina-topo">
      <div>
        <h1>Parcelas</h1>
        <p class="sub">O que já está comprometido nos próximos meses, incluindo parcelas que o banco ainda não lançou.</p>
      </div>
    </div>

    <div v-if="erro" class="erro">
      <span>Não foi possível carregar: {{ erro }}</span>
      <button class="botao" type="button" @click="carregar">Tentar de novo</button>
    </div>

    <AlertaParcelamentos :novos="parcelamentosNovos" />

    <template v-if="dados">
      <div class="kpis kpis-3">
        <KpiCard titulo="Falta pagar" :valor="brl(faltaPagar)" tom="negativo" :detalhe="`${parcelamentos.length} parcelamentos em aberto`" />
        <KpiCard titulo="Este mês" :valor="brl(porMes[0]?.total ?? '0')" :detalhe="porMes[0] ? mesCurto(porMes[0].mes) : ''" />
        <KpiCard titulo="Próximo mês" :valor="brl(porMes[1]?.total ?? '0')" :detalhe="porMes[1] ? mesCurto(porMes[1].mes) : ''" />
      </div>

      <div class="cartao">
        <div class="cartao-topo"><h2>Por mês</h2></div>
        <BarrasSimples v-if="barras.length" :itens="barras" descricao="Parcelas a pagar por mês" />
        <p v-else class="vazio">Nenhuma parcela pela frente.</p>
      </div>

      <div class="cartao sem-padding espaco-topo">
        <div class="tabela-rolagem">
          <table class="tabela tabela-m">
            <thead>
              <tr>
                <th>Compra</th>
                <th>Conta</th>
                <th>Pagas</th>
                <th class="direita">Parcela</th>
                <th class="direita">Falta</th>
                <th>Última</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in parcelamentos" :key="`${p.compra}|${p.conta}|${p.ultima_parcela}|${p.valor_parcela}`">
                <td class="m-1">{{ p.compra }}</td>
                <td class="muted m-2">{{ contaCurta(p.conta) }}</td>
                <td class="m-3 m-largo">
                  <div class="progresso">
                    <span class="progresso-barra"><span :style="{ width: larguraProgresso(p) }"></span></span>
                    {{ pagas(p) }} de {{ p.parcelas_total }}
                  </div>
                </td>
                <td class="direita num m-2" data-rotulo="parcela">{{ brl(p.valor_parcela) }}</td>
                <td class="direita num forte m-v" data-rotulo="falta">{{ brl(p.restante) }}</td>
                <td class="num muted m-2" data-rotulo="última">{{ mesCurto(p.ultima_parcela) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
    <p v-else-if="!erro" class="carregando">Carregando…</p>
  </section>
</template>
