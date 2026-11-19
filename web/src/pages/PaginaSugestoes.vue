<script setup lang="ts">
// Sugestões de categoria feitas pela IA (Claude Haiku) para o que nenhuma regra pegou.
// Nada muda nos relatórios até você aplicar, criar uma regra ou recusar.
import { computed, reactive, ref, watch } from 'vue';
import { api } from '../api.ts';
import DialogoRegra from '../components/DialogoRegra.vue';
import KpiCard from '../components/KpiCard.vue';
import SeletorCategoria from '../components/SeletorCategoria.vue';
import { brl, dataCurta, somaReais, sugerirPadrao, toNumber } from '../lib/format.ts';
import { atualizarSugestoesPendentes, avisar, carregarCategorias, dadosMudaram, versao } from '../store.ts';
import type { Sugestao, Sugestoes } from '../types.ts';

const ALTA = 0.85;
const dados = ref<Sugestoes | null>(null);
const erro = ref<string | null>(null);
// Categoria escolhida em cada linha (começa com a sugerida; dá para trocar antes de aplicar).
const escolha = reactive<Record<string, string | null>>({});
const ocupado = ref<string | null>(null);
const confirmandoLote = ref(false);
const dialogo = ref<{ padrao: string; categoria: string | null } | null>(null);

async function carregar(): Promise<void> {
  erro.value = null;
  try {
    dados.value = await api.sugestoes();
    for (const g of dados.value.grupos) if (!(g.chave in escolha)) escolha[g.chave] = g.categoria;
    await atualizarSugestoesPendentes();
  } catch (e) {
    erro.value = (e as Error).message;
  }
}
watch(versao, carregar, { immediate: true });
carregarCategorias().catch(() => {});

const grupos = computed(() => dados.value?.grupos ?? []);
// "Aplicar todas" só pega o que pode ir em lote: nunca movimentação (fatura, investimento,
// transferência), que tiraria o valor dos relatórios, nem categoria que contradiz o sinal.
const altas = computed(() => grupos.value.filter((g) => g.em_lote && (toNumber(g.confianca) ?? 0) >= ALTA));
const transacoesAltas = computed(() => altas.value.reduce((acc, g) => acc + g.transacoes, 0));
const volume = computed(() => somaReais(grupos.value.map((g) => String(Math.abs(toNumber(g.total) ?? 0)))));

const pct = (c: string) => `${Math.round((toNumber(c) ?? 0) * 100)}%`;
const nivel = (c: string) => {
  const v = toNumber(c) ?? 0;
  return v >= ALTA ? 'alta' : v >= 0.6 ? 'media' : 'baixa';
};
const plural = (n: number) => `${n} transaç${n === 1 ? 'ão' : 'ões'}`;

async function aplicar(g: Sugestao): Promise<void> {
  const categoria = escolha[g.chave];
  if (!categoria) return;
  ocupado.value = g.chave;
  try {
    const r = await api.aplicarSugestao(g.chave, categoria);
    avisar(`${plural(r.aplicadas)} de "${g.exemplo}" agora em ${categoria}.`, 'ok', {
      rotulo: 'Criar regra para as próximas', fazer: () => { dialogo.value = { padrao: sugerirPadrao(g.exemplo), categoria }; },
    });
    dadosMudaram();
  } catch (e) {
    avisar((e as Error).message, 'erro');
  } finally {
    ocupado.value = null;
  }
}

async function recusar(g: Sugestao): Promise<void> {
  ocupado.value = g.chave;
  try {
    await api.recusarSugestao(g.chave);
    avisar(`Sugestão para "${g.exemplo}" recusada. Ela não volta.`);
    dadosMudaram();
  } catch (e) {
    avisar((e as Error).message, 'erro');
  } finally {
    ocupado.value = null;
  }
}

async function aplicarLote(): Promise<void> {
  confirmandoLote.value = false;
  ocupado.value = '__lote__';
  try {
    const r = await api.aplicarConfiaveis(ALTA);
    avisar(`${plural(r.transacoes)} categorizadas (${r.grupos} estabelecimentos).`);
    dadosMudaram();
  } catch (e) {
    avisar((e as Error).message, 'erro');
  } finally {
    ocupado.value = null;
  }
}
</script>

