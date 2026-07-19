import "@github/relative-time-element";
import { CssVarsProvider } from "@mui/joy";
import { observer } from "mobx-react-lite";
import { createRoot } from "react-dom/client";
import { Toaster } from "react-hot-toast";
import { RouterProvider } from "react-router-dom";
import "./i18n";
import router from "./router";
import { initialUserStore } from "./store/v2/user";
import { initialWorkspaceStore } from "./store/v2/workspace";
import "./style.css";
import theme from "./theme";
import "@usememos/mui/theme.css";
import "leaflet/dist/leaflet.css";

// Version identification for deployment debugging
const BUILD_VERSION = "v2025-07-11-13:12:00";
const BUILD_COMMIT = "3bb4fd6";
console.log(`🚀 Memos Frontend ${BUILD_VERSION} (${BUILD_COMMIT})`);
console.log(`📅 Build Time: ${new Date().toISOString()}`);

const Main = observer(() => (
  <CssVarsProvider theme={theme}>
    <RouterProvider router={router} />
    <Toaster position="top-right" toastOptions={{ className: "dark:bg-zinc-700 dark:text-gray-300" }} />
  </CssVarsProvider>
));

(async () => {
  await initialWorkspaceStore();
  await initialUserStore();

  const container = document.getElementById("root");
  const root = createRoot(container as HTMLElement);
  root.render(<Main />);
})();
