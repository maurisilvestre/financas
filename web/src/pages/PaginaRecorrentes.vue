<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from '../api.ts';
import KpiCard from '../components/KpiCard.vue';
import { brl, contaCurta, dataCurta, somaReais, sugerirPadrao } from '../lib/format.ts';
import { carregarCategorias, corDa, link, versao } from '../store.ts';
import type { Recorrentes } from '../types.ts';

const janela = ref(6);
const minimo = ref(3);
const dados = ref<Recorrentes | null>(null);
const erro = ref<string | null>(null);

async function carregar(): Promise<void> {
  erro.value = null;
  try {
    dados.value = await api.recorrentes(janela.value, Math.min(minimo.value, janela.value));
  } catch (e) {
    erro.value = (e as Error).message;
  }
}
watch([janela, minimo, versao], carregar, { immediate: true });
carregarCategorias().catch(() => {});

const itens = computed(() => dados.value?.recorrentes ?? []);
const porMes = computed(() => somaReais(itens.value.map((r) => r.media_mensal)));
const porAno = computed(() => somaReais(Array<string>(12).fill(porMes.value)));
const linkTransacoes = (descricao: string) => link('transacoes', { texto: sugerirPadrao(descricao) || undefined });
</script>

<template>
  <section>
    <div class="pagina-topo">
      <div>
        <h1>Gastos recorrentes</h1>
        <p class="sub">O que se repete mês a mês: assinaturas, mensalidades, contas fixas. Bons candidatos a cortar ou renegociar.</p>
      </div>
      <div class="controles">
        <label>Olhar os últimos
          <select v-model.number="janela" class="campo">
            <option :value="3">3 meses</option>
            <option :value="6">6 meses</option>
            <option :value="12">12 meses</option>
          </select>
        </label>
        <label>aparecendo em pelo menos
          <select v-model.number="minimo" class="campo">
            <option :value="2">2 meses</option>
            <option :value="3">3 meses</option>
            <option :value="4">4 meses</option>
            <option :value="6">6 meses</option>
          </select>
        </label>
      </div>
    </div>

    <div v-if="erro" class="erro">
      <span>Não foi possível carregar: {{ erro }}</span>
      <button class="botao" type="button" @click="carregar">Tentar de novo</button>
    </div>

    <template v-if="dados">
      <div class="kpis kpis-2">
        <KpiCard titulo="Por mês, em média" :valor="brl(porMes)" tom="negativo" :detalhe="`${itens.length} gastos recorrentes`" />
        <KpiCard titulo="Em um ano" :valor="brl(porAno)" detalhe="Se nada mudar" />
      </div>

      <div class="cartao sem-padding">
        <div class="tabela-rolagem">
          <table class="tabela tabela-m">
            <thead>
              <tr>
                <th>Descrição</th>
                <th>Categoria</th>
                <th>Conta</th>
                <th class="direita">Meses</th>
                <th class="direita">Valor médio</th>
                <th class="direita">Média por mês</th>
                <th>Última vez</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in itens" :key="`${r.descricao}|${r.conta}`">
                <td class="m-1"><a :href="linkTransacoes(r.descricao)" title="Ver as transações">{{ r.descricao }}</a></td>
                <td class="m-3"><span class="pilula"><i class="ponto" :style="{ backgroundColor: corDa(r.categoria) }"></i>{{ r.categoria ?? 'Sem categoria' }}</span></td>
                <td class="muted m-2">{{ contaCurta(r.conta) }}</td>
                <td class="direita num m-2">{{ r.meses }} de {{ dados.periodo_meses }}<span class="so-celular"> meses</span></td>
                <td class="direita num m-2" data-rotulo="valor médio">{{ brl(r.valor_medio) }}</td>
                <td class="direita num forte m-v" data-rotulo="por mês">{{ brl(r.media_mensal) }}</td>
                <td class="num muted m-2" data-rotulo="última">{{ dataCurta(r.ultima) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="itens.length === 0" class="vazio">Nada se repete nessa janela.</p>
      </div>
    </template>
    <p v-else-if="!erro" class="carregando">Carregando…</p>
  </section>
</template>
