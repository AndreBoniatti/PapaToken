import { EventEmitter } from "node:events";

/** In-process event bus feeding the SSE endpoint. */
export const bus = new EventEmitter();
bus.setMaxListeners(50);

export type AppEvent =
  | { type: "usage"; }
  | { type: "task"; taskId: number; status: string }
  | { type: "scheduler"; message: string };

export function emit(event: AppEvent) {
  bus.emit("event", event);
}
