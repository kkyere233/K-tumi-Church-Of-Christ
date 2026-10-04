const fs = require("node:fs/promises");
const path = require("node:path");

async function build() {
  const backendValue = String(process.env.RENDER_BACKEND_URL || "").trim();
  if (!backendValue) throw new Error("Set RENDER_BACKEND_URL to the HTTPS origin of the Render backend.");

  let backend;
  try {
    backend = new URL(backendValue);
  } catch {
    throw new Error("RENDER_BACKEND_URL must be a valid HTTPS origin.");
  }
  if (backend.protocol !== "https:" || backend.origin !== backendValue.replace(/\/$/, "")) {
    throw new Error("RENDER_BACKEND_URL must be an HTTPS origin without a path, query, or fragment.");
  }

  const output = path.join(__dirname, "dist");
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(path.join(output, "dashboard"), { recursive: true });
  await fs.mkdir(path.join(output, "assets"), { recursive: true });
  await fs.copyFile(path.join(__dirname, "login.html"), path.join(output, "index.html"));
  await fs.copyFile(path.join(__dirname, "COC jct.html"), path.join(output, "dashboard", "index.html"));
  await Promise.all(["church-logo.svg", "church-logo-dark.svg"].map(file =>
    fs.copyFile(path.join(__dirname, "assets", file), path.join(output, "assets", file))
  ));
  await fs.writeFile(path.join(output, "_redirects"), [
    `/api/* ${backend.origin}/api/:splat 200`,
    `/health ${backend.origin}/health 200`,
    ""
  ].join("\n"));
  console.log(`Built Netlify frontend with API proxy to ${backend.origin}.`);
}

build().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
