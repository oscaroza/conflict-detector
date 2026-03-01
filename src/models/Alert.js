const mongoose = require("mongoose");

const AlertSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    summary: { type: String, default: "" },
    sourceName: { type: String, required: true },
    sourceUrl: { type: String, required: true, unique: true },
    publishedAt: { type: Date },
    occurredAt: { type: Date, default: null },
    occurredAtSource: { type: String, default: "unknown" },
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
    city: {
      name: { type: String, default: "" },
      lat: { type: Number, default: null },
      lng: { type: Number, default: null }
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
    read: { type: Boolean, default: false },
    confirmed: { type: Boolean, default: false },
    confidenceScore: { type: Number, default: 35, min: 0, max: 100 },
    sourceCount: { type: Number, default: 1, min: 1 },
    sourceNames: { type: [String], default: [] },
    eventGroupId: { type: String, default: "" }
  },
  { timestamps: true }
);

AlertSchema.index({ location: "2dsphere" });
AlertSchema.index({ createdAt: -1 });
AlertSchema.index({ publishedAt: -1, createdAt: -1 });
AlertSchema.index({ occurredAt: -1, publishedAt: -1, createdAt: -1 });
AlertSchema.index({ type: 1, severity: 1 });
AlertSchema.index({ actionable: 1, createdAt: -1 });
AlertSchema.index({ type: 1, publishedAt: -1, createdAt: -1 });
AlertSchema.index({ "country.name": 1 });
AlertSchema.index({ "city.name": 1 });
AlertSchema.index({ confirmed: 1, createdAt: -1 });
AlertSchema.index({ eventGroupId: 1, createdAt: -1 });

module.exports = mongoose.model("Alert", AlertSchema);
