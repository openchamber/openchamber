import type { EasterEggCopy } from './types';

export const copy: EasterEggCopy = {
  draftTitle: {
    everyday: [
      'Waar werken we aan in {project}?',
      'Wat is de volgende stap voor {project}?',
      'Wat bouwen we vandaag in {project}?',
      'Bug of idee? Allebei prima in {project}.',
      'Waar beginnen we in {project}?',
    ],
    deepNight: [
      'Nog wakker? Waar werken we aan in {project}?',
      'De nachtdienst is begonnen. Wat staat er in {project}?',
      'Iedereen slaapt, behalve wij en {project}.',
      'Bugs slapen ook. Vangen we ze in {project}?',
      'Late nacht, helder hoofd. Wat is de volgende stap in {project}?',
      'Stille uren. Een goed moment voor {project}.',
    ],
    halloween: [
      'Wat roepen we vandaag op in {project}?',
      'Welke bugs spoken er rond in {project}?',
    ],
    newYearsEve: ['Nog één ding voor {project} voordat het jaar om is?'],
    newYearsDay: ['Wat komt er dit jaar als eerste in {project}?'],
  },
  gitClean: {
    everyday: [
      'Verdacht schoon.',
      'Niets te committen. Genieten we van de rust zolang die duurt.',
      'Brandschoon. Tijd voor wat rommel.',
      'Ga je gang, met een paar prompts komen de wijzigingen vanzelf.',
      'Alles gecommit. Koffiepauze officieel toegestaan.',
    ],
    halloween: ['Niets te committen. Niets te vrezen.'],
    newYearsEve: ['Een schone boom om het jaar mee af te sluiten.'],
    newYearsDay: ['Een schone start van het jaar.'],
  },
  push: {
    fridayEvening: [
      { title: 'Moedig.', description: 'Een push op vrijdagavond. Volgens de legende worden zo weekenden geannuleerd.' },
      { title: 'Gewaagd.', description: 'Een push op vrijdagavond. Moge de dienstdoende rustig blijven.' },
      { title: 'Zo het weekend in gepusht.', description: 'Hopelijk komt hij er niet achteraan.' },
      { title: 'Vrijdagpush geaccepteerd.', description: 'Het weekend is op de hoogte gebracht.' },
      { title: 'Gepusht.', description: 'Niet iedereen durft dit op vrijdagavond.' },
    ],
    smallHours: [
      { title: 'Gepusht om {time}.', description: 'De rust is welverdiend.' },
      { title: 'Gepusht om {time}.', description: 'Nachtelijke commits hebben hun eigen charme.' },
      { title: 'Gepusht om {time}.', description: 'Een leuke verrassing voor morgenochtend.' },
      { title: 'Nachtpush, {time}.', description: 'Het stilste uur voor de gedurfdste wijzigingen.' },
      { title: '{time}, gepusht.', description: 'De code is veilig. Even uitademen.' },
    ],
  },
  thinking: [
    'kraakt de hersens',
    'staart naar het plafond',
    'overlegt met het badeendje',
    'broedt op een idee',
    'weegt elk token',
    'praat in zichzelf',
    'zoekt de rode draad',
    'krabt zich achter de oren',
    'laat het even bezinken',
    'zet de gedachten op een rij',
    'denkt nog een rondje',
    'kookt de oceaan',
  ],
  netDeletionCommit: [
    { title: { one: '{count} regel met pensioen.', other: '{count} regels met pensioen.' }, description: 'Ze hebben goed gediend.' },
    { title: { one: '−{count} regel.', other: '−{count} regels.' }, description: 'De zeldzaamste soort commit.' },
    { title: { one: '{count} regel lichter.', other: '{count} regels lichter.' }, description: 'Niemand hoeft die ooit nog te reviewen.' },
    { title: { one: '{count} regel weg.', other: '{count} regels weg.' }, description: 'Laten we doen alsof ze nooit hebben bestaan.' },
  ],
};
