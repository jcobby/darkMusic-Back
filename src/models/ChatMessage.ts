import { Schema, model, Document, Types } from "mongoose";

/**
 * A chat message in a game "room" (controllers/chat): "pool-<match code>" — the two
 * players of a DMY Pool match — or "event-<slug>" — everyone at a live event. Kept 30 days.
 */
export interface IChatMessage extends Document {
  room: string;
  user: Types.ObjectId;
  name: string; // first name + initial, as on the boards
  text: string;
  hidden?: boolean; // removed by DMY
  at: Date;
}

const chatMessageSchema = new Schema<IChatMessage>({
  room: { type: String, required: true },
  user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  name: { type: String, required: true },
  text: { type: String, required: true },
  hidden: { type: Boolean },
  at: { type: Date, required: true },
});
chatMessageSchema.index({ room: 1, at: 1 });
chatMessageSchema.index({ at: 1 }, { expireAfterSeconds: 30 * 86400 });

export const ChatMessage = model<IChatMessage>("ChatMessage", chatMessageSchema);
