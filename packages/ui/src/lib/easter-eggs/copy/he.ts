import type { EasterEggCopy } from './types';

export const copy: EasterEggCopy = {
  draftTitle: {
    everyday: [
      'על מה עובדים ב-{project}?',
      'מה הצעד הבא ב-{project}?',
      'מה בונים היום ב-{project}?',
      'באג או רעיון? ב-{project} שניהם בסדר.',
      'מאיפה מתחילים ב-{project}?',
    ],
    deepNight: [
      'עדיין ערים? על מה עובדים ב-{project}?',
      'משמרת הלילה התחילה. מה יש ב-{project}?',
      'כולם ישנים, חוץ מאיתנו ומ-{project}.',
      'גם באגים ישנים. נתפוס אותם ב-{project}?',
      'לילה מאוחר, ראש צלול. מה הלאה ב-{project}?',
      'שעות שקטות. זמן טוב ל-{project}.',
    ],
    halloween: [
      'את מי מזמנים היום ב-{project}?',
      'אילו באגים רודפים את {project}?',
    ],
    newYearsEve: ['עוד דבר אחד ב-{project} לפני שהשנה נגמרת?'],
    newYearsDay: ['מה ראשון ב-{project} השנה?'],
  },
  gitClean: {
    everyday: [
      'נקי באופן חשוד.',
      'אין שינויים ל-commit. נהנים מהשקט כל עוד הוא נמשך.',
      'מבריק. הגיע הזמן לבלגן קצת.',
      'קדימה, כמה פרומפטים והשינויים יגיעו.',
      'הכול בוצע commit. הפסקת קפה מאושרת רשמית.',
    ],
    halloween: ['אין שינויים ל-commit. אין ממה לפחד.'],
    newYearsEve: ['עץ נקי לסיום השנה.'],
    newYearsDay: ['התחלה נקייה לשנה.'],
  },
  push: {
    // Friday evening is already Shabbat.
    fridayEvening: [],
    smallHours: [
      { title: 'נדחף ב-{time}.', description: 'המנוחה מגיעה בצדק.' },
      { title: 'נדחף ב-{time}.', description: 'לקומיטים של לילה יש קסם משלהם.' },
      { title: 'נדחף ב-{time}.', description: 'הפתעה נעימה לבוקר.' },
      { title: 'דחיפת לילה, {time}.', description: 'השעה השקטה ביותר לשינויים הנועזים ביותר.' },
      { title: '{time}, נדחף.', description: 'הקוד בטוח. אפשר לנשום.' },
    ],
  },
  thinking: [
    'בוהה בתקרה',
    'מתייעץ עם ברווז גומי',
    'שוקל כל מילה',
    'מדבר עם עצמו',
    'מבשל רעיון על אש קטנה',
    'מגרד בראש',
    'מחפש קצה חוט',
    'הופך את הרעיון מכל צד',
    'מחטט במגירות הזיכרון',
    'מכנס ישיבה בתוך הראש',
    'חושב אם הוא חושב יותר מדי',
    'מרתיח אוקיינוס שלם',
  ],
  netDeletionCommit: [
    { title: { other: '{count} שורות פרשו לגמלאות.' }, description: 'הן שירתו היטב.' },
    { title: { other: '−{count} שורות.' }, description: 'סוג הקומיט הנדיר ביותר.' },
    { title: { other: 'קל יותר ב-{count} שורות.' }, description: 'אף אחד לא יצטרך לעבור עליהן שוב.' },
    { title: { other: '{count} שורות נעלמו.' }, description: 'בואו נעמיד פנים שהן מעולם לא היו.' },
  ],
};
