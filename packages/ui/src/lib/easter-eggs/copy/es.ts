import type { EasterEggCopy } from './types';

export const copy: EasterEggCopy = {
  draftTitle: {
    everyday: [
      '¿En qué trabajamos en {project}?',
      '¿Qué sigue para {project}?',
      '¿Qué construimos hoy en {project}?',
      '¿Bug o idea? En {project} vale cualquiera.',
      '¿Por dónde empezamos en {project}?',
    ],
    deepNight: [
      '¿Aún en pie? ¿En qué trabajamos en {project}?',
      'El turno de noche está abierto. ¿Qué hay en {project}?',
      'Todos duermen, menos nosotros y {project}.',
      'Los bugs también duermen. ¿Los cazamos en {project}?',
      'Noche avanzada, mente clara. ¿Qué sigue en {project}?',
      'Horas tranquilas. Buen momento para {project}.',
    ],
    halloween: [
      '¿Qué invocamos hoy en {project}?',
      '¿Qué bugs tienen embrujado {project}?',
    ],
    newYearsEve: ['¿Una cosa más para {project} antes de que acabe el año?'],
    newYearsDay: ['¿Qué va primero en {project} este año?'],
  },
  gitClean: {
    everyday: [
      'Sospechosamente limpio.',
      'Nada que commitear. Disfrutemos de la calma mientras dure.',
      'Impecable. Hora de desordenar un poco.',
      'Adelante, con unos cuantos prompts llegarán los cambios.',
      'Todo commiteado. La pausa para el café queda oficialmente autorizada.',
    ],
    halloween: ['Nada que commitear. Nada que temer.'],
    newYearsEve: ['Un árbol limpio para cerrar el año.'],
    newYearsDay: ['Un comienzo limpio para el año.'],
  },
  push: {
    fridayEvening: [
      { title: 'Valiente.', description: 'Un push un viernes por la tarde. Cuenta la leyenda que así se cancelan los fines de semana.' },
      { title: 'Jugada audaz.', description: 'Un push un viernes por la tarde. Que la guardia tenga una noche tranquila.' },
      { title: 'Push directo al fin de semana.', description: 'Ojalá no venga detrás.' },
      { title: 'Push de viernes aceptado.', description: 'El fin de semana ya ha sido avisado.' },
      { title: 'Push hecho.', description: 'No todos se atreven un viernes por la tarde.' },
    ],
    smallHours: [
      { title: 'Push hecho a las {time}.', description: 'El descanso está más que merecido.' },
      { title: 'Push hecho a las {time}.', description: 'Los commits nocturnos tienen su encanto.' },
      { title: 'Push hecho a las {time}.', description: 'Una bonita sorpresa para la mañana.' },
      { title: 'Push nocturno, {time}.', description: 'La hora más tranquila para los cambios más audaces.' },
      { title: '{time}, push hecho.', description: 'El código está a salvo. Ya se puede respirar.' },
    ],
  },
  thinking: [
    'le da vueltas al asunto',
    'mira al techo',
    'consulta al patito de goma',
    'se estruja las neuronas',
    'pesa cada token',
    'habla consigo mismo',
    'cocina una idea a fuego lento',
    'busca los tres pies al gato',
    'se rasca la cabeza',
    'busca el hilo de la madeja',
    'piensa hasta en las comas',
    'hierve el océano',
  ],
  netDeletionCommit: [
    { title: { one: '{count} línea jubilada.', other: '{count} líneas jubiladas.' }, description: 'Cumplieron bien su trabajo.' },
    { title: { one: '−{count} línea.', other: '−{count} líneas.' }, description: 'El tipo de commit más raro.' },
    { title: { one: '{count} línea menos.', other: '{count} líneas menos.' }, description: 'Nadie tendrá que revisarlas nunca más.' },
    { title: { one: '{count} línea fuera.', other: '{count} líneas fuera.' }, description: 'Hagamos como si nunca hubieran existido.' },
  ],
};
