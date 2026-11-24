import { HostPage } from "./pages/HostPage.js";
import { GuestPage } from "./pages/GuestPage.js";

export function App() {
  return location.pathname.startsWith("/r/") ? <GuestPage /> : <HostPage />;
}
