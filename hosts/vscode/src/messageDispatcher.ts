export type RouteMessage = { type: string; [k: string]: unknown };
type MessageHandler = (message: RouteMessage) => Promise<void>;

const CONTROL_MESSAGES = new Set(["chat.answer", "chat.approve", "chat.cancel"]);

export function createMessageDispatcher(handle: MessageHandler): MessageHandler {
  let queue: Promise<void> = Promise.resolve();
  return (message) => {
    if (CONTROL_MESSAGES.has(message.type)) return Promise.resolve().then(() => handle(message));
    const result = queue.then(() => handle(message));
    queue = result.catch(() => {});
    return result;
  };
}
