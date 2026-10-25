/**
 * Appareil à pointeur « grossier » = tactile (téléphone OU tablette) : c'est là qu'un
 * `autoFocus` ferait surgir le clavier virtuel de façon intempestive. `(pointer: coarse)`
 * cible le pointeur PRINCIPAL tactile → couvre mobile ET tablette, tout en excluant les
 * desktop/laptop à souris (pointeur « fin »).
 */
const TOUCH_QUERY = '(pointer: coarse)';

/**
 * Vrai sur un appareil tactile (mobile / tablette). Évalué à l'appel (non réactif) :
 * suffisant pour décider d'un `autoFocus` au MONTAGE d'un composant.
 *
 * Usage principal : sur tactile, on N'AUTO-FOCALISE PAS les champs de recherche — sinon le
 * clavier virtuel s'ouvre tout seul dès l'ouverture du popup/menu. L'utilisateur tape le
 * champ lui-même. En desktop (souris), l'auto-focus reste actif.
 *
 * Garde `typeof matchMedia` : dans certains environnements de test (jsdom sans polyfill),
 * `matchMedia` peut être absent → on considère alors « non tactile » (comportement desktop).
 */
export function isTouchDevice(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(TOUCH_QUERY).matches
  );
}
