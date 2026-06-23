"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.STORAGE = void 0;
exports.ensureStorageDirs = ensureStorageDirs;
exports.resolveStored = resolveStored;
exports.storedFileExists = storedFileExists;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const env_1 = require("../config/env");
/**
 * Local disk storage layout (all under backend/storage, gitignored):
 *   images/  — public cover & merch images, served statically at /uploads
 *   audio/   — release MP3s, delivered only via download tokens
 *   beats/   — beat free MP3s (controlled stream) + paid WAVs (token only)
 */
exports.STORAGE = {
    images: path_1.default.join(env_1.env.storageDir, "images"),
    audio: path_1.default.join(env_1.env.storageDir, "audio"),
    beats: path_1.default.join(env_1.env.storageDir, "beats"),
};
function ensureStorageDirs() {
    for (const dir of Object.values(exports.STORAGE)) {
        fs_1.default.mkdirSync(dir, { recursive: true });
    }
}
function resolveStored(bucket, filename) {
    // Guard against path traversal — only allow a bare filename.
    const safe = path_1.default.basename(filename);
    return path_1.default.join(exports.STORAGE[bucket], safe);
}
function storedFileExists(bucket, filename) {
    if (!filename)
        return false;
    return fs_1.default.existsSync(resolveStored(bucket, filename));
}
//# sourceMappingURL=storage.js.map