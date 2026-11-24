import Foundation

/// What the share extension says, in the phone's language. The extension shows at most a
/// notification or a one-button alert, so its few lines live here instead of a strings
/// table per language in the Xcode project.
struct ShareStrings {
    /// Notification body when the share opened a draft.
    let openDraft: String
    /// Notification body when every item was refused; the app names them.
    let nothingTaken: String
    /// Alert shown when notifications are off.
    let savedTitle: String
    let savedMessage: String
    /// Alert shown when notifications are off and nothing could be attached; the app
    /// names each refused item once it is opened.
    let failedTitle: String
    let failedMessage: String
    let ok: String

    static func forPreferredLanguages(_ preferences: [String] = Locale.preferredLanguages) -> ShareStrings {
        let language = Bundle.preferredLocalizations(from: Array(table.keys), forPreferences: preferences).first
        return language.flatMap { table[$0] } ?? table["en"]!
    }

    static let table: [String: ShareStrings] = [
        "en": .init(
            openDraft: "Tap to open the draft in OpenChamber",
            nothingTaken: "OpenChamber couldn't attach this. Tap to see why",
            savedTitle: "Saved to OpenChamber",
            savedMessage: "Open OpenChamber to continue in a new draft.",
            failedTitle: "Couldn't attach to OpenChamber",
            failedMessage: "Open OpenChamber to see why.",
            ok: "OK"),
        "ar": .init(
            openDraft: "اضغط لفتح المسودة في OpenChamber",
            nothingTaken: "تعذّر على OpenChamber إرفاق هذا. اضغط لمعرفة السبب",
            savedTitle: "تم الحفظ في OpenChamber",
            savedMessage: "افتح OpenChamber للمتابعة في مسودة جديدة.",
            failedTitle: "تعذّر الإرفاق في OpenChamber",
            failedMessage: "افتح OpenChamber لمعرفة السبب.",
            ok: "حسنًا"),
        "de": .init(
            openDraft: "Tippen, um den Entwurf in OpenChamber zu öffnen",
            nothingTaken: "OpenChamber konnte das nicht anhängen. Tippen für Details",
            savedTitle: "In OpenChamber gespeichert",
            savedMessage: "Öffne OpenChamber, um in einem neuen Entwurf weiterzumachen.",
            failedTitle: "Anhängen in OpenChamber fehlgeschlagen",
            failedMessage: "Öffne OpenChamber, um den Grund zu sehen.",
            ok: "OK"),
        "es": .init(
            openDraft: "Toca para abrir el borrador en OpenChamber",
            nothingTaken: "OpenChamber no pudo adjuntar esto. Toca para ver el motivo",
            savedTitle: "Guardado en OpenChamber",
            savedMessage: "Abre OpenChamber para continuar en un borrador nuevo.",
            failedTitle: "No se pudo adjuntar en OpenChamber",
            failedMessage: "Abre OpenChamber para ver el motivo.",
            ok: "OK"),
        "fr": .init(
            openDraft: "Touchez pour ouvrir le brouillon dans OpenChamber",
            nothingTaken: "OpenChamber n'a pas pu joindre ceci. Touchez pour voir pourquoi",
            savedTitle: "Enregistré dans OpenChamber",
            savedMessage: "Ouvrez OpenChamber pour continuer dans un nouveau brouillon.",
            failedTitle: "Impossible de joindre dans OpenChamber",
            failedMessage: "Ouvrez OpenChamber pour voir pourquoi.",
            ok: "OK"),
        "he": .init(
            openDraft: "הקש כדי לפתוח את הטיוטה ב-OpenChamber",
            nothingTaken: "OpenChamber לא הצליח לצרף את זה. הקש כדי לראות למה",
            savedTitle: "נשמר ב-OpenChamber",
            savedMessage: "פתח את OpenChamber כדי להמשיך בטיוטה חדשה.",
            failedTitle: "לא ניתן לצרף ב-OpenChamber",
            failedMessage: "פתח את OpenChamber כדי לראות למה.",
            ok: "אישור"),
        "ja": .init(
            openDraft: "タップしてOpenChamberで下書きを開く",
            nothingTaken: "OpenChamberに添付できませんでした。タップして理由を確認",
            savedTitle: "OpenChamberに保存しました",
            savedMessage: "OpenChamberを開くと新しい下書きで続けられます。",
            failedTitle: "OpenChamberに添付できませんでした",
            failedMessage: "OpenChamberを開いて理由を確認してください。",
            ok: "OK"),
        "ko": .init(
            openDraft: "탭하여 OpenChamber에서 초안 열기",
            nothingTaken: "OpenChamber에 첨부하지 못했습니다. 탭하여 이유 보기",
            savedTitle: "OpenChamber에 저장됨",
            savedMessage: "OpenChamber를 열어 새 초안에서 계속하세요.",
            failedTitle: "OpenChamber에 첨부하지 못했습니다",
            failedMessage: "OpenChamber를 열어 이유를 확인하세요.",
            ok: "확인"),
        "nl": .init(
            openDraft: "Tik om het concept in OpenChamber te openen",
            nothingTaken: "OpenChamber kon dit niet bijvoegen. Tik om te zien waarom",
            savedTitle: "Bewaard in OpenChamber",
            savedMessage: "Open OpenChamber om verder te gaan in een nieuw concept.",
            failedTitle: "Bijvoegen in OpenChamber mislukt",
            failedMessage: "Open OpenChamber om te zien waarom.",
            ok: "OK"),
        "pl": .init(
            openDraft: "Stuknij, aby otworzyć szkic w OpenChamber",
            nothingTaken: "OpenChamber nie mógł tego dołączyć. Stuknij, aby zobaczyć dlaczego",
            savedTitle: "Zapisano w OpenChamber",
            savedMessage: "Otwórz OpenChamber, aby kontynuować w nowym szkicu.",
            failedTitle: "Nie udało się dołączyć w OpenChamber",
            failedMessage: "Otwórz OpenChamber, aby zobaczyć dlaczego.",
            ok: "OK"),
        "pt-BR": .init(
            openDraft: "Toque para abrir o rascunho no OpenChamber",
            nothingTaken: "O OpenChamber não conseguiu anexar isto. Toque para ver o motivo",
            savedTitle: "Salvo no OpenChamber",
            savedMessage: "Abra o OpenChamber para continuar em um novo rascunho.",
            failedTitle: "Não foi possível anexar no OpenChamber",
            failedMessage: "Abra o OpenChamber para ver o motivo.",
            ok: "OK"),
        "tr": .init(
            openDraft: "Taslağı OpenChamber'da açmak için dokunun",
            nothingTaken: "OpenChamber bunu ekleyemedi. Nedenini görmek için dokunun",
            savedTitle: "OpenChamber'a kaydedildi",
            savedMessage: "Yeni bir taslakta devam etmek için OpenChamber'ı açın.",
            failedTitle: "OpenChamber'a eklenemedi",
            failedMessage: "Nedenini görmek için OpenChamber'ı açın.",
            ok: "Tamam"),
        "uk": .init(
            openDraft: "Торкніться, щоб відкрити чернетку в OpenChamber",
            nothingTaken: "OpenChamber не вдалося це прикріпити. Торкніться, щоб побачити чому",
            savedTitle: "Збережено в OpenChamber",
            savedMessage: "Відкрийте OpenChamber, щоб продовжити в новій чернетці.",
            failedTitle: "Не вдалося прикріпити в OpenChamber",
            failedMessage: "Відкрийте OpenChamber, щоб побачити чому.",
            ok: "OK"),
        "zh-Hans": .init(
            openDraft: "轻点以在 OpenChamber 中打开草稿",
            nothingTaken: "OpenChamber 无法附加此内容。轻点查看原因",
            savedTitle: "已保存到 OpenChamber",
            savedMessage: "打开 OpenChamber 以在新草稿中继续。",
            failedTitle: "无法附加到 OpenChamber",
            failedMessage: "打开 OpenChamber 查看原因。",
            ok: "好"),
        "zh-Hant": .init(
            openDraft: "點一下以在 OpenChamber 中開啟草稿",
            nothingTaken: "OpenChamber 無法附加此內容。點一下查看原因",
            savedTitle: "已儲存到 OpenChamber",
            savedMessage: "開啟 OpenChamber 以在新草稿中繼續。",
            failedTitle: "無法附加到 OpenChamber",
            failedMessage: "開啟 OpenChamber 查看原因。",
            ok: "好"),
    ]
}
