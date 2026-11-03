import type { EasterEggCopy } from './types';

// The commit counts that get a line start at ten, so the zero, one and two
// plural forms never show and are left out.
export const copy: EasterEggCopy = {
  draftTitle: {
    everyday: [
      'على ماذا نعمل في {project}؟',
      'ما الخطوة التالية في {project}؟',
      'ماذا نبني اليوم في {project}؟',
      'خطأ أم فكرة؟ كلاهما مرحب به في {project}.',
      'من أين نبدأ في {project}؟',
    ],
    deepNight: [
      'ما زلنا مستيقظين؟ على ماذا نعمل في {project}؟',
      'بدأت النوبة الليلية. ماذا لدينا في {project}؟',
      'الجميع نائمون، إلا نحن و{project}.',
      'الأخطاء نائمة أيضًا. هل نصطادها في {project}؟',
      'ليل متأخر وذهن صافٍ. ما التالي في {project}؟',
      'ساعات هادئة. وقت مناسب لـ{project}.',
    ],
    halloween: [
      'ماذا نستحضر اليوم في {project}؟',
      'أي أخطاء تطارد {project}؟',
    ],
    newYearsEve: ['شيء أخير في {project} قبل نهاية العام؟'],
    newYearsDay: ['ما أول شيء في {project} هذا العام؟'],
  },
  gitClean: {
    everyday: [
      'نظيف بشكل مريب.',
      'لا شيء للإيداع. لنستمتع بالهدوء ما دام.',
      'لامع تمامًا. حان وقت بعض الفوضى.',
      'هيا، بضع مطالبات وستظهر التغييرات.',
      'كل شيء مودَع. استراحة القهوة مسموحة رسميًا.',
    ],
    halloween: ['لا شيء للإيداع. ولا شيء يُخيف.'],
    newYearsEve: ['شجرة نظيفة لختام العام.'],
    newYearsDay: ['بداية نظيفة للعام.'],
  },
  push: {
    // Friday evening is already the weekend in much of the Arabic-speaking world.
    fridayEvening: [],
    smallHours: [
      { title: 'تم الدفع في {time}.', description: 'الراحة مستحقة تمامًا.' },
      { title: 'تم الدفع في {time}.', description: 'لعمليات الإيداع الليلية سحرها الخاص.' },
      { title: 'تم الدفع في {time}.', description: 'مفاجأة لطيفة للصباح.' },
      { title: 'دفع ليلي، {time}.', description: 'أهدأ ساعة لأجرأ التغييرات.' },
      { title: '{time}، تم الدفع.', description: 'الشيفرة في أمان. يمكن التقاط الأنفاس الآن.' },
    ],
  },
  thinking: [
    'يحدق في السقف',
    'يستشير البطة المطاطية',
    'يزن كل كلمة',
    'يحدث نفسه',
    'يطبخ فكرة على نار هادئة',
    'يحك رأسه',
    'يفتش في أدراج الذاكرة',
    'يبحث عن طرف الخيط',
    'يقلب الفكرة على كل وجه',
    'يعقد اجتماعا مع أفكاره',
    'يفكر إن كان يبالغ في التفكير',
    'يغلي محيطا كاملا',
  ],
  netDeletionCommit: [
    { title: { few: 'تقاعدت {count} أسطر.', many: 'تقاعد {count} سطرًا.', other: 'تقاعد {count} سطر.' }, description: 'لقد أدّت عملها جيدًا.' },
    { title: { few: '−{count} أسطر.', many: '−{count} سطرًا.', other: '−{count} سطر.' }, description: 'أندر أنواع الإيداعات.' },
    { title: { few: 'أخف بـ {count} أسطر.', many: 'أخف بـ {count} سطرًا.', other: 'أخف بـ {count} سطر.' }, description: 'لن يضطر أحد إلى مراجعتها بعد اليوم.' },
    { title: { few: 'اختفت {count} أسطر.', many: 'اختفى {count} سطرًا.', other: 'اختفى {count} سطر.' }, description: 'لنتظاهر بأنها لم توجد قط.' },
  ],
};
