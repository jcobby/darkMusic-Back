"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.imageUrl = imageUrl;
const env_1 = require("../config/env");
/** Turn a stored image filename into a browser URL; pass through absolute URLs. */
function imageUrl(value) {
    if (!value)
        return undefined;
    if (/^https?:\/\//i.test(value))
        return value;
    return `${env_1.env.apiBaseUrl}/uploads/${value}`;
}
//# sourceMappingURL=media.js.map