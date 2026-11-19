<script setup lang="ts">
// "Posso comprar?": previsão dos próximos meses (média do que costuma entrar e sair, parcelas
// exatas, gastos planejados e o aporte dos objetivos) e simulação de uma compra. O limite do
// cartão não conta.
import { computed, ref, watch } from 'vue';
import { api } from '../api.ts';
import GraficoPrevisao from '../components/GraficoPrevisao.vue';
import KpiCard from '../components/KpiCard.vue';
import Segmentos from '../components/Segmentos.vue';
import { brl, dataCurta, lerReais, mesCurto, percentual, somaReais, toNumber } from '../lib/format.ts';
import { paginaDoMes, paginar, primeiroBuraco } from '../lib/previsao.ts';
import { avisar, dadosMudaram, versao } from '../store.ts';
import type { MesPrevisao, Objetivo, Previsao, Simulacao } from '../types.ts';

const semSinal = (v: string) => v.replace(/^-/, '');

type Cenario = 'media' | 'meta';
type Horizonte = '12' | '24' | '36' | '48';

const dados = ref<Previsao | null>(null);
const erro = ref<string | null>(null);
const cenario = ref<Cenario>('media');
const horizonte = ref<Horizonte>('12');
const opcoesHorizonte: Array<{ valor: Horizonte; rotulo: string }> = [
  { valor: '12', rotulo: '1 ano' },
  { valor: '24', rotulo: '2 anos' },
  { valor: '36', rotulo: '3 anos' },
  { valor: '48', rotulo: '4 anos' },
];
const simulacao = ref<Simulacao | null>(null);

// Formulário da compra.
const oQue = ref('');
const valorTexto = ref('');
const parcelas = ref(1);
const mesCompra = ref('');
const motivo = ref('');
const gravando = ref(false);

async function carregar(): Promise<void> {
  erro.value = null;
  try {
    const s = simulacao.value;
    dados.value = await api.previsao({
      cenario: cenario.value,
      meses: Number(horizonte.value),
      ...(s ? { valor: s.valor, parcelas: s.parcelas, mes: s.mes, descricao: s.descricao || undefined } : {}),
    });
    if (!mesCompra.value) mesCompra.value = dados.value.meses[0]?.mes ?? '';
    if (!objInicio.value) objInicio.value = (dados.value.meses[1] ?? dados.value.meses[0])?.mes ?? '';
  } catch (e) {
    erro.value = (e as Error).message;
  }
}
watch([cenario, simulacao, versao, horizonte], carregar, { immediate: true });

// Encurtar o horizonte: o que estava escolhido depois do novo fim volta ao começo.
function mudarHorizonte(h: Horizonte): void {
  const ultimo = dados.value?.meses[Number(h) - 1]?.mes;
  if (ultimo) {
    if (mesCompra.value > ultimo) mesCompra.value = dados.value!.meses[0]!.mes;
    if (objInicio.value > ultimo) objInicio.value = '';
    if (simulacao.value && simulacao.value.mes > ultimo) simulacao.value = null;
  }
  horizonte.value = h;
}

// A tabela vai de ano em ano; o gráfico mostra o horizonte todo e marca o ano da tabela.
const pagina = ref(0);
const paginas = computed(() => paginar(dados.value?.meses.length ?? 0));
const paginaAtual = computed(() => paginas.value[Math.min(pagina.value, Math.max(paginas.value.length - 1, 0))] ?? null);
const mesesDaTabela = computed(() => (dados.value && paginaAtual.value
  ? dados.value.meses.slice(paginaAtual.value.de, paginaAtual.value.ate) : []));
const rotuloPagina = computed(() => {
  const p = paginaAtual.value;
  const m = dados.value?.meses;
  return p && m ? `${mesCurto(m[p.de]!.mes)} a ${mesCurto(m[p.ate - 1]!.mes)}` : '';
});
watch(paginas, (ps) => {
  if (pagina.value >= ps.length) pagina.value = Math.max(ps.length - 1, 0);
});

function simular(): void {
  const valor = lerReais(valorTexto.value);
  if (valor === null || valor <= 0) {
    avisar('Digite o valor em reais, por exemplo 4.000 ou 1.299,90.', 'erro');
    return;
  }
  simulacao.value = { descricao: oQue.value.trim(), valor, parcelas: parcelas.value, mes: mesCompra.value };
  pagina.value = paginaDoMes(dados.value?.meses ?? [], mesCompra.value);
}

