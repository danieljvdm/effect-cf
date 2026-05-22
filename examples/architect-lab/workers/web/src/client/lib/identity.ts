export const randomLabel = (): string => `Guest ${Math.floor(Math.random() * 1000)}`;

export const getInitialRoomId = (): string =>
  location.pathname.startsWith("/room/") ? location.pathname.slice("/room/".length) : "";

export const getPersistentUserId = (): string => {
  const stored = localStorage.getItem("architect:userId");
  if (stored !== null) {
    return stored;
  }

  const userId = `user_${crypto.randomUUID().slice(0, 8)}`;
  localStorage.setItem("architect:userId", userId);
  return userId;
};
