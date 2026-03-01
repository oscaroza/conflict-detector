require("dotenv").config();

const path = require("path");
const express = require("express");
const morgan = require("morgan");

const { connectDatabase } = require("./src/config/db");
const apiRoutes = require("./src/routes/api");
const feedService = require("./src/services/feedService");

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(morgan("dev"));
app.use(express.json({ limit: "1mb" }));

app.use("/api", apiRoutes);
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ status: "ok", at: new Date().toISOString() });
});

app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || "Erreur serveur" });
});

async function start() {
  await connectDatabase();
  await feedService.startScheduler();

  app.listen(port, () => {
    console.log(`[server] Dashboard en ligne sur http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error("[server] Erreur de demarrage", error);
  process.exit(1);
});