function limpar(): void {
  simulacao.value = null;
  oQue.value = '';
  valorTexto.value = '';
  parcelas.value = 1;
  motivo.value = '';
}

async function planejar(): Promise<void> {
  const s = simulacao.value;
  if (!s) return;
  gravando.value = true;
  try {
    await api.planejarGasto({ descricao: s.descricao || 'Compra', motivo: motivo.value.trim() || undefined, valor: s.valor, parcelas: s.parcelas, mes: s.mes });
    avisar(`Planejado: ${s.descricao || 'compra'} de ${brl(s.valor)} em ${mesCurto(s.mes)}. A previsão já conta com ele.`);
    limpar();
    dadosMudaram();
  } catch (e) {
    avisar((e as Error).message, 'erro');
  } finally {
    gravando.value = false;
  }
}

async function mudarPlanejado(id: number, status: 'realizado' | 'cancelado'): Promise<void> {
  try {
    await api.atualizarPlanejado(id, status);
    avisar(status === 'realizado' ? 'Marcado como realizado: sai da previsão.' : 'Cancelado: sai da previsão.');
    dadosMudaram();
  } catch (e) {
    avisar((e as Error).message, 'erro');
  }
}

// Objetivos: criar, atualizar (já guardado, aporte, início), concluir ou cancelar.
const objNome = ref('');
const objValor = ref('');
const objGuardado = ref('');
const objPorMes = ref('');
const objInicio = ref('');
const objMotivo = ref('');
const editando = ref<number | null>(null);
const edGuardado = ref('');
const edPorMes = ref('');
const edInicio = ref('');

async function criarObjetivo(): Promise<void> {
  const nome = objNome.value.trim();
  const valor = lerReais(objValor.value);
  const porMes = lerReais(objPorMes.value);
  const guardado = objGuardado.value.trim() ? lerReais(objGuardado.value) : 0;
  if (!nome || !valor || !porMes || guardado === null) {
    avisar('Preencha o objetivo, quanto precisa e quanto guardar por mês (ex.: 20.000 e 1.000).', 'erro');
    return;
  }
  try {
    await api.criarObjetivo({ nome, motivo: objMotivo.value.trim() || undefined, valor, ja_guardado: guardado, por_mes: porMes, inicio: objInicio.value });
    avisar(`Objetivo criado: ${nome}. A previsão já guarda ${brl(porMes)} por mês para ele.`);
    objNome.value = '';
    objValor.value = '';
    objGuardado.value = '';
    objPorMes.value = '';
    objMotivo.value = '';
    dadosMudaram();
  } catch (e) {
    avisar((e as Error).message, 'erro');
  }
}

function editar(o: Objetivo): void {
  editando.value = o.id;
  edGuardado.value = o.guardado;
  edPorMes.value = o.por_mes;
  edInicio.value = o.inicio;
}

async function salvarObjetivo(id: number): Promise<void> {
  const guardado = lerReais(edGuardado.value);
  const porMes = lerReais(edPorMes.value);
  if (guardado === null || !porMes) {
    avisar('Digite quanto já está guardado e quanto guardar por mês.', 'erro');
    return;
  }
  try {
    await api.atualizarObjetivo(id, { ja_guardado: guardado, por_mes: porMes, inicio: edInicio.value });
    avisar('Objetivo atualizado.');
    editando.value = null;
    dadosMudaram();
  } catch (e) {
    avisar((e as Error).message, 'erro');
  }
}

async function mudarObjetivo(id: number, status: 'concluido' | 'cancelado'): Promise<void> {
  try {
    await api.atualizarObjetivo(id, { status });
    avisar(status === 'concluido' ? 'Objetivo concluído: sai da previsão.' : 'Objetivo cancelado: sai da previsão.');
    dadosMudaram();
  } catch (e) {
    avisar((e as Error).message, 'erro');
  }
}

// Tirar da média algo que acabou.
const novoTrecho = ref('');
const novoMotivo = ref('');
async function excluir(): Promise<void> {
  const padrao = novoTrecho.value.trim();
  const m = novoMotivo.value.trim();
  if (padrao.length < 3 || !m) {
    avisar('Escreva um trecho da descrição (3 letras ou mais) e o motivo.', 'erro');
    return;
  }
  try {
    await api.excluirDaPrevisao({ padrao, motivo: m });
    avisar(`"${padrao}" saiu da média da previsão.`);
    novoTrecho.value = '';
    novoMotivo.value = '';
    dadosMudaram();
  } catch (e) {
    avisar((e as Error).message, 'erro');
  }
}
async function devolver(id: number): Promise<void> {
  try {
    await api.removerExclusao(id);
    avisar('Voltou para a média da previsão.');
    dadosMudaram();
  } catch (e) {
    avisar((e as Error).message, 'erro');
  }
}

