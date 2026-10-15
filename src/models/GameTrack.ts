import { Schema, model, Document } from "mongoose";

/**
 * Music for a game (Beat Breaker): Lenko Psycho songs that take over from the
 * beats as players level up, and an unreleased track kept for the best players.
 * The audio lives on Cloudinary as private ("authenticated") files and is only
 * handed out through signed links. Added with `npm run game-music` — titles and
 * files stay out of the (public) code repository.
 */
export interface IGameTrack extends Document {
  game: string; // "beat-breaker"
  kind: "song" | "unreleased";
  title: string;
  artist: string;
  publicId?: string; // Cloudinary (authenticated video resource)
  src?: string; // or a direct URL (local testing)
  order: number;
  welcome: boolean; // also the site's welcome song (a short clip on arrival)
  cover?: string; // artwork URL, for the welcome player
  href?: string; // where to hear the full song (e.g. Spotify)
  hidden: boolean;
}

const gameTrackSchema = new Schema<IGameTrack>(
  {
    game: { type: String, required: true, index: true },
    kind: { type: String, enum: ["song", "unreleased"], required: true },
    title: { type: String, required: true, trim: true },
    artist: { type: String, default: "Lenko Psycho", trim: true },
    publicId: { type: String },
    src: { type: String },
    order: { type: Number, default: 0 },
    welcome: { type: Boolean, default: false },
    cover: { type: String },
    href: { type: String },
    hidden: { type: Boolean, default: false },
  },
  { timestamps: true }
);
gameTrackSchema.index({ game: 1, kind: 1, title: 1 }, { unique: true });

export const GameTrack = model<IGameTrack>("GameTrack", gameTrackSchema);
