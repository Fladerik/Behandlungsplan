/**
 * Anpassung an eine Einrichtung.
 *
 * Alles, was von Haus zu Haus verschieden ist, steht hier -- und nur hier.
 * Fuer eine weitere Klinik genuegt es, diese Datei zu aendern; am Programm
 * selbst ist nichts zu tun.
 *
 * Drei Stellen ausserhalb dieser Datei tragen den Namen ebenfalls, weil der
 * Browser sie liest, bevor Programmcode laeuft:
 *   - manifest.webmanifest  (Name auf dem Startbildschirm)
 *   - rechtliches.html      (Seitentitel und Fusszeile)
 *   - pruefen.html          (Seitentitel)
 * Sie sind im README unter "Anpassung an eine andere Einrichtung" genannt.
 */

/**
 * Fassung dieser Auslieferung.
 *
 * Steht sichtbar im Menue und auf der Pruefseite. Ohne eine solche Marke
 * laesst sich nicht unterscheiden, ob eine Aenderung wirklich auf dem Server
 * liegt oder ob der Browser noch die alte Datei haelt -- eine Frage, die
 * sonst jeden Fehlerbericht unbrauchbar macht.
 *
 * Beim Ausliefern hochzaehlen.
 */
export const FASSUNG = "2026-09-22 20:24";

export const ANWENDUNG = {
  /** Name der Anwendung, wie er in der Kopfzeile und im Browsertab steht. */
  name: "Federsee Terminplan",

  /** Untertitel unter dem Namen. */
  untertitel: "Ihr Therapie- und Tagesplan",

  /** Einrichtung, deren Plaene gelesen werden -- erscheint in Hinweistexten. */
  einrichtung: "Federseeklinik Bad Buchau",

  /** Anbieter der Anwendung. */
  anbieter: {
    name: "FUGO Labs",
    adresse: "https://www.cameraorganizer.com",
    zweitprodukt: { name: "TaM²", adresse: "https://www.fugo-labs.de/tam2" },
  },

  /**
   * Schluessel des lokalen Speichers.
   *
   * Bewusst unveraendert gelassen: Wird er umbenannt, sind die auf den
   * Geraeten bereits gespeicherten Plaene nicht mehr auffindbar. Er ist
   * technisch und fuer Nutzer nie sichtbar.
   */
  speicherschluessel: "federsee.plan.v3",
};
