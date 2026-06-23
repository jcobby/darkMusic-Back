"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const upload_1 = require("../services/upload");
const admin_controller_1 = require("../controllers/admin.controller");
const router = (0, express_1.Router)();
// Every admin route requires a valid admin JWT.
router.use(auth_1.requireAdmin);
const releaseUpload = upload_1.upload.fields([
    { name: "cover", maxCount: 1 },
    { name: "audio", maxCount: 1 },
]);
const beatUpload = upload_1.upload.fields([
    { name: "cover", maxCount: 1 },
    { name: "mp3Free", maxCount: 1 },
    { name: "wav", maxCount: 1 },
]);
const merchUpload = upload_1.upload.fields([{ name: "images", maxCount: 6 }]);
// Releases
router.get("/releases", admin_controller_1.adminListReleases);
router.post("/releases", releaseUpload, admin_controller_1.createRelease);
router.put("/releases/:id", releaseUpload, admin_controller_1.updateRelease);
router.delete("/releases/:id", admin_controller_1.deleteRelease);
// Beats
router.get("/beats", admin_controller_1.adminListBeats);
router.post("/beats", beatUpload, admin_controller_1.createBeat);
router.put("/beats/:id", beatUpload, admin_controller_1.updateBeat);
router.delete("/beats/:id", admin_controller_1.deleteBeat);
// Merch
router.get("/merch", admin_controller_1.adminListMerch);
router.post("/merch", merchUpload, admin_controller_1.createMerch);
router.put("/merch/:id", merchUpload, admin_controller_1.updateMerch);
router.delete("/merch/:id", admin_controller_1.deleteMerch);
// Inquiries & orders
router.get("/inquiries", admin_controller_1.adminListInquiries);
router.patch("/inquiries/:id", admin_controller_1.updateInquiry);
router.get("/orders", admin_controller_1.adminListOrders);
exports.default = router;
//# sourceMappingURL=admin.routes.js.map