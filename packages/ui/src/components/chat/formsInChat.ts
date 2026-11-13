/**
 * Whether a chat column draws waiting questions as cards at the end of its
 * transcript ("Questions: in the chat") instead of the composer's dock.
 *
 * Only while the transcript is on screen: an empty or loading session and an
 * expanded composer have no end to put a card at. A chat pinned in the side
 * panel keeps the dock, because the dock's line brings the card into view
 * through the app-wide waiting-page request, which only the main timeline
 * serves.
 */
export const resolveFormsInChat = ({ questionsInChat, pinned, transcriptShown }: {
    questionsInChat: boolean;
    pinned: boolean;
    transcriptShown: boolean;
}): boolean => questionsInChat && !pinned && transcriptShown;
