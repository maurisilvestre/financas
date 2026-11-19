<script setup lang="ts">
// "A pagar": do último salário ao próximo, o que já saiu, o que falta pagar (faturas e contas
// fixas) e se o saldo de cada conta corrente dá. É a visão de caixa; o "entrou × saiu" do mês
// fica na Visão geral.
import { computed, ref, watch } from 'vue';
import { api } from '../api.ts';
import KpiCard from '../components/KpiCard.vue';
import { situacaoTexto } from '../lib/apagar.ts';
import { brl, dataCurta, lerReais, toNumber } from '../lib/format.ts';
import { avisar, dadosMudaram, link, versao } from '../store.ts';
import type { APagar, ItemAPagar } from '../types.ts';

const dados = ref<APagar | null>(null);
const erro = ref<string | null>(null);

async function carregar(): Promise<void> {
  erro.value = null;
  try {
    dados.value = await api.aPagar();
    if (!novoConta.value) novoConta.value = String(dados.value.contas[0]?.id ?? '');
  } catch (e) {
    erro.value = (e as Error).message;
  }
}
watch(versao, carregar, { immediate: true });

const negativo = (v: string | null | undefined) => (toNumber(v) ?? 0) < 0;
const semSinal = (v: string) => v.replace(/^-/, '');
const faltando = computed(() => negativo(dados.value?.sobra));
const abertos = computed(() => dados.value?.itens.filter((i) => i.situacao !== 'paga') ?? []);
const pagos = computed(() => dados.value?.itens.filter((i) => i.situacao === 'paga') ?? []);
const atualizado = computed(() => {
  const datas = (dados.value?.contas ?? []).map((c) => c.atualizado_em).filter((d): d is string => !!d).sort();
  if (!datas.length) return '';
  const d = new Date(datas[0]!);
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
});
const ciclo = computed(() => {
  const d = dados.value;
  if (!d) return '';
  return d.ultimo_salario
    ? `Do último salário (${dataCurta(d.ultimo_salario.data)}) ao próximo (~${dataCurta(d.proximo_salario)})`
    : `Até ${dataCurta(d.proximo_salario)} (nenhum salário nos últimos 45 dias)`;
});
const situacao = (i: ItemAPagar) => situacaoTexto(i, dados.value?.hoje ?? '');
const jaSaiu = computed(() => (toNumber(dados.value?.ja_saiu) ?? 0) > 0);
// O guardado (investimentos) cobre o que falta?
const coberturaGuardado = computed(() => {
  const d = dados.value;
  if (!d?.guardado) return '';
  const cobre = (toNumber(d.guardado.total) ?? 0) + (toNumber(d.sobra) ?? 0) >= 0;
  return ` · o guardado (${brl(d.guardado.total)}) ${cobre ? 'cobre' : 'não cobre'}`;
});

async function jaPaguei(i: ItemAPagar): Promise<void> {
  if (i.id === null) return;
  try {
    await api.atualizarContaFixa(i.id, { pago_ate: i.vencimento });
    avisar(`${i.descricao} de ${dataCurta(i.vencimento)} marcada como paga.`);
    dadosMudaram();
  } catch (e) {
    avisar((e as Error).message, 'erro');
  }
}

async function encerrar(id: number, nome: string): Promise<void> {
  try {
    await api.atualizarContaFixa(id, { status: 'encerrada' });
    avisar(`${nome} encerrada: sai do a pagar.`);
    dadosMudaram();
  } catch (e) {
    avisar((e as Error).message, 'erro');
  }
}

async function debitoAutomatico(id: number, nome: string, ligar: boolean): Promise<void> {
  try {
    await api.atualizarContaFixa(id, { debito_automatico: ligar });
    avisar(ligar ? `${nome}: débito automático. Passado o vencimento, conta como paga.` : `${nome}: sem débito automático.`);
    dadosMudaram();
  } catch (e) {
    avisar((e as Error).message, 'erro');
  }
}

// Nova conta fixa.
const novoNome = ref('');
const novoPadrao = ref('');
const novoDia = ref('');
const novoValor = ref('');
const novoConta = ref('');
const novoDebito = ref(false);
async function criar(): Promise<void> {
  const nome = novoNome.value.trim();
  const padrao = novoPadrao.value.trim();
  const dia = Number(novoDia.value);
  const valor = novoValor.value.trim() ? lerReais(novoValor.value) : undefined;
  if (!nome || padrao.length < 3 || !Number.isInteger(dia) || dia < 1 || dia > 31 || valor === null) {
    avisar('Preencha a conta, um trecho da descrição (3 letras ou mais) e o dia (1 a 31). O valor é opcional.', 'erro');
    return;
  }
  try {
    await api.criarContaFixa({ nome, padrao, dia, valor, conta_id: novoConta.value ? Number(novoConta.value) : undefined, debito_automatico: novoDebito.value });
    avisar(`${nome} cadastrada.`);
    novoNome.value = '';
    novoPadrao.value = '';
    novoDia.value = '';
    novoValor.value = '';
    novoDebito.value = false;
    dadosMudaram();
  } catch (e) {
    avisar((e as Error).message, 'erro');
  }
}
</script>

