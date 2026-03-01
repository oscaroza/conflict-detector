const mongoose = require("mongoose");

const SettingsSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, default: "default" },
    paused: { type: Boolean, default: false },
    pollIntervalSeconds: { type: Number, default: 300, min: 30, max: 3600 },
    soundEnabled: { type: Boolean, default: true },
    globalCoverage: { type: Boolean, default: true },
    alertMode: { type: String, enum: ["insight", "action"], default: "insight" },
    keywordFilters: { type: [String], default: [] },
    countryFilters: { type: [String], default: [] }
  },
  { timestamps: true }
);

SettingsSchema.statics.getSingleton = async function getSingleton() {
  let doc = await this.findOne({ key: "default" });
  if (!doc) {
    doc = await this.create({ key: "default" });
  }
  return doc;
};

module.exports = mongoose.model("Settings", SettingsSchema);
