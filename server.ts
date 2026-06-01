import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import app from "./api/index";

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const HOST = "0.0.0.0";

function startServer(mode: "DEV" | "PROD") {
  if (!process.env.VERCEL) {
    app.listen(PORT, HOST, () => {
      console.log(`Server running on http://localhost:${PORT} [${mode}]`);
    });
  }
}

// Only use Vite middleware in development
if (process.env.NODE_ENV !== "production") {
  createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  }).then((vite) => {
    app.use(vite.middlewares);

    // We start listening after middleware is ready in dev.
    startServer("DEV");
  });
} else {
  const distPath = path.join(process.cwd(), "dist");
  app.use(express.static(distPath));
  app.get("*", (req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });

  startServer("PROD");
}
