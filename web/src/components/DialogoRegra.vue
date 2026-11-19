<script setup lang="ts">
// Cria uma regra "contém" mostrando antes quantas transações ela vai pegar.
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from '../api.ts';
import { avisar, dadosMudaram } from '../store.ts';
import type { PreviaRegra } from '../types.ts';
import SeletorCategoria from './SeletorCategoria.vue';

const props = defineProps<{ padrao: string; categoria: string | null }>();
const emit = defineEmits<{ fechar: [] }>();

const padrao = ref(props.padrao);
const categoria = ref<string | null>(props.categoria);
const previa = ref<PreviaRegra | null>(null);
const procurando = ref(false);
const salvando = ref(false);
const erro = ref<string | null>(null);
const campo = ref<HTMLInputElement | null>(null);

let timer: ReturnType<typeof setTimeout> | undefined;
let pedido = 0;
watch(padrao, (valor) => {
  clearTimeout(timer);
  previa.value = null;
  erro.value = null;
  const p = valor.trim();
  if (p.length < 3) return;
  procurando.value = true;
  timer = setTimeout(async () => {
    const meu = ++pedido;
    try {
      const r = await api.previaRegra(p);
      if (meu === pedido) previa.value = r;
    } catch (e) {
      if (meu === pedido) erro.value = (e as Error).message;
    } finally {
      if (meu === pedido) procurando.value = false;
    }
  }, 300);
}, { immediate: true });

const plural = (n: number) => `${n} transaç${n === 1 ? 'ão' : 'ões'}`;

async function salvar(): Promise<void> {
  if (!categoria.value) return;
  salvando.value = true;
  erro.value = null;
  try {
    const r = await api.criarRegra(categoria.value, padrao.value.trim());
    avisar(`Regra criada: ${plural(r.casam)} com "${r.regra.padrao}" vão para ${r.regra.categoria}.`);
    if (r.observacao) avisar(r.observacao);
    dadosMudaram();
    emit('fechar');
  } catch (e) {
    erro.value = (e as Error).message;
  } finally {
    salvando.value = false;
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('fechar');
}
onMounted(() => {
  document.addEventListener('keydown', onKey);
  void nextTick(() => campo.value?.select());
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
  clearTimeout(timer);
});
</script>

<template>
  <div class="fundo-modal" @click.self="emit('fechar')">
    <form class="modal" role="dialog" aria-modal="true" aria-labelledby="titulo-regra" @submit.prevent="salvar">
      <h2 id="titulo-regra">Criar regra</h2>
      <p class="sub">Toda transação cuja descrição contiver o trecho ganha a categoria, inclusive as antigas.</p>

      <label class="rotulo-campo">
        Descrição contém
        <input ref="campo" v-model="padrao" class="campo largo" maxlength="200" autocomplete="off" spellcheck="false" />
      </label>
      <label class="rotulo-campo">
        Categoria
        <SeletorCategoria v-model="categoria" vazio="Escolha uma categoria…" />
      </label>

      <div class="previa" aria-live="polite">
        <p v-if="padrao.trim().length < 3" class="sub">Digite pelo menos 3 letras.</p>
        <p v-else-if="procurando" class="sub">Procurando…</p>
        <template v-else-if="previa">
          <p v-if="previa.casam === 0">Nenhuma transação contém esse trecho.</p>
          <p v-else><strong>{{ plural(previa.casam) }}</strong> contêm esse trecho:</p>
          <ul class="exemplos">
            <li v-for="e in previa.exemplos" :key="`${e.descricao}|${e.categoria}`">
              <span :title="e.descricao">{{ e.descricao }}</span>
              <span class="sub">{{ e.n }}× · {{ e.categoria ?? 'sem categoria' }}</span>
            </li>
          </ul>
        </template>
      </div>
      <p v-if="erro" class="erro-texto">{{ erro }}</p>

      <div class="acoes">
        <button type="button" class="botao" @click="emit('fechar')">Cancelar</button>
        <button
          type="submit"
          class="botao primario"
          :disabled="!categoria || !previa || previa.casam === 0 || salvando"
        >{{ salvando ? 'Salvando…' : 'Criar regra' }}</button>
      </div>
    </form>
  </div>
</template>
