import { HostPage } from "./pages/HostPage.js";
import { GuestPage } from "./pages/GuestPage.js";
import { CodePage } from "./pages/CodePage.js";
import { PrivacyPage } from "./pages/PrivacyPage.js";

export function App() {
  if (location.pathname.startsWith("/r/")) return <GuestPage />;
  if (location.pathname.startsWith("/j/")) {
    const code = location.pathname.split("/")[2] ?? "";
    return <GuestPage code={code} />;
  }
  if (location.pathname.startsWith("/code")) return <CodePage />;
  if (location.pathname.startsWith("/privacy")) return <PrivacyPage />;
  return <HostPage />;
}