<template>
  <section>
    <div class="pagina-topo">
      <div>
        <h1>Sugestões da IA</h1>
        <p class="sub">O Claude Haiku sugere categorias para o que nenhuma regra pegou. Nada muda nos relatórios até você aplicar.</p>
      </div>
    </div>

    <div v-if="erro" class="erro">
      <span>Não foi possível carregar: {{ erro }}</span>
      <button class="botao" type="button" @click="carregar">Tentar de novo</button>
    </div>

    <template v-if="dados">
      <div v-if="grupos.length === 0" class="cartao vazio-sugestoes">
        <h2>Nenhuma sugestão esperando você</h2>
        <p class="sub">
          As sugestões aparecem depois de cada sync, para o que chegar sem categoria. Para isso, coloque
          <code>ANTHROPIC_API_KEY</code> no <code>.env</code> e reinicie o sync. Para rodar agora:
          <code>docker compose run --rm sync classify</code>.
        </p>
      </div>

      <template v-else>
        <div class="kpis kpis-3">
          <KpiCard titulo="Estabelecimentos com sugestão" :valor="String(grupos.length)" :detalhe="`${plural(dados.total_transacoes)} sem categoria`" />
          <KpiCard titulo="Valor envolvido" :valor="brl(volume)" detalhe="Soma, sem sinal, das transações" />
          <KpiCard titulo="Confiança alta" :valor="String(altas.length)" :detalhe="`${plural(transacoesAltas)} com ${Math.round(ALTA * 100)}% ou mais. Movimentações e casos que não combinam com o valor você confere uma a uma.`">
            <div v-if="altas.length" class="lote">
              <button v-if="!confirmandoLote" class="botao primario pequeno" type="button" :disabled="ocupado !== null" @click="confirmandoLote = true">
                Aplicar todas
              </button>
              <template v-else>
                <span>Aplicar {{ altas.length }} sugestões?</span>
                <button class="botao primario pequeno" type="button" @click="aplicarLote">Sim, aplicar</button>
                <button class="botao discreto pequeno" type="button" @click="confirmandoLote = false">Cancelar</button>
              </template>
            </div>
          </KpiCard>
        </div>

        <div class="cartao sem-padding">
          <div class="tabela-rolagem">
            <table class="tabela sugestoes tabela-m">
              <thead>
                <tr>
                  <th>Estabelecimento</th>
                  <th class="direita">Total</th>
                  <th>Categoria</th>
                  <th>Confiança</th>
                  <th><span class="sr">Ações</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="g in grupos" :key="g.chave">
                  <td class="descricao m-1">
                    <div>{{ g.exemplo }}</div>
                    <div class="nota-normal">{{ plural(g.transacoes) }} · última em {{ dataCurta(g.ultima) }}<template v-if="g.motivo"> · {{ g.motivo }}</template></div>
                  </td>
                  <td class="direita valor m-v">{{ brl(g.total) }}</td>
                  <td class="m-3 m-cresce">
                    <SeletorCategoria
                      v-model="escolha[g.chave]"
                      compacto
                      :permitir-vazio="false"
                      :rotulo="`Categoria para ${g.exemplo}`"
                      :desabilitado="ocupado !== null"
                    />
                  </td>
                  <td class="m-3">
                    <span class="confianca" :class="`confianca-${nivel(g.confianca)}`">{{ pct(g.confianca) }}</span>
                    <span
                      v-if="!g.em_lote"
                      class="etiqueta"
                      title="Fica fora do aplicar todas: é uma movimentação (tira o valor dos relatórios) ou não combina com o sinal do valor. Confira antes de aplicar."
                    >confira</span>
                  </td>
                  <td class="acoes-linha m-3 m-fim">
                    <button class="botao pequeno" type="button" :disabled="ocupado !== null" @click="aplicar(g)">Aplicar</button>
                    <button
                      class="botao discreto pequeno"
                      type="button"
                      title="Criar uma regra: vale também para as próximas transações"
                      @click="dialogo = { padrao: sugerirPadrao(g.exemplo), categoria: escolha[g.chave] ?? g.categoria }"
                    >Regra</button>
                    <button class="botao discreto pequeno" type="button" :disabled="ocupado !== null" @click="recusar(g)">Recusar</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </template>
    <p v-else-if="!erro" class="carregando">Carregando…</p>

    <DialogoRegra v-if="dialogo" :padrao="dialogo.padrao" :categoria="dialogo.categoria" @fechar="dialogo = null" />
  </section>
</template>
