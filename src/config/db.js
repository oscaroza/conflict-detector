const mongoose = require("mongoose");

async function connectDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI manquant. Ajoutez-le dans votre fichier .env");
  }

  mongoose.set("strictQuery", true);
  await mongoose.connect(uri);
  console.log("[db] MongoDB connecte");
}

module.exports = { connectDatabase };
