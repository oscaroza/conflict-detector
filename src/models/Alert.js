const mongoose = require("mongoose");

const AlertSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    summary: { type: String, default: "" },
    sourceName: { type: String, required: true },
    sourceUrl: { type: String, required: true, unique: true },
    publishedAt: { type: Date },
    type: {
      type: String,
      enum: [
        "geopolitique",
        "sport",
        "economie",
        "technologie",
        "cyber",
        "humanitaire",
        "autre",
        // Legacy values kept for backward compatibility.
        "politique",
        "militaire"
      ],
      default: "autre"
    },
    severity: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium"
    },
    country: {
      name: { type: String, default: "Inconnu" },
      code: { type: String, default: "XX" },
      region: { type: String, default: "Global" }
    },
    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point"
      },
      coordinates: {
        type: [Number],
        default: [0, 20]
      }
    },
    actionable: { type: Boolean, default: false },
    read: { type: Boolean, default: false }
  },
  { timestamps: true }
);

AlertSchema.index({ location: "2dsphere" });
AlertSchema.index({ createdAt: -1 });
AlertSchema.index({ type: 1, severity: 1 });
AlertSchema.index({ actionable: 1, createdAt: -1 });
AlertSchema.index({ "country.name": 1 });

module.exports = mongoose.model("Alert", AlertSchema);
