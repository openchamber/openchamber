import type { EasterEggCopy } from './types';

export const copy: EasterEggCopy = {
  draftTitle: {
    everyday: [
      'Woran arbeiten wir in {project}?',
      'Was steht als Nächstes in {project} an?',
      'Was bauen wir heute in {project}?',
      'Bug oder Idee? In {project} geht beides.',
      'Wo fangen wir in {project} an?',
    ],
    deepNight: [
      'Noch wach? Woran arbeiten wir in {project}?',
      'Die Nachtschicht hat begonnen. Was steht in {project} an?',
      'Alle schlafen, außer uns und {project}.',
      'Auch Bugs schlafen. Fangen wir sie in {project}?',
      'Späte Nacht, klarer Kopf. Was kommt als Nächstes in {project}?',
      'Ruhige Stunden. Genau die richtige Zeit für {project}.',
    ],
    halloween: [
      'Was beschwören wir heute in {project}?',
      'Welche Bugs spuken in {project} herum?',
    ],
    newYearsEve: ['Noch eine Sache für {project}, bevor das Jahr endet?'],
    newYearsDay: ['Was kommt dieses Jahr in {project} zuerst?'],
  },
  gitClean: {
    everyday: [
      'Verdächtig sauber.',
      'Nichts zu committen. Genießen wir die Ruhe, solange sie hält.',
      'Blitzblank. Zeit für etwas Chaos.',
      'Nur zu, ein paar Prompts und die Änderungen kommen.',
      'Alles committet. Kaffeepause offiziell genehmigt.',
    ],
    halloween: ['Nichts zu committen. Nichts zu fürchten.'],
    newYearsEve: ['Ein sauberer Baum zum Jahresende.'],
    newYearsDay: ['Ein sauberer Start ins Jahr.'],
  },
  push: {
    fridayEvening: [
      { title: 'Mutig.', description: 'Ein Push am Freitagabend. Der Legende nach werden so Wochenenden abgesagt.' },
      { title: 'Gewagt.', description: 'Ein Push am Freitagabend. Möge die Rufbereitschaft ruhig bleiben.' },
      { title: 'Direkt ins Wochenende gepusht.', description: 'Hoffentlich kommt er nicht hinterher.' },
      { title: 'Freitags-Push angenommen.', description: 'Das Wochenende wurde benachrichtigt.' },
      { title: 'Gepusht.', description: 'Am Freitagabend trauen sich das nicht alle.' },
    ],
    smallHours: [
      { title: 'Gepusht um {time}.', description: 'Die Pause ist mehr als verdient.' },
      { title: 'Gepusht um {time}.', description: 'Nächtliche Commits haben ihren eigenen Charme.' },
      { title: 'Gepusht um {time}.', description: 'Eine nette Überraschung für morgen früh.' },
      { title: 'Nacht-Push, {time}.', description: 'Die ruhigste Stunde für die mutigsten Änderungen.' },
      { title: '{time}, gepusht.', description: 'Der Code ist in Sicherheit. Zeit durchzuatmen.' },
    ],
  },
  thinking: [
    'grübelt vor sich hin',
    'starrt an die Decke',
    'fragt die Gummiente',
    'wälzt Gedanken',
    'knackt die Kopfnuss',
    'wiegt jedes Token ab',
    'führt Selbstgespräche',
    'brütet über einer Idee',
    'sucht den roten Faden',
    'kratzt sich am Kopf',
    'denkt um drei Ecken',
    'kocht den Ozean auf',
  ],
  netDeletionCommit: [
    { title: { one: '{count} Zeile in Rente.', other: '{count} Zeilen in Rente.' }, description: 'Sie haben gute Dienste geleistet.' },
    { title: { one: '−{count} Zeile.', other: '−{count} Zeilen.' }, description: 'Die seltenste Art von Commit.' },
    { title: { one: '{count} Zeile leichter.', other: '{count} Zeilen leichter.' }, description: 'Die muss nie wieder jemand reviewen.' },
    { title: { one: '{count} Zeile weg.', other: '{count} Zeilen weg.' }, description: 'Tun wir so, als hätte es sie nie gegeben.' },
  ],
};
