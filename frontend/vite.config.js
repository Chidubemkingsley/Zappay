import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import fs from "fs";

const certExists =
  fs.existsSync("localhost+2-key.pem") && fs.existsSync("localhost+2.pem");

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: certExists
    ? {
        https: {
          key: fs.readFileSync("localhost+2-key.pem"),
          cert: fs.readFileSync("localhost+2.pem"),
        },
      }
    : {},
});
