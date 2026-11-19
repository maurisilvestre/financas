// Largura de um elemento, atualizada quando a tela muda (girar o celular, redimensionar a janela).
// Os gráficos usam para desenhar no tamanho real em tela estreita (ver larguraGrafico).
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

export function useLargura(el: Ref<HTMLElement | null>): Ref<number> {
  const largura = ref(0);
  let observador: ResizeObserver | undefined;
  onMounted(() => {
    if (!el.value) return;
    largura.value = el.value.clientWidth;
    if (typeof ResizeObserver === 'undefined') return;
    observador = new ResizeObserver(([e]) => { if (e) largura.value = Math.round(e.contentRect.width); });
    observador.observe(el.value);
  });
  onBeforeUnmount(() => observador?.disconnect());
  return largura;
}