const compra = computed(() => dados.value?.compra ?? null);
const saidasMedias = computed(() => (dados.value ? somaReais([dados.value.medias.gastos_conta, dados.value.medias.cartao_avista]) : '0'));
const opcoesCenario = computed(() => [
  { valor: 'media' as const, rotulo: 'Cartão pela média' },
  ...(dados.value?.meta ? [{ valor: 'meta' as const, rotulo: 'Cartão pela meta' }] : []),
]);
const negativo = (v: string | undefined) => (toNumber(v) ?? 0) < 0;
const temGuardar = computed(() => dados.value?.meses.some((m) => (toNumber(m.guardar_planejado) ?? 0) > 0) ?? false);
// Só se guarda o que sobra: quanto vai para os objetivos no mês e se ficou abaixo do planejado.
const guardarDoMes = (m: MesPrevisao) => (compra.value ? m.guardar_com_compra : m.guardar);
const abaixoDoPlano = (m: MesPrevisao) => (toNumber(guardarDoMes(m)) ?? 0) < (toNumber(m.guardar_planejado) ?? 0);
const guardarNoHorizonte = computed(() => ({
  planejado: somaReais(dados.value?.meses.map((m) => m.guardar_planejado) ?? []),
  previsto: somaReais(dados.value?.meses.map((m) => m.guardar) ?? []),
}));
const objetivosAtrasam = computed(() => (toNumber(guardarNoHorizonte.value.previsto) ?? 0) < (toNumber(guardarNoHorizonte.value.planejado) ?? 0));
// Exemplo para a legenda: um mês em que sobra dinheiro, mas o saldo acumulado continua negativo.
const exemploBuraco = computed(() => primeiroBuraco((dados.value?.meses ?? []).map((m) => ({
  mes: m.mes,
  sobra: (compra.value ? m.sobra_com_compra : m.sobra) ?? '0.00',
  saldo: (compra.value ? m.saldo_com_compra : m.saldo) ?? '0.00',
}))));
const tiraDosObjetivos = computed(() => (toNumber(compra.value?.tira_dos_objetivos) ?? 0) > 0);
// Quanto ainda dá para guardar por mês a partir do início escolhido para um novo objetivo.
const livreNoInicio = computed(() => dados.value?.meses.find((m) => m.mes === objInicio.value)?.aporte_maximo ?? '0.00');
const primeiroComFolga = computed(() => dados.value?.meses.find((m) => m.mes >= objInicio.value && (toNumber(m.aporte_maximo) ?? 0) > 0) ?? null);
const cenarioTexto = computed(() => (dados.value?.cenario === 'meta' ? 'cumprindo a meta do cartão' : 'com o cartão na média'));
const cenarioFrase = computed(() => (dados.value?.cenario === 'meta' ? 'Cumprindo a meta do cartão' : 'Com o cartão na média'));
// "Equivale a 4 meses de Reserva e 2 meses de Viagem."
const trocaTexto = computed(() => {
  const partes = (compra.value?.equivale ?? []).map((e) => `${e.meses} ${e.meses === 1 ? 'mês' : 'meses'} de ${e.nome}`);
  if (!partes.length) return '';
  const lista = partes.length === 1 ? partes[0] : `${partes.slice(0, -1).join(', ')} e ${partes.at(-1)}`;
  return `Em aporte dos objetivos, equivale a ${lista}.`;
});
const TITULOS = { cabe: 'Cabe', no_limite: 'Cabe, mas no limite', nao_cabe: 'Não cabe' } as const;
</script>

