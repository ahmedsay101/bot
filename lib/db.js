const { default: mongoose } = require("mongoose");
require("dotenv").config();

const db = async () => {
    try {
        await mongoose.connect(process.env.DATABASE_URL);
    } catch (err) {
        console.error("Database Connection Error", err);
    }
};

module.exports = db;
