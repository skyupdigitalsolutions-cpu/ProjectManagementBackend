const express = require("express");
const router = express.Router();

const { register, login, getMe, changePassword } = require("../controllers/Authcontroller");
const { protect, authorise } = require("../middleware/authMiddleware");



router.post("/register",         protect, authorise("admin"), register);
router.post("/login",            login);
router.get("/me",                protect, getMe);
router.patch("/change-password", protect, changePassword);

module.exports = router;
