import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// host:true 让手机通过局域网 IP 直接访问开发服务器（配合手机连接 PC 引擎联调）
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: false, host: true },
  build: { target: "safari15", outDir: "dist" }
});
