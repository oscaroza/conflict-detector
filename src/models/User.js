const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    email: { type: String, unique: true, sparse: true },
    name: { type: String, default: "Utilisateur" },
    preferredCountries: { type: [String], default: [] },
    preferredTypes: { type: [String], default: [] }
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", UserSchema);
