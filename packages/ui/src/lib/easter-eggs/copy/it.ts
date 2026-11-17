import type { EasterEggCopy } from './types';

export const copy: EasterEggCopy = {
  draftTitle: {
    everyday: [
      'A cosa lavoriamo in {project}?',
      'Cosa costruiamo oggi in {project}?',
      'Da dove partiamo in {project}?',
      'Bug o idea? In {project} vanno bene entrambi.',
      'Qual è il prossimo passo in {project}?',
    ],
    deepNight: [
      'Ancora sveglio? A cosa lavoriamo in {project}?',
      'Il turno di notte è iniziato. Cosa c’è in {project}?',
      'Dormono tutti, tranne noi e {project}.',
      'Anche i bug dormono. Li staniamo in {project}?',
      'Notte fonda, idee chiare. Cosa arriva dopo in {project}?',
      'Ore tranquille. Il momento giusto per {project}.',
    ],
    halloween: [
      'Cosa evochiamo oggi in {project}?',
      'Quali bug infestano {project}?',
    ],
    newYearsEve: ['Un’ultima cosa per {project} prima che l’anno finisca?'],
    newYearsDay: ['Cosa arriva per primo in {project} quest’anno?'],
  },
  gitClean: {
    everyday: [
      'Sospettosamente pulito.',
      'Niente da committare. Godiamoci la calma finché dura.',
      'Lucido come uno specchio. È ora di un po’ di caos.',
      'Dai, bastano un paio di prompt e le modifiche arrivano.',
      'Tutto committato. Pausa caffè ufficialmente concessa.',
    ],
    halloween: ['Niente da committare. Niente da temere.'],
    newYearsEve: ['Un albero pulito per chiudere l’anno.'],
    newYearsDay: ['Un inizio d’anno pulito.'],
  },
  push: {
    fridayEvening: [
      { title: 'Coraggioso.', description: 'Un push di venerdì sera. La leggenda dice che così si annullano i fine settimana.' },
      { title: 'Azzardato.', description: 'Un push di venerdì sera. Che il reperibile resti tranquillo.' },
      { title: 'Pushato dritto nel fine settimana.', description: 'Speriamo che non si perda per strada.' },
      { title: 'Push del venerdì accettato.', description: 'Il fine settimana è stato avvisato.' },
      { title: 'Push completato.', description: 'Di venerdì sera non tutti hanno questo coraggio.' },
    ],
    smallHours: [
      { title: 'Push alle {time}.', description: 'La pausa è più che meritata.' },
      { title: 'Push alle {time}.', description: 'I commit notturni hanno un fascino tutto loro.' },
      { title: 'Push alle {time}.', description: 'Una bella sorpresa per domani mattina.' },
      { title: 'Push notturno, {time}.', description: 'L’ora più tranquilla per le modifiche più coraggiose.' },
      { title: '{time}, push fatto.', description: 'Il codice è al sicuro. È il momento di respirare.' },
    ],
  },
  thinking: [
    'rimugina',
    'fissa il soffitto',
    'interroga l’anatra di gomma',
    'rimesta le idee',
    'spezza il nodo',
    'soppesa ogni token',
    'parla da solo',
    'covando un’idea',
    'cerca il filo',
    'si gratta la testa',
    'pensa di traverso',
    'fa bollire l’oceano',
  ],
  netDeletionCommit: [
    { title: { one: '{count} riga in pensione.', other: '{count} righe in pensione.' }, description: 'Hanno fatto il loro dovere.' },
    { title: { one: '−{count} riga.', other: '−{count} righe.' }, description: 'Il tipo di commit più raro.' },
    { title: { one: '{count} riga in meno.', other: '{count} righe in meno.' }, description: 'Nessuno dovrà più revisionarle.' },
    { title: { one: '{count} riga sparita.', other: '{count} righe sparite.' }, description: 'Facciamo finta che non siano mai esistite.' },
  ],
};
