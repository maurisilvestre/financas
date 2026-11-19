<script setup lang="ts">
// Alerta de compras parceladas recentes. Parcelar vale só para o que é da casa e foi planejado: cada uma aparece aqui para conferir.
import { brl, contaCurta, dataLonga, mesCurto } from '../lib/format.ts';
import type { ParcelamentoNovo } from '../types.ts';

defineProps<{ novos: ParcelamentoNovo[] }>();
</script>

<template>
  <div v-if="novos.length" class="alerta-parcelas" role="alert">
    <strong>{{ novos.length === 1 ? 'Parcelamento novo' : `${novos.length} parcelamentos novos` }} nos últimos 30 dias</strong>
    <ul>
      <li v-for="p in novos" :key="p.grupo">
        <span>{{ p.compra }}</span>
        <span class="num">{{ p.parcelas }}x de {{ brl(p.valor_parcela) }} = {{ brl(p.total) }}</span>
        <span class="muted">
          {{ p.data_exata ? `em ${dataLonga(p.data_compra)}` : `1ª parcela em ${mesCurto(p.data_compra.slice(0, 7))}` }} · {{ contaCurta(p.conta) }}
        </span>
      </li>
    </ul>
  </div>
</template>
