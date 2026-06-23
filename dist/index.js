"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const app_1 = __importDefault(require("./app"));
const db_1 = require("./config/db");
const PORT = Number(process.env.PORT) || 5000;
async function start() {
    await (0, db_1.connectDB)();
    app_1.default.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
}
start().catch((err) => {
    console.error("❌ Failed to start server:", err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map