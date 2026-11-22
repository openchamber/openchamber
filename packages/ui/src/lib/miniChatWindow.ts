let miniChatWindow = false;

export const markMiniChatWindow = (): void => {
  miniChatWindow = true;
};

export const isMiniChatWindow = (): boolean => miniChatWindow;
