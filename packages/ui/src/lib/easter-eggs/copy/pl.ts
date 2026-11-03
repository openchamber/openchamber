import type { EasterEggCopy } from './types';

export const copy: EasterEggCopy = {
  draftTitle: {
    everyday: [
      'Nad czym pracujemy w {project}?',
      'Co dalej w {project}?',
      'Co dziś budujemy w {project}?',
      'Bug czy pomysł? W {project} oba się przydadzą.',
      'Od czego zaczynamy w {project}?',
    ],
    deepNight: [
      'Jeszcze nie śpimy? Nad czym pracujemy w {project}?',
      'Nocna zmiana rozpoczęta. Co słychać w {project}?',
      'Wszyscy śpią, oprócz nas i {project}.',
      'Bugi też śpią. Złapiemy je w {project}?',
      'Późna noc, jasny umysł. Co dalej w {project}?',
      'Ciche godziny. Dobry czas na {project}.',
    ],
    halloween: [
      'Co dziś przywołujemy w {project}?',
      'Jakie bugi straszą w {project}?',
    ],
    newYearsEve: ['Jeszcze jedna rzecz w {project} przed końcem roku?'],
    newYearsDay: ['Od czego {project} zaczyna ten rok?'],
  },
  gitClean: {
    everyday: [
      'Podejrzanie czysto.',
      'Nic do commitowania. Cieszmy się ciszą, póki trwa.',
      'Lśni czystością. Czas trochę nabałaganić.',
      'Śmiało, kilka promptów i zmiany się pojawią.',
      'Wszystko zacommitowane. Przerwa na kawę oficjalnie dozwolona.',
    ],
    halloween: ['Nic do commitowania. Nie ma się czego bać.'],
    newYearsEve: ['Czyste drzewo na koniec roku.'],
    newYearsDay: ['Czysty start w nowy rok.'],
  },
  push: {
    fridayEvening: [
      { title: 'Odważnie.', description: 'Push w piątkowy wieczór. Legenda głosi, że tak właśnie przepadają weekendy.' },
      { title: 'Śmiały ruch.', description: 'Push w piątkowy wieczór. Oby dyżurny miał spokojną noc.' },
      { title: 'Wypchnięte prosto w weekend.', description: 'Oby nie przyszło tam za nami.' },
      { title: 'Piątkowy push przyjęty.', description: 'Weekend został powiadomiony.' },
      { title: 'Wypchnięte.', description: 'Nie każdy odważy się na to w piątkowy wieczór.' },
    ],
    smallHours: [
      { title: 'Wypchnięto o {time}.', description: 'Odpoczynek w pełni zasłużony.' },
      { title: 'Wypchnięto o {time}.', description: 'Nocne commity mają swój urok.' },
      { title: 'Wypchnięto o {time}.', description: 'Miła niespodzianka na rano.' },
      { title: 'Nocny push, {time}.', description: 'Najcichsza godzina na najodważniejsze zmiany.' },
      { title: '{time}, wypchnięte.', description: 'Kod jest bezpieczny. Można odetchnąć.' },
    ],
  },
  thinking: [
    'główkuje',
    'patrzy w sufit',
    'radzi się gumowej kaczuszki',
    'waży każdy token',
    'rozmawia ze sobą',
    'szuka dziury w całym',
    'drapie się po głowie',
    'dzieli włos na czworo',
    'miesza w kotle pomysłów',
    'szuka końca nitki',
    'myśli, czy za dużo nie myśli',
    'gotuje ocean',
  ],
  netDeletionCommit: [
    {
      title: { one: '{count} linia na emeryturze.', few: '{count} linie na emeryturze.', many: '{count} linii na emeryturze.', other: '{count} linii na emeryturze.' },
      description: 'Dobrze się spisały.',
    },
    {
      title: { one: '−{count} linia.', few: '−{count} linie.', many: '−{count} linii.', other: '−{count} linii.' },
      description: 'Najrzadszy rodzaj commita.',
    },
    {
      title: { one: 'Lżej o {count} linię.', few: 'Lżej o {count} linie.', many: 'Lżej o {count} linii.', other: 'Lżej o {count} linii.' },
      description: 'Nikt już nigdy nie będzie musiał ich przeglądać.',
    },
    {
      title: { one: '{count} linia zniknęła.', few: '{count} linie zniknęły.', many: '{count} linii zniknęło.', other: '{count} linii zniknęło.' },
      description: 'Udawajmy, że nigdy ich nie było.',
    },
  ],
};
