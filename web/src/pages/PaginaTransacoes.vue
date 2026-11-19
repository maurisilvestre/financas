<script setup lang="ts">
// Lista com filtros (guardados na URL), categorização na própria linha, regra e "ignorar".
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.ts';
import DialogoRegra from '../components/DialogoRegra.vue';
import SeletorCategoria from '../components/SeletorCategoria.vue';
import { brl, contaCurta, dataCurta, dataLonga, mesAtual, mesCurto, shiftMes, sugerirPadrao, toNumber, ultimoDia } from '../lib/format.ts';
import { avisar, carregarCategorias, categorias, corDa, dadosMudaram, go, route, versao } from '../store.ts';
import type { Conta, Fluxo, Transacao } from '../types.ts';

const LIMITE = 50;
const q = computed(() => (route.page === 'transacoes' ? route.query : {}));

function atualizar(mudanca: Record<string, string | undefined>): void {
  go('transacoes', { ...q.value, ...mudanca });
}
const valorDe = (e: Event) => (e.target as HTMLSelectElement).value;

// Busca: o campo atualiza a URL com um pequeno atraso.
const texto = ref(q.value.texto ?? '');
watch(() => q.value.texto, (t) => { if ((t ?? '') !== texto.value.trim()) texto.value = t ?? ''; });
let atraso: ReturnType<typeof setTimeout> | undefined;
watch(texto, (t) => {
  clearTimeout(atraso);
  atraso = setTimeout(() => {
    const valor = t.trim().length >= 2 ? t.trim() : undefined;
    if (valor !== q.value.texto) atualizar({ texto: valor });
  }, 350);
});

// Período: um mês inteiro, tudo, ou um intervalo vindo de um link.
const meses = Array.from({ length: 13 }, (_, i) => shiftMes(mesAtual(), -i));
const periodo = computed(() => {
  const { de, ate } = q.value;
  if (!de && !ate) return '';
  const m = de?.slice(0, 7);
  return m && de === `${m}-01` && ate === ultimoDia(m) ? m : 'intervalo';
});
const rotuloIntervalo = computed(() => `${q.value.de ? dataLonga(q.value.de) : 'início'} a ${q.value.ate ? dataLonga(q.value.ate) : 'hoje'}`);
function mudarPeriodo(v: string): void {
  if (v === '') atualizar({ de: undefined, ate: undefined });
  else if (v !== 'intervalo') atualizar({ de: `${v}-01`, ate: ultimoDia(v) });
}

const filtroCategoria = computed(() => (q.value.sem_categoria === 'true' ? '__sem__' : q.value.categoria ?? ''));
function mudarCategoria(v: string): void {
  atualizar({ categoria: v && v !== '__sem__' ? v : undefined, sem_categoria: v === '__sem__' ? 'true' : undefined });
}
const temFiltro = computed(() => Object.keys(q.value).length > 0);

const contas = ref<Conta[]>([]);
const lista = ref<Transacao[]>([]);
const encontradas = ref(0);
const soma = ref('0.00');
const carregando = ref(false);
const erro = ref<string | null>(null);

let pedido = 0;
async function carregar(maisPagina = false): Promise<void> {
  const meu = ++pedido;
  carregando.value = true;
  erro.value = null;
  try {
    const r = await api.transacoes({
      texto: q.value.texto, categoria: q.value.categoria, sem_categoria: q.value.sem_categoria === 'true',
      conta: q.value.conta, origem: (q.value.origem === 'cartao' || q.value.origem === 'conta') ? q.value.origem : undefined,
      fluxo: q.value.fluxo as Fluxo | undefined, de: q.value.de, ate: q.value.ate,
      limite: LIMITE, offset: maisPagina ? lista.value.length : 0,
    });
    if (meu !== pedido) return;
    lista.value = maisPagina ? [...lista.value, ...r.transacoes] : r.transacoes;
    encontradas.value = r.encontradas;
    soma.value = r.soma;
  } catch (e) {
    if (meu === pedido) erro.value = (e as Error).message;
  } finally {
    if (meu === pedido) carregando.value = false;
  }
}
watch([q, versao], () => carregar(), { immediate: true });

onMounted(async () => {
  carregarCategorias().catch(() => {});
  try {
    contas.value = (await api.contas()).contas;
  } catch {
    /* o filtro de conta fica vazio; o erro principal aparece na lista */
  }
});

const curto = (s: string) => (s.length > 42 ? `${s.slice(0, 40)}…` : s);

// --- escrita -------------------------------------------------------------

const salvandoId = ref<number | null>(null);
const dialogo = ref<{ padrao: string; categoria: string | null } | null>(null);

function abrirRegra(t: Transacao, categoria: string | null = t.categoria): void {
  dialogo.value = { padrao: sugerirPadrao(t.descricao), categoria };
}

async function categorizar(t: Transacao, nova: string | null): Promise<void> {
  if (!nova || nova === t.categoria) return;
  salvandoId.value = t.id;
  try {
    const r = await api.definirCategoria(t.id, nova);
    t.categoria = r.transacao.categoria;
    t.origem_categoria = r.transacao.origem_categoria;
    const podeRegra = sugerirPadrao(t.descricao).length >= 3;
    avisar(`"${curto(t.descricao)}" agora está em ${nova}.`, 'ok',
      podeRegra ? { rotulo: 'Criar regra para as parecidas', fazer: () => abrirRegra(t, nova) } : undefined);
  } catch (e) {
    avisar((e as Error).message, 'erro');
  } finally {
    salvandoId.value = null;
  }
}

