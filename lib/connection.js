const db = require("./db");
(async() => {
  try {
    await db();
    console.log("Database Connected Successfully");
  } catch (err) {
    console.error("Database Connection Error", err);
  }
})();
