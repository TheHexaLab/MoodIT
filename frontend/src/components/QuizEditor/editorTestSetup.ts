/**
 * Polyfills jsdom partagés par les tests de l'éditeur de quiz montés dans la coquille
 * (`EditorShell`) :
 * - `ResizeObserver` : utilisé par la coquille pour animer sa hauteur — absent de jsdom.
 * - `matchMedia` : `matches: true` (prefers-reduced-motion) → les fermetures/confirmations
 *   des popups (EditorShell, DeleteConfirmationPopup, ErrorPopup) s'exécutent
 *   SYNCHRONEMENT (sans attendre `animationend`, non émis par jsdom).
 */

if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
