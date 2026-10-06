import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

export const LANGUAGES = { en: 'English', it: 'Italiano' };
const DEFAULT_LANGUAGE = 'en';
const STORAGE_KEY = 'travel-planner-language';

const STRINGS = {
  en: {
    'app.title': 'Travel Planner',
    'app.tagline1': 'List the places you want to see.',
    'app.tagline2': 'Get the order that costs you the least travel.',
    'health.checking': 'checking backend…',
    'health.waking': 'waking the backend…',
    'health.online': 'backend online',
    'health.offline': 'backend offline',
    'language.switch': 'Switch language',

    'form.heading': 'Plan your trip',
    'form.city': 'Which city or region?',
    'form.cityPlaceholder': 'London',
    'form.citySet': 'Set',
    'form.cityChange': 'Change',
    'form.daysFewer': 'One day fewer',
    'form.daysMore': 'One day more',
    'place.addFailed': '“{name}” was not found here. Check the spelling, or try a fuller name.',
    'form.cityFirst': 'Confirm the city first — places are looked up inside it.',
    'place.resolving': 'checking…',
    'place.notFound': 'not found — try a longer or more specific name',
    'error.unresolved': 'Could not find: {names}. Fix or remove them.',
    'error.resolving': 'Still checking the places…',
    'form.places': 'Places to visit',
    'form.addPlace': 'Add a place, e.g. Tower Bridge',
    'form.add': 'Add',
    'form.addBatch': 'Paste a whole list instead',
    'form.clearPlaces': 'Clear all',
    'form.clearPlacesConfirm': 'Remove all {count} places?',
    'batch.title': 'Paste your list of places',
    'batch.help': 'One place per line. Bullets, dashes and numbering are stripped for you. Optionally add the stay and opening hours after a pipe: Colosseum | 1h30 | 9:00-19:00.',
    'batch.placeholder': '- Colosseum | 1h30 | 9:00-19:00\n- Trevi Fountain | 15m\n- Pantheon | 1h | 9-19',
    'batch.unreadable': 'Details not understood for {names}: use a stay like 45m or 1h30, and hours like 9:00-19:00. These stay in the box.',
    'batch.detected': '{count} places ready to add',
    'batch.detectedNone': 'Nothing detected yet',
    'batch.duplicates': '{count} already in your list',
    'batch.cancel': 'Cancel',
    'batch.add': 'Add {count} places',
    'batch.adding': 'Adding {done} of {total}…',
    'batch.someFailed': '{count} could not be found. They are left below — fix the names and try again.',

    'form.placesEmpty': 'Add at least two places to plan a route.',
    'form.moveUp': 'Move {name} up',
    'form.moveDown': 'Move {name} down',
    'form.remove': 'Remove {name}',
    'form.mode': 'How are you getting around?',
    'form.days': 'How many days?',
    'form.startAt': 'Start at',
    'form.finishAt': 'Finish at',
    'form.dayStart': 'Day {day} — start',
    'form.dayFinish': 'Day {day} — finish',
    'form.roundTrip': 'Round trip: you end where you started.',
    'form.roundTripDay': 'Day {day} is a round trip.',
    'form.startTime': 'Start time',
    'form.maxWalk': 'Longest stretch you will walk (km)',
    'form.maxCycle': 'Longest stretch you will cycle (km)',
    'form.submit': 'Plan my route',
    'form.submitting': 'Planning…',

    'mode.walking': 'On foot',
    'mode.bicycle': 'By bike',
    'mode.driving': 'By car',
    'mode.hint.walking': 'Stretches too far to walk are flagged.',
    'mode.hint.bicycle': 'Stretches too far to cycle are flagged.',

    'error.tooFarWalking': '“{first}” and “{second}” are {km} km apart — too far to cover on foot. Try by car, or plan them as separate trips.',
    'error.tooFarBicycle': '“{first}” and “{second}” are {km} km apart — too far to cover by bike. Try by car, or plan them as separate trips.',
    'error.tooFarDriving': '“{first}” and “{second}” are {km} km apart — too far for a single trip. Plan them separately.',
    'error.dayBudget':
      'Time at these places adds up to {needed_hours} h, which does not fit in {days} day(s) of {budget_hours} h — and that is before any travel. Allow at least {minimum_days} day(s), or shorten some visits.',
    'error.dayBudgetSolver':
      'Travel plus time at these places does not fit in {days} day(s) of {budget_hours} h. Add a day, or shorten some visits.',
    'error.hoursInvalid': '{name} closes no later than it opens — check its opening hours.',
    'error.closesBeforeStart':
      '{name} closes at {closes}, before the day starts at {start}. Start earlier or remove it.',
    'error.openingTooShort':
      '{name} is open for less than the {minutes} min you plan to spend there. Shorten the visit or check its opening hours.',
    'error.openingConflict':
      'No order fits every place within its opening hours in {days} day(s) of {budget_hours} h. Add a day, start earlier, or shorten some visits.',
    'error.city': 'Enter the city or region.',
    'error.places': 'Add at least two places.',
    'error.daysTooMany':
      'Not enough places for {days} days. Add more places or reduce the days.',

    'results.heading': 'Your route',
    'results.empty': 'Your optimized itinerary and its map will appear here.',
    'results.working': 'Resolving places and computing travel times…',
    'results.failed': 'Planning failed.',
    'results.stops': 'stops',
    'results.stopsLoop': 'stops · loop',
    'results.time': 'travel time',
    'results.distance': 'distance',
    'results.finish': 'finish by',
    'results.days': 'days',
    'results.day': 'Day {day}',
    'results.backTo': 'Back to {name}',
    'results.overLimitOne':
      '1 stretch exceeds your distance limit — its time assumes a car.',
    'results.overLimitMany':
      '{count} stretches exceed your distance limit — their times assume a car.',
    'results.stay': 'stay {duration}',
    'results.wait': 'wait {duration} for opening',
    'results.visits': 'at places',
    'form.visitTime': 'Time at {name}',
    'form.hours': 'Open',
    'form.opensAt': '{name} opens at',
    'form.closesAt': '{name} closes at',
    'form.visitTimeHint':
      'Time at each place, next to its name — 45m, 1h30, 2h. Start and end places count too: set 0 for one you only set off from. Opening hours are optional — leave them empty for a place that is always open. Travel plus visits is capped at 16 h a day.',

    'map.caption':
      'Lines show the visit order as straight connections, not the actual streets taken. Red dashes mark stretches too far to walk or cycle.',
    'map.startFinish': 'start and finish',

    'note.too_far_to_walk':
      'Too far to walk: take public transport or a car',
    'note.too_far_to_cycle':
      'Too far to cycle: take public transport or a car',
    'note.too_far_to_walk_or_cycle':
      'Too far to walk or cycle: take public transport or a car',
    'note.too_far_for_selected_mode':
      'Too far for the selected mode: take public transport or a car',

    'export.button': 'Export Markdown',
    'export.heading': 'Itinerary — {area}',
    'export.headingNoArea': 'Itinerary',
    'export.failed': 'Could not save the file.',

    'pdf.button': 'Export PDF',
    'pdf.generating': 'Preparing…',
    'pdf.generated': 'Generated {date}',
    'pdf.mapCredit': '© OpenStreetMap contributors',
    'pdf.continued': '(continued)',
    'pdf.page': 'Page {page} of {total}',
  },

  it: {
    'app.title': 'Pianificatore di viaggi',
    'app.tagline1': 'Elenca i luoghi che vuoi vedere.',
    'app.tagline2': 'Ottieni l’ordine che ti fa viaggiare di meno.',
    'health.checking': 'verifica del backend…',
    'health.waking': 'riattivazione del backend…',
    'health.online': 'backend attivo',
    'health.offline': 'backend non raggiungibile',
    'language.switch': 'Cambia lingua',

    'form.heading': 'Organizza il viaggio',
    'form.city': 'In quale città o regione?',
    'form.cityPlaceholder': 'Roma',
    'form.citySet': 'Conferma',
    'form.cityChange': 'Modifica',
    'form.daysFewer': 'Un giorno in meno',
    'form.daysMore': 'Un giorno in più',
    'place.addFailed': '“{name}” non è stato trovato qui. Controlla come l’hai scritto, o prova un nome più completo.',
    'form.cityFirst': 'Conferma prima la città: i luoghi vengono cercati al suo interno.',
    'place.resolving': 'verifica…',
    'place.notFound': 'non trovato — prova un nome più lungo o più preciso',
    'error.unresolved': 'Non trovati: {names}. Correggili o rimuovili.',
    'error.resolving': 'Verifica dei luoghi in corso…',
    'form.places': 'Luoghi da visitare',
    'form.addPlace': 'Aggiungi un luogo, es. Fontana di Trevi',
    'form.add': 'Aggiungi',
    'form.addBatch': 'Incolla un elenco intero',
    'form.clearPlaces': 'Svuota elenco',
    'form.clearPlacesConfirm': 'Rimuovere tutti i {count} luoghi?',
    'batch.title': 'Incolla il tuo elenco di luoghi',
    'batch.help': 'Un luogo per riga. Trattini, punti elenco e numerazione vengono rimossi in automatico. Se vuoi, aggiungi sosta e orari dopo una barra verticale: Colosseo | 1h30 | 9:00-19:00.',
    'batch.placeholder': '- Colosseo | 1h30 | 9:00-19:00\n- Fontana di Trevi | 15m\n- Pantheon | 1h | 9-19',
    'batch.unreadable': 'Dettagli non riconosciuti per {names}: usa una sosta come 45m o 1h30 e orari come 9:00-19:00. Restano nel riquadro.',
    'batch.detected': '{count} luoghi pronti da aggiungere',
    'batch.detectedNone': 'Nessun luogo rilevato',
    'batch.duplicates': '{count} già nella tua lista',
    'batch.cancel': 'Annulla',
    'batch.add': 'Aggiungi {count} luoghi',
    'batch.adding': 'Aggiunta {done} di {total}…',
    'batch.someFailed': '{count} non sono stati trovati. Sono rimasti qui sotto: correggi i nomi e riprova.',

    'form.placesEmpty': 'Aggiungi almeno due luoghi per calcolare il percorso.',
    'form.moveUp': 'Sposta {name} su',
    'form.moveDown': 'Sposta {name} giù',
    'form.remove': 'Rimuovi {name}',
    'form.mode': 'Come ti sposti?',
    'form.days': 'Quanti giorni?',
    'form.startAt': 'Parti da',
    'form.finishAt': 'Arrivi a',
    'form.dayStart': 'Giorno {day} — partenza',
    'form.dayFinish': 'Giorno {day} — arrivo',
    'form.roundTrip': 'Percorso ad anello: torni al punto di partenza.',
    'form.roundTripDay': 'Il giorno {day} è un anello.',
    'form.startTime': 'Ora di partenza',
    'form.maxWalk': 'Tratta più lunga che percorri a piedi (km)',
    'form.maxCycle': 'Tratta più lunga che percorri in bici (km)',
    'form.submit': 'Calcola il percorso',
    'form.submitting': 'Calcolo in corso…',

    'mode.walking': 'A piedi',
    'mode.bicycle': 'In bici',
    'mode.driving': 'In auto',
    'mode.hint.walking': 'Le tratte troppo lunghe per andare a piedi vengono segnalate.',
    'mode.hint.bicycle': 'Le tratte troppo lunghe per la bici vengono segnalate.',

    'error.tooFarWalking': '“{first}” e “{second}” distano {km} km: troppo per andarci a piedi. Prova in auto, oppure pianificali come viaggi separati.',
    'error.tooFarBicycle': '“{first}” e “{second}” distano {km} km: troppo per andarci in bici. Prova in auto, oppure pianificali come viaggi separati.',
    'error.tooFarDriving': '“{first}” e “{second}” distano {km} km: troppo per un unico viaggio. Pianificali separatamente.',
    'error.dayBudget':
      'Le soste nei luoghi sommano {needed_hours} h e non entrano in {days} giorno/i da {budget_hours} h, senza contare gli spostamenti. Serve almeno {minimum_days} giorno/i, oppure accorcia qualche sosta.',
    'error.dayBudgetSolver':
      'Spostamenti e soste non entrano in {days} giorno/i da {budget_hours} h. Aggiungi un giorno oppure accorcia qualche sosta.',
    'error.hoursInvalid': '{name} chiude prima di aprire: controlla i suoi orari.',
    'error.closesBeforeStart':
      '{name} chiude alle {closes}, prima dell’inizio della giornata alle {start}. Parti prima oppure rimuovilo.',
    'error.openingTooShort':
      '{name} resta aperto meno dei {minutes} min di sosta previsti. Accorcia la sosta o controlla gli orari.',
    'error.openingConflict':
      'Nessun ordine rispetta gli orari di apertura di tutti i luoghi in {days} giorno/i da {budget_hours} h. Aggiungi un giorno, parti prima oppure accorcia qualche sosta.',
    'error.city': 'Inserisci la città o la regione.',
    'error.places': 'Aggiungi almeno due luoghi.',
    'error.daysTooMany':
      'Luoghi insufficienti per {days} giorni. Aggiungi luoghi o riduci i giorni.',

    'results.heading': 'Il tuo percorso',
    'results.empty': 'Qui compariranno l’itinerario ottimizzato e la sua mappa.',
    'results.working': 'Risoluzione dei luoghi e calcolo dei tempi…',
    'results.failed': 'Calcolo non riuscito.',
    'results.stops': 'tappe',
    'results.stopsLoop': 'tappe · anello',
    'results.time': 'tempo di viaggio',
    'results.distance': 'distanza',
    'results.finish': 'arrivo entro',
    'results.days': 'giorni',
    'results.day': 'Giorno {day}',
    'results.backTo': 'Ritorno a {name}',
    'results.overLimitOne':
      '1 tratta supera il tuo limite di distanza: il tempo indicato è quello in auto.',
    'results.overLimitMany':
      '{count} tratte superano il tuo limite di distanza: i tempi indicati sono quelli in auto.',
    'results.stay': 'sosta {duration}',
    'results.wait': 'attesa apertura {duration}',
    'results.visits': 'nei luoghi',
    'form.visitTime': 'Tempo a {name}',
    'form.hours': 'Aperto',
    'form.opensAt': 'Apertura di {name}',
    'form.closesAt': 'Chiusura di {name}',
    'form.visitTimeHint':
      'Tempo in ogni luogo, accanto al nome — 45m, 1h30, 2h. Contano anche partenza e arrivo: metti 0 per un luogo da cui parti soltanto. Gli orari di apertura sono facoltativi: lasciali vuoti se il luogo è sempre aperto. Spostamenti e soste insieme non superano le 16 h al giorno.',

    'map.caption':
      'Le linee mostrano l’ordine di visita come collegamenti diretti, non le strade reali. I tratteggi rossi segnano le tratte troppo lunghe per piedi o bici.',
    'map.startFinish': 'partenza e arrivo',

    'note.too_far_to_walk':
      'Troppo lontano a piedi: prendi i mezzi pubblici o l’auto',
    'note.too_far_to_cycle':
      'Troppo lontano in bici: prendi i mezzi pubblici o l’auto',
    'note.too_far_to_walk_or_cycle':
      'Troppo lontano a piedi o in bici: prendi i mezzi pubblici o l’auto',
    'note.too_far_for_selected_mode':
      'Troppo lontano per il mezzo scelto: prendi i mezzi pubblici o l’auto',

    'export.button': 'Esporta Markdown',
    'export.heading': 'Itinerario — {area}',
    'export.headingNoArea': 'Itinerario',
    'export.failed': 'Impossibile salvare il file.',

    'pdf.button': 'Esporta PDF',
    'pdf.generating': 'Preparazione…',
    'pdf.generated': 'Generato il {date}',
    'pdf.mapCredit': '© OpenStreetMap contributors',
    'pdf.continued': '(segue)',
    'pdf.page': 'Pagina {page} di {total}',
  },
};

const I18nContext = createContext(null);

function readStoredLanguage() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored in LANGUAGES ? stored : DEFAULT_LANGUAGE;
  } catch {
    // Private browsing and blocked storage should not break the app.
    return DEFAULT_LANGUAGE;
  }
}

export function I18nProvider({ children }) {
  const [language, setLanguageState] = useState(readStoredLanguage);

  const setLanguage = useCallback((next) => {
    setLanguageState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Preference is lost on reload, which is better than crashing.
    }
  }, []);

  const t = useCallback(
    (key, params) => {
      const template = STRINGS[language][key] ?? STRINGS[DEFAULT_LANGUAGE][key];
      if (template === undefined) return key;
      if (!params) return template;
      return Object.entries(params).reduce(
        (text, [name, value]) => text.replaceAll(`{${name}}`, value),
        template
      );
    },
    [language]
  );

  const value = useMemo(
    () => ({ language, setLanguage, t }),
    [language, setLanguage, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside an I18nProvider');
  return context;
}