<template>
  <section>
    <div class="pagina-topo">
      <div>
        <h1>Posso comprar?</h1>
        <p class="sub">Os próximos {{ dados?.meses.length ?? horizonte }} meses com o que costuma entrar e sair. O limite do cartão não conta: só o que entra e o que já se sabe que vai sair.</p>
      </div>
      <Segmentos v-if="opcoesCenario.length > 1" v-model="cenario" :opcoes="opcoesCenario" rotulo="Como prever o cartão à vista" />
    </div>

    <div v-if="erro" class="erro">
      <span>Não foi possível carregar: {{ erro }}</span>
      <button class="botao" type="button" @click="carregar">Tentar de novo</button>
    </div>

    <div class="cartao">
      <div class="cartao-topo"><h2>Simular uma compra</h2></div>
      <form class="form-compra" @submit.prevent="simular">
        <label>O que<input v-model="oQue" class="campo" maxlength="120" placeholder="ex.: geladeira" autocomplete="off" /></label>
        <label>Valor (R$)<input v-model="valorTexto" class="campo" inputmode="decimal" placeholder="4.000" autocomplete="off" /></label>
        <label>Forma
          <select v-model.number="parcelas" class="campo">
            <option :value="1">À vista</option>
            <option v-for="k in 11" :key="k" :value="k + 1">{{ k + 1 }}x</option>
          </select>
        </label>
        <label>Mês
          <select v-model="mesCompra" class="campo">
            <option v-for="m in dados?.meses ?? []" :key="m.mes" :value="m.mes">{{ mesCurto(m.mes) }}</option>
          </select>
        </label>
        <div class="form-compra-botoes">
          <button class="botao primario" type="submit">Simular</button>
          <button v-if="simulacao" class="botao discreto" type="button" @click="limpar">Limpar</button>
        </div>
      </form>
      <p v-if="parcelas > 1" class="aviso-parcelar">Parcelado vale para o que é da casa, sem juros: as parcelas ficam fora da meta do cartão, mas entram na previsão mês a mês.</p>

      <div v-if="compra" class="veredito" :class="`veredito-${compra.veredito}`" role="status">
        <strong>{{ TITULOS[compra.veredito] }}{{ compra.veredito === 'nao_cabe' ? ` em ${mesCurto(compra.mes)}` : '' }}</strong>
        <p v-if="compra.veredito === 'cabe'">
          {{ compra.descricao || 'A compra' }} de {{ brl(compra.valor) }}{{ compra.parcelas > 1 ? ` em ${compra.parcelas}x` : '' }}:
          no pior mês ({{ mesCurto(compra.mes_menor_saldo) }}), o saldo fica em {{ brl(compra.menor_saldo) }}.
        </p>
        <p v-else-if="compra.veredito === 'no_limite'">
          O saldo fica em {{ brl(compra.menor_saldo) }} em {{ mesCurto(compra.mes_menor_saldo) }}, abaixo da folga de {{ brl(dados?.margem) }}.
          Qualquer imprevisto vira dívida.
          <template v-if="compra.corte_mensal"> Cortando {{ brl(compra.corte_mensal) }} por mês desde já, fica com folga.</template>
        </p>
        <p v-else>
          <template v-if="negativo(compra.menor_saldo)">O saldo fica negativo: {{ brl(compra.menor_saldo) }} em {{ mesCurto(compra.mes_menor_saldo) }}.</template>
          <template v-if="tiraDosObjetivos">
            {{ negativo(compra.menor_saldo) ? 'E tira' : 'Tira' }} {{ brl(compra.tira_dos_objetivos) }} do que iria para os objetivos, que atrasam.
          </template>
          <template v-if="compra.a_partir_de">Cabe a partir de <strong>{{ mesCurto(compra.a_partir_de) }}</strong>.</template>
          <template v-else>Não cabe nos próximos {{ dados?.meses.length }} meses.</template>
          <template v-if="compra.corte_mensal"> Para comprar em {{ mesCurto(compra.mes) }}, seria preciso cortar {{ brl(compra.corte_mensal) }} por mês desde já.</template>
        </p>
        <p v-if="trocaTexto" class="veredito-troca">{{ trocaTexto }}</p>
        <p v-if="compra.guardado" class="veredito-troca">
          <template v-if="compra.guardado.acaba_em">Com ela, o guardado não cobre os meses negativos: acaba em {{ mesCurto(compra.guardado.acaba_em) }}.</template>
          <template v-else>Com ela, o guardado chega a {{ brl(compra.guardado.menor) }} no pior mês ({{ mesCurto(compra.guardado.mes_menor) }}).</template>
        </p>
        <div class="veredito-planejar">
          <input v-model="motivo" class="campo" maxlength="500" placeholder="Por que precisa (opcional)" aria-label="Por que precisa" />
          <button class="botao" type="button" :disabled="gravando" @click="planejar">Planejar esta compra</button>
        </div>
      </div>
    </div>

    <template v-if="dados">
      <div class="kpis kpis-3 espaco-topo">
        <KpiCard titulo="Entra por mês" :valor="brl(dados.medias.entradas)" :detalhe="`média de ${mesCurto(dados.base.de)} a ${mesCurto(dados.base.ate)}`" />
        <KpiCard titulo="Sai por mês, sem parcelas" :valor="brl(saidasMedias)"
          :detalhe="`conta ${brl(dados.medias.gastos_conta)} · cartão ${brl(dados.medias.cartao_avista)}${dados.cenario === 'meta' ? ' (meta)' : ''}`" />
        <KpiCard titulo="Dá para gastar à vista agora" :valor="brl(dados.meses[0]?.capacidade_avista)"
          :tom="(toNumber(dados.meses[0]?.capacidade_avista) ?? 0) > 0 ? undefined : 'negativo'"
          detalhe="sem o saldo de nenhum mês seguinte ficar negativo" />
      </div>

      <div v-if="dados.guardado" class="kpis kpis-3">
        <KpiCard titulo="Guardado hoje" :valor="brl(dados.guardado.total)"
          :detalhe="`investimentos${dados.guardado.data ? `, posição de ${dataCurta(dados.guardado.data)}` : ''}`">
          <span v-for="c in dados.guardado.contas" :key="c.conta" class="guardado-contas">{{ c.conta }}: {{ brl(c.saldo) }}</span>
        </KpiCard>
        <KpiCard v-if="dados.guardado.acaba_em" titulo="O guardado acaba em" :valor="mesCurto(dados.guardado.acaba_em)" tom="negativo"
          :detalhe="`${cenarioTexto}: no pior mês (${mesCurto(dados.guardado.mes_menor)}) faltam ${brl(semSinal(dados.guardado.menor))}`" />
        <KpiCard v-else titulo="Guardado no pior mês" :valor="brl(dados.guardado.menor)"
          :tom="(toNumber(dados.guardado.menor) ?? 0) < (toNumber(dados.margem) ?? 0) ? 'negativo' : undefined"
          :detalhe="`em ${mesCurto(dados.guardado.mes_menor)}, ${cenarioTexto}, cobrindo os meses em que falta`" />
        <KpiCard titulo="Fica tranquilo em" :valor="dados.guardado.tranquilo_em ? mesCurto(dados.guardado.tranquilo_em) : 'Ainda não'"
          :tom="dados.guardado.tranquilo_em ? 'positivo' : 'negativo'"
          :detalhe="dados.guardado.tranquilo_em ? 'a partir daí sobra todo mês, e o guardado volta a crescer' : `a sobra ainda fica negativa em algum dos próximos ${dados.meses.length} meses`" />
      </div>

      <div class="cartao">
        <div class="cartao-topo">
          <h2>Saldo acumulado</h2><span class="sub">começa em zero neste mês{{ dados.guardado ? '; o guardado começa no que está nos investimentos' : ': não conta com reserva' }}</span>
          <Segmentos class="horizonte" :model-value="horizonte" :opcoes="opcoesHorizonte" rotulo="Até quando prever" @update:model-value="mudarHorizonte" />
        </div>
        <GraficoPrevisao :meses="dados.meses" :pagina="paginaAtual" @mes="(i) => (pagina = Math.floor(i / 12))" />
      </div>

      <div class="cartao sem-padding espaco-topo">
        <div class="sub tabela-legenda">
          <p>
          Todo mês: entram {{ brl(dados.medias.entradas) }}; saem {{ brl(dados.medias.gastos_conta) }} na conta e
          {{ brl(dados.medias.cartao_avista) }} no cartão à vista{{ dados.cenario === 'meta' ? ' (meta)' : '' }}. Mudam as parcelas e os planejados.
          </p>
          <p>
          <strong>O saldo é acumulado:</strong> começa em zero neste mês e vai somando a sobra de cada
          mês<template v-if="temGuardar">, menos o que vai para os objetivos</template>. Saldo negativo é o que faltou nos meses
          anteriores: a sobra de um mês primeiro cobre esse buraco<template v-if="temGuardar">, e só o que passar disso vai para
          os objetivos, até o planejado</template>.
          <template v-if="exemploBuraco">
            Em {{ mesCurto(exemploBuraco.mes) }}, por exemplo, sobram {{ brl(exemploBuraco.sobra) }}, que diminuem o buraco de
            {{ brl(exemploBuraco.antes) }} para {{ brl(exemploBuraco.depois) }}.
          </template>
          </p>
        </div>
        <nav v-if="paginas.length > 1" class="paginacao" aria-label="Ano da tabela">
          <button class="botao pequeno" type="button" :disabled="pagina === 0" @click="pagina--">‹ Ano anterior</button>
          <span><strong>{{ rotuloPagina }}</strong> <span class="muted">· {{ pagina + 1 }} de {{ paginas.length }}</span></span>
          <button class="botao pequeno" type="button" :disabled="pagina >= paginas.length - 1" @click="pagina++">Próximo ano ›</button>
        </nav>
        <div class="tabela-rolagem">
          <table class="tabela tabela-m tabela-m-grade">
            <thead>
              <tr>
                <th>Mês</th>
                <th class="direita">Parcelas</th>
                <th class="direita">Planejados</th>
                <th v-if="compra" class="direita">Compra</th>
                <th class="direita">Sobra</th>
                <th v-if="temGuardar" class="direita">Guardar</th>
                <th class="direita">Saldo acumulado</th>
                <th v-if="dados.guardado" class="direita">Guardado</th>
                <th class="direita">Dá para gastar</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in mesesDaTabela" :key="m.mes">
                <td class="m-1 forte">{{ mesCurto(m.mes) }}</td>
                <td class="direita num m-2" data-rotulo="parcelas">{{ brl(m.parcelas) }}</td>
                <td class="direita num m-2" data-rotulo="planejados">{{ brl(m.planejados) }}</td>
                <td v-if="compra" class="direita num m-2" data-rotulo="compra">{{ brl(m.compra) }}</td>
                <td class="direita num m-2" data-rotulo="sobra" :class="{ negativo: negativo(compra ? m.sobra_com_compra : m.sobra) }">{{ brl(compra ? m.sobra_com_compra : m.sobra) }}</td>
                <td v-if="temGuardar" class="direita num m-2" data-rotulo="guardar">
                  {{ brl(guardarDoMes(m)) }}
                  <span v-if="abaixoDoPlano(m)" class="de-planejado">de {{ brl(m.guardar_planejado) }}</span>
                </td>
                <td class="direita num forte m-v" data-rotulo="saldo" :class="{ negativo: negativo(compra ? m.saldo_com_compra : m.saldo) }">{{ brl(compra ? m.saldo_com_compra : m.saldo) }}</td>
                <td v-if="dados.guardado" class="direita num m-2" data-rotulo="guardado" :class="{ negativo: negativo(compra ? m.guardado_com_compra : m.guardado) }">{{ brl(compra ? m.guardado_com_compra : m.guardado) }}</td>
                <td class="direita num muted m-2" data-rotulo="dá para gastar">{{ brl(m.capacidade_avista) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="cartao espaco-topo">
        <div class="cartao-topo"><h2>Objetivos</h2><span class="sub">guarda o que sobra no mês, até o aporte; se não sobra, o objetivo atrasa</span></div>
        <p v-if="dados.objetivos.length && objetivosAtrasam" class="aviso-objetivos">
          {{ cenarioFrase }}, dos {{ brl(guardarNoHorizonte.planejado) }} planejados para os próximos {{ dados.meses.length }} meses
          só sobram {{ brl(guardarNoHorizonte.previsto) }} para guardar. Os objetivos atrasam: as datas abaixo são as do plano.
        </p>
        <ul v-if="dados.objetivos.length" class="lista-objetivos">
          <li v-for="o in dados.objetivos" :key="o.id">
            <div class="objetivo-topo">
              <strong>{{ o.nome }}</strong>
              <span class="num">{{ brl(o.guardado) }} de {{ brl(o.alvo) }}</span>
            </div>
            <div class="progresso">
              <span class="progresso-barra"><span :style="{ width: `${percentual(o.guardado, o.alvo)}%` }"></span></span>
              {{ percentual(o.guardado, o.alvo) }}%
            </div>
            <p class="sub">
              {{ brl(o.por_mes) }} por mês a partir de {{ mesCurto(o.inicio) }} ·
              {{ o.fica_pronto ? `pelo plano, fica pronto em ${mesCurto(o.fica_pronto)}` : 'já tem o valor todo' }}<template v-if="o.motivo"> · {{ o.motivo }}</template>
            </p>
            <form v-if="editando === o.id" class="form-objetivo" @submit.prevent="salvarObjetivo(o.id)">
              <label>Já guardado (R$)<input v-model="edGuardado" class="campo" inputmode="decimal" autocomplete="off" /></label>
              <label>Por mês (R$)<input v-model="edPorMes" class="campo" inputmode="decimal" autocomplete="off" /></label>
              <label>A partir de
                <select v-model="edInicio" class="campo">
                  <option v-for="m in dados.meses" :key="m.mes" :value="m.mes">{{ mesCurto(m.mes) }}</option>
                </select>
              </label>
              <div class="form-compra-botoes">
                <button class="botao primario" type="submit">Salvar</button>
                <button class="botao discreto" type="button" @click="editando = null">Voltar</button>
              </div>
            </form>
            <div v-else class="lista-planejados-botoes">
              <button class="botao pequeno" type="button" @click="editar(o)">Atualizar</button>
              <button class="botao pequeno" type="button" @click="mudarObjetivo(o.id, 'concluido')">Concluído</button>
              <button class="botao discreto pequeno" type="button" @click="mudarObjetivo(o.id, 'cancelado')">Cancelar</button>
            </div>
          </li>
        </ul>
        <p v-else class="vazio">Nenhum ainda. Cadastre aqui ou na conversa com o Claude: reserva de emergência, quitar uma dívida, uma viagem.</p>

        <p class="sub livre-objetivos">
          <template v-if="(toNumber(livreNoInicio) ?? 0) > 0">
            Ainda dá para guardar até <strong>{{ brl(livreNoInicio) }}</strong> por mês a partir de {{ mesCurto(objInicio) }},
            {{ cenarioTexto }}, sem o saldo de nenhum mês ficar abaixo de {{ brl(dados.margem) }}.
          </template>
          <template v-else-if="primeiroComFolga">
            {{ cenarioFrase }}, não sobra para guardar a partir de {{ mesCurto(objInicio) }}:
            só a partir de {{ mesCurto(primeiroComFolga.mes) }} (até {{ brl(primeiroComFolga.aporte_maximo) }} por mês).
          </template>
          <template v-else>{{ cenarioFrase }}, não sobra para guardar nos próximos {{ dados.meses.length }} meses.</template>
        </p>

        <details class="novo-objetivo">
          <summary>Novo objetivo</summary>
          <form class="form-objetivo" @submit.prevent="criarObjetivo">
            <label>Objetivo<input v-model="objNome" class="campo" maxlength="80" placeholder="ex.: Reserva" autocomplete="off" /></label>
            <label>Quanto precisa (R$)<input v-model="objValor" class="campo" inputmode="decimal" placeholder="20.000" autocomplete="off" /></label>
            <label>Já tem (R$)<input v-model="objGuardado" class="campo" inputmode="decimal" placeholder="0" autocomplete="off" /></label>
            <label>Por mês (R$)<input v-model="objPorMes" class="campo" inputmode="decimal" placeholder="1.000" autocomplete="off" /></label>
            <label>A partir de
              <select v-model="objInicio" class="campo">
                <option v-for="m in dados.meses" :key="m.mes" :value="m.mes">{{ mesCurto(m.mes) }}</option>
              </select>
            </label>
            <label class="form-objetivo-motivo">Por quê (opcional)<input v-model="objMotivo" class="campo" maxlength="500" autocomplete="off" /></label>
            <div class="form-compra-botoes"><button class="botao primario" type="submit">Criar objetivo</button></div>
          </form>
        </details>
      </div>

      <div class="grade espaco-topo">
        <div class="cartao">
          <div class="cartao-topo"><h2>Gastos planejados</h2></div>
          <ul v-if="dados.planejados.length" class="lista-planejados">
            <li v-for="p in dados.planejados" :key="p.id">
              <div>
                <div class="planejado-linha">
                  <strong>{{ p.descricao }}</strong>
                  <span class="num">{{ p.parcelas > 1 ? `${p.parcelas}x de ${brl(p.valor_parcela)}` : brl(p.valor) }}</span>
                  <span class="muted">{{ p.parcelas > 1 ? `a partir de ${mesCurto(p.mes)}` : `em ${mesCurto(p.mes)}` }}</span>
                </div>
                <p v-if="p.motivo" class="sub">{{ p.motivo }}</p>
              </div>
              <div class="lista-planejados-botoes">
                <button class="botao pequeno" type="button" @click="mudarPlanejado(p.id, 'realizado')">Já aconteceu</button>
                <button class="botao discreto pequeno" type="button" @click="mudarPlanejado(p.id, 'cancelado')">Cancelar</button>
              </div>
            </li>
          </ul>
          <p v-else class="vazio">Nenhum. Quando decidir comprar algo, planeje aqui ou na conversa com o Claude: a previsão passa a contar com ele.</p>
        </div>

        <div class="cartao">
          <div class="cartao-topo"><h2>Onde dá para cortar</h2><span class="sub">média por mês, {{ mesCurto(dados.base.de) }} a {{ mesCurto(dados.base.ate) }}</span></div>
          <ul v-if="dados.cortaveis.length" class="lista-cortes">
            <li v-for="c in dados.cortaveis.slice(0, 10)" :key="c.categoria">
              <span>{{ c.categoria }}</span><span class="num">{{ brl(c.media_mensal) }}</span>
            </li>
          </ul>
          <p v-else class="vazio">Nada fora das categorias essenciais.</p>
        </div>
      </div>

      <details class="cartao espaco-topo como-funciona">
        <summary>Como a previsão é feita e o que ficou fora da média</summary>
        <ul class="explicacao">
          <li>Entradas e cartão à vista: média de {{ mesCurto(dados.base.de) }} a {{ mesCurto(dados.base.ate) }}.</li>
          <li>Contas pagas na conta (débito, Pix, boletos): média de {{ mesCurto(dados.base.fixos_de) }} a {{ mesCurto(dados.base.ate) }}, para pegar o valor atual das contas fixas.</li>
          <li>Parcelas: exatas, mês a mês. Gastos planejados: até você marcar como realizados.</li>
          <li>Objetivos: a sobra do mês primeiro cobre o saldo negativo dos meses anteriores; o que passar vai para os objetivos, até o aporte planejado. Se não sobra, não guarda, e o objetivo atrasa. Atualize o "já guardado" quando guardar.</li>
          <li>Uma compra "cabe" quando o saldo de nenhum mês seguinte fica abaixo de {{ brl(dados.margem) }} e ela não tira nada dos objetivos.</li>
        </ul>

        <h3>Fora da média</h3>
        <ul class="lista-fora">
          <li v-for="c in dados.fora_da_media.categorias" :key="`c${c.id}`">
            <span><strong>{{ c.categoria }}</strong> (categoria) · {{ c.motivo }} · <span class="num">{{ brl(c.total) }}</span></span>
            <button class="botao discreto pequeno" type="button" @click="devolver(c.id)">Voltar à média</button>
          </li>
          <li v-for="e in dados.fora_da_media.encerrados" :key="`e${e.id}`">
            <span><strong>"{{ e.padrao }}"</strong> · {{ e.motivo }} · <span class="num">{{ brl(e.total) }}</span></span>
            <button class="botao discreto pequeno" type="button" @click="devolver(e.id)">Voltar à média</button>
          </li>
          <li v-if="!dados.fora_da_media.categorias.length && !dados.fora_da_media.encerrados.length" class="muted">Nada excluído por você.</li>
        </ul>
        <form class="form-exclusao" @submit.prevent="excluir">
          <input v-model="novoTrecho" class="campo" maxlength="80" placeholder="Trecho da descrição (ex.: assinatura cancelada)" aria-label="Trecho da descrição" />
          <input v-model="novoMotivo" class="campo" maxlength="200" placeholder="Por que não vai se repetir" aria-label="Motivo" />
          <button class="botao" type="submit">Tirar da média</button>
        </form>

        <h3>Gastos únicos grandes (fora sozinhos)</h3>
        <p class="sub">A partir de R$ 2.000, que não se repetiram na janela.</p>
        <ul v-if="dados.fora_da_media.pontuais.length" class="lista-fora">
          <li v-for="(p, i) in dados.fora_da_media.pontuais" :key="i">
            <span>{{ dataCurta(p.data) }} · {{ p.descricao }} <span class="muted">({{ p.fluxo === 'income' ? 'entrada' : 'saída' }})</span></span>
            <span class="num">{{ brl(p.valor) }}</span>
          </li>
        </ul>
      </details>
    </template>
    <p v-else-if="!erro" class="carregando">Carregando…</p>
  </section>
</template>
