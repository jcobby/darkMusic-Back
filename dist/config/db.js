"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectDB = connectDB;
const mongoose_1 = __importDefault(require("mongoose"));
async function connectDB() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        throw new Error("MONGODB_URI is not defined in environment variables");
    }
    mongoose_1.default.set("strictQuery", true);
    await mongoose_1.default.connect(uri);
    console.log("✅ MongoDB connected");
    mongoose_1.default.connection.on("error", (err) => {
        console.error("MongoDB connection error:", err);
    });
}
//# sourceMappingURL=db.js.map