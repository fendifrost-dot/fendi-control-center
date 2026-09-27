import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { TaxShell } from "@/components/tax/TaxShell";
import { MuseShell } from "@/components/muse/MuseShell";
import { RequireSession } from "@/components/auth/RequireSession";
import Index from "./pages/Index";
import HubHomePage from "./pages/HubHomePage";
import Ops from "./pages/Ops";
import RemoteControlPage from "./pages/RemoteControlPage";
import Test from "./pages/Test";
import Login from "./pages/Login";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import NotFound from "./pages/NotFound";
import ClientsPage from "./pages/tax/ClientsPage";
import ClientReturnsPage from "./pages/tax/ClientReturnsPage";
import YearWorkspacePage from "./pages/tax/YearWorkspacePage";
import MuseBriefPage from "./pages/muse/MuseBriefPage";
import MusePortfolioPage from "./pages/muse/MusePortfolioPage";
import MuseOpenLoopsPage from "./pages/muse/MuseOpenLoopsPage";
import MuseImprovementsPage from "./pages/muse/MuseImprovementsPage";
import MuseSourcesPage from "./pages/muse/MuseSourcesPage";
import MuseSystemsPage from "./pages/muse/MuseSystemsPage";
import MuseMissionsPage from "./pages/muse/MuseMissionsPage";
import MuseDailyPage from "./pages/muse/MuseDailyPage";
import MuseAgentQueuePage from "./pages/muse/MuseAgentQueuePage";
import MuseVerificationPage from "./pages/muse/MuseVerificationPage";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/" element={<HubHomePage />} />
            <Route path="/ops" element={<Ops />} />
            <Route path="/remote" element={<RemoteControlPage />} />
            <Route path="/test" element={<Test />} />
            <Route path="/tax" element={<Navigate to="/clients" replace />} />
            <Route path="/tax/*" element={<Navigate to="/clients" replace />} />
            <Route
              element={
                <RequireSession>
                  <TaxShell />
                </RequireSession>
              }
            >
              <Route path="/clients" element={<ClientsPage />} />
              <Route path="/clients/:clientId" element={<ClientReturnsPage />} />
              <Route path="/clients/:clientId/:year" element={<YearWorkspacePage />} />
            </Route>
            {/* Muse executive layer. MuseShell already wraps children in
                RequireSession, matching how TaxShell is guarded. */}
            <Route path="/muse" element={<MuseShell />}>
              <Route index element={<MuseBriefPage />} />
              <Route path="missions" element={<MuseMissionsPage />} />
              <Route path="daily" element={<MuseDailyPage />} />
              <Route path="queue" element={<MuseAgentQueuePage />} />
              <Route path="verification" element={<MuseVerificationPage />} />
              <Route path="portfolio" element={<MusePortfolioPage />} />
              <Route path="loops" element={<MuseOpenLoopsPage />} />
              <Route path="improvements" element={<MuseImprovementsPage />} />
              <Route path="sources" element={<MuseSourcesPage />} />
              <Route path="systems" element={<MuseSystemsPage />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
