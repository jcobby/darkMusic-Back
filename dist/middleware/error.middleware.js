"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notFound = notFound;
exports.errorHandler = errorHandler;
function notFound(req, res) {
    res.status(404).json({ message: `Route not found: ${req.originalUrl}` });
}
function errorHandler(err, _req, res, 
// eslint-disable-next-line @typescript-eslint/no-unused-vars
_next) {
    console.error(err);
    const status = err.statusCode ?? 500;
    res.status(status).json({
        message: err.message || "Internal Server Error",
    });
}
//# sourceMappingURL=error.middleware.js.map