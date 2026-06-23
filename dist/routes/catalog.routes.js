"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const catalog_controller_1 = require("../controllers/catalog.controller");
const router = (0, express_1.Router)();
router.get("/releases", catalog_controller_1.listReleases);
router.get("/releases/:slug", catalog_controller_1.getRelease);
router.get("/releases/:slug/preview", catalog_controller_1.previewRelease);
router.get("/beats", catalog_controller_1.listBeats);
router.get("/beats/:slug", catalog_controller_1.getBeat);
router.get("/beats/:slug/free", catalog_controller_1.downloadFreeBeat);
router.get("/merch", catalog_controller_1.listMerch);
router.get("/merch/:slug", catalog_controller_1.getMerch);
exports.default = router;
//# sourceMappingURL=catalog.routes.js.map