<template>
  <section>
    <div class="pagina-topo">
      <div>
        <h1>A pagar</h1>
        <p class="sub">{{ ciclo || 'Até o próximo salário' }}: o que já saiu, o que falta pagar e se o dinheiro das contas dá.</p>
      </div>
    </div>

    <div v-if="erro" class="erro">
      <span>Não foi possível carregar: {{ erro }}</span>
      <button class="botao" type="button" @click="carregar">Tentar de novo</button>
    </div>

    <template v-if="dados">
      <div class="kpis kpis-3">
        <KpiCard titulo="Nas contas hoje" :valor="brl(dados.saldo)"
          :detalhe="jaSaiu
            ? `${brl(dados.saldo_banco)} no banco (Pluggy em ${atualizado}), menos ${brl(dados.ja_saiu)} que já saiu depois e o banco ainda não mostra`
            : atualizado ? `saldo das contas correntes, atualizado pela Pluggy em ${atualizado}` : 'saldo das contas correntes'" />
        <KpiCard :titulo="`Falta pagar até ~${dataCurta(dados.proximo_salario)}`" :valor="brl(dados.a_pagar)"
          :detalhe="`${abertos.length} ${abertos.length === 1 ? 'conta ou fatura' : 'contas e faturas'}`" />
        <KpiCard :titulo="faltando ? 'Vai faltar' : 'Vai sobrar'" :valor="brl(semSinal(dados.sobra))" :tom="faltando ? 'negativo' : 'positivo'"
          :detalhe="faltando ? `pagando tudo, sem contar o que entra antes do salário${coberturaGuardado}` : 'pagando tudo o que falta até o salário'" />
      </div>

      <div class="cartao">
        <div class="cartao-topo"><h2>Por conta</h2><span class="sub">cada conta paga o que sai dela, na ordem dos vencimentos</span></div>
        <ul class="lista-contas-apagar">
          <li v-for="c in dados.contas" :key="c.id">
            <div class="conta-apagar-topo">
              <strong>{{ c.conta }}</strong>
              <span class="num" :class="{ negativo: negativo(c.sobra) }">
                {{ negativo(c.sobra) ? `falta ${brl(semSinal(c.sobra))}` : `sobra ${brl(c.sobra)}` }}
              </span>
            </div>
            <p class="sub">
              tem {{ brl(c.saldo) }}<template v-if="(toNumber(c.ja_saiu) ?? 0) > 0"> ({{ brl(c.saldo_banco) }} no banco, menos {{ brl(c.ja_saiu) }} que já saiu)</template>
              · sai {{ brl(c.a_pagar) }} até o salário
              <template v-if="c.acaba_em"> · <span class="negativo">o dinheiro acaba em {{ dataCurta(c.acaba_em.data) }} ({{ c.acaba_em.descricao }})</span></template>
            </p>
          </li>
        </ul>
      </div>

      <div class="cartao sem-padding espaco-topo">
        <div class="cartao-topo tabela-titulo"><h2>Falta pagar</h2></div>
        <div v-if="abertos.length" class="tabela-rolagem">
          <table class="tabela tabela-m">
            <thead>
              <tr><th>Vence</th><th>O quê</th><th>Sai de</th><th class="direita">Valor</th><th>Situação</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="i in abertos" :key="`${i.tipo}-${i.id}-${i.vencimento}`">
                <td class="m-2" data-rotulo="vence">{{ dataCurta(i.vencimento) }}</td>
                <td class="m-1">{{ i.descricao }}</td>
                <td class="muted m-2">{{ i.conta ?? '—' }}</td>
                <td class="direita num m-v">{{ i.valor === null ? '?' : brl(i.valor) }}</td>
                <td class="m-3"><span class="situacao" :class="`situacao-${i.situacao}`">{{ situacao(i) }}</span></td>
                <td class="direita m-3 m-fim">
                  <button v-if="i.tipo === 'conta_fixa'" class="botao pequeno" type="button" @click="jaPaguei(i)">Já paguei</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="vazio">Nada a pagar até o próximo salário.</p>
      </div>

      <div v-if="pagos.length" class="cartao sem-padding espaco-topo">
        <div class="cartao-topo tabela-titulo"><h2>Já pago desde o salário</h2></div>
        <div class="tabela-rolagem">
          <table class="tabela tabela-m">
            <tbody>
              <tr v-for="i in pagos" :key="`${i.tipo}-${i.id}-${i.vencimento}`">
                <td class="m-2" data-rotulo="venceu">{{ dataCurta(i.vencimento) }}</td>
                <td class="m-1">{{ i.descricao }}</td>
                <td class="muted m-2">{{ i.conta ?? '—' }}</td>
                <td class="direita num m-v">{{ brl(i.valor) }}</td>
                <td class="m-3"><span class="situacao situacao-paga">{{ situacao(i) }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="cartao espaco-topo">
        <div class="cartao-topo"><h2>Contas fixas</h2><span class="sub">o que sai todo mês da conta corrente; o pagamento é reconhecido pelo trecho da descrição, em qualquer banco</span></div>
        <ul v-if="dados.contas_fixas.length" class="lista-planejados">
          <li v-for="c in dados.contas_fixas" :key="c.id">
            <div>
              <div class="planejado-linha">
                <strong>{{ c.nome }}</strong>
                <span class="num">{{ c.valor ? brl(c.valor) : 'valor do mês anterior' }}</span>
                <span class="muted">dia {{ c.dia }}{{ c.debito_automatico ? ' · débito automático' : '' }} · {{ c.conta ?? 'sem conta' }} · contém "{{ c.padrao }}"</span>
              </div>
            </div>
            <div class="lista-planejados-botoes">
              <button class="botao discreto pequeno" type="button" @click="debitoAutomatico(c.id, c.nome, !c.debito_automatico)">
                {{ c.debito_automatico ? 'Não é débito automático' : 'É débito automático' }}
              </button>
              <button class="botao discreto pequeno" type="button" @click="encerrar(c.id, c.nome)">Encerrar</button>
            </div>
          </li>
        </ul>
        <p v-else class="vazio">Nenhuma ainda. Cadastre as contas que saem todo mês: luz, água, internet, condomínio...</p>

        <details class="novo-objetivo">
          <summary>Nova conta fixa</summary>
          <form class="form-objetivo" @submit.prevent="criar">
            <label>Conta<input v-model="novoNome" class="campo" maxlength="80" placeholder="ex.: Luz" autocomplete="off" /></label>
            <label>Descrição contém<input v-model="novoPadrao" class="campo" maxlength="80" placeholder="ex.: energia" autocomplete="off" /></label>
            <label>Dia<input v-model="novoDia" class="campo" inputmode="numeric" placeholder="13" autocomplete="off" /></label>
            <label>Valor (opcional)<input v-model="novoValor" class="campo" inputmode="decimal" placeholder="do mês anterior" autocomplete="off" /></label>
            <label>Sai de
              <select v-model="novoConta" class="campo">
                <option v-for="c in dados.contas" :key="c.id" :value="String(c.id)">{{ c.conta }}</option>
              </select>
            </label>
            <label class="check-debito"><input v-model="novoDebito" type="checkbox" /> Débito automático</label>
            <div class="form-compra-botoes"><button class="botao primario" type="submit">Cadastrar</button></div>
          </form>
        </details>
      </div>

      <details class="cartao espaco-topo como-funciona">
        <summary>Como a conta é feita</summary>
        <ul class="explicacao">
          <li>Saldo: o das contas correntes, como a Pluggy trouxe na última atualização (uma vez por dia). O que entra antes do salário, como um Pix, não está contado.</li>
          <li>Faturas fechadas: pagas quando o pagamento chega no cartão. A fatura aberta que vence antes do salário entra pelo que já foi gasto nela até hoje (estimativa; cresce com as compras até fechar).</li>
          <li>Débito automático: passado o vencimento, a conta conta como paga. Se o banco ainda não mostrou o débito, o valor sai do saldo até mostrar; se mostrar os dados do dia sem o débito, ela volta a "atrasada".</li>
          <li>Contas fixas: pagas quando sai de uma conta corrente um pagamento com o trecho da descrição. Cada pagamento vale para o vencimento mais próximo: um mês pago com atraso não adianta o seguinte. Sem valor fixo, vale o que saiu no mês anterior. Se o pagamento não for reconhecido (um Pix sem descrição, por exemplo), use "Já paguei".</li>
          <li>Próximo salário: um mês depois do último. As faturas que vencem depois dele ficam para o ciclo seguinte; veja as próximas em <a :href="link('parcelas')">Parcelas</a>.</li>
        </ul>
      </details>
    </template>
    <p v-else-if="!erro" class="carregando">Carregando…</p>
  </section>
</template>
