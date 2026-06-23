"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.upload = void 0;
exports.fileName = fileName;
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const storage_1 = require("./storage");
(0, storage_1.ensureStorageDirs)();
/** Map an upload field name to its storage bucket. */
function bucketForField(fieldname) {
    switch (fieldname) {
        case "audio":
            return "audio"; // release MP3 (paid)
        case "mp3Free":
        case "wav":
            return "beats"; // beat files
        default:
            return "images"; // cover / image / images
    }
}
const storage = multer_1.default.diskStorage({
    destination: (_req, file, cb) => cb(null, storage_1.STORAGE[bucketForField(file.fieldname)]),
    filename: (_req, file, cb) => {
        const ext = path_1.default.extname(file.originalname).toLowerCase();
        const base = crypto_1.default.randomBytes(8).toString("hex");
        cb(null, `${Date.now()}-${base}${ext}`);
    },
});
/** Single multer instance; routes choose fields via `.fields([...])`. */
exports.upload = (0, multer_1.default)({ storage, limits: { fileSize: 100 * 1024 * 1024 } });
/** First uploaded filename for a field, if present. */
function fileName(files, field) {
    return files?.[field]?.[0]?.filename;
}
//# sourceMappingURL=upload.js.map