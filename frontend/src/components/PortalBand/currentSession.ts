/** Session en cours, déduite de la date : hiver (janv.-avr.), été (mai-août), automne (sept.-déc.). */
export function currentSessionLabel(now: Date = new Date()): string {
  const month = now.getMonth();
  const season = month < 4 ? "d'hiver" : month < 8 ? "d'été" : "d'automne";
  return `Session ${season} ${now.getFullYear()}`;
}
