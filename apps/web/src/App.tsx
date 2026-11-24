import { HostPage } from "./pages/HostPage.js";
import { GuestPage } from "./pages/GuestPage.js";
import { CodePage } from "./pages/CodePage.js";

export function App() {
  if (location.pathname.startsWith("/r/")) return <GuestPage />;
  if (location.pathname.startsWith("/j/")) {
    const code = location.pathname.split("/")[2] ?? "";
    return <GuestPage code={code} />;
  }
  if (location.pathname.startsWith("/code")) return <CodePage />;
  return <HostPage />;
}