async function ignorar(t: Transacao, valor: boolean): Promise<void> {
  try {
    await api.ignorar(t.id, valor);
    dadosMudaram();
    if (valor) avisar(`"${curto(t.descricao)}" saiu dos relatórios.`, 'ok', { rotulo: 'Desfazer', fazer: () => void ignorar(t, false) });
  } catch (e) {
    avisar((e as Error).message, 'erro');
  }
}

const classeValor = (t: Transacao) => (t.fluxo === 'transfer' ? 'muted' : (toNumber(t.valor) ?? 0) < 0 ? 'tom-negativo' : 'tom-positivo');
</script>

<template>
  <section>
    <div class="pagina-topo">
      <div>
        <h1>Transações</h1>
        <p class="sub">
          {{ encontradas }} {{ encontradas === 1 ? 'transação' : 'transações' }} · soma <span class="num">{{ brl(soma) }}</span>
        </p>
      </div>
    </div>

    <div class="filtros">
      <input v-model="texto" class="campo busca" type="search" placeholder="Buscar na descrição…" aria-label="Buscar na descrição" />
      <select class="campo" :value="periodo" aria-label="Período" @change="mudarPeriodo(valorDe($event))">
        <option value="">Todo o período</option>
        <option v-if="periodo === 'intervalo'" value="intervalo">{{ rotuloIntervalo }}</option>
        <option v-for="m in meses" :key="m" :value="m">{{ mesCurto(m) }}</option>
      </select>
      <select class="campo" :value="filtroCategoria" aria-label="Categoria" @change="mudarCategoria(valorDe($event))">
        <option value="">Todas as categorias</option>
        <option value="__sem__">Sem categoria</option>
        <option v-for="c in categorias" :key="c.nome" :value="c.nome">{{ c.nome }}</option>
      </select>
      <select class="campo" :value="q.origem ?? ''" aria-label="Cartão ou conta" @change="atualizar({ origem: valorDe($event) || undefined })">
        <option value="">Cartões e conta</option>
        <option value="cartao">Só cartões</option>
        <option value="conta">Só conta</option>
      </select>
      <select class="campo" :value="q.conta ?? ''" aria-label="Conta" @change="atualizar({ conta: valorDe($event) || undefined })">
        <option value="">Todas as contas</option>
        <option v-for="c in contas" :key="c.nome" :value="c.nome">{{ contaCurta(c.nome) }}</option>
      </select>
      <select class="campo filtro-largo" :value="q.fluxo ?? ''" aria-label="Tipo" @change="atualizar({ fluxo: valorDe($event) || undefined })">
        <option value="">Gastos, receitas e movimentações</option>
        <option value="expense">Só gastos</option>
        <option value="income">Só receitas</option>
        <option value="transfer">Só movimentações</option>
      </select>
      <button v-if="temFiltro" class="botao discreto" type="button" @click="go('transacoes')">Limpar filtros</button>
    </div>

    <div v-if="erro" class="erro">
      <span>Não foi possível carregar: {{ erro }}</span>
      <button class="botao" type="button" @click="carregar()">Tentar de novo</button>
    </div>

    <div class="cartao sem-padding">
      <div class="tabela-rolagem">
        <table class="tabela transacoes tabela-m">
          <thead>
            <tr>
              <th>Data</th>
              <th>Descrição</th>
              <th>Conta</th>
              <th>Categoria</th>
              <th class="direita">Valor</th>
              <th><span class="sr">Ações</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in lista" :key="t.id" :class="{ pendente: t.status === 'PENDING' }">
              <td class="data m-2">{{ dataCurta(t.data) }}</td>
              <td class="descricao m-1">
                <div>
                  {{ t.descricao }}
                  <span v-if="t.parcela" class="etiqueta">{{ t.parcela }}</span>
                  <span v-if="t.status === 'PENDING'" class="etiqueta">pendente</span>
                </div>
                <div v-if="t.nota" class="nota">{{ t.nota }}</div>
              </td>
              <td class="conta m-2" :title="t.conta">{{ contaCurta(t.conta) }}</td>
              <td class="m-3 m-cresce">
                <div class="cat-celula">
                  <i class="ponto" :style="{ backgroundColor: corDa(t.categoria) }"></i>
                  <SeletorCategoria
                    :model-value="t.categoria"
                    compacto
                    :permitir-vazio="false"
                    vazio="Escolher…"
                    :desabilitado="salvandoId === t.id"
                    :rotulo="`Categoria de ${t.descricao}`"
                    @update:model-value="(v) => categorizar(t, v)"
                  />
                  <span v-if="t.origem_categoria === 'rule'" class="origem" title="Categoria definida por uma regra">regra</span>
                </div>
              </td>
              <td class="direita valor m-v" :class="classeValor(t)">{{ brl(t.valor) }}</td>
              <td class="acoes-linha m-3 m-fim">
                <button class="botao discreto pequeno" type="button" title="Criar uma regra a partir desta transação" @click="abrirRegra(t)">Regra</button>
                <button class="botao discreto pequeno" type="button" title="Tirar dos relatórios" @click="ignorar(t, true)">Ignorar</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="carregando && lista.length === 0" class="vazio">Carregando…</p>
      <p v-else-if="!carregando && lista.length === 0 && !erro" class="vazio">Nenhuma transação com esses filtros.</p>
      <div v-if="lista.length < encontradas" class="rodape-lista">
        <button class="botao" type="button" :disabled="carregando" @click="carregar(true)">
          Mostrar mais ({{ encontradas - lista.length }} restantes)
        </button>
      </div>
    </div>

    <DialogoRegra v-if="dialogo" :padrao="dialogo.padrao" :categoria="dialogo.categoria" @fechar="dialogo = null" />
  </section>
</template>
