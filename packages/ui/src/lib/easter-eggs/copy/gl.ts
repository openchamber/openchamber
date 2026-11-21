import type { EasterEggCopy } from './types';

export const copy: EasterEggCopy = {
  draftTitle: {
    everyday: [
      'En que traballamos en {project}?',
      'Que vén agora para {project}?',
      'Que construímos hoxe en {project}?',
      'Erro ou idea? En {project} vale calquera.',
      'Por onde empezamos en {project}?',
    ],
    deepNight: [
      'Aínda en pé? En que traballamos en {project}?',
      'A quenda de noite está aberta. Que hai en {project}?',
      'Todo o mundo dorme agás nós e {project}.',
      'Os erros tamén dormen. Cazámolos en {project}?',
      'Noite pecha, mente despexada. Que é o seguinte en {project}?',
      'Horas tranquilas. Bo momento para {project}.',
    ],
    halloween: [
      'Que invocamos hoxe en {project}?',
      'Que erros andan a asombrar en {project}?',
    ],
    newYearsEve: ['Unha cousa máis para {project} antes de que remate o ano?'],
    newYearsDay: ['Que vai ser o primeiro para {project} este ano?'],
  },
  gitClean: {
    everyday: [
      'Sospeitosamente limpo.',
      'Nada que confirmar en commits. Disfrutemos da calma mentres dure.',
      'Impecable. Hora de desordenar un pouco.',
      'Adiante, con algúns prompts chegarán os cambios.',
      'Todo gardado en commits. A pausa do café queda oficialmente concedida.',
    ],
    halloween: ['Nada que facer commit. Nada que temer.'],
    newYearsEve: ['Unha árbore limpa para rematar o ano.'],
    newYearsDay: ['Un comezo limpo para o aninovo.'],
  },
  push: {
    fridayEvening: [
      { title: 'Valente.', description: 'Un push un venres á noitiña. Conta a lenda que así se cancelan as fins de semana.' },
      { title: 'Xogada audaz.', description: 'Enviar cambios un venres á tarde. Que as gardas teñan unha noite tranquila.' },
      { title: 'Push directo á fin de semana.', description: 'Agardemos que non veña detrás de ti.' },
      { title: 'Push de venres aceptado.', description: 'A fin de semana xa foi avisada.' },
      { title: 'Push feito.', description: 'Non calquera se atreve un venres á noite.' },
    ],
    smallHours: [
      { title: 'Push feito ás {time}.', description: 'O descanso está ben merecido.' },
      { title: 'Push feito ás {time}.', description: 'Os commits nocturnos teñen un encanto propio.' },
      { title: 'Push feito ás {time}.', description: 'Unha boa sorpresa para a mañá.' },
      { title: 'Push nocturno, {time}.', description: 'A hora máis tranquila para os cambios máis atrevidos.' },
      { title: '{time}, push feito.', description: 'O código está a salvo. Xa se pode respirar fondo.' },
    ],
  },
  thinking: [
    'dándolle voltas ao asunto',
    'mirando para o teito',
    'consultando co parrulo de goma',
    'estrusando as neuronas',
    'pesando cada token',
    'falando consigo mesmo',
    'cociñando unha idea a lume manso',
    'buscando tres pés ao gato',
    'coçando a cabeza',
    'buscando o fío da meada',
    'pensando ata nas comas',
    'aquecendo os motores',
  ],
  netDeletionCommit: [
    { title: { one: '{count} liña xubilada.', other: '{count} liñas xubiladas.' }, description: 'Cumpriron ben co seu servizo.' },
    { title: { one: '−{count} liña.', other: '−{count} liñas.' }, description: 'A clase máis estraña de commit.' },
    { title: { one: '{count} liña máis lixeiro.', other: '{count} liñas máis lixeiro.' }, description: 'Ninguén terá que revisar esas liñas nunca máis.' },
    { title: { one: '{count} liña menos.', other: '{count} liñas menos.' }, description: 'Fagamos como se nunca existisen.' },
  ],
};
