/** Filter the already-loaded friend chats on-device; no contact data is searched remotely. */
export function filterConversations(conversations, query) {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return conversations;
  return conversations.filter((conversation) =>
    conversation.peerUsername?.toLocaleLowerCase().includes(term));
}
