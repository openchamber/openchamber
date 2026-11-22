import type { EasterEggCopy } from './types';

export const copy: EasterEggCopy = {
  draftTitle: {
    everyday: [
      '{project} projesinde ne üzerinde çalışıyoruz?',
      '{project} için sırada ne var?',
      'Bugün {project} projesinde ne inşa ediyoruz?',
      'Hata mı, fikir mi? {project} için ikisi de olur.',
      '{project} projesinde nereden başlıyoruz?',
    ],
    deepNight: [
      'Hâlâ ayakta mıyız? {project} projesinde ne üzerinde çalışıyoruz?',
      'Gece vardiyası başladı. {project} projesinde neler var?',
      'Herkes uyuyor, biz ve {project} hariç.',
      'Hatalar da uyuyor. {project} projesinde yakalayalım mı?',
      'Gece geç, zihin berrak. {project} için sırada ne var?',
      'Sessiz saatler. {project} için tam zamanı.',
    ],
    halloween: [
      'Bugün {project} projesinde neyi çağırıyoruz?',
      '{project} projesine hangi hatalar musallat oldu?',
    ],
    newYearsEve: ['Yıl bitmeden {project} için bir şey daha?'],
    newYearsDay: ['Bu yıl {project} için ilk iş ne?'],
  },
  gitClean: {
    everyday: [
      'Şüphe uyandıracak kadar temiz.',
      'Commit edilecek bir şey yok. Bu sessizliğin tadını çıkaralım.',
      'Pırıl pırıl. Biraz dağıtma zamanı.',
      'Haydi, birkaç prompt ile değişiklikler gelir.',
      'Her şey commit edildi. Kahve molası resmen onaylandı.',
    ],
    halloween: ['Commit edilecek bir şey yok. Korkacak bir şey de yok.'],
    newYearsEve: ['Yılı temiz bir ağaçla kapatıyoruz.'],
    newYearsDay: ['Yıla temiz bir başlangıç.'],
  },
  push: {
    fridayEvening: [
      { title: 'Cesurca.', description: 'Cuma akşamı push. Efsaneye göre hafta sonları böyle iptal olur.' },
      { title: 'Cesur hamle.', description: 'Cuma akşamı push. Nöbetçinin gecesi sakin geçsin.' },
      { title: 'Doğrudan hafta sonuna push edildi.', description: 'Umarız oraya kadar peşinizden gelmez.' },
      { title: "Cuma push'u kabul edildi.", description: 'Hafta sonuna haber verildi.' },
      { title: 'Push edildi.', description: 'Cuma akşamı herkes buna cesaret edemez.' },
    ],
    smallHours: [
      { title: 'Saat {time}, push edildi.', description: 'Dinlenmeyi fazlasıyla hak ettiniz.' },
      { title: 'Saat {time}, push edildi.', description: "Gece commit'lerinin kendine has bir çekiciliği var." },
      { title: 'Saat {time}, push edildi.', description: 'Sabah için güzel bir sürpriz.' },
      { title: "Gece push'u, {time}.", description: 'En sessiz saatte en cesur değişiklikler.' },
      { title: '{time}, push edildi.', description: 'Kod güvende. Derin bir nefes alabilirsiniz.' },
    ],
  },
  thinking: [
    'kafa yoruyor',
    'tavana bakıyor',
    'lastik ördeğe danışıyor',
    'her tokenı tartıyor',
    'kendi kendine konuşuyor',
    'bir fikir demliyor',
    'ince eleyip sık dokuyor',
    'kafasını kaşıyor',
    'düşünce yumağını çözüyor',
    'bin dereden su getiriyor',
    'fazla mı düşündüğünü düşünüyor',
    'okyanusu kaynatıyor',
  ],
  netDeletionCommit: [
    { title: { other: '{count} satır emekli oldu.' }, description: 'İyi hizmet ettiler.' },
    { title: { other: '−{count} satır.' }, description: 'Commit türlerinin en nadiri.' },
    { title: { other: '{count} satır daha hafif.' }, description: 'Artık kimse onları incelemek zorunda kalmayacak.' },
    { title: { other: '{count} satır gitti.' }, description: 'Hiç var olmamışlar gibi davranalım.' },
  ],
};
