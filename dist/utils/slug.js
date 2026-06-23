"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.slugify = slugify;
/** Minimal, dependency-free slugifier (lowercase, hyphenated, alnum only). */
function slugify(input) {
    return input
        .toString()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "") // strip combining diacritical marks
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-");
}
//# sourceMappingURL=slug.js.map